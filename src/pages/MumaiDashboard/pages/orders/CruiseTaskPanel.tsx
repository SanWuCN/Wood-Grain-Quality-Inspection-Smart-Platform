/**
 * 工单页 · 下发自主巡航任务（用户 2026-09-18 口径）
 *
 * 原话：「在工单界面添加下发自主巡航任务功能，页面可以有小车数据，小车巡航任务预览，
 * 生成任务编号，这边是 shi 派发的，然后 ma 这边接受任务去建图巡航」。
 *
 * 这一块把四件事摆在一屏里：
 *   ① **小车数据**：链路 / 延迟 / 位姿 / 电量 / 定位 / 相机帧率 —— 全部来自服务端
 *      代理的小车状态，读不到就写「—」，不拿上一次的旧值充数；
 *   ② **巡航任务预览**：航点数、巡检构件、计划里程（与小木口播同源）、预计时长、速度、圈数；
 *   ③ **任务编号**：由服务端生成（`CR-<工单号日期段>-<两位流水>`），下发前写「下发后生成」；
 *   ④ **派发 / 接受**：史（或任何有 `mission:dispatch` 的账号）下发，马这边点「接受任务」
 *      之后就能「去建图巡航」—— 按钮的对错由 `cruiseTask.ts` 的纯函数判，服务端再判一次。
 *
 * 与「扫描仪下发」的区别写在标题下面那行小字里：这条是**平台侧的巡航任务单据**
 * （谁派、谁接、巡哪些构件），车端执行仍然在小车的建图巡航控制台上做；
 * 车没给控制令牌时平台不发假指令（`canControl=false` 时页面照实说）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";

import { Panel } from "../../Panel";
import { Btn, DataTable, KV, SourceTag, StateBlock, StatusChip } from "../../ui";
import { MISSION } from "../../seed/scenario";
import { batteryPercent, cartApi, sourceLabel, voltageText, type CartStatus } from "../cart/api";
import type { MissionEntity, WorkOrderDetail } from "../../api/client";
import {
  cruiseActionBlock,
  cruiseBlockReason,
  cruisePayload,
  cruisePeopleLine,
  cruisePreview,
  cruiseTimeText,
  gridNote,
  missionStateText,
  missionStateTone,
  plannedCruisePath,
  plannedCruiseWaypoints,
} from "./cruiseTask";
import "./orders.css";

/** 小车状态读一次就够用的那一档：面板只显示摘要，不跟着 2 Hz 刷 */
const CART_POLL_MS = 4000;

/**
 * 小车摘要读数（只读轮询，**不开第二条 WebSocket**）。
 *
 * 为什么不直接用 `useCartLive`：那个 hook 自己开一条 `/ws`，而共享服务的"端数"
 * 是按 WebSocket 房间数数的 —— 工单页人人都会打开，每人多一条连接会让
 * 「内网协同」里凭空多出一台"端"。这里只要一份 4 秒一刷的摘要，一个 GET 足够。
 */
function useCartSnapshot(enabled: boolean) {
  const [status, setStatus] = useState<CartStatus | null>(null);
  const [error, setError] = useState("");
  const alive = useRef(true);

  const load = useCallback(async () => {
    try {
      const next = await cartApi.status();
      if (alive.current) {
        setStatus(next);
        setError("");
      }
    } catch (cause) {
      if (!alive.current) return;
      setError((cause as { message?: string })?.message ?? "读不到小车状态");
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    if (!enabled) return undefined;
    void load();
    const timer = window.setInterval(() => void load(), CART_POLL_MS);
    return () => {
      alive.current = false;
      window.clearInterval(timer);
    };
  }, [enabled, load]);

  return { status, error, reload: load };
}

export function CruiseTaskPanel({
  detail,
  mission,
  history,
  canDispatch,
  canMonitor,
  busy,
  onDispatch,
  onAccept,
  onComplete,
  onCancel,
  className = "",
}: {
  detail: WorkOrderDetail;
  /** 本单当前该盯的那条任务（未结束优先） */
  mission: MissionEntity | null;
  /** 本单的历史任务，最新在前 */
  history: MissionEntity[];
  canDispatch: boolean;
  canMonitor: boolean;
  busy: boolean;
  onDispatch: (body: ReturnType<typeof cruisePayload>) => Promise<void>;
  onAccept: () => Promise<void>;
  onComplete: () => Promise<void>;
  onCancel: () => Promise<void>;
  className?: string;
}) {
  const navigate = useNavigate();
  const cart = useCartSnapshot(true);
  const state = cart.status?.state ?? null;
  const [laps, setLaps] = useState(1);
  const [submitting, setSubmitting] = useState<string | null>(null);
  const pending = busy || submitting !== null;

  const maxSpeed = cart.status?.info.maxSpeedMps ?? state?.max_speed_mps ?? null;
  const speedMps = typeof maxSpeed === "number" && maxSpeed > 0 ? maxSpeed : null;
  const speedProfile = speedMps === null ? "速度未读到（以下发时车端上限为准）" : `${speedMps.toFixed(2)} m/s（小车自报上限）`;
  const mapVersion = state?.active_map_id ?? MISSION.mapVersion;

  const preview = useMemo(
    () =>
      cruisePreview({
        waypoints: plannedCruiseWaypoints(),
        plannedPath: plannedCruisePath(),
        speedMps,
        laps,
      }),
    [laps, speedMps],
  );

  const blocked = cruiseBlockReason({
    canDispatch,
    orderStatus: detail.order.status,
    existing: mission && !["succeeded", "failed", "cancelled"].includes(mission.state) ? mission : null,
    waypointCount: preview.waypointCount,
  });
  const gates = cruiseActionBlock({ mission, canDispatch, canMonitor });

  const run = async (key: string, action: () => Promise<void>) => {
    setSubmitting(key);
    try {
      await action();
    } catch {
      /* 错误由父组件显示（工单页统一一处报错），这里只负责别把按钮卡住 */
    } finally {
      setSubmitting(null);
    }
  };

  const battery = batteryPercent(state);
  const pose = state?.pose ?? null;
  const ageSec = cart.status?.ageMs === null || cart.status?.ageMs === undefined ? null : Math.round(cart.status.ageMs / 1000);

  return (
    <Panel
      className={`${className} cruise-panel`}
      title="自主巡航任务"
      icon="biz-inspection-cart"
      extra={
        <span className="cruise-head">
          <span className="muted">平台侧任务单据（车端执行在建图巡航控制台）</span>
          <StatusChip text={missionStateText(mission?.state ?? null)} tone={missionStateTone(mission?.state ?? null)} />
        </span>
      }>
      <div className="cruise-grid">
        <section className="cruise-col">
          <h4 className="sub">
            小车数据
            <SourceTag label={cart.status ? sourceLabel(state).text : "读取中"} />
          </h4>
          <KV
            columns={2}
            items={[
              {
                k: "链路",
                v: (
                  <span className="cruise-inline">
                    <StatusChip
                      text={cart.status?.live ? "在线" : cart.status?.link === "online" ? "延迟" : cart.status?.configured ? "离线" : "未配置"}
                      tone={cart.status?.live ? "ok" : cart.status?.link === "online" ? "warn" : "danger"}
                    />
                    {ageSec !== null ? <em className="muted">数据延迟 {ageSec}s</em> : null}
                  </span>
                ),
              },
              { k: "车号", v: state?.device_id ?? cart.status?.info.deviceId ?? "—" },
              { k: "位姿", v: pose ? `x ${pose.x.toFixed(2)} · y ${pose.y.toFixed(2)} · yaw ${pose.yaw.toFixed(2)}` : "—" },
              { k: "定位", v: state?.localization ? (state.localization.ready ? `已定位（匹配 ${state.localization.match?.toFixed(2) ?? "—"}）` : "未定位") : "—" },
              { k: "电量", v: battery === null ? voltageText(state) : `${battery}%（${voltageText(state)}）` },
              { k: "相机", v: state?.camera ? `${state.camera.state}${state.camera.fps ? ` · ${state.camera.fps.toFixed(1)} fps` : ""}` : "—" },
              { k: "控制令", v: cart.status?.canControl ? "平台可下发指令" : "只读监视（车上没给控制令牌）" },
              ...(cart.error ? [{ k: "读取", v: cart.error }] : []),
            ]}
          />
        </section>

        <section className="cruise-col">
          <h4 className="sub">巡航任务预览</h4>
          <KV
            columns={2}
            items={[
              { k: "任务编号", v: mission ? <b>{mission.id}</b> : <em className="muted">下发后生成</em> },
              { k: "巡检构件", v: preview.componentIds.length ? preview.componentIds.join(" · ") : "—" },
              { k: "航点数", v: `${preview.waypointCount} 个` },
              { k: "计划里程", v: `${preview.lengthM} m${preview.laps > 1 ? ` × ${preview.laps} 圈 = ${preview.totalLengthM} m` : ""}` },
              { k: "预计时长", v: preview.etaText },
              { k: "速度", v: preview.speedText },
              { k: "目标图", v: mapVersion ?? "—" },
              { k: "机器人", v: mission?.robotId ?? state?.device_id ?? "mumai-car-01" },
            ]}
          />
          <p className="cruise-note">{gridNote()}；预计时长 = 全程里程 ÷ 速度，不写死。</p>
          <label className="cruise-laps">
            <span>巡航圈数</span>
            <select
              className="wo-select"
              value={laps}
              disabled={pending || Boolean(mission && !["succeeded", "failed", "cancelled"].includes(mission.state))}
              onChange={(event) => setLaps(Number(event.target.value))}>
              {[1, 2, 3].map((value) => (
                <option key={value} value={value}>
                  {value} 圈
                </option>
              ))}
            </select>
          </label>
        </section>
      </div>

      {mission ? (
        <p className="cruise-people">
          <b>{mission.id}</b>
          <span>{cruisePeopleLine(mission)}</span>
          <span className="muted">派发 {cruiseTimeText(mission.createdAt)}</span>
          {mission.endedAt ? <span className="muted">结束 {cruiseTimeText(mission.endedAt)}</span> : null}
          {mission.cancelReason ? <span className="muted">原因：{mission.cancelReason}</span> : null}
        </p>
      ) : null}

      <div className="wo-actions">
        <Btn
          tone="primary"
          disabled={pending || blocked !== null}
          title={blocked ?? "按上面的预览下发一条自主巡航任务（服务端生成任务编号）"}
          onClick={() =>
            void run("dispatch", () =>
              onDispatch(
                cruisePayload({
                  orderId: detail.order.id,
                  orderNo: detail.order.orderNo,
                  robotId: state?.device_id ?? null,
                  mapVersion,
                  speedMps,
                  speedProfile,
                  laps,
                }),
              ),
            )
          }>
          {submitting === "dispatch" ? "下发中…" : "下发自主巡航任务"}
        </Btn>
        {mission ? (
          <>
            <Btn
              tone="primary"
              disabled={pending || gates.accept !== null}
              title={gates.accept ?? "我接受这条任务（记下是谁接的、什么时候）"}
              onClick={() => void run("accept", onAccept)}>
              {submitting === "accept" ? "接受中…" : "接受任务"}
            </Btn>
            <Btn
              disabled={pending || gates.complete !== null}
              title={gates.complete ?? "标记为已完成（车端作业回到平台后点这个）"}
              onClick={() => void run("complete", onComplete)}>
              标记完成
            </Btn>
            <Btn
              tone="danger"
              disabled={pending || gates.cancel !== null}
              title={gates.cancel ?? "撤销这条任务（终态不可复活）"}
              onClick={() => void run("cancel", onCancel)}>
              撤销任务
            </Btn>
            {mission.state === "running" ? (
              <Btn tone="primary" onClick={() => navigate(`/mapping?task=${encodeURIComponent(mission.id)}`)}>
                去建图巡航
              </Btn>
            ) : null}
          </>
        ) : null}
        {blocked ? <span className="muted">{blocked}</span> : null}
      </div>

      <h4 className="sub">本单巡航任务</h4>
      <DataTable
        head={["任务编号", "状态", "派发 / 接受", "圈数", "派发时间", "结束时间"]}
        rows={history.map((item) => [
          <b key={`${item.id}-no`}>{item.id}</b>,
          <StatusChip key={`${item.id}-state`} text={missionStateText(item.state)} tone={missionStateTone(item.state)} />,
          cruisePeopleLine(item),
          `${item.laps ?? 1} 圈`,
          cruiseTimeText(item.createdAt),
          cruiseTimeText(item.endedAt),
        ])}
        empty="本单还没有下发过自主巡航任务"
      />
      {history.length === 0 ? (
        <StateBlock
          kind="empty"
          title="下发之后这里会记着：谁派的、谁接的、什么时候结束"
          hint="任务编号由服务端按工单生成，换台电脑打开也是同一个号。"
        />
      ) : null}
      {!canDispatch ? <p className="cruise-note muted">当前账号没有 `mission:dispatch`：能看任务，不能下发与接受。</p> : null}
      {!mission && detail.order.status !== "已归档" ? (
        <p className="cruise-note muted">现场动线：史点「下发自主巡航任务」→ 马在工单页点「接受任务」→「去建图巡航」。</p>
      ) : null}
    </Panel>
  );
}
