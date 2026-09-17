/**
 * 照片处理批次 · 纯逻辑（用户 2026-09-22 给的「处理」包）
 *
 * ── 用户口径 ──────────────────────────────────────────────────────
 * 「将我现在给的东西呈现到固件及模型，训练验证，新旧对比中」。
 * 那批东西是：`处理完毕/` 1,312 张处理后影像（HEIC 按四宫格切出的单块，1512×2016）、
 * `已标注照片/` 27 张人工标注原片（3024×4032）、`原文件名对照表.csv` 1,312 行
 * （新文件名 ← 原文件名 ← 源照片 + 位号）。
 *
 * 「新旧」在这一页的口径：**处理前**是原始拍摄件（`IMG_xxxx.HEIC`，包内未附原片，
 * 但四块按位号拼回就是原构图），**处理后**是编号件（`sxs2026092200NNN.jpg`）。
 * 页面如实这么写，不假装手里有 HEIC 原片。
 *
 * ── 为什么数据直接读 CSV 而不生成一份清单 ────────────────────────
 * 对照表就是用户给的原件（已按字节原样放进 `public/photo-batch-20260922/mapping.csv`），
 * 页面读它、解析它 —— 只有一份事实源，不存在"生成的清单和原件对不上"这种漂移。
 * 行数、位号分布、一一对应关系在 `photoSetLogic.test.ts` 里对**真实文件**断言。
 */

/** 位号 → 方位（对照表表头里写死的口径，改字会与用户原件对不上） */
export const POSITION_LABEL: Record<1 | 2 | 3 | 4, string> = {
  1: "左上",
  2: "右上",
  3: "左下",
  4: "右下",
};

export type PhotoPosition = 1 | 2 | 3 | 4;

export const PHOTO_POSITIONS: PhotoPosition[] = [1, 2, 3, 4];

export type PhotoMappingRow = {
  /** 处理后的编号件 */
  newName: string;
  /** 处理前的原始命名（IMG_xxxx_N.jpg） */
  oldName: string;
  /** 原始拍摄件（IMG_xxxx.HEIC） */
  source: string;
  /** 位号 */
  pos: PhotoPosition;
};

export type PhotoSourceGroup = {
  source: string;
  /** 四块，按位号排序 */
  crops: PhotoMappingRow[];
};

/** 对照表的存放位置（静态资源，跟页面同源；原件字节未改，见测试里的 sha256 钉住） */
export const MAPPING_CSV_URL = "/photo-batch-20260922/mapping.csv";
/** 服务端只读映射前缀（见 server/services/photo-set.mjs） */
export const PHOTO_MEDIA_BASE = "/photos";

/** 处理后影像的地址：`thumb` 走缩略图（网格/墙），否则是原件（点开看大图） */
export function processedUrl(newName: string, options: { thumb?: boolean } = {}): string {
  return `${PHOTO_MEDIA_BASE}/${options.thumb ? "thumb/" : ""}processed/${encodeURIComponent(newName)}`;
}

/** 已标注原片的地址 */
export function annotatedUrl(name: string, options: { thumb?: boolean } = {}): string {
  return `${PHOTO_MEDIA_BASE}/${options.thumb ? "thumb/" : ""}annotated/${encodeURIComponent(name)}`;
}

/**
 * 解析对照表。
 *
 * 容错但**不猜**：字段数不对、位号不是 1–4 的行一律进 `errors`（页面据此提示
 * "对照表有 N 行读不出来"），不静默丢掉 —— 少一行就意味着少一块影像。
 */
export function parsePhotoMapping(text: string): { rows: PhotoMappingRow[]; errors: string[] } {
  const rows: PhotoMappingRow[] = [];
  const errors: string[] = [];
  const lines = String(text).replace(/^\uFEFF/, "").split(/\r?\n/);
  const seen = new Set<string>();

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    /* 表头：第一行（也容忍换过顺序的文件里表头不在第一行） */
    if (index === 0 || /^新文件名/.test(trimmed)) return;

    const parts = trimmed.split(",").map((item) => item.trim());
    if (parts.length !== 4) {
      errors.push(`第 ${index + 1} 行字段数不是 4：${trimmed.slice(0, 60)}`);
      return;
    }
    const [newName, oldName, source, posText] = parts;
    const pos = Number(posText) as PhotoPosition;
    if (!newName || !oldName || !source || !PHOTO_POSITIONS.includes(pos)) {
      errors.push(`第 ${index + 1} 行内容不合法：${trimmed.slice(0, 60)}`);
      return;
    }
    if (seen.has(newName)) {
      errors.push(`第 ${index + 1} 行新文件名重复：${newName}`);
      return;
    }
    seen.add(newName);
    rows.push({ newName, oldName, source, pos });
  });

  return { rows, errors };
}

/** 按源照片分组（每组四块按位号排序）——四宫格拼回原构图就靠这个 */
export function groupBySource(rows: PhotoMappingRow[]): PhotoSourceGroup[] {
  const map = new Map<string, PhotoMappingRow[]>();
  for (const row of rows) {
    const list = map.get(row.source) ?? [];
    list.push(row);
    map.set(row.source, list);
  }
  return [...map.entries()]
    .map(([source, crops]) => ({
      source,
      crops: [...crops].sort((a, b) => a.pos - b.pos),
    }))
    .sort((a, b) => a.source.localeCompare(b.source));
}

/** 关键词过滤：新编号 / 原文件名 / 源照片都能搜（大小写不敏感） */
export function filterMapping(rows: PhotoMappingRow[], query: string): PhotoMappingRow[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((row) =>
    [row.newName, row.oldName, row.source].some((field) => field.toLowerCase().includes(needle)),
  );
}

/** 分页（表格用）；页码越界时夹回有效范围，不给出空表 */
export function pageSlice<T>(items: T[], page: number, size: number): { items: T[]; page: number; pages: number; total: number } {
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / size));
  const safePage = Math.min(Math.max(1, Math.floor(page) || 1), pages);
  const start = (safePage - 1) * size;
  return { items: items.slice(start, start + size), page: safePage, pages, total };
}

/** 概览统计：全部由解析结果推出，不写死 */
export function summarizePhotoSet(rows: PhotoMappingRow[]) {
  const sources = new Set(rows.map((row) => row.source));
  const byPosition = PHOTO_POSITIONS.map((pos) => ({
    pos,
    label: POSITION_LABEL[pos],
    count: rows.filter((row) => row.pos === pos).length,
  }));
  const incomplete = groupBySource(rows).filter((group) => group.crops.length !== PHOTO_POSITIONS.length);
  return {
    total: rows.length,
    sourceCount: sources.size,
    byPosition,
    /** 四块不齐的源照片：位号缺号说明包本身不完整，页面要敢说 */
    incomplete: incomplete.map((group) => group.source),
  };
}

/** 源照片编号区间的可读描述（如 IMG_0467–IMG_0794），给"与已标注照片无交集"那句话用 */
export function sourceRange(rows: PhotoMappingRow[]): string {
  const numbers = rows
    .map((row) => Number(/(\d{3,})/.exec(row.source)?.[1] ?? NaN))
    .filter((value) => Number.isFinite(value));
  if (!numbers.length) return "—";
  const min = Math.min(...numbers);
  const max = Math.max(...numbers);
  /* 两端都补零到 4 位：只补一端会写成 IMG_0467–IMG_794 这种看着像两个体系的区间 */
  const label = (value: number) => `IMG_${String(value).padStart(4, "0")}`;
  return min === max ? label(min) : `${label(min)}–${label(max)}`;
}

/** 已标注原片与对照表的源照片有没有交集（页面据此决定"单独成组"还是"配对展示"） */
export function annotatedOverlap(rows: PhotoMappingRow[], annotated: string[]): string[] {
  const sources = new Set(rows.map((row) => row.source.replace(/\.heic$/i, "")));
  return annotated.filter((name) => sources.has(name.replace(/\.jpe?g$/i, "")));
}
