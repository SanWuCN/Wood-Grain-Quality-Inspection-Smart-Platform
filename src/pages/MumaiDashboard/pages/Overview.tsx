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

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import styled from "styled-components";
import { useDashboardStore, requestMapMode } from "../map/store";
import Map from "../mapDemo";
import { Panel } from "../Panel";
import { Icon } from "../icons";
import { Btn, Modal, StatusChip } from "../ui";
import { useMumai } from "../context";
import { STATUS_ACTION, STATUS_COLOR, STATUS_TEXT } from "../map/status";
import Chart from "./OverviewCharts";
import { CHART } from "../design";
import { LOAD_TEXT, LOAD_TONE, QUALITY_TEXT, barWidth, bytesPerSec, gibShort, percent, power, tb, usePlatformResources } from "./usePlatformResources";
import ResourceModal from "./ResourceModal";
import type { ResourceTab } from "./usePlatformResources";
import { useEntranceSettled } from "./useEntranceSettled";
import { useMediaQuery, usePrefersReducedMotion } from "./useMediaQuery";
import SiteDetailCard from "../map/SiteDetailCard";
import {
  CHINA_PROVINCE_COUNT,
  CHINA_SITES,
  SHANGHAI_SITES,
  statusesOf,
  summariseSites,
} from "../seed/sites";
import {

  DEVICES,
  HISTORIC_ORDERS,
  MISSION,

  WORK_ORDER,
} from "../seed/scenario";
import {
  DEMO_GEO_POSITION,
  ORDER_LEVEL_TONE,
  ORDER_STATUS_TONE,
  OVERVIEW_SLOGAN,
  STATUS_KEY_BY_TEXT,
  CHART_BASE,
  LOAD_COLOR,
} from "./overview.constants";

/** 首页工单列表：本轮工单 + 历史工单，共 6 条（设计稿「工单列表」） */
const OVERVIEW_ORDERS = [WORK_ORDER, ...HISTORIC_ORDERS];

/**
 * 巡检概览环形图的状态顺序：已检测 → 有工单 → 有风险 → 已勘察。
 * 提到模块级是为了让 `useMemo` 的依赖稳定（写在组件里每次渲染都是新数组）。
 */
const SITE_STATUS_ORDER = ["inspected", "workorder", "risk", "collected"] as const;

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

/* ------------------------------------------------------------------ *
 * 左栏 · 面板一：场地概览（阶段 / 本轮工单 + 三通道）
 * ------------------------------------------------------------------ */

/** 三角色通道一行（PRD 3.1：地图 / 场景 / 手持采集三个通道） */
/**
 * 全国巡检态势 → **巡检概览**
 *
 * 首页左栏第一块，回答「这轮覆盖了多少地方、做到哪一步」。
 * 数字全部由 seed/sites 现算，不写死。
 *
 * ⚠️ 面板标题叫「巡检概览」而不是「巡检态势」：后者是评审点名的 AI 腔命名
 * （见 `docs/design/视觉重构验收报告.md` 对文案口径的要求），而且这一块本来
 * 就是「概览」——四个 KPI + 一张状态分布图，没有推演、没有态势判断。
 *
 * 视觉（规范 §10「减少首页字段，采用渐进披露」+ §5.1 图表口径）：
 *   · 上半：四个 KPI 数字，只靠字号/颜色分层，不各自包框（§4.3）
 *   · 中段：状态分布**环形图**，中心写点位数 —— 原来这里是四行「色点 + 文字 +
 *     数字」，既和上面 KPI 抢注意力，也把面板下半部留成一大片空白
 *   · 下半：完成率细条 + 本轮任务脚注，贴到面板底部
 * 图例不再单独一行文字：状态名与数量直接进 ECharts 图例，颜色即语义
 * （绿=已检测 / 黄=有工单 / 红=有风险 / 蓝=已勘察，取自 `map/status.ts`）。
 */
function SituationPanel() {
  const ready = useEntranceSettled("/");
  const summary = useMemo(() => summariseSites(CHINA_SITES), []);
  const done = summary.byStatus.inspected + summary.byStatus.workorder;
  const rate = Math.round((done / Math.max(1, summary.total)) * 100);

  /**
   * 状态分布环形图。
   *
   * 顺序按 `SITE_STATUS_ORDER`（已检测 → 有工单 → 有风险 → 已勘察），
   * 颜色逐个取自 `STATUS_COLOR` —— 和地图点位、页面图例是同一份色源，
   * 不在这里另配一套色。
   */
  const option = useMemo(
    () => ({
      ...CHART_BASE,
      /* 图例在右，状态名 + 数量一行读完；不占纵向空间 */
      legend: {
        orient: "vertical",
        right: 0,
        top: "middle",
        itemWidth: 8,
        itemHeight: 8,
        itemGap: 10,
        icon: "circle",
        textStyle: { color: CHART.axisText, fontSize: 13 },
        formatter: (name: string) =>
          `${name}  ${summary.byStatus[STATUS_KEY_BY_TEXT[name]] ?? ""}`,
      },
      series: [
        {
          type: "pie",
          radius: ["54%", "78%"],
          center: ["31%", "50%"],
          avoidLabelOverlap: true,
          /*
            中心是**点位数总量**，不是当前扇区的值 —— 默认 formatter 的 `{c}`
            取的是扇区值，直接用会显示成「已勘察 9」那一块的数量，
            和「古建点位」四个字对不上。这里写死总量 + 单位。
          */
          label: {
            show: true,
            position: "center",
            formatter: `{v|${summary.total}}{u| 处}\n{t|古建点位}`,
            rich: {
              v: { color: CHART.palette[0], fontSize: 24, fontWeight: 600, lineHeight: 30 },
              u: { color: CHART.axisText, fontSize: 12, lineHeight: 30 },
              t: { color: CHART.axisText, fontSize: 12, lineHeight: 16 },
            },
          },
          labelLine: { show: false },
          itemStyle: { borderColor: "transparent", borderWidth: 2 },
          data: SITE_STATUS_ORDER.map((key) => ({
            name: STATUS_TEXT[key],
            value: summary.byStatus[key],
            itemStyle: { color: STATUS_COLOR[key] },
          })),
        },
      ],
    }),
    [summary],
  );

  return (
    <Panel
      title="巡检概览"
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

      <Chart
        className="ov-chart ov-chart--donut"
        option={option}
        animate={ready}
        ariaLabel={`全国古建点位状态分布：共 ${summary.total} 处，${SITE_STATUS_ORDER
          .map((key) => `${STATUS_TEXT[key]} ${summary.byStatus[key]} 处`)
          .join("，")}`}
      />

      <p className="ov-tally__foot">
        本轮任务 {WORK_ORDER.id} · {WORK_ORDER.site}
      </p>
    </Panel>
  );
}

/**
 * 设备状态（PRD §6）
 *
 * 固定三行：毫米波扫描仪 / 智能巡检车 / 算力服务器。
 *   · 前两行是**真实设备接口**（扫描仪走设备网关的在线与采集状态，
 *     巡检车走任务与回放状态），名称只做显示名映射，协议 deviceId 不动（§6.2）。
 *   · 第三行是新增的独立算力实体：**不复用旧实机的 ID 或控制通道**，
 *     状态取自后端主机 GPU 基准（§6.1）。
 * 下面是四路数据通道的横向条形图（§6.4）：条长 = 距最后有效数据的时间，
 * 超出绘图上限时封顶但把真实秒数写在条右侧。
 */
function DevicePanel() {
  const ready = useEntranceSettled("/");
  const navigate = useNavigate();
  const { channels } = useMumai();
  const { data: resources, error: resourceError } = usePlatformResources(true);
  /** 算力行点开资源弹窗（不是设备详情）：状态就放在这个组件里 */
  const [resourceTab, setResourceTab] = useState<ResourceTab | null>(null);

  /**
   * 行的点击目标。
   * 前两行进既有业务页（设备详情 / 建图巡检），第三行开资源弹窗 ——
   * 算力服务器没有「设备详情页」，硬跳过去会打开一台根本不存在的设备（§6.1）。
   */
  const selectDeviceRow = (row: { resourceTab?: ResourceTab; to?: string }) => {
    if (row.resourceTab) setResourceTab(row.resourceTab);
    else if (row.to) navigate(row.to);
  };

  const channelText = (state: string) =>
    state === "online" ? "正常" : state === "stale" ? "延迟" : "断开";
  const channelColor = (state: string) =>
    state === "online" ? STATUS_COLOR.inspected : state === "stale" ? STATUS_COLOR.workorder : STATUS_COLOR.risk;

  /**
   * 三行设备状态。
   *
   * 扫描仪与巡检车读的是既有真实接口的状态（`channels` 来自 `useMumai`，
   * 与顶栏状态条同一个来源），不是静态名称，也没有演示计时器（§6.2）。
   * 算力服务器的负载用后端快照的 GPU 基准；取不到就是「负载未知」，
   * **不能**落成「空闲」—— 空闲是一个有效样本的档位，不是缺省值（§9.5）。
   */
  const deviceRows = [
    {
      key: "scanner",
      name: DEVICES.scanner.name,
      mode: "模拟采集",
      state: channels.some((channel) => channel.state !== "online") ? "延迟" : "在线",
      tone: channels.some((channel) => channel.state !== "online") ? ("warn" as const) : ("ok" as const),
      hint: "设备详情",
      to: "/hardware?tab=monitor",
    },
    {
      key: "cart",
      name: DEVICES.demoCart.name,
      /* 名称与数据模式分离：改叫「智能巡检车」之后，回放语义必须留着（§6.2） */
      mode: "回放",
      state: MISSION.state,
      tone: "info" as const,
      hint: "建图巡检",
      to: "/mapping",
    },
    {
      key: "compute",
      name: DEVICES.realCart.name,
      mode: resources ? `${resources.serverCount} 台` : "—",
      state: resourceError
        ? "连接中断"
        : resources
          ? LOAD_TEXT[resources.summary.loadState]
          : "负载未知",
      tone: resourceError
        ? ("danger" as const)
        : resources
          ? LOAD_TONE[resources.summary.loadState]
          : ("muted" as const),
      hint: "算力明细",
      /* 算力行点开的不是设备详情，而是资源弹窗 */
      resourceTab: "gpu" as const,
    },
  ];

  /**
   * 通道新鲜度条形图。
   *
   * 只有 4 个通道、量纲是「秒」，横向条 + 阈值线最直观：条越短越好。
   * 轴从 0 起，不截断 —— 截断会让 9 秒看起来和 1 秒一样长，反而失真。
   */
  const option = useMemo(() => {
    const rows = [...channels].sort((a, b) => a.ageSec - b.ageSec);
    return {
      ...CHART_BASE,
      grid: { left: 0, right: 42, top: 6, bottom: 2, containLabel: true },
      xAxis: {
        type: "value" as const,
        max: 12,
        splitLine: { lineStyle: { color: CHART.grid } },
        axisLabel: { color: CHART.axisText, fontSize: 12, margin: 10, formatter: "{value}s" },
      },
      yAxis: {
        type: "category" as const,
        inverse: true,
        data: rows.map((channel) => channel.label),
        axisLine: { lineStyle: { color: CHART.axisLine } },
        axisTick: { show: false },
        axisLabel: { color: CHART.axisText, fontSize: 13 },
      },
      series: [
        {
          type: "bar",
          barWidth: 10,
          /* 阈值线：规范 §3.4「超过 10 秒标记离线」，与前端 freshness 同一口径 */
          markLine: {
            silent: true,
            symbol: "none",
            label: { formatter: "离线", color: CHART.axisText, fontSize: 11, position: "insideEndTop" },
            lineStyle: { color: CHART.axisLine, type: "dashed" as const },
            data: [{ xAxis: 10 }],
          },
          label: {
            show: true,
            position: "right" as const,
            color: CHART.axisText,
            fontSize: 12,
            formatter: "{c}s",
          },
          data: rows.map((channel) => ({
            value: channel.ageSec,
            itemStyle: { color: channelColor(channel.state) },
          })),
        },
      ],
    };
  }, [channels]);

  return (
    <Panel
      title="设备状态"
      extra={<span className="muted">{MISSION.mapVersion}</span>}
      className="ov__panel">
      {/* 三行设备：名称 + 数据模式 + 状态。ID 下沉到详情页，不在这里占行（§6.1 表） */}
      <ul className="dev-rows">
        {deviceRows.map((row) => (
          <li key={row.key}>
            <button
              type="button"
              className="dev-row"
              onClick={() => selectDeviceRow(row)}
              title={`${row.name} · ${row.hint}`}>
              <span className="dev-row__name">{row.name}</span>
              <small className="dev-row__mode">{row.mode}</small>
              <StatusChip text={row.state} tone={row.tone} dot />
            </button>
          </li>
        ))}
      </ul>

      {/* 数据通道标题做成紧凑标签，不再单独占一整行（§6.4） */}
      <h4 className="ov-sec ov-sec--tight">
        数据通道
        <span className="ov-sec__note">条长 = 距最后有效数据</span>
      </h4>
      <Chart
        className="ov-chart ov-chart--bars"
        option={option}
        animate={ready}
        ariaLabel={`四路数据通道距最后有效数据的秒数：${channels
          .map((channel) => `${channel.label} ${channel.ageSec} 秒（${channelText(channel.state)}）`)
          .join("，")}；超过 10 秒算离线`}
      />

      {resourceTab ? <ResourceModal initialTab={resourceTab} onClose={() => setResourceTab(null)} /> : null}
    </Panel>
  );
}


/**
 * 工单看板（PRD §7）
 *
 * 顶部是三个**互斥**状态计数：待处理 / 处理中 / 待验收（待复核并入待处理，
 * 口径写在标题旁）。已关闭工单只进「查看全部 · N」，不进这三个数。
 * 高风险不再是第四个计数 —— 它是行内标记，最多在标题旁附一处「高风险 N」（§7）。
 *
 * 列表固定高度、逐条循环（`OrderBoardList`）。**没有**独立的选中大卡片：
 * 选中详情移出窗口（点行进工单页），重复编号与长问题说明一并删掉（§7）。
 */
function RiskOrderPanel() {
  const [boardOpen, setBoardOpen] = useState(false);
  const orderTotal = OVERVIEW_ORDERS.length;

  /** 三档互斥状态计数。待复核并入待处理；已关闭不计入（§7） */
  const buckets = useMemo(() => {
    const pending = OVERVIEW_ORDERS.filter((order) => order.status === "待处理" || order.status === "待复核").length;
    const running = OVERVIEW_ORDERS.filter((order) => order.status === "处理中").length;
    const accepting = OVERVIEW_ORDERS.filter((order) => order.status === "待验收").length;
    const high = OVERVIEW_ORDERS.filter((order) => order.level === "高风险").length;
    return { pending, running, accepting, high };
  }, []);

  /**
   * 排序：高风险优先 → 临期优先 → 最近更新优先 → 稳定 ID（§7）。
   * 都在种子数据里，不额外造字段；同权重用 order id 兜底保证稳定。
   */
  const ordered = useMemo(
    () =>
      [...OVERVIEW_ORDERS].sort((a, b) => {
        const level = (order: typeof a) => (order.level === "高风险" ? 0 : order.level === "中风险" ? 1 : 2);
        if (level(a) !== level(b)) return level(a) - level(b);
        /* 种子里的工单没有独立「到期日」，临期按发现时间早的优先（越早发现越该先处理） */
        const seen = (order: typeof a) => order.discoveredAt ?? "9999";
        if (seen(a) !== seen(b)) return seen(a) < seen(b) ? -1 : 1;
        return a.id.localeCompare(b.id);
      }),
    [],
  );

  return (
    <>
      <div className="ob-counts">
        <div className="ob-count is-warn">
          <strong>{buckets.pending}</strong>
          <span>待处理</span>
        </div>
        <div className="ob-count is-info">
          <strong>{buckets.running}</strong>
          <span>处理中</span>
        </div>
        <div className="ob-count is-ok">
          <strong>{buckets.accepting}</strong>
          <span>待验收</span>
        </div>
      </div>
      <p className="ob-note">
        待复核并入待处理{buckets.high > 0 ? ` · 高风险 ${buckets.high}` : ""}
      </p>

      <h4 className="ov-sec ov-sec--tight">
        工单
        <button type="button" className="ov-more" onClick={() => setBoardOpen((open) => !open)}>
          {boardOpen ? "收起明细" : `查看全部 · ${orderTotal}`}
        </button>
      </h4>

      {boardOpen ? (
        /* 「查看全部」打开的是**弹窗式清单**，不在窗口里向下展开长列表（§4.3） */
        <OrderListModal onClose={() => setBoardOpen(false)} />
      ) : null}

      <OrderBoardList orders={ordered} />
    </>
  );
}

/**
 * 工单循环列表（PRD §7.1）
 *
 * 固定高度视口，可见行数由面板正文剩余高度决定（大屏 3 行 / 小屏 2 行）；
 * 总数超过可见行数时每条停 4 秒、再花 450ms 向上移一个整行高，尾部无缝接回第一条。
 *
 * 暂停条件（缺一不可恢复）：鼠标悬停、键盘焦点在列表内、工单被选中、
 * 页面不可见、prefers-reduced-motion。
 *
 * 这里**不提供**暂停/继续与上一条/下一条按钮：轮播就是默认行为，
 * 要看某一条可以直接点它进工单详情，要看全部走标题右侧的「查看全部」。
 * 悬停发生在移动途中时位移本来就在整行像素上（translateY = 行高 × 整数索引），
 * 所以停下来不会卡在半条工单上。
 */
function OrderBoardList({ orders }: { orders: typeof OVERVIEW_ORDERS }) {
  const navigate = useNavigate();
  const rowHeight = useMediaQuery("(max-width: 1440px), (max-height: 800px)") ? 46 : 52;
  const visibleRows = useMediaQuery("(max-width: 1440px), (max-height: 800px)") ? 2 : 3;
  const reduceMotion = usePrefersReducedMotion();

  const [index, setIndex] = useState(0);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);

  const loop = orders.length > visibleRows;
  /** 循环副本：多渲染 visibleRows 条，位移到副本时视觉上无缝（§7.1） */
  const rendered = loop ? [...orders, ...orders.slice(0, visibleRows)] : orders;

  useEffect(() => {
    const onVisibility = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  /**
   * 暂停条件（缺一不可恢复）：鼠标悬停、键盘焦点在列表内、工单被选中、
   * 页面不可见、prefers-reduced-motion。
   *
   * 界面上**没有**暂停/继续、上一条/下一条这些按钮：轮播就是默认行为，
   * 要看某一条直接点它进工单详情，要看全部走标题右侧的「查看全部」。
   *
   * 悬停时**不禁用点击定位**（下面那行 style 的 pointer-events）：
   * 鼠标移上来只停轮播，行本身照旧可以点、可以聚焦 —— 否则用户想点某条
   * 还得先把鼠标挪开，属于「暂停把操作抢走」。
   */
  const blocked = hovered || focused || hidden || reduceMotion || Boolean(selectedId);

  useEffect(() => {
    if (!loop || blocked) return;
    const timer = window.setTimeout(() => setIndex((value) => value + 1), 4000);
    return () => window.clearTimeout(timer);
  }, [loop, blocked, index]);

  /** 位移到位后归一索引：把「副本位置」换算回真实位置，避免索引无限增长 */
  useEffect(() => {
    if (!loop || index < orders.length) return;
    const timer = window.setTimeout(() => setIndex(index - orders.length), 460);
    return () => window.clearTimeout(timer);
  }, [index, loop, orders.length]);

  if (orders.length === 0) {
    return <p className="note">当前范围内没有工单。</p>;
  }

  return (
    <div className="ob">
      <div
        className="ob-viewport"
        style={{ height: `${visibleRows * rowHeight}px` }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}>
        <ul
          className="ob-track"
          style={{
            /* 要移动的位移用 calc 保证与行高严格一致：行高变了位移跟着变，不会错半行 */
            transform: `translateY(calc(${-index} * var(--ob-row)))`,
            transition: reduceMotion ? "none" : "transform 450ms cubic-bezier(0.33, 0, 0.2, 1)",
            ["--ob-row" as string]: `${rowHeight}px`,
          }}>
          {rendered.map((order, position) => {
            const real = orders[position % orders.length];
            const duplicate = position >= orders.length;
            return (
              <li key={`${order.id}-${position}`} aria-hidden={duplicate || undefined}>
                <button
                  type="button"
                  tabIndex={duplicate ? -1 : 0}
                  className={`ob-row${selectedId === real.id ? " is-selected" : ""}`}
                  style={{ height: `${rowHeight}px` }}
                  onClick={() => {
                    setSelectedId(real.id);
                    navigate(`/orders?order=${real.id}`);
                  }}>
                  <span className="ob-row__title">
                    {real.id} · {real.site}
                  </span>
                  <span className="ob-row__meta">
                    <StatusChip text={real.level} tone={ORDER_LEVEL_TONE[real.level]} />
                    <StatusChip text={real.status} tone={ORDER_STATUS_TONE[real.status]} />
                    <em>{real.discoveredAt?.slice(5) ?? ""}</em>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>

    </div>
  );
}

/** 「查看全部」弹窗：清单式，不在窗口内纵向展开（§4.3 / UI-10） */
function OrderListModal({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  return (
    <Modal
      wide
      title="全部工单"
      subtitle={`共 ${OVERVIEW_ORDERS.length} 条 · 含已关闭工单`}
      onClose={onClose}
      footer={<Btn onClick={onClose}>关闭</Btn>}>
      <div className="ob-all">
        {OVERVIEW_ORDERS.map((order) => (
          <button
            key={order.id}
            type="button"
            className="ob-all__row"
            onClick={() => navigate(`/orders?order=${order.id}`)}>
            <span className="ob-all__id">
              {order.id}
              <i>{order.site}</i>
            </span>
            <StatusChip text={order.level} tone={ORDER_LEVEL_TONE[order.level]} />
            <StatusChip text={order.status} tone={ORDER_STATUS_TONE[order.status]} />
          </button>
        ))}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * 右栏 · 面板二：平台数据
 * ------------------------------------------------------------------ */

/**
 * 平台数据（PRD §8.1）
 *
 * 五行摘要：存储 / 内存 / GPU / 功耗 / 网络，每行一个数字 + 一条短比例条。
 * 数据是**运行后端那台主机**的实测值经服务端映射后的统一快照
 * （`/api/platform/resources`），主卡与弹窗读同一份。
 *
 * 刻意不做的几件事（都是 PRD 明令）：
 *   · 不在这里逐台列服务器、不画多条历史曲线、不堆多个圆环（§8.1）
 *   · 不用「更多 / 收起」在窗口里展开长列表（§4.3）—— 明细进弹窗
 *   · 不解释指标怎么算的 —— 那是弹窗「映射说明」的事
 * 标题右侧只放一个轻量入口与一个状态点，不新增第六行。
 */
function PlatformDataPanel() {
  const ready = useEntranceSettled("/");
  const { data, error } = usePlatformResources(true);
  const [tab, setTab] = useState<ResourceTab | null>(null);

  const summary = data?.summary;
  const quality = data?.quality ?? "unavailable";

  /** 一行摘要：名称 + 数字 + 可选比例条。null 一律显示「—」，不显示 0 */
  const rows: { key: ResourceTab; label: string; value: ReactNode; ratio: number | null; note?: string }[] = summary
    ? [
        {
          key: "storage",
          label: "存储",
          value: (
            <>
              {tb(summary.storageUsedTB)} <i>/ {summary.storageTotalTB} TB</i>
            </>
          ),
          ratio: summary.storageRatio,
          note: data?.noVolumeReason ?? undefined,
        },
        {
          key: "memory",
          label: "内存",
          value: (
            <>
              {gibShort(summary.memoryUsedGiB)} <i>/ {gibShort(summary.memoryTotalGiB)}</i>
            </>
          ),
          ratio: summary.memoryRatio,
        },
        {
          key: "gpu",
          label: "GPU",
          value: (
            <>
              {percent(summary.gpuBasePercent, 0)}
              <i>{LOAD_TEXT[summary.loadState]}</i>
            </>
          ),
          ratio: summary.gpuBasePercent === null ? null : summary.gpuBasePercent / 100,
        },
        {
          key: "power",
          label: "功耗",
          value: (() => {
            const formatted = power(summary.powerTotalW);
            return (
              <>
                {formatted.w}
                {formatted.kw ? (
                  <>
                    {" "}
                    <i>{formatted.kw}</i>
                  </>
                ) : null}
              </>
            );
          })(),
          ratio: null,
        },
        {
          key: "network",
          label: "网络",
          value: (
            <>
              ↑ {bytesPerSec(summary.uploadBytesPerSec)} <i>↓ {bytesPerSec(summary.downloadBytesPerSec)}</i>
            </>
          ),
          ratio: null,
        },
      ]
    : [];

  /**
   * 逐台 GPU 占用：横向条形图。
   *
   * 颜色按负载档位取语义色（空闲灰 / 低绿 / 中黄 / 高红），并在 25 / 50 / 75
   * 画三条虚线 —— 与 §9.5 的档位定义同一套口径，看图不用数刻度就知道哪台进档。
   * 未知（null）的条不画，靠右侧文字与「负载未知」表达，不拿 0 顶替（§10.3）。
   */
  const loadOption = useMemo(() => {
    const list = data?.servers ?? [];
    return {
      ...CHART_BASE,
      grid: { left: 0, right: 34, top: 4, bottom: 0, containLabel: true },
      xAxis: {
        type: "value" as const,
        max: 100,
        splitLine: { lineStyle: { color: CHART.grid } },
        axisLabel: { color: CHART.axisText, fontSize: 11, formatter: "{value}%" },
      },
      yAxis: {
        type: "category" as const,
        inverse: true,
        data: list.map((server) => server.id),
        axisLine: { lineStyle: { color: CHART.axisLine } },
        axisTick: { show: false },
        axisLabel: { color: CHART.axisText, fontSize: 12 },
      },
      series: [
        {
          type: "bar",
          barWidth: 10,
          markLine: {
            silent: true,
            symbol: "none",
            label: { show: false },
            lineStyle: { color: CHART.axisLine, type: "dashed" as const },
            data: [{ xAxis: 25 }, { xAxis: 50 }, { xAxis: 75 }],
          },
          label: {
            show: true,
            position: "right" as const,
            color: CHART.axisText,
            fontSize: 11,
            formatter: "{c}%",
          },
          data: list.map((server) => ({
            value: server.gpu.percent === null ? null : Number(server.gpu.percent.toFixed(1)),
            itemStyle: { color: LOAD_COLOR[server.gpu.load] },
          })),
        },
      ],
    };
  }, [data]);

  /**
   * 存储构成：一根堆叠横条（已用 + 剩余）。
   *
   * 不画饼图：只有两个分量时一根条比饼好读，而且这块面板已经有一张条形图，
   * 再来一个圆环会让面板变吵（规范 §5.1「一块最多一个主要图」）。
   * 「已用未知」时只画配置容量那一段并写明 —— 不用 0% 冒充（RES-09）。
   */
  const storageOption = useMemo(() => {
    const total = summary?.storageTotalTB ?? 0;
    const used = summary?.storageUsedTB ?? null;
    const known = used !== null && Number.isFinite(used);
    return {
      ...CHART_BASE,
      grid: { left: 0, right: 0, top: 0, bottom: 0 },
      series: [
        {
          type: "bar",
          stack: "storage",
          barWidth: 16,
          silent: !known,
          label: {
            show: true,
            position: "inside" as const,
            color: "#eaf3ff",
            fontSize: 12,
            formatter: known ? `已用 ${tb(used)}` : "",
          },
          itemStyle: { color: CHART.palette[0] },
          data: [known ? Number(used.toFixed(4)) : 0],
        },
        {
          type: "bar",
          stack: "storage",
          barWidth: 16,
          silent: !known,
          label: {
            show: true,
            position: "inside" as const,
            color: CHART.axisText,
            fontSize: 12,
            formatter: known ? `剩余 ${tb(total - (used ?? 0))}` : "已用未知",
          },
          itemStyle: { color: "rgba(78,168,255,0.14)" },
          data: [known ? Number((total - (used ?? 0)).toFixed(4)) : total],
        },
      ],
    };
  }, [summary]);

  return (
    <>
      <Panel
        title="平台数据"
        extra={
          <span className="pd-head">
            {/*
              夹具徽标：夹具是假输入，必须看得出来，不然「用夹具验过的数」
              会被误当成真实主机采集结果。放在标题区而不是正文里 ——
              正文高度是硬预算（四窗口不许滚动），一行提示会把图挤出去。
              完整说明在弹窗副标题与「映射说明」里。
            */}
            {data?.fixture ? (
              <span className="pd-badge" title={`验收夹具输入：${data.fixture.label}（不是真实主机采集）`}>
                验收夹具
              </span>
            ) : null}
            {/* 状态点：数据过期 / 断连时在标题区提示，不新增一行解释（§8.1） */}
            <StatusChip
              text={error ? "连接中断" : data ? QUALITY_TEXT[quality] : "采样中"}
              tone={error || quality === "unavailable" ? "danger" : quality === "stale" ? "warn" : "ok"}
              dot
            />
            {/*
              按钮文案在窄面板里会被挤出去（面板 269px、标题区只剩 ~215px）：
              用「详情」+ aria-label 保住可读名称，宽度省下一半。
            */}
            <Btn tone="ghost" onClick={() => setTab("storage")} aria-label="打开平台资源详情">
              详情
            </Btn>
          </span>
        }
        className="ov__panel">
        {data && summary ? (
          <>
            <ul className="pd-rows">
              {rows.map((row) => {
                const width = barWidth(row.ratio);
                return (
                  <li key={row.key}>
                    <button
                      type="button"
                      className="pd-row"
                      onClick={() => setTab(row.key)}
                      title={`查看${row.label}明细`}>
                      <span className="pd-row__label">{row.label}</span>
                      <b className="pd-row__value">{row.value}</b>
                      <i className="pd-bar">
                        {width === null ? null : <u style={{ width: `${width}%` }} />}
                      </i>
                    </button>
                    {row.note ? <em className="pd-row__note">{row.note}</em> : null}
                  </li>
                );
              })}
            </ul>

            {/*
              可视化一：逐台负载。§8.1 允许「短比例条 / 微型图」，
              禁止的是逐台列表与多条历史曲线 —— 这条横向条形图一次讲完
              「几台机器、各自多少占用」，比五行数字多一层信息。
            */}
            <h4 className="ov-sec ov-sec--tight">
              逐台负载
              <span className="ov-sec__note">
                {data.serverCount} 台 · {LOAD_TEXT[summary.loadState]}
              </span>
            </h4>
            <Chart
              className="ov-chart ov-chart--load"
              option={loadOption}
              animate={ready}
              ariaLabel={`每台服务器 GPU 占用：${data.servers
                .map((server) => `${server.id} ${percent(server.gpu.percent)}`)
                .join("，")}`}
            />

            {/*
              可视化二：存储构成。§8.1 要求「平台存储严格表示按主机磁盘占用
              映射的平台容量」—— 所以只画「已用 / 剩余」这一个构成，
              不混入知识库文件数或数据库字节数。
            */}
            <h4 className="ov-sec ov-sec--tight">存储构成</h4>
            <Chart
              className="ov-chart ov-chart--storage"
              option={storageOption}
              animate={ready}
              ariaLabel={`平台存储构成：已用 ${tb(summary.storageUsedTB)}，共 ${summary.storageTotalTB} TB`}
            />

          </>
        ) : (
          /* 首次加载 / 断连：占位高度与五行一致，不把窗口撑高也不缩塌（§10.3） */
          <ul className="pd-rows pd-rows--placeholder" aria-busy={!error}>
            {["存储", "内存", "GPU", "功耗", "网络"].map((label) => (
              <li key={label}>
                <span className="pd-row pd-row--static">
                  <span className="pd-row__label">{label}</span>
                  <b className="pd-row__value">—</b>
                  <i className="pd-bar" />
                </span>
              </li>
            ))}
            <li className="pd-row__note">{error ? `连接中断：${error}` : "正在读取后端主机资源…"}</li>
          </ul>
        )}
      </Panel>

      {tab ? (
        <ResourceModal initialTab={tab} onClose={() => setTab(null)} />
      ) : null}
    </>
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
        <Panel title="工单看板" className="ov__panel">
          <RiskOrderPanel />
        </Panel>
        <PlatformDataPanel />
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
          <Icon name="arrow" size={20} aria-hidden />
        </button>
      </div>

      <div className="ov__hint">
        {/*
          PRD §3.3：「真地图定位保留 pin」。这里是地图上的点位提示，
          属于真实地图定位语义，不用 biz-manual-mark（那是人工标记）。
        */}
        <Icon name="pin" size={16} aria-hidden /> 点击点位查看工单与勘察记录
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
