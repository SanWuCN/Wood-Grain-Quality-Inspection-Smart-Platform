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
import {
  buildPacket,
  CURRENT_LOG_PACKET_ID,
  DEVICE_LOG_BOOTS,
  LOG_OUTCOMES,
  TRIAGE_EVENTS,
} from "../seed/deviceLogs";
import type {
  AnomalyEvent,
  DeviceLogBoot,
  DeviceLogOutcome,
  DeviceLogPacket,
  DeviceLogSource,
} from "../seed/types";

/** 事件状态 → 语义色 */
const EVENT_TONE: Record<AnomalyEvent["state"], "danger" | "warn" | "ok"> = {
  待处理: "danger",
  处理中: "warn",
  已结案: "ok",
};

/**
 * 结果档位 → 语义色。
 *
 * 「正常」用中性灰而不是绿色：一屏三十行里如果二十七行都亮着绿灯，
 * 剩下三行的问题反而被淹没。绿色只留给真正需要看一眼的那两个档。
 */
const OUTCOME_TONE: Record<DeviceLogOutcome, "ok" | "warn" | "danger" | "muted"> = {
  正常: "muted",
  需留意: "warn",
  异常: "danger",
};

const LOG_SOURCES: DeviceLogSource[] = ["ESP32-S3", "树莓派", "毫米波模块", "传输", "供电"];

/** 时间范围筛选：按日记事，所以「近 N 天」比绝对日期更符合现场口径 */
const TIME_RANGES = [
  { key: "today", label: "当日" },
  { key: "3d", label: "近 3 天" },
  { key: "all", label: "全部" },
] as const;

type TimeRangeKey = (typeof TIME_RANGES)[number]["key"];

/** 检查结果 → 语义色。记录行的 result 是自由文本，按关键词归类 */
function resultTone(result: string): "ok" | "warn" | "danger" | "muted" {
  if (/正常|合格|一致|通过|完成|已排除|已标记/.test(result)) return "ok";
  if (/超限|异常|不适用|失败|不足|不一致|不满足/.test(result)) return "danger";
  if (/部分|待|记录|偏离|观察|延迟/.test(result)) return "warn";
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
 * 日志包内容弹窗
 * ------------------------------------------------------------------ */

/**
 * 一个日志包的完整内容。
 *
 * 这里是「点开日志包才看的东西」，所以放得下筛选与检索：
 * 两三百条输出平铺着翻是没法用的，必须能按来源收窄、能搜关键词、
 * 能一键只看告警以上。默认就停在**只显示问题行**的意图上 ——
 * 打开日志包的人多半是来找问题的，不是来读心跳的。
 */
function LogPacketModal({ packet, onClose }: { packet: DeviceLogPacket; onClose: () => void }) {
  const [source, setSource] = useState<DeviceLogSource | "全部">("全部");
  const [warnOnly, setWarnOnly] = useState(false);
  const [keyword, setKeyword] = useState("");

  const shown = useMemo(() => {
    const needle = keyword.trim().toLowerCase();
    return packet.entries.filter((entry) => {
      if (source !== "全部" && entry.source !== source) return false;
      if (warnOnly && entry.level === "INFO") return false;
      if (needle && !`${entry.text} ${entry.source} ${entry.level}`.toLowerCase().includes(needle)) {
        return false;
      }
      return true;
    });
  }, [packet, source, warnOnly, keyword]);

  /** 每个来源在本包里各有多少条 —— 让「哪一层出问题」一眼可见 */
  const perSource = useMemo(() => {
    const map = new Map<DeviceLogSource, number>();
    for (const entry of packet.entries) map.set(entry.source, (map.get(entry.source) ?? 0) + 1);
    return map;
  }, [packet]);

  return (
    <Modal
      wide
      title={`日志包 ${packet.id}`}
      subtitle={
        <>
          <span>{packet.deviceName}</span>
          <span>·</span>
          <span>启动 {packet.bootAt}</span>
          <StatusChip
            text={packet.endedAs}
            tone={packet.endedAs === "异常结束" ? "warn" : "ok"}
            dot
          />
        </>
      }
      onClose={onClose}
      footer={
        <>
          <span className="muted">
            显示 {shown.length} / {packet.stats.total} 条
          </span>
          <Btn onClick={onClose}>关闭</Btn>
        </>
      }>
      <dl className="kv">
        <div>
          <dt>业务日期</dt>
          <dd>{packet.date}</dd>
        </div>
        <div>
          <dt>固件 / 配置</dt>
          <dd>
            {packet.firmwareVersion} · {packet.configVersion}
          </dd>
        </div>
        <div>
          <dt>关联批次</dt>
          <dd>{packet.batchId ?? "无（未开展采集）"}</dd>
        </div>
        <div>
          <dt>会话时长</dt>
          <dd>{packet.durationMin} 分钟</dd>
        </div>
        <div>
          <dt>日志条数</dt>
          <dd>
            {packet.stats.total} 条（INFO {packet.stats.info} / WARN {packet.stats.warn} / ERROR{" "}
            {packet.stats.error}）
          </dd>
        </div>
        <div>
          <dt>结束原因</dt>
          <dd>{packet.endNote}</dd>
        </div>
      </dl>

      <div className="tri-filter">
        <Btn active={source === "全部"} onClick={() => setSource("全部")}>
          全部 {packet.stats.total}
        </Btn>
        {LOG_SOURCES.map((item) => (
          <Btn key={item} active={source === item} onClick={() => setSource(item)}>
            {item} {perSource.get(item) ?? 0}
          </Btn>
        ))}
        <Btn active={warnOnly} onClick={() => setWarnOnly((value) => !value)}>
          仅告警与错误
        </Btn>
        <label className="devlog-search">
          <input
            type="search"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="搜关键词，如 冻结 / 重传 / 有效比例"
            aria-label="在日志包内检索"
          />
        </label>
      </div>

      {shown.length > 0 ? (
        <ol className="devlog devlog--packet">
          {shown.map((entry) => (
            <li key={entry.id} className={`is-${entry.level.toLowerCase()}`}>
              <time>{entry.at}</time>
              <b className="devlog__level">{entry.level}</b>
              <span className="devlog__source">{entry.source}</span>
              <span className="devlog__text">{entry.text}</span>
            </li>
          ))}
        </ol>
      ) : (
        <StateBlock
          kind="empty"
          title="没有符合当前筛选的日志"
          hint="换一个来源、清掉关键词，或关掉「仅告警与错误」。"
        />
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * 日志包一行
 * ------------------------------------------------------------------ */

/**
 * 一行日志包（列表用**索引**，不碰几百条内容）。
 *
 * 正常行不写「无异常」这种空话，也不挂徽标 —— 一屏三十行里二十七行都标一遍，
 * 「正常」这件事就看不出来了。异常行才把问题摘要摆出来。
 */
function PacketRow({ boot, onOpen }: { boot: DeviceLogBoot; onOpen: () => void }) {
  const isCurrent = boot.id === CURRENT_LOG_PACKET_ID;
  return (
    <li className={`${isCurrent ? "is-current" : ""} is-${boot.outcome}`}>
      <button type="button" onClick={onOpen}>
        <span className="pkt__main">
          <b>
            <span className="pkt__time">{boot.date.slice(5)}</span>
            <span className="pkt__at">{boot.bootAt}</span>
            {boot.deviceName}
            {isCurrent ? <em className="pkt__now">本次</em> : null}
          </b>
          <i>
            会话 {boot.durationMin} 分钟 · {boot.stats.total} 条日志 ·{" "}
            {boot.batchId ?? "未开展采集"} · {boot.endNote}
          </i>
          {/* 只有出过问题的包才把摘要摆出来 */}
          {boot.stats.errorSummary ? (
            <em className="pkt__issue is-error">ERROR {boot.stats.errorSummary}</em>
          ) : boot.stats.warnSummary ? (
            <em className="pkt__issue is-warn">WARN {boot.stats.warnSummary}</em>
          ) : null}
        </span>
        <span className="pkt__meta">
          <StatusChip text={boot.outcome} tone={OUTCOME_TONE[boot.outcome]} dot />
          {boot.stats.warn > 0 ? <em className="pkt__n is-warn">{boot.stats.warn} 告警</em> : null}
          {boot.stats.error > 0 ? <em className="pkt__n is-error">{boot.stats.error} 错误</em> : null}
        </span>
      </button>
    </li>
  );
}

/* ------------------------------------------------------------------ *
 * 页签
 * ------------------------------------------------------------------ */

export function TriageTab() {
  const { toast, pushEvent } = useMumai();
  const [openEventId, setOpenEventId] = useState<string | null>(null);
  const [openPacketId, setOpenPacketId] = useState<string | null>(null);

  /* ---- 设备日志的筛选条件（用户要求：按时间、设备机号、结果档检索） ---- */
  const [deviceId, setDeviceId] = useState<string>("全部");
  const [range, setRange] = useState<TimeRangeKey>("all");
  const [outcome, setOutcome] = useState<DeviceLogOutcome | "全部">("全部");
  const [keyword, setKeyword] = useState("");

  /* 设备与日期就从数据里取，不另立一份名单 —— 加了新设备这里自动多一项 */
  const devices = useMemo(() => {
    const map = new Map<string, string>();
    for (const boot of DEVICE_LOG_BOOTS) map.set(boot.deviceId, boot.deviceName);
    return [...map.entries()].map(([id, name]) => ({ id, name }));
  }, []);

  const dates = useMemo(
    () => [...new Set(DEVICE_LOG_BOOTS.map((boot) => boot.date))].sort((a, b) => b.localeCompare(a)),
    [],
  );

  /**
   * 筛选后的日志包。
   *
   * 关键词这一项搜的是**列表可见的字段**（日期 / 时刻 / 设备 / 批次 / 说明 /
   * 问题摘要），不搜包内几百条 —— 那是包内检索的活（点开后有专门的输入框）。
   * 两级检索各管一段：列表检索用「哪一次启动」定位，包内检索用「哪一条输出」定位。
   */
  const filtered = useMemo(() => {
    const needle = keyword.trim().toLowerCase();
    /* 纯数字形式：让「260908」也能搜到「2026-09-08」（现场习惯只写月日） */
    const digits = needle.replace(/\D/g, "");
    const recent = range === "today" ? dates.slice(0, 1) : range === "3d" ? dates.slice(0, 3) : null;
    return DEVICE_LOG_BOOTS.filter((boot) => {
      if (deviceId !== "全部" && boot.deviceId !== deviceId) return false;
      if (recent && !recent.includes(boot.date)) return false;
      if (outcome !== "全部" && boot.outcome !== outcome) return false;
      if (needle) {
        const hay = `${boot.date} ${boot.bootAt} ${boot.deviceName} ${boot.deviceId} ${boot.batchId ?? ""} ${boot.endNote} ${boot.stats.errorSummary ?? ""} ${boot.stats.warnSummary ?? ""}`;
        const hayLower = hay.toLowerCase();
        const hitText = hayLower.includes(needle);
        const hitDate = digits.length >= 4 && hay.replace(/\D/g, "").includes(digits);
        if (!hitText && !hitDate) return false;
      }
      return true;
    });
  }, [deviceId, range, outcome, keyword, dates]);

  /** 各档位的数量：筛选按钮上直接标出来，不用点进去数 */
  const counts = useMemo(() => {
    const base = DEVICE_LOG_BOOTS.length;
    return {
      total: base,
      正常: DEVICE_LOG_BOOTS.filter((boot) => boot.outcome === "正常").length,
      需留意: DEVICE_LOG_BOOTS.filter((boot) => boot.outcome === "需留意").length,
      异常: DEVICE_LOG_BOOTS.filter((boot) => boot.outcome === "异常").length,
    };
  }, []);

  const openEvent = TRIAGE_EVENTS.find((item) => item.id === openEventId) ?? null;
  /* 内容按需生成：点开哪个包，才算哪个包的两三百条 */
  const openPacket = openPacketId ? buildPacket(openPacketId) : null;

  const pendingCount = TRIAGE_EVENTS.filter((item) => item.state !== "已结案").length;
  const settledCount = TRIAGE_EVENTS.length - pendingCount;

  return (
    <div className="triage">
      <Panel
        title="异常事件"
        extra={
          <span className="muted">
            共 {TRIAGE_EVENTS.length} 条 · 已结案 {settledCount}
            {pendingCount > 0 ? ` · ${pendingCount} 条在跟踪` : ""}
          </span>
        }
        className="tri-panel">
        {/*
          与右侧同一个口径：**只有列表滚**，操作按钮固定在面板底部。
          否则翻到第 15 条事件时「标记待核验」已经滚出视野 ——
          而它恰恰是在看完某条事件之后要点的东西。
        */}
        <div className="evt-list__scroll">
          <ul className="evt-list">
            {TRIAGE_EVENTS.map((event) => (
              <li key={event.id} className={event.state === "已结案" ? "is-settled" : ""}>
                <button type="button" onClick={() => setOpenEventId(event.id)}>
                  <span className="evt-list__main">
                    <b>{event.kind}</b>
                    <i>{event.summary}</i>
                    {/*
                      已结案的要能看见「怎么解决的」—— 结论就长在列表里，
                      否则十几条结案记录点开才知道结果，等于没结。
                    */}
                    {event.conclusion ? <em className="evt-list__conclusion">{event.conclusion}</em> : null}
                  </span>
                  <span className="evt-list__meta">
                    {event.frozenBatch !== "—" ? <em>{event.frozenBatch}</em> : null}
                    <time>{event.at.slice(5)}</time>
                    <StatusChip text={event.state} tone={EVENT_TONE[event.state]} dot />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>

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
          <span className="muted">
            {DEVICE_LOG_BOOTS.length} 个日志包 · 正常 {counts.正常}/需留意 {counts.需留意}/异常 {counts.异常}
          </span>
        }
        className="tri-panel">
        {/*
          筛选：时间 / 设备机号 / 结果档 / 关键词。
          用户要的是「按时间、设备机号、正常或者异常去检索、筛选」，
          所以三组控件都给到，并且**每一档都标出数量** ——
          不用点进去数才知道「有几个异常的」。

          这块**固定在面板顶部不跟着列表滚**（用户明确要求：
          「这个部分不要随着上滑而看不到」）。滚动交给下面的 .pkt-list__scroll。
        */}
        <div className="pkt-filter">
          <div className="pkt-filter__row">
            <span className="pkt-filter__label">时间</span>
            {TIME_RANGES.map((item) => (
              <Btn key={item.key} active={range === item.key} onClick={() => setRange(item.key)}>
                {item.label}
              </Btn>
            ))}
          </div>

          <div className="pkt-filter__row">
            <span className="pkt-filter__label">设备机号</span>
            <Btn active={deviceId === "全部"} onClick={() => setDeviceId("全部")}>
              全部 {DEVICE_LOG_BOOTS.length}
            </Btn>
            {devices.map((item) => (
              <Btn key={item.id} active={deviceId === item.id} onClick={() => setDeviceId(item.id)}>
                {item.name}
              </Btn>
            ))}
          </div>

          <div className="pkt-filter__row">
            <span className="pkt-filter__label">结果</span>
            <Btn active={outcome === "全部"} onClick={() => setOutcome("全部")}>
              全部 {counts.total}
            </Btn>
            {LOG_OUTCOMES.map((item) => (
              <Btn key={item} active={outcome === item} onClick={() => setOutcome(item)}>
                {item} {counts[item]}
              </Btn>
            ))}
            <label className="devlog-search">
              <input
                type="search"
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
                placeholder="搜批次 / 说明 / 问题摘要"
                aria-label="按批次、说明或问题摘要筛选日志包"
              />
            </label>
          </div>
        </div>

        {/*
          每个日志包 = 一次设备启动会话。列表只回答「哪一次启动、多久、多少条、
          什么结果」，完整的两三百条输出点进去看 —— 平铺在一页上既看不出
          是哪一次启动，也没法翻一段连续输出。

          外面这层 .pkt-list__scroll 才是滚动区：只有列表滚，上面的筛选区和
          下面的统计说明都留在原处（否则翻到第 20 个包时已经忘了当前筛的是什么）。
        */}
        <div className="pkt-list__scroll">
          {filtered.length > 0 ? (
            <ul className="pkt-list">
              {filtered.map((boot) => (
                <PacketRow key={boot.id} boot={boot} onOpen={() => setOpenPacketId(boot.id)} />
              ))}
            </ul>
          ) : (
            <StateBlock
              kind="empty"
              title="没有符合条件的日志包"
              hint="换一个时间范围、设备或结果档，或清掉关键词。"
            />
          )}
        </div>

        <p className="note">
          显示 {filtered.length} / {DEVICE_LOG_BOOTS.length} 个日志包，按「设备启动」切包：一次上电会话内的
          输出连续可读，跨会话的因果（例如上一次遗留的存储占用）不会被混进同一条流水账。
          进入包内可按来源收窄、按关键词检索。
        </p>
      </Panel>

      {openEvent ? <EventModal event={openEvent} onClose={() => setOpenEventId(null)} /> : null}
      {openPacket ? <LogPacketModal packet={openPacket} onClose={() => setOpenPacketId(null)} /> : null}
    </div>
  );
}

export default TriageTab;
