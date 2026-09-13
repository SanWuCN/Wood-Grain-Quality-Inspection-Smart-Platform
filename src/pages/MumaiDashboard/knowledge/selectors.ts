/**
 * 数据与知识中心 · 视图派生（纯函数，无 React）
 *
 * 依据：PRD §6.1（视觉与文案规范）、§7.2（指标定义）、§9.1（三套状态分开表达）。
 *
 * 这里只做「把服务端给的事实翻译成界面用的语气与文案」，**不重算任何统计**：
 * 数字一律来自 /api/knowledge/*，页面里不允许再出现第二套统计逻辑
 * （PRD §15「selectors.ts 视图派生，禁止独立硬编码统计」）。
 */

import type {
  AssetAvailability,
  AssetIndexState,
  JobStatus,
  KnowledgeAsset,
  Metrics,
  Overview,
  SearchHit,
} from "./types";

/* ------------------------------------------------------------------ *
 * 数值与时间
 * ------------------------------------------------------------------ */

/** 千位分隔；数量、分块、日志条数都用它，保证同一页只有一种数字写法 */
export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return value.toLocaleString("en-US");
}

/** 覆盖率：分母为 0 时显示「—」而不是误导性的 100%（PRD §7.2） */
export function formatCoverage(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return value.toFixed(1);
}

export function formatBytes(bytes: number | null | undefined): string {
  const value = Number(bytes ?? 0);
  if (!value) return "—";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "—";
  if (seconds < 60) return `${Math.round(seconds)} 秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)} 小时`;
  return `${(seconds / 86400).toFixed(1)} 天`;
}

/**
 * 服务端存 UTC、界面按 Asia/Shanghai 展示（PRD §7.3）。
 * 同一天的只显示时间，跨天补月-日，跨年补年份 —— 一行里不出现无意义的重复日期。
 */
export function formatMoment(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "—";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "—";
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(at);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const stamp = `${pick("year")}-${pick("month")}-${pick("day")}`;
  const time = `${pick("hour")}:${pick("minute")}`;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date(now));
  if (stamp === today) return time;
  const sameYear = pick("year") === String(new Date(now).getFullYear());
  return sameYear ? `${pick("month")}-${pick("day")} ${time}` : `${stamp} ${time}`;
}

/** 资产 12.5px 表格里的紧凑写法：只到分钟 */
export function formatDay(iso: string | null | undefined): string {
  if (!iso) return "—";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "—";
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(at);
}

/* ------------------------------------------------------------------ *
 * 状态语气（文字与颜色必须同时出现，颜色只表达语义）
 * ------------------------------------------------------------------ */

export type Tone = "ok" | "warn" | "danger" | "info" | "muted";

export function indexStateTone(state: AssetIndexState): Tone {
  switch (state) {
    case "已覆盖":
      return "ok";
    case "待更新":
      return "warn";
    case "处理中":
      return "info";
    case "更新失败":
      return "danger";
    default:
      return "muted";
  }
}

export function availabilityTone(value: AssetAvailability): Tone {
  switch (value) {
    case "可用":
      return "ok";
    case "待补充内容":
      return "warn";
    case "文件缺失":
      return "danger";
    default:
      return "muted";
  }
}

export function jobStatusTone(status: JobStatus): Tone {
  switch (status) {
    case "成功":
      return "ok";
    case "部分成功":
      return "warn";
    case "失败":
      return "danger";
    case "运行":
    case "排队":
      return "info";
    default:
      return "muted";
  }
}

/** 资产详情里的「索引来源版本」提示：旧版继续服务时必须显式说明（PRD §10.2） */
export function sourceVersionNote(asset: KnowledgeAsset): string | null {
  if (asset.indexedRevision === null) return null;
  if (asset.indexedRevision === asset.contentRevision) return null;
  return `来源版本 v${asset.indexedRevision}，存在更新`;
}

/* ------------------------------------------------------------------ *
 * 六项指标（唯一一处把 metrics 变成卡片的地方）
 * ------------------------------------------------------------------ */

export type MetricCard = {
  key: string;
  label: string;
  value: string;
  unit?: string;
  hint?: string;
  tone: "default" | "accent" | "warn" | "danger";
  /** 点击行为（PRD §7.2）；null 表示这一项不可点 */
  action: { kind: "tab"; tab: "assets" | "indexes"; filter?: Record<string, string> } | null;
};

/**
 * 指标卡：严格按 PRD §7.2 的六项，一张不多一张不少。
 *
 * 「可展开明细 / 规模样本」曾经也做成两张卡，但那是个错误：
 *   · §7.2 规定顶部就是六项，多出来两张会把这一行从「指标」变成「指标 + 说明」；
 *   · 它们不是指标，而是**数据层说明** —— 总量里有多少能点开、多少只是计数。
 * 所以这两层的关系改用一句话说明（sampledNote）+ 各面板自己的「共 X 项 · 可展开 Y 项」
 * 呈现，读者在任何一处看到的都是同一组数字，而指标行仍然只有六张卡。
 */
export function metricCards(metrics: Metrics, servingVersion: string | null): MetricCard[] {
  return [
    {
      key: "total",
      label: "资产总量",
      value: formatCount(metrics.total),
      unit: "项",
      hint: servingVersion ? `当前服务版本 ${servingVersion}` : "尚未建立索引",
      tone: "default",
      action: { kind: "tab", tab: "assets" },
    },
    {
      key: "coverage",
      label: "索引覆盖率",
      value: formatCoverage(metrics.coveragePct),
      unit: metrics.coveragePct === null ? undefined : "%",
      hint: metrics.coveragePct === null ? "暂无纳入资产" : `${formatCount(metrics.covered)} / ${formatCount(metrics.included)} 项`,
      tone: "accent",
      action: { kind: "tab", tab: "indexes" },
    },
    {
      key: "chunks",
      label: "有效分块",
      value: formatCount(metrics.chunks),
      hint: "当前服务版本可访问的分块",
      tone: "default",
      action: { kind: "tab", tab: "indexes" },
    },
    {
      key: "vectors",
      label: "向量条目",
      value: formatCount(metrics.vectors),
      hint: "演示索引模式 · 一块一条",
      tone: "default",
      action: { kind: "tab", tab: "indexes" },
    },
    {
      key: "pending",
      label: "待更新",
      value: formatCount(metrics.pending),
      unit: "项",
      hint: metrics.longestWaitSeconds ? `最长等待 ${formatDuration(metrics.longestWaitSeconds)}` : "无待处理变更",
      tone: "warn",
      action: { kind: "tab", tab: "assets", filter: { state: "待更新" } },
    },
    {
      key: "error",
      label: "更新异常",
      value: formatCount(metrics.error),
      unit: "项",
      hint: metrics.error ? "最近一次构建失败，尚未重试" : "没有失败项",
      tone: metrics.error ? "danger" : "default",
      action: { kind: "tab", tab: "assets", filter: { state: "更新失败" } },
    },
  ];
}

/**
 * 指标行下方的一句话说明：点明「总量里只有一部分能点开」。
 *
 * 必须放在指标正下方：看到「资产总量 167,110 项」的人下一步就去列表里翻，
 * 不在这里先说明，列表页的「共 X 项 · 其中 Y 项可展开明细」会被当成漏数据。
 *
 * **必须一行放得下**（≤ 60 字）：它每多占一行就从左栏两张卡上各扣 24px，
 * 而卡里的表格正是要保住的东西。细分口径（哪些主类、规模样本的排除原因）
 * 在各面板自己的 note 与「数据说明」抽屉里，不挤这一行。
 */
export function sampledNote(metrics: Metrics): string {
  if (!metrics.scale) return `共 ${formatCount(metrics.total)} 项，全部提供可展开明细`;
  return `共 ${formatCount(metrics.total)} 项 · ${formatCount(metrics.materialized)} 项可展开明细 · `
    + `${formatCount(metrics.scale)} 项规模样本只参与统计`;
}

/** 「共 X 项 · 其中 Y 项可展开明细」的统一说法，列表与卡片共用 */
export function sampledHint(total: number, materialized: number): string {
  const scale = Math.max(0, total - materialized);
  if (!scale) return `共 ${formatCount(total)} 项，全部提供明细`;
  return `共 ${formatCount(total)} 项 · 其中 ${formatCount(materialized)} 项可展开明细（其余 ${formatCount(scale)} 项为规模样本）`;
}

/* ------------------------------------------------------------------ *
 * 覆盖分布（堆叠条 + 每类数字）
 * ------------------------------------------------------------------ */

export type CoverageSegments = {
  type: string;
  label: string;
  covered: number;
  pending: number;
  error: number;
  excluded: number;
  processing: number;
  total: number;
  /** 规模（不可展开的历史归档）与可展开明细 */
  scale: number;
  materialized: number;
  scaleNote: string | null;
  /** 该主类在当前服务版本里的有效分块数 */
  chunks: number;
  /** 各段的百分比（按 materialized 归一），供 CSS 变量使用 */
  pct: { covered: number; pending: number; error: number; excluded: number; processing: number };
};

/**
 * 覆盖堆叠条的百分比按 **materialized** 归一，不按 total。
 *
 * 理由：规模样本没有分块、没有索引成员记录，把它们算进分母会让每一类的进度条
 * 都变成一条几乎全空的长条（54,160 张照片里只有 120 张有明细），
 * 那不是「覆盖率低」，而是两种数据层被混在了一起。
 */
export function coverageSegments(overview: Overview | null): CoverageSegments[] {
  if (!overview) return [];
  return overview.coverage.map((row) => {
    const base = Math.max(1, row.materialized);
    const pct = (value: number) => Number(((value / base) * 100).toFixed(3));
    return {
      ...row,
      pct: {
        covered: pct(row.covered),
        pending: pct(row.pending),
        error: pct(row.error),
        excluded: pct(row.excluded),
        processing: pct(row.processing),
      },
    };
  });
}

/* ------------------------------------------------------------------ *
 * 检索结果
 * ------------------------------------------------------------------ */

/** 是否属于「低相关候选」：低于阈值但仍有词面命中，界面折叠展示（PRD §5.5） */
export function isLowCandidate(hit: SearchHit, threshold: number): boolean {
  return hit.score < threshold;
}

/** 分数显示：一位小数百分比。它是检索相似度，不是病害置信度。 */
export function formatScore(score: number): string {
  return score.toFixed(4);
}

/** 结果卡的第二行摘要：两行封顶，超出由 CSS 截断，不在这里做字符串截断 */
export function hitSummary(hit: SearchHit): string {
  return hit.snippet || "（该分块没有可预览文本）";
}

/* ------------------------------------------------------------------ *
 * 资产列表的展示列（默认列不超过 9 个，PRD §5.3）
 * ------------------------------------------------------------------ */

export const ASSET_TABLE_COLUMNS = [
  { key: "select", label: "", width: 36 },
  { key: "title", label: "名称", width: 0 },
  { key: "type", label: "类型", width: 76 },
  { key: "object", label: "关联对象", width: 128 },
  { key: "source", label: "来源", width: 92 },
  { key: "updatedAt", label: "更新时间", width: 112 },
  { key: "version", label: "当前版本", width: 88 },
  { key: "indexState", label: "索引状态", width: 100 },
  { key: "more", label: "", width: 44 },
] as const;

/** 「原始附件未随演示包提供」的判定：不能出现可点却无文件的下载按钮（PRD §11.2） */
export function attachmentState(asset: KnowledgeAsset): { downloadable: boolean; note: string | null } {
  if (asset.fileId) return { downloadable: true, note: null };
  return { downloadable: false, note: "原始附件未随演示包提供" };
}

/** 阶段进度文案：进度只能用完成记录数表达，没有独立计时器（PRD §9.3） */
export function stageSummary(processed: number, total: number): string {
  if (!total) return "进行中";
  if (processed >= total) return `已处理 ${total}/${total} 项`;
  return `已处理 ${processed}/${total} 项`;
}
