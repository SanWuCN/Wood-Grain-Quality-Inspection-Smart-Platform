/**
 * 异常排查（`/hardware?tab=triage`）
 *
 * 由 `adaptTabs.tsx` 拆出来单独成文件。这一页原来的形态是「一块异常事件详情
 * 卡片 + 一张四项检查签名表」，用户要求改成**日志形态**：
 *   · 异常事件按一条条记录，点开弹窗看详情；
 *   · 去掉「四项检查与签名」，换成硬件实际日志输出记录；
 *   · 四项检查本身改造成「设备启动检查」，移到采集作业里（见 CaptureRun.tsx）。
 *
 * 为什么「检查单」要搬走：原四项检查是**事后**在另一页逐项填结论再签名，
 * 但 PRD 3.4 与知识库 SOP 都把它定位成**采集启动前**的门槛
 * （「每次采集前核对…三项任一不满足即不开始采集」）。放在异常排查里，
 * 它既拦不住任何东西，也和异常事件的处理链脱节。搬到采集作业后，
 * 点「启动采集」→ 逐条确认并签署 → 才真的开始采集，检查单才有约束力。
 *
 * 这一页留下两件事，都围绕「事后怎么查」：
 *   ① 异常事件清单：一行一条，点开看设备证据 / 模型证据 / 处置过程；
 *   ② 设备日志：设备侧与链路的实际输出记录，按来源分层。
 *
 * 证据分「设备证据 / 模型证据」是剧本 S12 沈的原话：「设备是否正常有设备证据，
 * 模型是否适用有模型证据。请分别核对，不能把低分直接解释为木柱出了严重病害」。
 */

import { useMemo, useState } from "react";
import { Panel } from "../Panel";
import { Btn, Modal, StateBlock, StatusChip } from "../ui";
import { useMumai } from "../context";
import { ANOMALY_EVENTS, DEVICE_LOGS } from "../seed/scenario";
import type { AnomalyEvent, DeviceLogSource } from "../seed/types";

/** 事件状态 → 语义色 */
const EVENT_TONE: Record<AnomalyEvent["state"], "danger" | "warn" | "ok"> = {
  待处理: "danger",
  处理中: "warn",
  已结案: "ok",
};

const LOG_SOURCES: DeviceLogSource[] = ["ESP32-S3", "树莓派", "毫米波模块", "传输", "供电"];

/** 检查结果 → 语义色。记录行的 result 是自由文本，按关键词归类 */
function resultTone(result: string): "ok" | "warn" | "danger" | "muted" {
  if (/正常|合格|一致|通过/.test(result)) return "ok";
  if (/超限|异常|不适用|失败/.test(result)) return "danger";
  if (/部分|待|记录|偏离/.test(result)) return "warn";
  return "muted";
}

/* ------------------------------------------------------------------ *
 * 异常事件详情弹窗
 * ------------------------------------------------------------------ */

/**
 * 事件详情。
 *
 * 弹窗里刻意把「设备证据」和「模型证据」并列而不是合并成一串 —— 剧本 S12
 * 里沈专门强调过这两类要分开核对，混在一起会让人以为换个账号或重跑一次就能解决。
 * 处置过程单独一段，形成可追溯的处理链。
 */
function EventModal({ event, onClose }: { event: AnomalyEvent; onClose: () => void }) {
  const evidence = ({
    title,
    rows,
    empty,
  }: {
    title: string;
    rows: AnomalyEvent["deviceEvidence"];
    empty: string;
  }) => (
    <section className="evt-modal__section">
      <h4 className="sub">{title}</h4>
      {rows.length > 0 ? (
        <ul className="evt-modal__rows">
          {rows.map((row) => (
            <li key={`${row.at}-${row.text}`}>
              <time>{row.at}</time>
              <span>{row.text}</span>
              <StatusChip text={row.result} tone={resultTone(row.result)} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="note">{empty}</p>
      )}
    </section>
  );

  return (
    <Modal
      wide
      title={event.kind}
      subtitle={
        <>
          <span>{event.id}</span>
          <span>·</span>
          <span>{event.at}</span>
          <StatusChip text={event.state} tone={EVENT_TONE[event.state]} dot />
        </>
      }
      onClose={onClose}
      footer={
        <>
          <span className="muted">负责人 {event.owner}</span>
          <Btn onClick={onClose}>关闭</Btn>
        </>
      }>
      <dl className="kv">
        <div>
          <dt>冻结批次</dt>
          <dd>{event.frozenBatch}</dd>
        </div>
        <div>
          <dt>触发来源</dt>
          <dd>{event.trigger}</dd>
        </div>
        <div>
          <dt>诊断输出</dt>
          <dd>
            <StatusChip
              text={event.outputsFrozen ? "已冻结" : "正常"}
              tone={event.outputsFrozen ? "warn" : "ok"}
            />
          </dd>
        </div>
        <div>
          <dt>结论</dt>
          <dd>{event.conclusion ?? "尚未结案"}</dd>
        </div>
      </dl>

      <p className="note">{event.detail}</p>

      {evidence({
        title: "设备证据",
        rows: event.deviceEvidence,
        empty: "本事件没有设备侧证据 —— 设备是否正常尚未排除。",
      })}
      {evidence({
        title: "模型证据",
        rows: event.modelEvidence,
        empty: "本事件不涉及模型适用性判断。",
      })}

      <section className="evt-modal__section">
        <h4 className="sub">处置过程</h4>
        <ol className="evt-modal__handling">
          {event.handling.map((step) => (
            <li key={`${step.at}-${step.owner}`}>
              <time>{step.at}</time>
              <b>{step.owner}</b>
              <span>{step.text}</span>
            </li>
          ))}
        </ol>
      </section>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * 页签
 * ------------------------------------------------------------------ */

export function TriageTab() {
  const { toast, pushEvent } = useMumai();
  const [openId, setOpenId] = useState<string | null>(null);
  const [source, setSource] = useState<DeviceLogSource | "全部">("全部");
  /** 只看告警以上：默认关掉，排查时打开能立刻收窄到要看的那几条 */
  const [warnOnly, setWarnOnly] = useState(false);

  const open = ANOMALY_EVENTS.find((item) => item.id === openId) ?? null;

  const pendingCount = ANOMALY_EVENTS.filter((item) => item.state !== "已结案").length;

  const logs = useMemo(
    () =>
      DEVICE_LOGS.filter((log) => (source === "全部" ? true : log.source === source)).filter(
        (log) => (warnOnly ? log.level !== "INFO" : true),
      ),
    [source, warnOnly],
  );

  const counts = useMemo(() => {
    const warn = DEVICE_LOGS.filter((log) => log.level === "WARN").length;
    const error = DEVICE_LOGS.filter((log) => log.level === "ERROR").length;
    return { warn, error };
  }, []);

  return (
    <div className="triage">
      <Panel
        title="异常事件"
        extra={
          <span className="muted">
            共 {ANOMALY_EVENTS.length} 条
            {pendingCount > 0 ? ` · ${pendingCount} 条未结案` : ""}
          </span>
        }
        className="tri-panel">
        <ul className="evt-list">
          {ANOMALY_EVENTS.map((event) => (
            <li key={event.id}>
              <button type="button" onClick={() => setOpenId(event.id)}>
                <span className="evt-list__main">
                  <b>{event.kind}</b>
                  <i>{event.summary}</i>
                </span>
                <span className="evt-list__meta">
                  {event.frozenBatch !== "—" ? <em>{event.frozenBatch}</em> : null}
                  <time>{event.at.slice(11)}</time>
                  <StatusChip text={event.state} tone={EVENT_TONE[event.state]} dot />
                </span>
              </button>
            </li>
          ))}
        </ul>

        <div className="adapt-actions">
          <Btn
            tone="danger"
            onClick={() => {
              pushEvent("适用域待核验：冻结该批诊断输出", "danger");
              toast("已在该批次上标记待核验，诊断输出冻结", "warn");
            }}>
            标记待核验
          </Btn>
          <Btn
            onClick={() => {
              pushEvent("适用域核验通过，恢复诊断输出", "ok");
              toast("已恢复诊断输出", "ok");
            }}>
            核验通过并恢复
          </Btn>
        </div>
      </Panel>

      <Panel
        title="设备日志"
        extra={
          <span className="fw-console__actions">
            {counts.error > 0 ? <StatusChip text={`${counts.error} 错误`} tone="danger" dot /> : null}
            {counts.warn > 0 ? <StatusChip text={`${counts.warn} 告警`} tone="warn" dot /> : null}
          </span>
        }
        className="tri-panel">
        {/*
          来源筛选与「仅告警」原来放在面板体里占掉一整行，现在收进标题栏 ——
          一级页面只留状态与操作，筛选属于就地控件，不该单独占一层。
        */}
        <div className="tri-filter">
          <Btn active={source === "全部"} onClick={() => setSource("全部")}>
            全部
          </Btn>
          {LOG_SOURCES.map((item) => (
            <Btn key={item} active={source === item} onClick={() => setSource(item)}>
              {item}
            </Btn>
          ))}
          <Btn active={warnOnly} onClick={() => setWarnOnly((value) => !value)}>
            仅告警
          </Btn>
          <span className="muted">
            {logs.length}/{DEVICE_LOGS.length}
          </span>
        </div>

        {logs.length > 0 ? (
          <ol className="devlog">
            {logs.map((log) => (
              <li key={log.id} className={`is-${log.level.toLowerCase()}`}>
                <time>{log.at}</time>
                <b className="devlog__level">{log.level}</b>
                <span className="devlog__source">{log.source}</span>
                <span className="devlog__text">{log.text}</span>
              </li>
            ))}
          </ol>
        ) : (
          <StateBlock kind="empty" title="该来源暂无日志" hint="换一个来源或关闭「仅告警」。" />
        )}
      </Panel>

      {open ? <EventModal event={open} onClose={() => setOpenId(null)} /> : null}
    </div>
  );
}

export default TriageTab;
