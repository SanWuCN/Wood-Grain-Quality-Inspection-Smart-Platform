/**
 * 采集作业（`/hardware?tab=capture`）
 *
 * 从 `adaptTabs.tsx` 的 CaptureTab 拆出来重做。三处按用户要求改了：
 *
 * ① 「启动采集」不再是播个提示。点下去先进入**设备启动检查** ——
 *    逐条确认并签署，全部签完才真的开始采集。
 *    检查项来自 `seed/scenario.ts` 的 `BOOT_CHECKS`，前三项是知识库 SOP 的
 *    硬门槛（电量 / 存储余量 / 时间同步，「三项任一不满足即不开始采集」），
 *    另补传感器响应、通道连通与测区方向。
 *    检查单原本挂在异常排查页做「事后填结论」，拦不住任何东西；搬到这里才成立。
 *
 * ② 右侧留出**采集设备画面**的实时推流位。演示阶段显示最近一帧静态画面并
 *    明确标注「未接入」，接实机时在 `CAPTURE_SCREEN_STREAM.url` 填地址即可
 *    切到真实推流，页面不用改（与 `RvizView` 的串流口径一致）。
 *    不拿静态图冒充实时画面 —— PRD 3.4 对「页面状态不等于传感器状态」有明确要求。
 *
 * ③ 采集配置与接收情况保持原样（那部分已经按 PRD 3.4 做完）。
 */

import { useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { Panel } from "../Panel";
import { Btn, DataTable, Modal, SourceTag, StateBlock, StatusChip, WaveChart } from "../ui";
import { Icon } from "../icons";
import { useMumai } from "../context";
import {
  BOOT_CHECKS,
  CAPTURE_SCREEN_STREAM,
  REFERENCE_BATCHES,
  SCAN_BATCHES,
  WAVEFORMS,
} from "../seed/scenario";
import type { BootCheckItem } from "../seed/types";

/** 采集状态机。三个状态之间只能顺着走，不能跳 */
type CapturePhase = "idle" | "checking" | "running";

const RECEIVE_TONE: Record<string, "ok" | "warn" | "muted"> = {
  完成: "ok",
  部分接收: "warn",
  未开始: "muted",
};

const GROUP_ORDER: BootCheckItem["group"][] = ["设备", "链路", "测区"];

/* ------------------------------------------------------------------ *
 * 设备启动检查
 * ------------------------------------------------------------------ */

/**
 * 逐条确认 + 签署。
 *
 * 每条要显示「对着什么看」（expected）和「不过会怎样」（onFail）：
 * 只给一个「通过」按钮，签了等于没签。
 * 签署人取检查项自带的 owner —— 设备类归硬件工程师（饶），测区类归具身（马），
 * 这跟 PRD 2.1 的角色分工一致，不是让同一个人把所有项都签了。
 *
 * **这份检查单在弹窗里，不在页面上。** 用户的原话是「比如那个启动采集，
 * 需要确认并参数，就可以弹出一个弹窗窗口，来让我确认和签署啊，而不是在平台
 * 一级页面上生成并堆元素，排版就乱了」—— 原来点一下按钮就往页面里挂一整块
 * 检查单，左列被撑高、右列跟着错位。
 */
function BootCheckModal({
  signed,
  onSign,
  onClose,
  onStart,
}: {
  signed: Record<string, string>;
  onSign: (item: BootCheckItem) => void;
  onClose: () => void;
  onStart: () => void;
}) {
  const done = Object.keys(signed).length;
  const allDone = done === BOOT_CHECKS.length;

  return (
    <Modal
      wide
      title="设备启动检查"
      subtitle={`${done}/${BOOT_CHECKS.length} 项已签署 · 全部签署后才能开始采集`}
      onClose={onClose}
      footer={
        <>
          <span className="muted">
            {allDone ? "全部签署完成，可以开始采集" : `还有 ${BOOT_CHECKS.length - done} 项未签署`}
          </span>
          <Btn onClick={onClose}>取消</Btn>
          <Btn tone="primary" disabled={!allDone} onClick={onStart}>
            开始采集
          </Btn>
        </>
      }>
      {GROUP_ORDER.map((group) => (
        <section key={group} className="boot-group">
          <h4 className="sub">{group}</h4>
          <ul className="boot-list">
            {BOOT_CHECKS.filter((item) => item.group === group).map((item) => {
              const signer = signed[item.id];
              return (
                <li key={item.id} className={signer ? "is-done" : ""}>
                  <div className="boot-list__head">
                    <b>{item.label}</b>
                    {signer ? (
                      <StatusChip text={`已签署 ${signer}`} tone="ok" />
                    ) : (
                      <StatusChip text="待确认" tone="warn" />
                    )}
                  </div>
                  <dl className="boot-list__meta">
                    <div>
                      <dt>核对</dt>
                      <dd>{item.expected}</dd>
                    </div>
                    <div>
                      <dt>不通过</dt>
                      <dd>{item.onFail}</dd>
                    </div>
                  </dl>
                  {signer ? null : (
                    <Btn tone="primary" onClick={() => onSign(item)}>
                      确认并签署（{item.owner}）
                    </Btn>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * 采集设备画面（实时推流预留位）
 * ------------------------------------------------------------------ */

/**
 * 采集端屏幕画面。
 *
 * 接实机只改 seed 里的 `CAPTURE_SCREEN_STREAM.url`（+ 必要时 `kind`），
 * 这里会自动从静态画面切到真实串流 —— `mjpeg` 走 img、`webrtc` 走 video，
 * 与 `RvizView` 同一套判断。`url` 为空时明确显示「未接入」，
 * 不把静态图说成实时。
 */
function ScreenPanel({ live }: { live: boolean }) {
  const stream = CAPTURE_SCREEN_STREAM;
  const hasUrl = Boolean(stream.url);

  return (
    <Panel
      title="采集设备画面"
      extra={
        <StatusChip
          text={hasUrl ? (stream.kind === "webrtc" ? "WebRTC 推流" : "MJPEG 推流") : "未接入"}
          tone={hasUrl ? "ok" : "muted"}
          dot
        />
      }
      className="cap-panel cap-panel--screen">
      <div className={`cap-screen${live ? " is-live" : ""}`}>
        {hasUrl ? (
          stream.kind === "webrtc" ? (
            <video className="cap-screen__media" src={stream.url ?? undefined} autoPlay muted playsInline />
          ) : (
            <img className="cap-screen__media" src={stream.url ?? undefined} alt="采集设备屏幕推流" />
          )
        ) : (
          <>
            <span className="cap-screen__placeholder">
              <b>未接收屏幕信号</b>
              <em>上位机屏幕推流未接入，下方为最近一帧静态画面，不作为实时画面使用。</em>
            </span>
            {stream.image ? (
              <img className="cap-screen__media is-still" src={stream.image} alt="采集端屏幕静态参考画面" />
            ) : null}
          </>
        )}
        <span className="cap-screen__tag">{stream.source}</span>
      </div>
      <p className="note">
        {stream.source} · 画面帧率与时间戳随批次记录一并保存。
      </p>
    </Panel>
  );
}

/* ------------------------------------------------------------------ *
 * 页签
 * ------------------------------------------------------------------ */

export function CaptureTab() {
  const { toast, pushEvent } = useMumai();
  /** PRD 2.2：当前批次写在 URL 里，切页签 / 刷新都保留（单一批次来源） */
  const [params, setParams] = useSearchParams();
  const batchId = params.get("batch") ?? SCAN_BATCHES[0]?.batchId ?? "";
  const batch = SCAN_BATCHES.find((item) => item.batchId === batchId) ?? SCAN_BATCHES[0];
  const waveform = WAVEFORMS.find((item) => item.batchId === batchId) ?? WAVEFORMS[0];

  const [phase, setPhase] = useState<CapturePhase>("idle");
  const [signed, setSigned] = useState<Record<string, string>>({});
  /** 启动检查弹窗：清单与签署在二级窗口里，一级页面只留状态 */
  const [checkOpen, setCheckOpen] = useState(false);
  /**
   * 人工标记（PRD §5「人工标记用新笔形图标」/ §8「操作…人工标记入口…可逆页面交互」）。
   *
   * 这是**页面内的可逆操作**：标记只加在这份本地列表里，不写回种子、不发设备指令、
   * 不触发任何运动（PRD §6 第五阶段：「素材测试不触发运动指令」）。
   * 换批次时清空，避免上一批的标记落到下一批的波形上。
   *
   * 这里刻意不改 waveMarkers 的业务结论 —— 种子里的标记是数据，
   * 人工标记是操作痕迹，两者在图上分开着色，不混淆。
   */
  const [manualMarks, setManualMarks] = useState<{ x: number; label: string }[]>([]);

  const selectBatch = (nextBatchId: string) => {
    const next = new URLSearchParams(params);
    next.set("batch", nextBatchId);
    next.set("tab", params.get("tab") ?? "capture");
    setParams(next, { replace: true });
    // 换批次等于换一次作业，检查单必须重签 —— 上一批的签署不能带到下一批
    setPhase("idle");
    setSigned({});
    setCheckOpen(false);
    // 人工标记同样不跨批次携带
    setManualMarks([]);
  };

  const allSigned = Object.keys(signed).length === BOOT_CHECKS.length;

  /**
   * 签署一项。
   *
   * 先把下一份签署算出来再一次性提交：不能在 setSigned 的 updater 里调
   * setPhase / pushEvent / toast —— updater 会在渲染期间执行，在里面改别的组件状态
   * 会报「Cannot update a component while rendering a different component」，
   * 而且 StrictMode 下 updater 会被调用两次，事件会被推两遍。
   *
   * 签完最后一项**不再自动开始**：进入采集是一次正式动作，由弹窗页脚的
   * 「开始采集」按钮触发，签署与开始分开（用户要求重要操作要有人确认）。
   */
  const sign = (item: BootCheckItem) => {
    if (signed[item.id]) return;
    setSigned({ ...signed, [item.id]: item.owner });
  };

  const finishBootCheck = () => {
    if (!allSigned) return;
    setPhase("running");
    pushEvent(
      `设备启动检查 ${BOOT_CHECKS.length} 项全部签署，批次 ${batch?.batchId ?? ""} 开始采集`,
      "ok",
    );
    toast("设备启动检查完成，采集已开始", "ok");
  };

  const receiveRows = (["radar", "image", "result"] as const).map((key) => {
    const item = batch.receive[key];
    const label = key === "radar" ? "雷达原始数据" : key === "image" ? "表面图像" : "结果文件";
    return [
      <b key={`l-${key}`}>{label}</b>,
      `${item.received} / ${item.expected}`,
      <StatusChip key={`s-${key}`} text={item.state} tone={RECEIVE_TONE[item.state] ?? "muted"} />,
    ];
  });

  const phaseText = useMemo(() => {
    if (phase === "running") return { text: "采集中", tone: "ok" as const };
    if (phase === "checking") return { text: "启动检查中", tone: "warn" as const };
    return { text: "待启动", tone: "muted" as const };
  }, [phase]);

  if (!batch) return <StateBlock kind="empty" title="暂无采集批次" />;

  return (
    /*
      两列：左边是「配置 + 启动检查」这条操作链，右边是「设备画面 + 接收情况」
      这条监看链。用户要的是「启动后在右侧空白处看到采集设备画面」，
      所以画面必须落在右上，而不是排到整页最下面 —— 采集时人是一边看画面
      一边核对接收情况的，两件事要在同一屏里。
    */
    <div className="capture">
      <div className="cap-col">
        <Panel
          title="采集配置"
          extra={
            <span className="fw-console__actions">
              <SourceTag label={`批次 ${batch.batchId}`} />
              <StatusChip text={phaseText.text} tone={phaseText.tone} dot />
            </span>
          }
          className="cap-panel">
          <dl className="kv">
            <div>
              <dt>构件 / 测区</dt>
              <dd>
                {batch.componentId} · {batch.zoneId}
              </dd>
            </div>
            <div>
              <dt>轮次</dt>
              <dd>{batch.round}</dd>
            </div>
            <div>
              <dt>配置版本</dt>
              <dd>{batch.configVersion}</dd>
            </div>
            <div>
              <dt>模型版本</dt>
              <dd>{batch.modelVersion}</dd>
            </div>
            <div>
              <dt>原始数据级别</dt>
              <dd>{batch.rawLevel}</dd>
            </div>
            <div>
              <dt>开始时间</dt>
              <dd>{batch.startedAt}</dd>
            </div>
          </dl>

          <label className="field">
            <span>切换批次</span>
            <select value={batchId} onChange={(event) => selectBatch(event.target.value)}>
              {SCAN_BATCHES.map((item) => (
                <option key={item.batchId} value={item.batchId}>
                  {item.batchId} · {item.round} · {item.frozen ? "已冻结" : "正常"}
                </option>
              ))}
            </select>
          </label>

          <div className="adapt-actions">
            <Btn
              tone="primary"
              disabled={phase !== "idle"}
              onClick={() => setCheckOpen(true)}
              title="打开设备启动检查，逐条核对并签署后开始采集">
              {phase === "idle" ? "启动采集" : "已启动"}
            </Btn>
            <Btn
              disabled={phase !== "running"}
              onClick={() => {
                pushEvent(`批次 ${batch.batchId} 已请求暂停采集，等待设备确认`, "warn");
                toast("已请求暂停采集，等待设备确认", "warn");
              }}>
              暂停采集
            </Btn>
          </div>

          {batch.frozen ? (
            <StateBlock
              kind="partial"
              title="该批次已冻结"
              hint={`${batch.freezeReason ?? "等待适用域核验"}。`}
            />
          ) : null}
        </Panel>

        {/*
          设备启动检查在一级页面只留**状态**（签了几项、能不能开始），
          清单本体在弹窗里。原来点一下按钮就往这一列挂一整块检查单，
          左列被撑高、右列跟着错位 —— 用户点名过这个问题。
        */}
        <Panel
          title="设备启动检查"
          extra={
            <StatusChip
              text={
                phase === "idle"
                  ? "未开始"
                  : allSigned
                    ? `已签署 ${BOOT_CHECKS.length}/${BOOT_CHECKS.length}`
                    : `${Object.keys(signed).length}/${BOOT_CHECKS.length} 已签署`
              }
              tone={allSigned ? "ok" : phase === "idle" ? "muted" : "warn"}
              dot
            />
          }
          className="cap-panel">
          {phase === "idle" ? (
            <StateBlock kind="empty" title="尚未开始启动检查" hint="点「启动采集」逐条核对并签署。" />
          ) : (
            <div className="boot-summary">
              <ul>
                {BOOT_CHECKS.map((item) => (
                  <li key={item.id} className={signed[item.id] ? "is-ok" : ""}>
                    <b>{item.label}</b>
                    <span>{signed[item.id] ? `已签署 ${signed[item.id]}` : `待 ${item.owner} 确认`}</span>
                  </li>
                ))}
              </ul>
              {allSigned ? null : (
                <Btn tone="primary" onClick={() => setCheckOpen(true)}>
                  继续签署（{Object.keys(signed).length}/{BOOT_CHECKS.length}）
                </Btn>
              )}
            </div>
          )}
        </Panel>

        {checkOpen ? (
          <BootCheckModal
            signed={signed}
            onSign={sign}
            onClose={() => setCheckOpen(false)}
            onStart={() => {
              setCheckOpen(false);
              finishBootCheck();
            }}
          />
        ) : null}
      </div>

      <div className="cap-col">
        {/* 未启动时也占着位置：让人知道这里到时候会有画面，而不是启动后突然多一块 */}
        {phase === "running" ? (
          <ScreenPanel live />
        ) : (
          <Panel
            title="采集设备画面"
            extra={
              <StatusChip
                text="待采集启动"
                tone="muted"
                dot
              />
            }
            className="cap-panel">
            <div className="cap-screen">
              <span className="cap-screen__placeholder">
                <b>等待采集启动</b>
                <em>启动采集并完成设备启动检查后，这里显示上位机屏幕的实时推流。</em>
              </span>
            </div>
          </Panel>
        )}

        <Panel
          title="接收情况"
          extra={
            /*
              人工标记入口（PRD §5 / §8）。
              这是「可逆页面交互」：标记加在本地列表里，可以逐条撤掉，
              不写回种子、不下发设备指令、不触发运动（PRD §6 第五阶段）。
              纯图标按钮给中文 aria-label（PRD §3.2）。
            */
            <span className="cap-mark">
              {manualMarks.length > 0 ? (
                <em>
                  人工标记 {manualMarks.length} 处
                  <button
                    type="button"
                    className="cap-mark__clear"
                    onClick={() => {
                      setManualMarks([]);
                      toast("已清除本次的人工标记", "info");
                    }}>
                    清除
                  </button>
                </em>
              ) : null}
              <Btn
                tone="ghost"
                disabled={!(waveform?.points?.length ?? 0)}
                onClick={() => {
                  const points = waveform?.points ?? [];
                  if (points.length === 0) return;
                  /*
                    落在当前最强回波上：标记的意义是「我觉得这个频点要看」，
                    所以默认取幅值最大的那个点，而不是随便取中点。
                    同一点重复标记时序号递进，看得出是两次操作。
                  */
                  let peak = 0;
                  points.forEach((point, index) => {
                    if (point.y > points[peak].y) peak = index;
                  });
                  const at = points[peak].x;
                  const existing = manualMarks.filter((mark) => mark.x === at).length;
                  setManualMarks([
                    ...manualMarks,
                    { x: at, label: existing > 0 ? `人工标记 ${existing + 1}` : "人工标记" },
                  ]);
                  pushEvent(
                    `批次 ${batch.batchId} 在频点 ${at.toFixed(4)} 添加人工标记`,
                    "info",
                  );
                  toast("已在该频点添加人工标记", "ok");
                }}
                title="在实时波形上添加人工标记（仅本次页面操作，可清除）">
                <Icon name="biz-manual-mark" size={16} aria-hidden />
                人工标记
              </Btn>
            </span>
          }
          className="cap-panel">
          <DataTable head={["数据类型", "已接收 / 预期", "状态"]} rows={receiveRows} />
          <h4 className="sub">实时波形</h4>
          <WaveChart
            points={waveform?.points ?? []}
            unit={waveform?.unit}
            axisLabel={waveform?.axisLabel}
            /*
              报告里的标记（种子数据）用红色，人工标记用青色分开着色 ——
              两者语义不同，不能让操作痕迹看起来像系统结论。
            */
            markers={[
              ...(waveform?.markers ?? []),
              ...manualMarks.map((mark) => ({ ...mark, tone: "cyan" as const })),
            ]}
          />
        </Panel>

        <Panel title="参考样本批次" className="cap-panel">
          <DataTable
            head={["批次", "分组", "材种来源", "扫描次数", "方向"]}
            rows={REFERENCE_BATCHES.map((item) => [
              item.batchId,
              item.groupId,
              item.material,
              String(item.scans),
              item.direction,
            ])}
          />
        </Panel>
      </div>
    </div>
  );
}

export default CaptureTab;
