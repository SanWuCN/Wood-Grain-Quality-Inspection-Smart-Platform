/**
 * 任务总览（`/`）
 *
 * 地图铺满内容区，四块看板浮在它上面（对齐 docs/design/*.png），靠半透明底 +
 * 折角边框让地图从下方透出来：
 *   左上 巡检态势        覆盖省份 / 古建点位 / 完成巡检 / 完成率 + 四态分布
 *   左下 设备状态        三台设备的数据来源 + 四路数据通道的连接状态
 *   右上 风险与工单      三档计数 + 工单列表 + 当前工单卡
 *   右下 待办与最近事件  待办 + 最近事件 + 历史风险统计
 * 面板位置 / 高度全部由 pages.css 的 `.ov__side` / `.ov > .ov__side > .ov__panel`
 * 决定 —— 那两个选择器的理由写在 CSS 注释里，改动前先读。
 *
 * ⛔ 不要再往总览页加「四柱构件状态」看板。Z01–Z04 是比赛当天到现场才见到的
 * 场地，在总览页展示它们的采集状态等于自认数据是编的。这块已经删过一次，
 * 与之配套的 `.ov-components` 样式也已一并清掉，不要再加回来。
 *
 * 统计一律从 `seed/sites.ts`、`seed/scenario.ts` 现算，页面不硬编码业务数字；
 * 未检测用 `null` 表达「未采集」，不用 0 冒充「无风险」。
 *
 * 信息密度（规范 §3.3 + §4.3 + §10 P1「减少首页字段，采用渐进披露」）
 * ------------------------------------------------------------------
 * 每块 Panel 只保留三层：①当前对象/任务 ②核心状态 ③关键辅助数据；
 * 详细字段走「首页摘要 → 展开 → 查看工单 → 证据/历史」的渐进披露，
 * 展开一律用面板内 `useState` 就地展开（演示场景不用弹窗）。具体口径：
 *   - 风险与工单：工单表负责「列表 + 选中」，卡片只留表里没有的
 *     问题类型 / 构件 / 得分一行摘要，点位、区县、发现时间收进「详情」；
 *   - 待办与事件：待办、事件各默认 3 条，其余「更多」。
 * 一行里「数字 + 它的文字标签」放在同一个元素内（如 `<b>0.87<i>疑似受潮</i></b>`），
 * 靠字号/颜色/留白分层而不是再加一层标签元素（§4.3），也不画独立边框卡片。
 * 地图是视觉主角（§0）：面板只留摘要行，不再用字段平铺和它抢注意力。
 */

import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import styled from "styled-components";
import { useDashboardStore, requestMapMode } from "../map/store";
import Map from "../mapDemo";
import { Panel } from "../Panel";
import { Icon } from "../icons";
import { StatusChip } from "../ui";
import { useMumai } from "../context";
import { STATUS_ACTION, STATUS_COLOR, STATUS_TEXT } from "../map/status";
import SiteDetailCard from "../map/SiteDetailCard";
import {
  CHINA_PROVINCE_COUNT,
  CHINA_SITES,
  SHANGHAI_SITES,
  statusesOf,
  summariseSites,
} from "../seed/sites";
import {

  CURRENT_RISKS,
  DEVICES,
  HISTORIC_ORDERS,
  HISTORY_STATS,
  MISSION,
  RECENT_EVENTS,

  TODO_ITEMS,
  WORK_ORDER,
} from "../seed/scenario";
import {
  DEMO_GEO_POSITION,
  EVENT_PREVIEW_ITEMS,
  ORDER_COUNTERS,
  ORDER_LEVEL_TONE,
  ORDER_PREVIEW_ROWS,
  ORDER_STATUS_TONE,
  OVERVIEW_SLOGAN,
  TODO_PREVIEW_ITEMS,
} from "./overview.constants";

/** 首页工单列表：本轮工单 + 历史工单，共 6 条（设计稿「工单列表」） */
const OVERVIEW_ORDERS = [WORK_ORDER, ...HISTORIC_ORDERS];

/**
 * 图例里的计数。`pages.css` 已有 `.ov__actions .legend i`（色点）的样式，
 * 这里只补「状态名 + 数量」的排版 —— 不新增全局 CSS 文件，
 * 避免与并行任务改动的 `pages.css` / `tokens.css` 冲突。
 */
const Legend = styled.div`
  span b {
    font-family: var(--font-data);
    font-weight: 600;
    color: var(--text-primary);
  }
`;

/** 地图通道版本号：以任务实际下发的地图版本为准，不用 MAP_VERSIONS[0] */
const MISSION_MAP_VERSION = MISSION.mapVersion;

/* ------------------------------------------------------------------ *
 * 渐进披露：面板内「更多 / 收起」开关（§3.3，不用弹窗）
 * ------------------------------------------------------------------ */

function MoreButton({
  open,
  moreText,
  onClick,
}: {
  open: boolean;
  /** 收起态按钮文案，写清「还有多少」比只写「更多」更好判断 */
  moreText: string;
  onClick: () => void;
}) {
  return (
    <button type="button" className="ov-more" aria-expanded={open} onClick={onClick}>
      {open ? "收起" : moreText}
    </button>
  );
}

/* ------------------------------------------------------------------ *
 * 左栏 · 面板一：场地概览（阶段 / 本轮工单 + 三通道）
 * ------------------------------------------------------------------ */

/** 三角色通道一行（PRD 3.1：地图 / 场景 / 手持采集三个通道） */
/**
 * 全国巡检态势
 *
 * 首页左栏第一块，回答「这轮覆盖了多少地方、做到哪一步」。
 * 数字全部由 seed/sites 现算，不写死。
 */
function SituationPanel() {
  const summary = useMemo(() => summariseSites(CHINA_SITES), []);
  const done = summary.byStatus.inspected + summary.byStatus.workorder;
  const rate = Math.round((done / Math.max(1, summary.total)) * 100);

  const order = ["inspected", "workorder", "risk", "collected"] as const;

  return (
    <Panel
      title="巡检态势"
      extra={<span className="muted">全国 {CHINA_PROVINCE_COUNT} 个省级区域</span>}
      className="ov__panel">
      <div className="ov-tally">
        <div>
          <strong>{CHINA_PROVINCE_COUNT}</strong>
          <span>已覆盖省份</span>
        </div>
        <div>
          <strong>{summary.total}</strong>
          <span>古建点位</span>
        </div>
        <div>
          <strong>{done}</strong>
          <span>完成巡检</span>
        </div>
        <div>
          <strong>
            {rate}
            <em>%</em>
          </strong>
          <span>完成率</span>
        </div>
      </div>

      {/* 完成率进度条：设计稿里「完成率」带一条横向进度条，这里补上。
          宽度就是上面算出的 rate，不引入任何新数字 */}
      <div className="ov-tally__rate" title={`完成率 ${rate}%`}>
        <i style={{ width: `${rate}%` }} />
      </div>

      <ul className="ov-tally__bar">
        {order.map((key) => (
          <li key={key}>
            <i style={{ background: STATUS_COLOR[key] }} />
            <span>{STATUS_TEXT[key]}</span>
            <b>{summary.byStatus[key]}</b>
          </li>
        ))}
      </ul>

      <p className="ov-tally__foot">
        本轮任务 {WORK_ORDER.id} · {WORK_ORDER.site}
      </p>
    </Panel>
  );
}

/**
 * 设备状态
 *
 * 硬件侧一眼可见：三台设备各自的数据来源与状态，加四路通道的更新时间。
 * 不在这里给检测结论 —— 设备状态与结果判定是两条线（PRD 3.2）。
 */
function DevicePanel() {
  const { channels } = useMumai();

  const devices = [
    { ...DEVICES.scanner, source: "模拟采集", tone: "warn" as const },
    { ...DEVICES.demoCart, source: "回放", tone: "info" as const },
    { ...DEVICES.realCart, source: "只读监视", tone: "muted" as const },
  ];

  const channelTone = (state: string) =>
    state === "online" ? ("ok" as const) : state === "stale" ? ("warn" as const) : ("danger" as const);
  const channelText = (state: string) =>
    state === "online" ? "正常" : state === "stale" ? "延迟" : "断开";

  return (
    <Panel
      title="设备状态"
      extra={<span className="muted">{MISSION.mapVersion}</span>}
      className="ov__panel">
      <ul className="ov-devices">
        {devices.map((device) => (
          <li key={device.id}>
            <div className="ov-devices__id">
              <b>{device.name}</b>
              <em>{device.id}</em>
            </div>
            <StatusChip text={device.source} tone={device.tone} dot />
          </li>
        ))}
      </ul>

      <h4 className="ov-sec">数据通道</h4>
      <ul className="ov-channels">
        {channels.map((channel) => (
          <li key={channel.key}>
            <span>{channel.label}</span>
            <StatusChip
              text={channelText(channel.state)}
              tone={channelTone(channel.state)}
              dot
            />
            <em>{channel.updatedAt}</em>
          </li>
        ))}
      </ul>
    </Panel>
  );
}


function RiskOrderPanel() {
  const navigate = useNavigate();
  /**
   * 工单选中态放在 `map/store` 而不是这里的 `useState`：
   * 地图点位与右栏工单必须互相联动（选中工单 → 地图高亮点位；点击点位 →
   * 右栏这条变选中）。两处各自 `useState` 会绕成环，收敛到 store 才是单一来源。
   */
  const selectedOrderId = useDashboardStore((state) => state.selectedOrderId);
  const selectOrder = useDashboardStore((state) => state.selectOrder);
  const selectedSiteId = useDashboardStore((state) => state.selectedSiteId);
  /** 工单表默认 4 行，其余收进「更多」 */
  const [listOpen, setListOpen] = useState(false);
  /** 当前工单卡默认只给一行摘要，点位/区县/发现时间收进「详情」 */
  const [detailOpen, setDetailOpen] = useState(false);

  const selected =
    OVERVIEW_ORDERS.find((item) => item.id === selectedOrderId) ?? WORK_ORDER;

  /** 地图上处于选中态的点位（只用于给工单卡补一行「地图点位」） */
  const selectedSite = useMemo(() => {
    if (!selectedSiteId) return null;
    return [...CHINA_SITES, ...SHANGHAI_SITES].find((site) => site.id === selectedSiteId) ?? null;
  }, [selectedSiteId]);

  /** 计数按种子工单真实统计，不写死数字 */
  const counts = useMemo(
    () => ORDER_COUNTERS.map((counter) => ({ ...counter, value: OVERVIEW_ORDERS.filter(counter.match).length })),
    [],
  );

  /**
   * 收起态只给前 4 条；**当前选中的那条必须在场**——选中第 5/6 条时用选中行
   * 顶掉预览区的最后一行，顺序仍按原列表，避免选中项被挤到滚动区外看不见。
   */
  const rows = useMemo(() => {
    if (listOpen) return OVERVIEW_ORDERS;
    const preview = OVERVIEW_ORDERS.slice(0, ORDER_PREVIEW_ROWS);
    if (preview.some((order) => order.id === selected.id)) return preview;
    return OVERVIEW_ORDERS.filter((order, index) => index < ORDER_PREVIEW_ROWS - 1 || order.id === selected.id);
  }, [listOpen, selected]);

  /** 问题类型取该工单来源风险里优先级最高的一条，没有来源风险时退回检测范围 */
  const issueType = useMemo(() => {
    const risks = CURRENT_RISKS.filter((item) => selected.sourceRiskIds.includes(item.id));
    const top = risks.reduce<(typeof risks)[number] | null>(
      (best, risk) => (best === null || risk.score > best.score ? risk : best),
      null,
    );
    return top?.label ?? selected.scope;
  }, [selected]);

  /** 设计稿里 `SH-2026-0901` 额外显示 Z04 下部与疑似空洞读数。
      取该构件本轮得分最高的一条（0.87），与设计稿一致。 */
  const z04Risk = useMemo(() => {
    if (selected.id !== WORK_ORDER.id) return undefined;
    const z04 = WORK_ORDER.componentIds[WORK_ORDER.componentIds.length - 1];
    const risks = CURRENT_RISKS.filter((item) => item.componentId === z04);
    return risks.reduce<(typeof risks)[number] | undefined>(
      (best, risk) => (best === undefined || risk.score > best.score ? risk : best),
      undefined,
    );
  }, [selected]);

  return (
    <>
      {/* 第二层：三条计数只做数字 + 标签，不各自包一张边框卡（§4.3） */}
      <div className="ov-counts">
        {counts.map((counter) => (
          <div key={counter.key} className={`ov-count ov-count--${counter.tone}`}>
            <strong>
              {counter.value}
              <small>{counter.label}</small>
            </strong>
          </div>
        ))}
      </div>

      <h4 className="ov-sec">
        工单列表
        <MoreButton
          open={listOpen}
          moreText={`共 ${OVERVIEW_ORDERS.length} 条 · 更多`}
          onClick={() => setListOpen((v) => !v)}
        />
      </h4>
      {/* 表格负责「列表 + 选中」：编号 + 点位 / 风险 / 状态，都是一行的东西 */}
      <div className={`ov-orders${listOpen ? " is-open" : ""}`}>
        <div className="ov-orders__head">
          <span>工单 · 点位</span>
          <span>风险</span>
          <span>状态</span>
        </div>
        <div className="ov-orders__list">
          {rows.map((order) => (
            <button
              key={order.id}
              type="button"
              className={order.id === selected.id ? "is-active" : ""}
              onClick={() => selectOrder(order.id)}>
              <span className="ov-orders__id">
                {order.id}
                <i>{order.site}</i>
              </span>
              <StatusChip text={order.level} tone={ORDER_LEVEL_TONE[order.level]} />
              <StatusChip text={order.status} tone={ORDER_STATUS_TONE[order.status]} />
            </button>
          ))}
        </div>
      </div>

      {/* 第一层：当前工单。点位/区县已在上面表格里，这里只留表格没有的
          问题类型 / 构件 / 得分，压成一行摘要；明细进「详情」 */}
      <article className="ov-coc">
        <h3>
          {selected.id}
          <i>{selected.title}</i>
        </h3>
        <div className="ov-coc__chips">
          <StatusChip text={selected.level} tone={ORDER_LEVEL_TONE[selected.level]} />
          <StatusChip text={selected.status} tone={ORDER_STATUS_TONE[selected.status]} />
        </div>
        <p className="ov-coc__sum">
          问题类型 {issueType} · 构件 {z04Risk ? z04Risk.componentId : selected.componentIds.join("/")}
          {z04Risk ? <em>{z04Risk.score.toFixed(2)}</em> : null}
        </p>
        {detailOpen ? (
          <dl className="ov-coc__dl">
            <div>
              <dt>点位</dt>
              <dd>
                {selected.site} · {selected.componentIds.join("/")}
              </dd>
            </div>
            <div>
              <dt>区县</dt>
              <dd>{selectedSite ? selectedSite.district ?? selectedSite.province ?? selected.district : selected.district}</dd>
            </div>
            <div>
              <dt>发现时间</dt>
              <dd>{selected.discoveredAt}</dd>
            </div>
            <div>
              <dt>地图点位</dt>
              <dd>
                {selectedSite
                  ? `${selectedSite.name} · ${STATUS_TEXT[selectedSite.status]}（地图上已高亮）`
                  : "该工单未关联地图点位"}
              </dd>
            </div>
          </dl>
        ) : null}
        <div className="ov-coc__foot">
          <MoreButton open={detailOpen} moreText="详情" onClick={() => setDetailOpen((v) => !v)} />
          <button
            type="button"
            className="btn btn--primary ov-coc__go"
            onClick={() => navigate(`/orders?order=${selected.id}`)}>
            查看工单
            <Icon name="arrow" />
          </button>
        </div>
      </article>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * 右栏 · 面板二：待办与最近事件 + 历史风险统计
 * ------------------------------------------------------------------ */

function TodoEventPanel() {
  const [todoOpen, setTodoOpen] = useState(false);
  const [eventOpen, setEventOpen] = useState(false);

  const todos = todoOpen ? TODO_ITEMS : TODO_ITEMS.slice(0, TODO_PREVIEW_ITEMS);
  const events = eventOpen ? RECENT_EVENTS : RECENT_EVENTS.slice(0, EVENT_PREVIEW_ITEMS);

  return (
    <Panel title="待办与最近事件" className="ov__panel ov__panel--todo">
      <h4 className="ov-sec">
        待办事项
        <MoreButton
          open={todoOpen}
          moreText={`共 ${TODO_ITEMS.length} 项 · 更多`}
          onClick={() => setTodoOpen((v) => !v)}
        />
      </h4>
      <ul className="ov-todo">
        {todos.map((item) => (
          <li key={item.id} className={`is-${item.level}`}>
            <span className="ov-todo__text">
              {item.id} · {item.text}
              <i>
                {item.owner} · {item.due.slice(5)}
              </i>
            </span>
          </li>
        ))}
      </ul>

      <h4 className="ov-sec">
        最近事件
        <MoreButton
          open={eventOpen}
          moreText={`共 ${RECENT_EVENTS.length} 条 · 更多`}
          onClick={() => setEventOpen((v) => !v)}
        />
      </h4>
      <ol className="ov-events">
        {events.map((event) => (
          <li key={event.at + event.text}>
            <time>{event.at}</time>
            {event.text}
          </li>
        ))}
      </ol>

      {/* 第三层：历史风险口径（数字由种子算出，不写死） */}
      <div className="ov-stats">
        <span>
          历史风险<b>{HISTORY_STATS.total}</b>
        </span>
        <span>
          已关闭<b className="is-ok">{HISTORY_STATS.closed}</b>
        </span>
        <span>
          未关闭<b className="is-danger">{HISTORY_STATS.open}</b>
        </span>
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------ *
 * 页面
 * ------------------------------------------------------------------ */

export default function Overview() {
  const mode = useDashboardStore((state) => state.mode);
  const transitioning = useDashboardStore((state) => state.transitioning);
  const { currentOrder, toast } = useMumai();

  const enterShanghai = useCallback(() => requestMapMode("shanghai"), []);
  const returnChina = useCallback(() => requestMapMode("china"), []);

  /**
   * 图例与点位一一对应：
   *   ① 状态取自种子（`seed/sites.ts`），不再在页面里写一份状态名单；
   *   ② 只列当前地图上**真的有点位**的状态，图例里不会出现点了没有的颜色；
   *   ③ 顺带给出模式下的点位总数与分布，图例同时就是一句态势说明。
   */
  const sites = mode === "shanghai" ? SHANGHAI_SITES : CHINA_SITES;
  const legendStatuses = useMemo(() => statusesOf(sites), [sites]);
  const siteStats = useMemo(() => summariseSites(sites), [sites]);

  return (
    <div className="ov">
      {/* 地图铺满整个内容区，面板浮在它上面 */}
      <div className="ov__map">
        <Map mode={mode} />
      </div>
      <div className="ov__vignette" />

      {/* 点位详情浮层：只有勘察 / 检测记录的点位被点开时出现，
          不跳页、不遮地图（关闭靠点空白处或右上角 ✕） */}
      <SiteDetailCard />

      {/* 左栏：巡检态势 + 设备状态（硬件侧的设备与四路通道） */}
      <div className="ov__side ov__side--left">
        <SituationPanel />
        <DevicePanel />
      </div>

      {/* 右栏：风险与工单 + 待办与最近事件 */}
      <div className="ov__side ov__side--right">
        <Panel title="风险与工单" className="ov__panel">
          <RiskOrderPanel />
        </Panel>
        <TodoEventPanel />
      </div>

      {/* 面包屑与图例 */}
      <div className="ov__crumb">
        <button type="button" className={mode === "china" ? "is-current" : ""} onClick={returnChina}>
          全国总览
        </button>
        <button type="button" className={mode === "shanghai" ? "is-current" : ""} onClick={enterShanghai}>
          上海市
        </button>
      </div>

      <div className="ov__actions">
        <Legend
          className="legend"
          title={`${mode === "shanghai" ? "上海市" : "全国"}勘察检测点位 ${siteStats.total} 处`}>
          <span>
            勘察检测点位 <b>{siteStats.total}</b>
          </span>
          {legendStatuses.map((status) => (
            <span key={status} title={STATUS_ACTION[status]}>
              <i style={{ background: STATUS_COLOR[status] }} />
              {STATUS_TEXT[status]}
              <b>{siteStats.byStatus[status]}</b>
            </span>
          ))}
        </Legend>
        <button
          type="button"
          className="btn btn--primary"
          disabled={transitioning}
          onClick={() => {
            if (mode === "china") {
              enterShanghai();
              toast("镜头推进中，进入上海市区级地图", "info");
            } else {
              returnChina();
              toast("返回全国总览", "info");
            }
          }}>
          {mode === "china" ? "进入上海" : "返回全国"}
          <Icon name="arrow" />
        </button>
      </div>

      <div className="ov__hint">
        <Icon name="pin" /> 点击点位查看工单与勘察记录
      </div>

      <footer className="ov__foot">
        <span className="ov__motto">{OVERVIEW_SLOGAN}</span>
        <span>
          数据源 {currentOrder.sourceMode === "replay" ? "演示回放" : currentOrder.sourceMode} · 地图版本 {MISSION_MAP_VERSION}
        </span>
        <span>
          实时位置 {DEMO_GEO_POSITION.lat.toFixed(4)}°N {DEMO_GEO_POSITION.lon.toFixed(4)}°E
        </span>
      </footer>
    </div>
  );
}
