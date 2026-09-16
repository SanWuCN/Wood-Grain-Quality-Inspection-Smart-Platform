/**
 * 红头委托预览的**展示数据推导**（唯一事实源 = 工单详情）
 *
 * 用法（组件侧）：
 *   import { buildCommissionView } from "./commissionView";
 *   const view = buildCommissionView(detail);   // 纯函数，无副作用、无 IO、无路由
 *
 * ── 为什么把这一步单独拿出来 ─────────────────────────────────────────
 * 委托文件是政府 / 文保类演示材料，"写错一个字"比"样式丑"严重得多，
 * 所以把「详情 → 要显示的文字」这一步做成可被 Node 原生测试逐个证伪的纯函数：
 *
 *   · 组件只负责画，不负责判断该显示什么；
 *   · 每个字段只有一条来源，缺了就退回占位符，**绝不用常识补全**；
 *   · `restricted` 为真时正文与附件在**推导阶段**就砍掉，
 *     不依赖渲染层"记得不画"（漏一次就是权限事件）。
 *
 * 本模块不做、也永远不会做：OCR、图片文字解析、从标题里猜正文、按文件名补内容。
 */
import type { WorkOrderDetail } from "../../api/client";

/* ------------------------------------------------------------------ *
 * 缺失口径：全平台只有这一处定义
 * ------------------------------------------------------------------ */

/** 附件清单为空时的明确说法（PRD / 交接文档 §附件未明确信息 的固定措辞） */
export const ATTACHMENT_UNKNOWN = "附件未明确";

/** 单个字段缺失时的占位符；不写"暂无""未知"这类会被误读成结论的词 */
export const FIELD_PLACEHOLDER = "—";

/** 视觉上的样例标记（印章与角标共用，避免两处写法漂移） */
export const DEMO_LABEL = "版式样张";

/** 受限账号能看到的说明，语气与项目既有空态一致 */
export const RESTRICTED_NOTE = "当前账号未获准查看委托正文与随单附件，仅显示本账号可见的摘要。";

/* ------------------------------------------------------------------ *
 * 返回结构（组件按它渲染，字段名即语义）
 * ------------------------------------------------------------------ */

export type CommissionSummaryItem = { k: string; v: string };
export type CommissionAttachmentView = { name: string; kind: string; sizeText: string };

export type CommissionView = {
  /** 受限详情：正文与附件一律不下发到展示层 */
  restricted: boolean;
  /** 红头区的委托单位 */
  headUnit: string;
  /** 委托标题 */
  title: string;
  /** 正文段落（受限时为空数组） */
  paragraphs: string[];
  /** 落款单位 */
  signUnit: string;
  /** 落款日期（已排成中文写法，原文为 ISO 时才转换） */
  signDate: string;
  /** 附件清单（受限时为空数组） */
  attachments: CommissionAttachmentView[];
  /** 缺失项清单：附件为空时含「附件未明确」 */
  placeholders: string[];
  /** 受限时唯一可见的摘要（工单详情自身的字段，不做推断） */
  summary: CommissionSummaryItem[];
  /** 受限说明；可看全量时为空串 */
  restrictedNote: string;
};

/* ------------------------------------------------------------------ *
 * 文本归一化
 * ------------------------------------------------------------------ */

/** 只有"缺了"才用占位符：数字 0、`false` 这类合法值不会被误判成缺失 */
function present(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number") return Number.isFinite(value);
  return true;
}

function text(value: unknown, fallback: string): string {
  if (!present(value)) return fallback;
  return String(value).replace(/\s+/g, " ").trim();
}

/**
 * 日期展示：接口给 ISO（`2026-09-16`）时排成中文写法；
 * 已经是中文（服务端 `dateText`）或其它写法时**原样返回**，绝不重排、不猜。
 */
function dateText(value: unknown, fallback: string): string {
  const raw = text(value, "");
  if (!raw) return fallback;
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!matched) return raw;
  const [, year, month, day] = matched;
  return `${year} 年 ${Number(month)} 月 ${Number(day)} 日`;
}

/**
 * 正文切段：**只切分，不增删一个字**。
 *
 * `paragraphs.join("") === 原文` 是必须保住的硬约束（测试盯着），
 * 所以这里只做两件事：
 *   1. 原文自带换行时按行成段（作者已经排好的版不重排）；
 *   2. 单行长文按中文句末标点切，切完把过短的残句并回上一段，
 *      避免出现「于 2026 年 9 月 18 日」这种只有半句的段。
 */
function splitParagraphs(value: unknown): string[] {
  const raw = typeof value === "string" ? value.replace(/\r\n?/g, "\n").trim() : "";
  if (!raw) return [];

  const byLine = raw
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (byLine.length > 1) return byLine;

  const sentences = raw.match(/[^。！？；]*[。！？；]+|[^。！？；]+$/g) ?? [];
  const paragraphs: string[] = [];
  for (const piece of sentences) {
    const sentence = piece.trim();
    if (!sentence) continue;
    const previous = paragraphs[paragraphs.length - 1];
    if (previous && (sentence.length < 12 || previous.length < 12)) {
      paragraphs[paragraphs.length - 1] = previous + sentence;
      continue;
    }
    paragraphs.push(sentence);
  }
  return paragraphs;
}

function attachmentNameOf(attachment: { name?: unknown } | null | undefined): string {
  return text(attachment?.name, FIELD_PLACEHOLDER);
}

/* ------------------------------------------------------------------ *
 * 主函数
 * ------------------------------------------------------------------ */

/**
 * 从工单详情推导红头委托预览要显示的全部**可读内容**。
 *
 * 纯函数：同样的 detail 永远得到同样的 view，不读全局、不写 DOM、不碰路由。
 */
export function buildCommissionView(detail: WorkOrderDetail): CommissionView {
  const source = detail as unknown as {
    restricted?: unknown;
    order?: Record<string, unknown> | null;
    commission?: Record<string, unknown> | null;
  };
  const order = source?.order ?? {};
  const commission = source?.commission ?? {};

  /* 受限判定只看 restricted 字段本身：不按"正文长不长""附件有没有"反推 */
  const restricted = source?.restricted === true;

  const headUnit = text(commission.unit, FIELD_PLACEHOLDER);
  const title = text(commission.title, FIELD_PLACEHOLDER);
  const signUnit = text(commission.unit, FIELD_PLACEHOLDER);
  const signDate = dateText(commission.dateText ?? commission.date, FIELD_PLACEHOLDER);
  const rawAttachments = Array.isArray(commission.attachments) ? commission.attachments : [];

  const attachments: CommissionAttachmentView[] = restricted
    ? []
    : rawAttachments.map((item: { name?: unknown; kind?: unknown; sizeText?: unknown }) => ({
        name: attachmentNameOf(item),
        kind: text(item?.kind, FIELD_PLACEHOLDER),
        sizeText: text(item?.sizeText, FIELD_PLACEHOLDER),
      }));

  const paragraphs = restricted ? [] : splitParagraphs(order.requirementsText);

  /* 缺失项汇总：界面照单列出，读者一眼看到"这里没有原文"，而不是看到一段编的话 */
  const missing = new Set<string>();
  if (headUnit === FIELD_PLACEHOLDER) missing.add(`委托单位${FIELD_PLACEHOLDER}`);
  if (title === FIELD_PLACEHOLDER) missing.add(`委托标题${FIELD_PLACEHOLDER}`);
  if (signDate === FIELD_PLACEHOLDER) missing.add(`委托日期${FIELD_PLACEHOLDER}`);
  if (!restricted) {
    if (paragraphs.length === 0) missing.add("委托正文未明确");
    if (attachments.length === 0) missing.add(ATTACHMENT_UNKNOWN);
    else if (attachments.some((item) => item.name === FIELD_PLACEHOLDER)) {
      missing.add(`附件名称${FIELD_PLACEHOLDER}`);
    }
  }
  const placeholders = [...missing].sort();

  const summary: CommissionSummaryItem[] = [
    { k: "工单编号", v: text(order.orderNo, FIELD_PLACEHOLDER) },
    { k: "标题", v: text(order.title, FIELD_PLACEHOLDER) },
    { k: "状态", v: text(order.status, FIELD_PLACEHOLDER) },
    { k: "地点", v: text(order.location, FIELD_PLACEHOLDER) },
    { k: "创建时间", v: text(order.createdAt, FIELD_PLACEHOLDER).replace("T", " ").slice(0, 16) },
  ];

  return {
    restricted,
    headUnit,
    title,
    paragraphs,
    signUnit,
    signDate,
    attachments,
    placeholders,
    summary,
    restrictedNote: restricted ? RESTRICTED_NOTE : "",
  };
}
