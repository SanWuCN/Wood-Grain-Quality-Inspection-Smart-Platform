/**
 * 建图巡检（`/mapping`）
 *
 * PRD 3.2：
 *   - 主视图是可缩放平移的占据栅格地图，叠加小车、轨迹、巡检点、四柱和禁入区
 *   - 旁侧以视频和通信状态辅助判断，不做一屏全是仪表盘
 *   - 工具栏：地图保存、版本选择、路线预览、任务下发、暂停与取消
 *   - 先选地图版本与点位序列 → 预览 → 下发 → 收到机器人确认才进入执行中
 *   - 平台计划路径与机器人实际路径**分开着色**
 *   - 通信状态分别显示地图 / 位姿 / 视频 / 车辆更新时间，任一路断流只影响该通道
 */

import { useCallback, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { useMumai } from "../context";
import { permissionHint } from "../auth";
import { Panel } from "../Panel";
import { Btn, Modal, PermNote, SourceTag, StateBlock, StatusChip, Toolbar } from "../ui";
import { Icon } from "../icons";
import RvizView from "./RvizView";
import {
  DEVICES,
  FORBIDDEN_ZONES,
  MAP_VERSIONS,
  WAYPOINTS,
} from "../seed/scenario";
import { CHINA_SITES, SHANGHAI_SITES, waypointsForSite, siteRegion } from "../seed/sites";
import { isApiError } from "../api/client";
import { currentMission, isOnline, mapVersions, useSharedStore } from "../store/shared";

/**
 * 服务端任务状态 → 本页沿用的中文状态词。
 *
 * 服务端用 PRD §7 的英文状态机（queued/running/paused/succeeded/failed/cancelled），
 * 本页地图渲染与既有文案按中文状态读，映射集中在这一处，
 * 不让两套词在页面里各判各的。
 */
const SHARED_TO_LOCAL_STATE: Record<string, string> = {
  queued: "等待机器人确认",
  running: "执行中",
  paused: "已暂停",
  succeeded: "已完成",
  failed: "已完成",
  cancelled: "已取消",
};

/**
 * RViz 画面配置。
 *
 * 当前：直接使用 `public/rviz-reference.png` —— 那正是实际 RViz 的界面截图，
 * 用于演示阶段"建图画面就是 RViz"的观感。
 *
 * 后续接实机时，把下面的 image 换成空、把 url 换成后端串流地址即可，
 * 页面其它部分不用改（这是「预留串流接口」的落点）：
 *   { image: "", url: "http://<host>:8080/stream?topic=/map", kind: "mjpeg", source: "rosbridge" }
 */
const RVIZ_STREAM = {
  /** 静态参考画面（实际 RViz 截图） */
  image: "rviz-reference.png",
  /** 真实串流地址，留空则用上面的静态画面 */
  url: "",
  kind: "mjpeg" as const,
  source: "后端 /api/rviz/stream 占位（接实机后替换 url）",
};

/** 栅格编码 → 类名（用于禁入区与参数的文案展示） */
const CELL_HINT = "10 cm / 格";

export default function Mapping() {
  const { mission, channels, toast, pushEvent, deviceSource, setDeviceSource, can } = useMumai();
  /** 执行步骤弹窗：完整时间线在二级，一级页面只留当前这一步 */
  const [stepsOpen, setStepsOpen] = useState(false);
  const [versionId, setVersionId] = useState(MAP_VERSIONS[0]?.id ?? "");
  const [compare, setCompare] = useState(true);
  const [showLaser, setShowLaser] = useState(true);

  /* ---- 任务与地图都改成走共享服务（评审 F03） ---- */

  const online = useSharedStore(isOnline);
  const sharedMission = useSharedStore(currentMission);
  const mapVersionList = useSharedStore(mapVersions);
  const [missionBusy, setMissionBusy] = useState<string | null>(null);
  const [savingMap, setSavingMap] = useState(false);

  /**
   * 任务状态以服务端为准，**没有服务端任务时就是「未下发」，不回退到种子里那条**。
   *
   * 原来「任务下发」是先改本地状态、再挂一个 1.5 秒的 setTimeout 推到执行中；
   * 在这个窗口里点「取消」，本地状态会被延迟回调覆盖回执行中（评审 F03）。
   * 现在延迟推进交给服务端的状态机：取消是终态，之后任何迁移都会被 409 拒掉。
   *
   * 回退到种子会造成一个很隐蔽的假象：种子里 `MISSION.state` 是「执行中」，
   * 于是没有共享任务时页面显示任务在跑、「任务下发」被禁用、「取消」点了没反应 ——
   * 反馈和真实状态完全脱节。宁可显示「未下发」。
   */
  const missionState = sharedMission ? (SHARED_TO_LOCAL_STATE[sharedMission.data.state] ?? "草稿") : "未下发";
  const isRunning = missionState === "执行中";
  const isTerminal = ["已完成", "已取消"].includes(missionState);

  const missionEntityId = sharedMission?.id ?? null;

  const missionAction = useCallback(
    async (action: string, eventText: string) => {
      if (!missionEntityId) {
        toast("还没有下发过任务", "danger");
        return;
      }
      setMissionBusy(action);
      try {
        const result = await useSharedStore.getState().send({
          action,
          entityId: missionEntityId,
          // 带上 revision：另一端同时改过就返回 409，让操作员刷新而不是盲目覆盖
          expectedRevision: sharedMission?.revision ?? null,
          payload: action === "mission.cancel" ? { reason: "操作员取消" } : {},
        });
        const next = (result.entity.data as { state?: string }).state ?? "";
        pushEvent(`${eventText}：${SHARED_TO_LOCAL_STATE[next] ?? next}`, action === "mission.cancel" ? "danger" : "warn");
        toast(`${eventText}已保存到共享会话`, "ok");
      } catch (error) {
        const message = isApiError(error) ? error.message : "任务操作失败";
        toast(message, "danger");
        // 409/422 说明本地看到的状态已经过期，立刻重拉对齐
        void useSharedStore.getState().refresh();
      } finally {
        setMissionBusy(null);
      }
    },
    [missionEntityId, pushEvent, sharedMission?.revision, toast],
  );

  const dispatchMission = useCallback(async () => {
    setMissionBusy("mission.create");
    try {
      const created = await useSharedStore.getState().send({
        action: "mission.create",
        payload: { mapVersion: mapVersionList[0]?.id ?? versionId },
      });
      const missionId = String(created.result.missionId ?? "");
      pushEvent(`巡检任务 ${missionId} 已下发，等待机器人确认`, "info");
      toast(`任务 ${missionId} 已下发，等待机器人确认`, "info");
      // 车端 ack：实机控制必须收到 ack 才进入执行中（PRD §9.1），演示回放由适配器回一个
      window.setTimeout(() => {
        void useSharedStore
          .getState()
          .send({ action: "mission.ack", entityId: missionId })
          .then(() => pushEvent("机器人已接收任务，进入执行中", "ok"))
          .catch(() => {
            /* 期间被取消：服务端已拒，控制台不必再报一次 */
          });
      }, 1500);
    } catch (error) {
      toast(isApiError(error) ? error.message : "任务下发失败", "danger");
    } finally {
      setMissionBusy(null);
    }
  }, [mapVersionList, pushEvent, toast, versionId]);

  const version = useMemo(
    () => MAP_VERSIONS.find((item) => item.id === versionId) ?? MAP_VERSIONS[0],
    [versionId],
  );

  /**
   * 保存地图只生成 MapVersion，**不碰任务状态**。
   * 评审 F03 原文：「保存地图还会把任务改成已完成」。
   */
  const saveMap = useCallback(async () => {
    setSavingMap(true);
    try {
      const result = await useSharedStore.getState().send({
        action: "map.save",
        payload: {
          label: version.label,
          resolutionM: version.resolutionM,
          coveragePct: version.coveragePct,
          sizeText: version.sizeText,
        },
      });
      pushEvent(`地图版本 ${String(result.result.mapVersionId)} 已保存（巡检任务状态不变）`, "ok");
      toast("地图版本已保存，巡检任务状态不受影响", "ok");
    } catch (error) {
      toast(isApiError(error) ? error.message : "保存地图失败", "danger");
    } finally {
      setSavingMap(false);
    }
  }, [pushEvent, toast, version.coveragePct, version.label, version.resolutionM, version.sizeText]);

  /**
   * `?site=` —— 从地图点位点进来时定位到这一轮要看的航点。
   *
   * 地图上的「有任务的点位」（如示例寺）点击后跳到 `/mapping?site=sh`，
   * 但本页原先完全没读这个参数，跳过来和直接打开没有区别 ——
   * 用户看不到「我点的是哪个点位、它的航点在哪」。
   *
   * 两种地图态（全国 / 上海）里同 id 的点位是两条记录，所以要合并查找。
   */
  const [params, setParams] = useSearchParams();
  const siteId = params.get("site");

  const site = useMemo(() => {
    if (!siteId) return null;
    return [...CHINA_SITES, ...SHANGHAI_SITES].find((item) => item.id === siteId) ?? null;
  }, [siteId]);

  /** 该点位这一轮的构件观察点；没有任务时是空数组，不编数据顶上 */
  const highlighted = useMemo(() => (site ? waypointsForSite(site) : []), [site]);
  const highlightedIds = useMemo(() => new Set(highlighted.map((item) => item.id)), [highlighted]);

  const clearSite = () => {
    const next = new URLSearchParams(params);
    next.delete("site");
    setParams(next, { replace: true });
  };

  const robot = useMemo(() => WAYPOINTS.find((item) => item.state === "当前目标"), []);
  const videoChannel = channels.find((item) => item.key === "video");

  return (
    <div className="page page--mapping">
      <Toolbar
        note={
          <>
            <SourceTag
              label={deviceSource === "demo" ? "智能巡检车 · 回放" : "算力服务器 · 实时"}
            />
            <span>
              地图版本 {version?.label ?? "—"} · 分辨率 {version?.resolutionM ?? "—"} m ·{" "}
              {CELL_HINT}
            </span>
          </>
        }>
        <label className="field">
          <span>地图版本</span>
          <select value={versionId} onChange={(event) => setVersionId(event.target.value)}>
            {MAP_VERSIONS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label} · {item.state}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>数据来源</span>
          <select
            value={deviceSource}
            onChange={(event) => {
              // PRD 3.2：切换来源只能在任务停止后进行
              if (isRunning) {
                toast("任务执行中不允许切换数据来源，请先暂停", "danger");
                return;
              }
              setDeviceSource(event.target.value as "demo" | "real");
              pushEvent(
                `数据来源切换为 ${event.target.value === "demo" ? "智能巡检车" : "算力服务器"}`,
                "warn",
              );
            }}>
            <option value="demo">智能巡检车（回放）</option>
            <option value="real">算力服务器（只读监视）</option>
          </select>
        </label>
        <Btn
          active={compare}
          onClick={() => setCompare((value) => !value)}>
          {compare ? "隐藏实际路径" : "叠加实际路径"}
        </Btn>
        <Btn active={showLaser} onClick={() => setShowLaser((value) => !value)}>
          {showLaser ? "隐藏激光点" : "显示激光点"}
        </Btn>
        <Btn
          disabled={!online || !can("map:save") || savingMap}
          title={
            !can("map:save")
              ? permissionHint("map:save")
              : !online
                ? "连接不上共享服务，地图版本无法保存"
                : "检查无误后保存地图版本（只生成地图版本，不改变巡检任务状态）"
          }
          onClick={() => void saveMap()}>
          {savingMap ? "保存中…" : "保存地图"}
        </Btn>
        <Btn onClick={() => { toast("路线预览已生成", "info"); }}>
          路线预览
        </Btn>
        {/* PRD 2.1 / S11：任务下发与监视由具身智能工程师与架构师负责 */}
        <Btn
          tone="primary"
          disabled={!online || !can("mission:dispatch") || missionBusy !== null || isRunning}
          title={
            !can("mission:dispatch")
              ? permissionHint("mission:dispatch")
              : !online
                ? "连接不上共享服务，任务无法下发"
                : "下发巡检任务，等待机器人确认"
          }
          onClick={() => void dispatchMission()}>
          {missionBusy === "mission.create" ? "下发中…" : "任务下发"}
        </Btn>
        <Btn
          disabled={!online || !can("mission:monitor") || missionBusy !== null || missionState !== "执行中"}
          title={
            !can("mission:monitor")
              ? permissionHint("mission:monitor")
              : missionState !== "执行中"
                ? "只有执行中的任务可以暂停"
                : "暂停任务"
          }
          onClick={() => void missionAction("mission.pause", "巡检任务暂停")}>
          {missionBusy === "mission.pause" ? "暂停中…" : "暂停"}
        </Btn>
        <Btn
          tone="danger"
          disabled={!online || !can("mission:monitor") || missionBusy !== null || isTerminal}
          title={
            !can("mission:monitor")
              ? permissionHint("mission:monitor")
              : isTerminal
                ? `任务已是终态 ${missionState}，不能再次取消`
                : "取消任务并记录反馈"
          }
          onClick={() => void missionAction("mission.cancel", "巡检任务取消")}>
          {missionBusy === "mission.cancel" ? "取消中…" : "取消"}
        </Btn>
        <PermNote permissions={["mission:dispatch"]} />
      </Toolbar>

      <div className="map-layout">
        <Panel
          title="建图视图"
          extra={
            <>
              <StatusChip text={version?.state ?? "—"} tone="info" />
              <span className="muted">更新 {version?.updatedAt ?? "—"}</span>
            </>
          }
          className="map-view">
          {/*
            来自地图点位的上下文条。放在图上方而不是列表里 ——
            用户是从地图点进来的，「我现在看的是哪个点位」要在第一眼的位置。
            没有 `?site=` 时不占位置。
          */}
          {site ? (
            <div className="map-site">
              {/*
                PRD §3.3：「真地图定位保留 pin」。这里是地图上的点位标识，
                属于真实定位语义，不是人工标记（人工标记走 biz-manual-mark）。
              */}
              <Icon name="pin" size={16} aria-hidden />
              <b>{site.name}</b>
              <span className="map-site__region">{siteRegion(site)}</span>
              {highlighted.length > 0 ? (
                <span className="map-site__hint">
                  本轮 {highlighted.length} 个构件观察点已标出：
                  {highlighted.map((item) => item.id).join(" / ")}
                </span>
              ) : (
                <span className="map-site__hint">该点位没有本轮巡检航点</span>
              )}
              <button type="button" className="map-site__clear" onClick={clearSite}>
                清除
              </button>
            </div>
          ) : null}
          <RvizView
            stream={RVIZ_STREAM}
            showActualPath={compare}
            showLaser={showLaser}
            highlightIds={[...highlightedIds]}
          />
        </Panel>

        <div className="map-side">
          <Panel
            title="现场视频"
            extra={
              <StatusChip
                text={videoChannel?.state === "online" ? "在线" : "延迟"}
                tone={videoChannel?.state === "online" ? "ok" : "warn"}
              />
            }>
            <div className="video-slot">
              <strong>摄像头画面占位</strong>
              <em>
                更新于 {videoChannel?.updatedAt ?? "—"}；视频在播放不等于车辆在线，四路通道独立判断
              </em>
            </div>
          </Panel>

          <Panel title="通信状态">
            <ul className="channel-list">
              {channels.map((channel) => (
                <li key={channel.key} className={`is-${channel.state}`}>
                  <b>{channel.label}</b>
                  <StatusChip
                    text={
                      channel.state === "online" ? "正常" : channel.state === "stale" ? "延迟" : "断开"
                    }
                    tone={
                      channel.state === "online" ? "ok" : channel.state === "stale" ? "warn" : "danger"
                    }
                  />
                  <em>{channel.updatedAt}</em>
                  <span>{channel.source}</span>
                </li>
              ))}
            </ul>
          </Panel>

          <Panel
            title="巡检任务"
            extra={<StatusChip text={missionState} tone={isRunning ? "ok" : "warn"} />}>
            <dl className="mission">
              <div>
                <dt>任务编号</dt>
                <dd>{mission.id}</dd>
              </div>
              <div>
                <dt>地图版本</dt>
                <dd>{mission.mapVersion}</dd>
              </div>
              <div>
                <dt>速度档位</dt>
                <dd>{mission.speedProfile}</dd>
              </div>
              <div>
                <dt>设备</dt>
                <dd>{DEVICES.demoCart.name}</dd>
              </div>
              <div>
                <dt>当前目标</dt>
                <dd>{robot ? `${robot.id} · ${robot.label}` : "—"}</dd>
              </div>
              <div>
                <dt>禁入区</dt>
                <dd>{FORBIDDEN_ZONES.length} 处</dd>
              </div>
            </dl>

            <h4 className="sub">
              点位序列
              {highlighted.length > 0 ? (
                <span className="muted">{site?.name} · {highlighted.length} 个</span>
              ) : null}
            </h4>
            <ol className="waypoint-list">
              {WAYPOINTS.map((point) => {
                const isHighlighted = highlightedIds.has(point.id);
                return (
                  <li
                    key={point.id}
                    className={`is-${point.state === "当前目标" ? "current" : point.state === "已到达" ? "done" : "todo"}${isHighlighted ? " is-highlighted" : ""}`}>
                    <b>{point.id}</b>
                    <span>{point.label}</span>
                    <em>{isHighlighted ? "本次点位" : point.state}</em>
                  </li>
                );
              })}
            </ol>

            {/*
              执行步骤是任务的事件日志 —— 与工单页的操作记录同类，
              按「历史记录统一下沉」进弹窗。一级页面只留**当前这一步**，
              执行到哪、谁在等谁，一眼能看到；完整时间线一次点击。
            */}
            <h4 className="sub">
              执行步骤
              <span className="muted">
                {mission.steps.length} 步
                <button type="button" className="map-steps__open" onClick={() => setStepsOpen(true)}>
                  查看全部
                </button>
              </span>
            </h4>
            {mission.steps.length ? (
              <ol className="mission-steps mission-steps--latest">
                {mission.steps.slice(-1).map((step) => (
                  <li className="is-running" key={step.at + step.label}>
                    <i />
                    <b>{step.label}</b>
                    <time>{step.at}</time>
                    <span>
                      {step.actor} · {step.result}
                    </span>
                  </li>
                ))}
              </ol>
            ) : null}

            {mission.state === "等待机器人确认" ? (
              <StateBlock
                kind="loading"
                title="等待机器人确认"
                hint="收到机器人确认后才进入执行中；未接入实机时显示为等待操作员确认。"
              />
            ) : null}

            {mission.anomalies.length ? (
              <ul className="mission-anomalies">
                {mission.anomalies.map((item) => (
                  <li key={item.at}>
                    <time>{item.at}</time>
                    {item.text}
                  </li>
                ))}
              </ul>
            ) : null}

            <div className="mission-takeover">
              <small>接管记录（{mission.takeover.length} 次）</small>
              <button type="button" className="map-steps__open" onClick={() => setStepsOpen(true)}>
                查看
              </button>
            </div>

          </Panel>
        </div>
      </div>

      {/*
        任务时间线弹窗：完整执行步骤 + 异常 + 接管记录。
        这三样都是**历史**，一级页面只留「当前执行到哪一步」与「接管过几次」。
      */}
      {stepsOpen ? (
        <Modal
          wide
          title="任务执行步骤"
          subtitle={`${mission.id} · ${mission.steps.length} 步 · 接管 ${mission.takeover.length} 次`}
          onClose={() => setStepsOpen(false)}
          footer={
            <Btn tone="primary" onClick={() => setStepsOpen(false)}>
              关闭
            </Btn>
          }>
          <ol className="mission-steps">
            {mission.steps.map((step, index) => (
              <li
                key={step.at + step.label}
                className={`is-${index === mission.steps.length - 1 ? "running" : "done"}`}>
                <i />
                <b>{step.label}</b>
                <time>{step.at}</time>
                <span>
                  {step.actor} · {step.result}
                </span>
              </li>
            ))}
          </ol>

          {mission.anomalies.length ? (
            <>
              <h4 className="sub">异常</h4>
              <ul className="mission-anomalies">
                {mission.anomalies.map((item) => (
                  <li key={item.at}>
                    <time>{item.at}</time>
                    {item.text}
                  </li>
                ))}
              </ul>
            </>
          ) : null}

          {mission.takeover.length ? (
            <>
              <h4 className="sub">接管记录</h4>
              <ul className="mission-anomalies">
                {mission.takeover.map((item) => (
                  <li key={item.at}>
                    <time>{item.at}</time>
                    {item.operator}：{item.reason}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </Modal>
      ) : null}
    </div>
  );
}

