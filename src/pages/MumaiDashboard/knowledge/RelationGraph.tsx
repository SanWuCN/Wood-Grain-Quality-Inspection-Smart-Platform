/**
 * 知识库 · 资产关系图（二维）
 *
 * 替代原 TokenGraph3D：三维力导向 + 相似度边 + 无人操作自转，回答不了平台真正要回答的
 * 两个问题，还会让用户把「向量相似」读成「业务上有关联」。这一版只做二维、只做真关系。
 *
 * 三条不可让步的约定（PRD §8.1 / §8.2 / §8.3）：
 *
 *   1. **业务关联与索引血缘是两套独立边集，永不合并**。前者回答「这些资料与哪些工程对象
 *      有关」，靠业务簇看结构；后者回答「检索内容从哪里产生、进了哪个版本」，靠从左到右的
 *      分层看流向。合并成一张网就再也解释不清某条线到底是「属于」还是「提取自」。
 *   2. **血缘视图用固定分层坐标，不跑力导向**。层与层之间必须能一眼对上，力导向会把
 *      同一层的节点抖散，读者就失去了「第几层」这个坐标系；同时禁掉自动旋转 —— 静止的图
 *      才可截图、可复核。
 *   3. **节点类别色只表达类别，状态另开通道**（边框色 + 状态小点）。把类别色改成状态色，
 *      读者就再也认不出「蓝＝对象、青＝资产」这套编码（规范 §1.3 也要求状态色只表达语义）。
 *
 * 另外，本组件自带 <style>：页面样式表由另一个文件负责，面板在样式表到达前后都必须成立。
 *
 * 依据：PRD §8.1–§8.4、§5.3；docs/design/视觉设计规范-v1.0.md §1.2 / §4.1 / §4.2 / §6.2。
 */

import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import * as echarts from "echarts/core";
import { GraphChart } from "echarts/charts";
import { UniversalTransition } from "echarts/features";
import { CanvasRenderer } from "echarts/renderers";
import { GRAPH_CATEGORIES, KB_CHART } from "./chart-palette";
import type { GraphEdge, GraphNode, GraphView, RelationGraphData } from "./types";
import type { AssetIndexState } from "./types";

/*
 * 图表模块在这里自行注册：GraphChart 全项目没有别处注册过，而不注册的图表类型
 * 在 echarts/core 里是直接抛错的。use() 幂等，重复注册同一个模块没有副作用。
 *
 * 为什么不套 knowledge/KnowledgeCharts.tsx 的 EChart 薄封装：它对外只有
 * `onPick(seriesName, dataIndex)` 一个 click 出口，且**每次 option 变化都强制
 * notMerge: true**（重建 series ⇒ 力导向位置全部丢失，等于每选一个节点就重排一次全图，
 * 与 PRD §8.2「局部更新保留旧节点位置」直接冲突），也没有 hover / 双击通道。
 * 面板需要的是「视图切换才 notMerge，其余合并」，所以这里自己持有实例。
 */
echarts.use([GraphChart, UniversalTransition, CanvasRenderer]);

/* ------------------------------------------------------------------ *
 * 对外契约
 * ------------------------------------------------------------------ */

export type RelationGraphProps = {
  data: RelationGraphData | null;
  loading?: boolean;
  view: GraphView;
  onViewChange: (view: GraphView) => void;
  onSelectNode: (node: GraphNode | null) => void;
  selectedId: string | null;
  onExpand?: (node: GraphNode) => void;
  /** 全屏层 */
  expanded?: boolean;
  onToggleExpand?: () => void;
  /** 面板高度，默认 400 */
  height?: number;
};

/* ------------------------------------------------------------------ *
 * 视觉编码表
 * ------------------------------------------------------------------ */

const NODE_KIND_LABEL: Record<GraphNode["kind"], string> = {
  building: "建筑",
  component: "构件",
  device: "设备",
  workOrder: "工单",
  inspection: "巡检任务",
  asset: "资产",
  assetVersion: "资产版本",
  content: "提取内容",
  chunkGroup: "分块组",
  indexVersion: "索引版本",
  object: "工程对象",
};

/** 形状只分三族：对象类（圆角矩形）/ 资产类（圆）/ 版本类（菱形） */
const ROUND_RECT_KINDS: ReadonlyArray<GraphNode["kind"]> = [
  "building",
  "component",
  "device",
  "workOrder",
  "inspection",
  "object",
];

/** 资产类：资料本体及其两个派生层（提取内容、分块组） */
const CIRCLE_KINDS: ReadonlyArray<GraphNode["kind"]> = ["asset", "assetVersion", "content", "chunkGroup"];

/** 图例文案（本文件自用，不导出：本模块只对外导出组件与类型，避免破坏 fast-refresh 边界） */
const NODE_SHAPE_LABEL = {
  object: "对象 / 建筑 / 设备 / 工单",
  asset: "资产 / 内容 / 分块组",
  version: "索引版本",
} as const;

function nodeShape(kind: GraphNode["kind"]): "roundRect" | "circle" | "diamond" {
  if (kind === "indexVersion") return "diamond";
  if (CIRCLE_KINDS.includes(kind)) return "circle";
  if (ROUND_RECT_KINDS.includes(kind)) return "roundRect";
  return "circle";
}

/** 索引状态 → 边框语义色；只有真实状态语义允许用绿 / 黄 / 红 */
const STATE_TONE: Partial<Record<AssetIndexState, string>> = {
  已覆盖: "var(--success)",
  处理中: "var(--primary)",
  待更新: "var(--warning)",
  未纳入: "var(--text-disabled)",
  更新失败: "var(--danger)",
};

const STATE_TONE_HEX: Partial<Record<AssetIndexState, string>> = {
  已覆盖: "#39d5a3",
  处理中: "#4ea8ff",
  待更新: "#f2b84b",
  未纳入: "#465a70",
  更新失败: "#ff5c70",
};

/** 无状态的普通节点边框：低对比，不抢类别色 */
const PLAIN_BORDER = "rgba(130, 180, 230, 0.42)";
const DIM_OPACITY = 0.16;
const DIM_EDGE_OPACITY = 0.05;
/** 只有明确的「引用」关系才走虚线（PRD §8.3） */
const DASH_RELATION = "引用";
const TIP_HALF_WIDTH = 96;

/* ------------------------------------------------------------------ *
 * 纯函数
 * ------------------------------------------------------------------ */

/** FNV-1a：稳定散列。用来给节点定初值、给类别定颜色 —— 同一 ID 任何时候得到同一结果 */
function hash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** 单位圆内的确定性抖动：力导向需要一个不重合的初值，否则对称图上会出现节点完全重叠 */
function hashJitter(id: string): { dx: number; dy: number } {
  const h = hash32(id);
  const angle = ((h % 4096) / 4096) * Math.PI * 2;
  const radius = 0.06 + (((h >>> 12) % 1024) / 1024) * 0.34;
  return { dx: Math.cos(angle) * radius, dy: Math.sin(angle) * radius };
}

/**
 * 类别 → palette 颜色。
 *
 * 已知类别按 chart-palette.ts 的 GRAPH_CATEGORIES 顺序取色，而不是按「这次返回了哪些
 * 类别」现编：两张视图返回的类别集合不同，如果按集合定序，「资料」在业务视图里是第 2 色、
 * 切到血缘视图就变成第 1 色，同一种东西两种颜色，图例立刻就不可信了。
 */
function categoryPalette(categories: string[]): Map<string, string> {
  const map = new Map<string, string>();
  const taken = new Array<boolean>(KB_CHART.palette.length).fill(false);
  const ordered = [
    ...GRAPH_CATEGORIES.filter((name) => categories.includes(name)),
    ...categories.filter((name) => !(GRAPH_CATEGORIES as readonly string[]).includes(name)).sort(),
  ];
  ordered.forEach((name) => {
    const preferred = hash32(name) % KB_CHART.palette.length;
    let slot = preferred;
    for (let i = 0; i < KB_CHART.palette.length; i += 1) {
      const candidate = (preferred + i) % KB_CHART.palette.length;
      if (!taken[candidate]) {
        slot = candidate;
        break;
      }
    }
    taken[slot] = true;
    map.set(name, KB_CHART.palette[slot]);
  });
  return map;
}

function hexToRgba(hex: string, alpha: number): string {
  const value = hex.replace("#", "");
  const full = value.length === 3 ? value.split("").map((c) => c + c).join("") : value;
  const num = Number.parseInt(full, 16);
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** 节点大小只表达聚合数量（PRD §8.3），图例必须写明这一点 */
function nodeSize(count: number | undefined, maxCount: number): number {
  const value = Math.max(count ?? 1, 1);
  const span = Math.log1p(Math.max(maxCount, 1));
  const ratio = span > 0 ? Math.log1p(value) / span : 0;
  return Math.round(14 + ratio * 22);
}

/** 布局舞台：与容器同比例，ECharts 的 view 坐标系按数据包围盒缩放到画布 */
function stageBox(width: number, height: number): { w: number; h: number } {
  const w = Math.min(Math.max(width || 960, 320), 2400);
  const h = Math.min(Math.max(height || 400, 200), 1600);
  return { w, h };
}

/** 极坐标落点：业务视图的确定性初值 */
function polarPoint(id: string, w: number, h: number): [number, number] {
  const { dx, dy } = hashJitter(id);
  return [w * (0.5 + dx), h * (0.5 + dy)];
}

/** 血缘视图：x/y 是 0..1 归一化坐标，直接映射到舞台像素，不参与任何模拟 */
function lineagePoint(node: GraphNode, w: number, h: number, index: number): [number, number] {
  if (typeof node.x === "number" && typeof node.y === "number") {
    return [w * Math.min(Math.max(node.x, 0), 1), h * Math.min(Math.max(node.y, 0), 1)];
  }
  // 后端没给坐标时按序退化成一条横线，而不是让节点堆在原点
  const step = index % 5;
  return [w * (0.1 + step * 0.18), h * 0.5];
}

/**
 * 把行内提示摆到指针附近并夹进画布。
 * 上边留不够就翻到指针下方 —— 提示本身不能盖住被悬停的那个节点。
 */
function nearestEdgeTip(canvasWidth: number, tipX: number, tipY: number): { x: number; y: number } {
  const x = Math.min(Math.max(tipX, TIP_HALF_WIDTH), Math.max(canvasWidth - TIP_HALF_WIDTH, TIP_HALF_WIDTH));
  const y = tipY > 64 ? tipY - 12 : tipY + 24;
  return { x, y };
}

/* ------------------------------------------------------------------ *
 * 面板样式（自带，避免依赖页面样式表的到达时机）
 * ------------------------------------------------------------------ */

const PANEL_CSS = `
.kb-graph-panel {
  display: flex; flex-direction: column;
  background: var(--bg-panel);
  border: 1px solid var(--border-default);
  border-radius: 6px; overflow: hidden;
  font-family: var(--font-ui); color: var(--text-secondary);
  /*
   * 面板是**适应**而不是死高：组件给的行内 height 只是默认值，
   * 在 1366×768 下内容区只有三百多像素，固定 400 会把图挤出可视区
   * （PRD §5.2「图谱最低高度 290px」正是为这一档准备的）。
   */
  min-height: 290px;
}
.kb-graph-panel > .kb-graph-body { flex: 1 1 auto; }
.kb-graph-panel .kb-graph-canvas { flex: 1 1 auto; }
.kb-graph-panel[data-expanded="true"] {
  position: fixed; inset: 0; z-index: 60; border-radius: 0; height: auto;
  background: var(--overlay-solid);
}
.kb-graph-head { display: flex; align-items: center; gap: var(--space-3); height: 40px; padding: 0 var(--space-4); flex: none; }
.kb-graph-title { font-size: 16px; font-weight: 600; color: var(--text-title, #ddeeff); letter-spacing: 0.02em; }
.kb-graph-title::before { content: "// "; color: var(--glow-cyan); }
.kb-graph-meta { font-size: 11px; color: var(--text-tertiary); }
.kb-graph-spacer { flex: 1 1 auto; }
.kb-graph-tools { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); padding: 0 var(--space-4) var(--space-2); flex: none; }
.kb-graph-seg { display: inline-flex; border: 1px solid var(--border-default); border-radius: 4px; overflow: hidden; }
.kb-graph-seg button {
  height: 28px; padding: 0 var(--space-3); border: 0; background: transparent;
  color: var(--text-tertiary); font: inherit; font-size: 12px; cursor: pointer;
  transition: color var(--motion-fast) ease, background var(--motion-fast) ease;
}
.kb-graph-seg button + button { border-left: 1px solid var(--border-subtle); }
.kb-graph-seg button:hover { color: var(--text-primary); background: var(--fill-weak); }
.kb-graph-seg button[aria-pressed="true"] { color: var(--text-primary); background: var(--fill-strong); }
.kb-graph-input {
  height: 28px; width: 160px; padding: 0 var(--space-2); box-sizing: border-box;
  background: var(--bg-panel-hover); border: 1px solid var(--border-subtle); border-radius: 4px;
  color: var(--text-primary); font-family: var(--font-ui); font-size: 12px;
  transition: border-color var(--motion-fast) ease;
}
.kb-graph-input::placeholder { color: var(--text-disabled); }
.kb-graph-input:hover { border-color: var(--border-hover); }
.kb-graph-input:focus-visible { outline: none; border-color: var(--border-active); }
.kb-graph-btn {
  height: 28px; padding: 0 var(--space-3); border-radius: 4px; cursor: pointer;
  background: var(--fill-weak); border: 1px solid var(--border-default);
  color: var(--text-secondary); font: inherit; font-size: 12px;
  transition: color var(--motion-fast) ease, border-color var(--motion-fast) ease, background var(--motion-fast) ease;
}
.kb-graph-btn:hover:not(:disabled) { color: var(--text-primary); border-color: var(--border-hover); background: var(--fill-soft); }
.kb-graph-btn:disabled { color: var(--text-disabled); border-color: var(--border-subtle); cursor: not-allowed; }
.kb-graph-seg button:focus-visible, .kb-graph-btn:focus-visible, .kb-graph-row:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
.kb-graph-body { display: flex; flex-direction: column; gap: var(--space-2); padding: 0 var(--space-4) var(--space-2); min-height: 0; flex: 1 1 auto; }
.kb-graph-canvas { position: relative; flex: 0 0 auto; min-height: 140px; border: 1px solid var(--border-subtle); border-radius: 4px; background: var(--bg-page); }
.kb-graph-chart { position: absolute; inset: 0; }
.kb-graph-tip {
  position: absolute; z-index: 3; transform: translateX(-50%);
  min-width: 140px; max-width: 240px; padding: var(--space-2) var(--space-3);
  /* 底色与边框对齐 chart-palette.ts 的 KB_CHART，图表上的浮层不另起一套色 */
  background: ${KB_CHART.tooltipBg}; border: 1px solid ${KB_CHART.tooltipBorder};
  border-radius: 4px; pointer-events: none; font-size: 12px; line-height: 1.6;
  transition: opacity var(--motion-fast) ease;
}
.kb-graph-tip-name { color: var(--text-primary); font-size: 13px; }
.kb-graph-tip-row { display: flex; justify-content: space-between; gap: var(--space-3); color: var(--text-tertiary); }
.kb-graph-tip-row b { color: var(--text-secondary); font-weight: 500; font-family: var(--font-data); }
.kb-graph-empty { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: var(--space-1); color: var(--text-tertiary); font-size: 13px; }
.kb-graph-empty-sub { color: var(--text-disabled); font-size: 12px; }
.kb-graph-foot { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); flex: none; padding: 0 var(--space-4) var(--space-2); font-size: 11px; color: var(--text-tertiary); font-family: var(--font-data); }
.kb-graph-foot-note { color: var(--warning); font-family: var(--font-ui); }
.kb-graph-legend { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-1) var(--space-4); padding: 0 var(--space-4); font-size: 11px; color: var(--text-tertiary); flex: none; }
.kb-graph-legend-group { display: flex; align-items: center; gap: var(--space-2); }
.kb-graph-legend-item { display: inline-flex; align-items: center; gap: var(--space-1); }
.kb-graph-mark { width: 10px; height: 10px; border: 1px solid var(--border-default); flex: none; }
.kb-graph-mark[data-shape="roundRect"] { border-radius: 3px; }
.kb-graph-mark[data-shape="circle"] { border-radius: 50%; }
.kb-graph-mark[data-shape="diamond"] { transform: rotate(45deg); border-radius: 1px; }
.kb-graph-mark[data-size="s"] { width: 7px; height: 7px; }
.kb-graph-mark[data-size="m"] { width: 11px; height: 11px; }
.kb-graph-mark[data-size="l"] { width: 15px; height: 15px; }
.kb-graph-legend-line { width: 18px; height: 0; border-top: 1px solid var(--border-hover); flex: none; }
.kb-graph-legend-line[data-dash="true"] { border-top-style: dashed; }
.kb-graph-list { flex: 0 1 auto; min-height: 0; overflow: auto; padding: 0 var(--space-4) var(--space-2); }
.kb-graph-list-head { position: sticky; top: 0; padding: var(--space-1) 0; background: inherit; color: var(--text-tertiary); font-size: 11px; }
.kb-graph-list ul { margin: 0; padding: 0; list-style: none; display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: var(--space-1) var(--space-2); }
.kb-graph-row {
  display: grid; grid-template-columns: auto 1fr auto; align-items: baseline; gap: var(--space-2);
  width: 100%; padding: var(--space-1) var(--space-2); box-sizing: border-box;
  background: transparent; border: 1px solid var(--border-subtle); border-radius: 3px;
  color: var(--text-secondary); font: inherit; font-size: 12px; text-align: left; cursor: pointer;
  transition: background var(--motion-fast) ease, border-color var(--motion-fast) ease;
}
.kb-graph-row:hover { background: var(--fill-weak); border-color: var(--border-hover); }
.kb-graph-row-type { color: var(--primary); font-size: 11px; white-space: nowrap; }
.kb-graph-row-name { color: var(--text-primary); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kb-graph-row-ref { color: var(--text-disabled); font-size: 11px; font-family: var(--font-data); white-space: nowrap; }
.kb-graph-sr { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
`;

/* ------------------------------------------------------------------ *
 * 组件
 * ------------------------------------------------------------------ */

export function RelationGraph({
  data,
  loading = false,
  view,
  onViewChange,
  onSelectNode,
  selectedId,
  onExpand,
  expanded = false,
  onToggleExpand,
  height = 400,
}: RelationGraphProps): JSX.Element {
  const [query, setQuery] = useState("");
  const [refitNonce, setRefitNonce] = useState(0);
  const [pointer, setPointer] = useState<{ id: string; x: number; y: number } | null>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  /*
   * 画布 DOM 用 **state** 而不是 ref 保存。
   *
   * 原因：数据是异步来的，首帧渲染的是空状态分支，画布 div 那一刻还不存在；
   * 之后数据到位才切到图表分支。如果只把画布挂在 ref 上、初始化 effect 又是空依赖，
   * effect 在挂载时读到的是 null，画布出现后**永远不会再跑一次** ——
   * 表现就是「图例、节点数、关联列表都在，唯独图是空白」。
   * 挂到 state 上，画布一出现 effect 就会重跑，ECharts 实例才建得起来。
   */
  const [canvasEl, setCanvasEl] = useState<HTMLDivElement | null>(null);
  const chart = useRef<echarts.EChartsType | null>(null);
  /** 节点 id → 舞台坐标：数据刷新时保留旧位置，避免整图重排（PRD §8.2） */
  const stageXY = useRef(new Map<string, [number, number]>());
  /**
   * 已经在图上落过位的节点。业务视图下一轮把它们标成 fixed，力导向就只安置新来的节点：
   * 实测（见交付说明）不冻结时，筛掉一部分节点后保留下来的节点会被新的平衡位置拽走 ~94px，
   * 冻结后是 0.00px —— 「局部更新保留旧节点位置」靠的就是这一手。
   */
  const placed = useRef(new Set<string>());
  const lastView = useRef<GraphView | null>(null);
  const lastStage = useRef("");
  const lastFit = useRef(-1);
  /** 上一次点击的时间戳：用来分辨「双击的第二下」，双击不能被当成取消选择 */
  const lastClickAt = useRef(0);
  // 事件在挂载时只绑一次，回调必须走 ref 读取最新值，否则会锁住第一次渲染的闭包
  const onSelectRef = useRef(onSelectNode);
  const onExpandRef = useRef(onExpand);
  const selectedIdRef = useRef(selectedId);
  onSelectRef.current = onSelectNode;
  onExpandRef.current = onExpand;
  selectedIdRef.current = selectedId;

  /* ---------------- 客户端筛选：只留命中的节点和两端都在的边 ---------------- */

  const typed = data ?? null;
  const nodes = useMemo<GraphNode[]>(() => typed?.nodes ?? [], [typed]);
  const edges = useMemo<GraphEdge[]>(() => typed?.edges ?? [], [typed]);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return { nodes, edges };
    const keep = new Set<string>();
    const visible: GraphNode[] = [];
    nodes.forEach((node) => {
      const kindLabel = NODE_KIND_LABEL[node.kind] ?? node.kind;
      const haystack = `${node.label} ${node.kind} ${kindLabel} ${node.category}`.toLowerCase();
      if (haystack.includes(keyword)) {
        keep.add(node.id);
        visible.push(node);
      }
    });
    return { nodes: visible, edges: edges.filter((edge) => keep.has(edge.source) && keep.has(edge.target)) };
  }, [nodes, edges, query]);

  const degreeMap = useMemo(() => {
    const map = new Map<string, number>();
    filtered.edges.forEach((edge) => {
      map.set(edge.source, (map.get(edge.source) ?? 0) + 1);
      map.set(edge.target, (map.get(edge.target) ?? 0) + 1);
    });
    return map;
  }, [filtered.edges]);

  const neighbors = useMemo(() => {
    if (!selectedId) return [];
    const byId = new Map(filtered.nodes.map((node) => [node.id, node]));
    const rows: { key: string; type: string; node: GraphNode; evidenceRef: string }[] = [];
    filtered.edges.forEach((edge) => {
      if (edge.source !== selectedId && edge.target !== selectedId) return;
      const otherId = edge.source === selectedId ? edge.target : edge.source;
      const other = byId.get(otherId);
      if (!other) return;
      rows.push({ key: edge.id, type: edge.relationType, node: other, evidenceRef: edge.evidenceRef });
    });
    return rows;
  }, [filtered.edges, filtered.nodes, selectedId]);

  const categories = useMemo(
    () => Array.from(new Set(filtered.nodes.map((node) => node.category).filter(Boolean))).sort(),
    [filtered.nodes],
  );
  const colors = useMemo(() => categoryPalette(categories), [categories]);
  const maxCount = useMemo(
    () => filtered.nodes.reduce((max, node) => Math.max(max, node.count ?? 1), 1),
    [filtered.nodes],
  );

  const isEmpty = !typed || filtered.nodes.length === 0;
  const truncated = Boolean(typed && (typed.truncated.nodes || typed.truncated.edges));
  const selectedNodeForExpand = selectedId
    ? filtered.nodes.find((node) => node.id === selectedId) ?? null
    : null;

  /* ---------------- 尺寸：画布尺寸必须自己复核 ---------------- */

  useEffect(() => {
    const element = canvasEl;
    if (!element) return;
    const measure = () => setBox({ width: element.clientWidth, height: element.clientHeight });
    measure();
    let frame = 0;
    const observer = new ResizeObserver(() => {
      // 与 EChart 同一个理由：不在观察回调里同步改布局，交一帧再量
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    });
    observer.observe(element);
    // 进出全屏时父级的过渡动画会让第一帧量到旧尺寸，缓一帧重量一次即可收敛
    const settle = requestAnimationFrame(() => {
      requestAnimationFrame(measure);
    });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      cancelAnimationFrame(settle);
      observer.disconnect();
    };
  }, [canvasEl, expanded]);

  /* ---------------- 实例：画布一出现就建，切回空状态时销毁 ---------------- */

  useEffect(() => {
    const element = canvasEl;
    if (!element) return;
    // StrictMode 下挂载期 effect 会跑两遍，同一 DOM 上不能再 init 第二个实例
    const existing = echarts.getInstanceByDom(element);
    const instance = existing ?? echarts.init(element, undefined, { renderer: "canvas" });
    chart.current = instance;

    // 悬停提示不用内置 tooltip：内置 tooltip 会跟着指针每帧重排，面板只要一条稳定的行内提示。
    // 坐标从 ECharts 事件对象取（handler 的最后一个实参就是原生事件），
    // 用 params 上的 event 字段在某些版本里是 undefined。
    instance.on("mouseover", (params: unknown, event?: { offsetX?: number; offsetY?: number }) => {
      const payload = params as { dataType?: string; data?: GraphNode };
      if (payload.dataType !== "node" || !payload.data) return;
      const width = element.clientWidth;
      if (width <= 0) return;
      const point = nearestEdgeTip(width, event?.offsetX ?? 0, event?.offsetY ?? 0);
      setPointer({ id: payload.data.id, x: point.x, y: point.y });
    });
    instance.on("mouseout", () => setPointer(null));

    instance.on("click", (params: unknown) => {
      const payload = params as { dataType?: string; data?: GraphNode };
      const now = Date.now();
      const isSecondClick = now - lastClickAt.current < 320;
      lastClickAt.current = now;
      // 空白画布：ECharts 不会给 dataType，正好对应「取消选择」
      if (payload.dataType !== "node" || !payload.data) {
        onSelectRef.current(null);
        return;
      }
      /*
       * 双击的第二下也会派发 click。如果不吃掉它，双击的结果会变成「选中又取消」，
       * 而双击的本意是展开关联 —— 展开时保持选中，用户的动作才不会被回滚。
       */
      if (isSecondClick) return;
      onSelectRef.current(selectedIdRef.current === payload.data.id ? null : payload.data);
    });

    instance.on("dblclick", (params: unknown) => {
      const payload = params as { dataType?: string; data?: GraphNode };
      if (payload.dataType !== "node" || !payload.data) return;
      // 双击的第二下会先派发一次 click，展开同时选中该节点，用户不会觉得选择被吞掉
      onExpandRef.current?.(payload.data);
    });

    return () => {
      instance.dispose();
      chart.current = null;
    };
    // canvasEl 变化（切到空状态再切回来）时重建实例：旧 DOM 已经被 React 移除，
    // 继续往它上面画就是「数据都在、图是空白」。
  }, [canvasEl]);

  /* ---------------- option：视图切换才整体替换，其余情况合并以保住位置 ---------------- */

  const option = useMemo(() => {
    const { w, h } = stageBox(box.width, box.height);
    /*
     * 舞台尺寸变了（面板拉伸、进全屏）时把已有坐标等比缩放，而不是留着旧坐标：
     * 旧坐标会全部挤在左上角，读者第一眼会以为「图散了」，其实是量纲没跟上。
     */
    const previous = lastStage.current;
    if (previous && previous !== `${w}x${h}`) {
      const [pw, ph] = previous.split("x").map(Number);
      const sx = pw > 0 ? w / pw : 1;
      const sy = ph > 0 ? h / ph : 1;
      stageXY.current.forEach(([px, py], id) => {
        stageXY.current.set(id, [px * sx, py * sy]);
      });
      // 换量纲后必须让它们自己再落一次位，否则 x/y 与力导向内部坐标会对不上
      placed.current.clear();
    }
    const catIndex = new Map(categories.map((name, index) => [name, index]));
    const paletteByName = categories.map((name) => colors.get(name) ?? KB_CHART.palette[0]);
    const selectedNeighbors = new Set<string>();
    if (selectedId) {
      selectedNeighbors.add(selectedId);
      filtered.edges.forEach((edge) => {
        if (edge.source === selectedId) selectedNeighbors.add(edge.target);
        if (edge.target === selectedId) selectedNeighbors.add(edge.source);
      });
    }

    const seriesData = filtered.nodes.map((node, index) => {
      const kind = node.kind;
      const color = colors.get(node.category) ?? KB_CHART.palette[0];
      const size = nodeSize(node.count, maxCount);
      const tone = node.state ? STATE_TONE_HEX[node.state] : undefined;
      const focus = selectedId ? selectedNeighbors.has(node.id) : true;
      // 业务视图：确定性初值 + 力导向；血缘视图：只用后端给的固定分层坐标
      const memorized = stageXY.current.get(node.id);
      const point =
        view === "lineage"
          ? lineagePoint(node, w, h, index)
          : (memorized ?? polarPoint(node.id, w, h));
      stageXY.current.set(node.id, point);
      // 血缘视图本来就是固定坐标，谈不上「安置」，所以不写进 placed
      const settled = view === "lineage" || placed.current.has(node.id);
      if (view === "business") placed.current.add(node.id);

      return {
        id: node.id,
        name: node.label,
        category: catIndex.get(node.category) ?? 0,
        x: point[0],
        y: point[1],
        // 已经落过位的节点冻结：力导向只安置新来的，老位置不会被重新求解（PRD §8.2）
        fixed: settled,
        symbol: nodeShape(kind),
        symbolSize: selectedId === node.id ? size + 4 : size,
        // 悬停时把名称读全：缩放后只保留高优先级标签，标签本身就是高优先级（PRD §8.3）
        label: { show: true },
        itemStyle: {
          color,
          opacity: focus ? 1 : DIM_OPACITY,
          borderColor: tone ?? PLAIN_BORDER,
          borderWidth: node.state ? 2 : 1,
          borderRadius: kind === "chunkGroup" || kind === "indexVersion" ? 2 : 4,
          shadowBlur: selectedId === node.id ? 10 : 0,
          shadowColor: selectedId === node.id ? KB_CHART.palette[1] : "transparent",
        },
        emphasis: {
          scale: 1.12,
          itemStyle: { opacity: 1, borderColor: tone ?? KB_CHART.palette[1], borderWidth: 2 },
        },
        blur: { itemStyle: { opacity: DIM_OPACITY } },
        // 跨视图切换时用同一个 key 做形变，而不是闪一下重画
        universalTransition: { enabled: true, key: node.id },
        // 自定义字段：事件回调只认 data，页面需要的详情挂在节点上带走
        relationNode: node,
      };
    });

    const seriesLinks = filtered.edges.map((edge) => {
      const evidence = edge.evidenceRef ? `证据 ${edge.evidenceRef}` : edge.origin;
      const focus = selectedId ? edge.source === selectedId || edge.target === selectedId : true;
      const dashed = edge.relationType === DASH_RELATION;
      return {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        value: evidence,
        lineStyle: {
          color: dashed ? KB_CHART.palette[1] : "rgba(130, 180, 230, 0.5)",
          width: focus && selectedId ? 1.8 : 1,
          opacity: focus ? (dashed ? 0.9 : 0.72) : DIM_EDGE_OPACITY,
          type: dashed ? ("dashed" as const) : ("solid" as const),
          // 血缘视图必须直线：曲线会把「第几层到第几层」的对应关系搅乱
          curveness: view === "lineage" ? 0 : 0.04,
        },
        universalTransition: { enabled: true, key: edge.id },
      };
    });

    const palette = KB_CHART;
    const refresh = lastView.current !== view || lastStage.current !== `${w}x${h}` || lastFit.current !== refitNonce;
    lastView.current = view;
    lastStage.current = `${w}x${h}`;
    lastFit.current = refitNonce;

    return {
      refresh,
      option: {
        // 背景交给 CSS：ECharts 画布透出面板底，切全屏时不会出现第二种黑
        animation: true,
        animationDuration: 240,
        animationDurationUpdate: 200,
        animationEasing: "cubicOut",
        animationEasingUpdate: "cubicOut",
        universalTransition: { enabled: true, divideShape: "clone" },
        // 预算内（≤250 节点）动画多一点，超了就把节奏压掉，优先保证拖动跟手（PRD §8.2）
        animationThreshold: filtered.nodes.length + filtered.edges.length > 320 ? 120 : 600,
        textStyle: { fontFamily: "var(--font-ui), HarmonyOS Sans SC, sans-serif", color: palette.textSecondary },
        series: [
          {
            id: "kb-relation-graph",
            type: "graph",
            name: view === "business" ? "业务关联" : "索引血缘",
            // 关掉 ECharts 自带的类别循环：颜色由上面的 categoryPalette 定，保证同类别同色
            color: paletteByName,
            layout: view === "business" ? "force" : "none",
            // 血缘视图不参与任何模拟，forceLayout 必须为 null，否则旧布局会残留
            force:
              view === "business"
                ? {
                    initLayout: "none",
                    /*
                     * 斥力 / 边长 / 重心三个值是**在两种画布尺寸下都实测过**的：
                     *   150 / [60,130] / .08 → 图缩在画布中心一团；
                     *   260 / [70,150] / .07 → 节点被推到画布之外，只剩几个点可见；
                     *   190 / [60,140] / .09 → 铺得开且不越界，本值即为此。
                     * 力导向的平衡半径大致是 sqrt(repulsion × 节点数)，所以画布变高时
                     * 不是把斥力一路调大，而是维持「能铺开」的下限。
                     */
                    repulsion: 190,
                    edgeLength: [60, 140],
                    gravity: 0.09,
                    friction: 0.72,
                    // 布局只在初次成形时算一次，之后不再持续抖动（PRD §8.2）
                    layoutAnimation: false,
                  }
                : undefined,
            roam: true,
            draggable: true,
            // 保留 1:1：视图坐标已经是像素比例，缩放只改变可视范围
            preserveAspect: false,
            zoom: 1,
            top: 28,
            bottom: 28,
            left: 28,
            right: 28,
            label: {
              show: true,
              position: "right" as const,
              distance: 6,
              color: palette.textSecondary,
              fontSize: 11,
              formatter: (params: { data?: { relationNode?: GraphNode } }) => {
                const node = params.data?.relationNode;
                if (!node) return "";
                // 只给「聚合节点」和选中节点常显名称，其余靠悬停提示读；
                // 缩放时 ECharts 只保留高优先级标签，这里用聚合数量做优先级
                const aggregate = (node.count ?? 1) > 1 || node.focus === true || node.id === selectedId;
                return aggregate ? node.label : "";
              },
            },
            itemStyle: { borderColor: PLAIN_BORDER, borderWidth: 1 },
            lineStyle: { color: "rgba(130, 180, 230, 0.5)", width: 1, opacity: 0.72, curveness: 0.04 },
            // 方向用箭头表达（PRD §8.3），箭头画在目标端
            edgeSymbol: ["none", "arrow"],
            edgeSymbolSize: [0, 7],
            // 默认不显示边标签：边一多就是噪声，关系类型在图例和关联列表里读
            edgeLabel: { show: false },
            emphasis: {
              focus: "adjacency" as const,
              scale: 1.12,
              label: { show: true, color: palette.textPrimary },
              lineStyle: { width: 1.8, opacity: 0.95 },
            },
            blur: { itemStyle: { opacity: DIM_OPACITY }, lineStyle: { opacity: DIM_EDGE_OPACITY } },
            categories: categories.map((name) => ({ name }) as { name: string }),
            data: seriesData,
            links: seriesLinks,
          },
        ],
      } as Record<string, unknown>,
    };
  }, [box.height, box.width, categories, colors, filtered.edges, filtered.nodes, maxCount, refitNonce, selectedId, view]);

  useEffect(() => {
    const instance = chart.current;
    if (!instance) return;
    // 视图 / 舞台尺寸 / 适应视图变了才重建 series，其余（选中、筛选、悬停）一律合并：
    // 合并才能让 ECharts 把已有节点原地更新，力导向不会因为一次点击重排整图
    instance.setOption(option.option, { notMerge: option.refresh, lazyUpdate: true });
  }, [option]);

  /* ---------------- 键盘：Escape 退出全屏 ---------------- */

  useEffect(() => {
    if (!expanded) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // 全屏层是一次性的：同一次按键只收起一次，避免回调在多个面板间来回触发
      if (event.defaultPrevented) return;
      event.preventDefault();
      setPointer(null);
      onToggleExpand?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded, onToggleExpand]);

  const handleView = useCallback(
    (next: GraphView) => {
      if (next === view) return;
      setPointer(null);
      onViewChange(next);
    },
    [onViewChange, view],
  );

  const handleFit = useCallback(() => {
    setPointer(null);
    setRefitNonce((value) => value + 1);
  }, []);

  const hoveredNode = pointer ? filtered.nodes.find((node) => node.id === pointer.id) ?? null : null;

  /*
   * 非全屏时给的是「参考高度 + 可压缩」：`min-height` 让它在窄屏（1366×768 的
   * 内容区只有三百多像素）缩到 PRD §5.2 允许的 290px，而不是把任务区顶出屏幕；
   * 宽屏下父容器的 minmax(0,1fr) 会把它撑到该有的高度。
   */
  const shellStyle = expanded ? undefined : { height, minHeight: 290, flex: "1 1 auto" };

  return (
    <section
      className="kb-graph-panel"
      data-expanded={expanded ? "true" : "false"}
      style={shellStyle}
      aria-label="资产关系图">
      <style>{PANEL_CSS}</style>

      <header className="kb-graph-head">
        <h3 className="kb-graph-title">资产关系</h3>
        <span className="kb-graph-meta">
          {view === "business" ? "业务关联 · 力导向" : "索引血缘 · 固定分层"}
        </span>
        <span className="kb-graph-spacer" />
        {loading ? <span className="kb-graph-meta">加载中…</span> : null}
      </header>

      <div className="kb-graph-tools" role="toolbar" aria-label="关系图工具栏">
        <div className="kb-graph-seg" role="group" aria-label="视图切换">
          <button type="button" aria-pressed={view === "business"} onClick={() => handleView("business")}>
            业务关联
          </button>
          <button type="button" aria-pressed={view === "lineage"} onClick={() => handleView("lineage")}>
            索引血缘
          </button>
        </div>

        <label className="kb-graph-sr" htmlFor="kb-graph-filter">
          对象筛选
        </label>
        <input
          id="kb-graph-filter"
          className="kb-graph-input"
          type="search"
          value={query}
          placeholder="对象筛选：名称 / 类型"
          onChange={(event) => setQuery(event.target.value)}
        />

        <button
          type="button"
          className="kb-graph-btn"
          onClick={() => selectedNodeForExpand && onExpand?.(selectedNodeForExpand)}
          disabled={view !== "business" || !onExpand || !selectedNodeForExpand}>
          展开层级
        </button>

        <button type="button" className="kb-graph-btn" onClick={handleFit}>
          适应视图
        </button>

        {onToggleExpand ? (
          <button type="button" className="kb-graph-btn" onClick={onToggleExpand}>
            {expanded ? "收起视图" : "展开视图"}
          </button>
        ) : null}
      </div>

      <div className="kb-graph-body">
        <div className="kb-graph-canvas" style={expanded ? { flex: "1 1 auto" } : { flex: "1 1 auto", minHeight: 180 }}>
          {isEmpty ? (
            <div className="kb-graph-empty" role="status">
              <span>暂无关系数据</span>
              <span className="kb-graph-empty-sub">调整对象筛选后重试</span>
            </div>
          ) : (
            <>
              <div
                ref={setCanvasEl}
                className="kb-graph-chart"
                role="img"
                aria-label={`${view === "business" ? "业务关联" : "索引血缘"}图，${filtered.nodes.length} 个节点，${filtered.edges.length} 条关系；节点明细见下方关联列表`}
              />
              {hoveredNode ? (
                <div
                  className="kb-graph-tip"
                  role="status"
                  style={{ left: pointer?.x ?? 0, top: pointer?.y ?? 0 }}>
                  <div className="kb-graph-tip-name">{hoveredNode.label}</div>
                  <div className="kb-graph-tip-row">
                    <span>类型</span>
                    <b>{NODE_KIND_LABEL[hoveredNode.kind] ?? hoveredNode.kind}</b>
                  </div>
                  <div className="kb-graph-tip-row">
                    <span>关联数</span>
                    <b>{degreeMap.get(hoveredNode.id) ?? hoveredNode.degree ?? 0}</b>
                  </div>
                  {hoveredNode.detail ? <div className="kb-graph-tip-row">{hoveredNode.detail}</div> : null}
                </div>
              ) : null}
            </>
          )}
        </div>

        <div className="kb-graph-foot">
          <span>
            范围 {typed?.scopeCounts.assets ?? 0} 项资产 · 当前显示 {filtered.nodes.length} 节点 /{" "}
            {filtered.edges.length} 条关系
          </span>
          {truncated ? <span className="kb-graph-foot-note">继续筛选或收起其他节点</span> : null}
        </div>

        <div className="kb-graph-legend">
          <span className="kb-graph-legend-group">
            {(
              [
                ["roundRect", NODE_SHAPE_LABEL.object],
                ["circle", NODE_SHAPE_LABEL.asset],
                ["diamond", NODE_SHAPE_LABEL.version],
              ] as const
            ).map(([shape, label]) => (
              <span className="kb-graph-legend-item" key={shape}>
                <i className="kb-graph-mark" data-shape={shape} />
                {label}
              </span>
            ))}
          </span>
          <span className="kb-graph-legend-group">
            <span>类别</span>
            {categories.map((name) => (
              <span className="kb-graph-legend-item" key={name}>
                <i
                  className="kb-graph-mark"
                  data-shape="circle"
                  style={{ background: hexToRgba(colors.get(name) ?? KB_CHART.palette[0], 0.85), borderColor: "transparent" }}
                />
                {name}
              </span>
            ))}
          </span>
          <span className="kb-graph-legend-group">
            <span>大小＝聚合数量</span>
            <i className="kb-graph-mark" data-shape="circle" data-size="s" />
            <i className="kb-graph-mark" data-shape="circle" data-size="m" />
            <i className="kb-graph-mark" data-shape="circle" data-size="l" />
          </span>
          <span className="kb-graph-legend-group">
            <span>状态＝边框</span>
            {(Object.keys(STATE_TONE) as AssetIndexState[]).map((state) => (
              <span className="kb-graph-legend-item" key={state}>
                <i className="kb-graph-mark" data-shape="circle" style={{ borderColor: STATE_TONE[state], borderWidth: 2 }} />
                {state}
              </span>
            ))}
          </span>
          <span className="kb-graph-legend-group">
            <span>关系类型</span>
            {(typed?.relationTypes ?? []).map((type) => (
              <span className="kb-graph-legend-item" key={type}>
                <i className="kb-graph-legend-line" data-dash={type === DASH_RELATION ? "true" : "false"} />
                {type}
              </span>
            ))}
          </span>
        </div>
      </div>

      <div className="kb-graph-list">
        <div className="kb-graph-list-head">
          {selectedId ? `关联列表 · ${neighbors.length} 条` : "关联列表 · 单击节点后显示一跳邻居"}
        </div>
        <ul aria-label="关联列表">
          {neighbors.map((row) => (
            <li key={row.key}>
              <button
                type="button"
                className="kb-graph-row"
                onClick={() => onSelectNode(row.node)}
                title={`${row.type} · ${row.node.label} · ${row.evidenceRef}`}>
                <span className="kb-graph-row-type">{row.type}</span>
                <span className="kb-graph-row-name">{row.node.label}</span>
                <span className="kb-graph-row-ref">{row.evidenceRef}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

export default RelationGraph;
