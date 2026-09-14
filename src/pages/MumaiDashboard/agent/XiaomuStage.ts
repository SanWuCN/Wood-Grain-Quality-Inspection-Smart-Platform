/**
 * 小木浮标的**位置与尺寸**：拖拽、实时缩放、视口限界、记忆。
 *
 * ── 参考的商业做法 ──────────────────────────────────────────────────
 * 这类"悬浮形象 + 气泡"的交互在国内外的客服/助手组件里已经收敛到同一套：
 *   · 用 **Pointer Events**（而不是 mouse + touch 各写一套）—— 一套代码覆盖鼠标/触屏/笔；
 *   · 拖动时对**视口做夹取**，不允许拖出可视区（Intercom 式浮标都是这个行为）；
 *   · 位置与尺寸**持久化**，刷新后保持用户调整过的样子。
 * 这三条都落在下面的纯函数里，可单测。
 *
 * ── 为什么把纯函数单独导出 ──────────────────────────────────────────
 * "夹取"这件事的坑全在边界条件上：
 *   · 对话框比形象宽得多，**限界必须按"形象与对话框的并集"算**，只按形象算会让面板出屏；
 *   · 尺寸变化后，原来合法的位置可能变成非法（形象变大后右下角会出屏）；
 *   · 视口缩小（浏览器窗口被拖小）时也要重新夹取。
 * 这些都不是"看一眼就知道对不对"的，所以写成纯函数 + 单测。
 */

/** 位置的表示：以**右下角**为锚（与原来的 CSS `right/bottom` 一致，改动最小） */
export type StagePos = {
  /** 距视口右边（px）。≥ 0 */
  right: number;
  /** 距视口下边（px）。≥ 0 */
  bottom: number;
};

export type StageSize = {
  /** 形象边长（px），正方形 */
  size: number;
};

export type StageRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/** 尺寸上下限：下限要保证"球"仍可辨认；上限按用户要求"极限大小翻一倍"（240 → 480） */
export const SIZE_MIN = 72;
export const SIZE_MAX = 480;
/**
 * 上限还要**跟着视口收**：480px 的形象在 700px 高的窗口里会占掉三分之二，
 * 还得留出对话框的位置。取"视口短边的 62%"与 SIZE_MAX 的较小者。
 */
export const SIZE_VIEWPORT_RATIO = 0.62;

/** 按视口算出实际可用的上限 */
export function maxSizeForViewport(vw: number, vh: number): number {
  if (!Number.isFinite(vw) || !Number.isFinite(vh) || vw <= 0 || vh <= 0) return SIZE_MAX;
  const byViewport = Math.floor(Math.min(vw, vh) * SIZE_VIEWPORT_RATIO);
  return Math.max(SIZE_MIN, Math.min(SIZE_MAX, byViewport));
}

export const SIZE_DEFAULT = 132;

/**
 * 默认尺寸按**视口高度**分档。
 *
 * ⚠ 这段逻辑以前写在 CSS 的 `@media (max-height: 820px)` 里
 * （`.xd__avatar { width: 72px }`）。加了拖动缩放之后它就成了 bug 源：
 * 媒体查询里的 `width` 会**盖掉**用户拖出来的内联尺寸，
 * 现象是"拖了把手但形象不变大"（用户口径："拉不到缩放按钮"）。
 *
 * 现在分工明确：
 *   · **默认值**（用户没调过）按视口分档 → 短屏自动收一档，气泡不会顶出视口
 *   · **用户调过的值**以用户为准，不再被媒体查询覆盖
 * 短屏那一档取 72 是为了兼容既有的验收口径（`验收界面.mjs` 的 avatarMin = 72）。
 */
export function defaultSizeForViewport(vh: number): number {
  if (!Number.isFinite(vh) || vh <= 0) return SIZE_DEFAULT;
  if (vh <= 820) return 72;
  return SIZE_DEFAULT;
}
/** 距视口边缘的最小留白：贴边会让阴影被裁、也不好点 */
export const EDGE_GAP = 8;

/** 夹取尺寸到合法区间；非有限值回落默认 */
export function clampSize(size: number): number {
  if (!Number.isFinite(size)) return SIZE_DEFAULT;
  return Math.min(SIZE_MAX, Math.max(SIZE_MIN, Math.round(size)));
}

/**
 * 把一个矩形夹进视口。
 *
 * @param rect   要放的东西（形象与对话框的并集）
 * @param vw/vh  视口尺寸
 * @returns 夹取后的左上角坐标（保证整个 rect 都在视口内）
 */
export function clampRectToViewport(rect: StageRect, vw: number, vh: number): { x: number; y: number } {
  /*
    若 rect 比视口还大，`max` 会小于 `min`，此时取"贴左上角" ——
    这与"尽量露出内容"的直觉一致，也避免出现负的可用宽度。
  */
  const maxX = Math.max(EDGE_GAP, vw - rect.width - EDGE_GAP);
  const maxY = Math.max(EDGE_GAP, vh - rect.height - EDGE_GAP);
  return {
    x: Math.min(Math.max(EDGE_GAP, rect.x), maxX),
    y: Math.min(Math.max(EDGE_GAP, rect.y), maxY),
  };
}

/**
 * 由"右下角锚点 + 尺寸 + 并集尺寸"算出实际左上角坐标。
 *
 * 并集 = 形象 + 对话框：对话框在形象旁边展开，两者的外接矩形才是真正要限界的东西。
 * 这里按"对话框在形象左侧、垂直方向与形象底部对齐"的布局算并集
 * （与 `xiaomuDock.css` 的 `.xd__panel` 定位一致）。
 */
export function unionRect(pos: StagePos, size: StageSize, panel: { width: number; height: number } | null, vw: number, vh: number): StageRect {
  const avatarRight = vw - pos.right;
  const avatarBottom = vh - pos.bottom;
  const avatarLeft = avatarRight - size.size;
  const avatarTop = avatarBottom - size.size;
  if (!panel) return { x: avatarLeft, y: avatarTop, width: size.size, height: size.size };
  /* 面板在形象左侧、底边与形象底边对齐（允许面板更高时向上溢出） */
  const panelRight = avatarLeft - 8;
  const panelLeft = panelRight - panel.width;
  const panelBottom = avatarBottom;
  const panelTop = panelBottom - panel.height;
  const x = Math.min(avatarLeft, panelLeft);
  const y = Math.min(avatarTop, panelTop);
  return {
    x,
    y,
    width: Math.max(avatarRight, panelRight) - x,
    height: Math.max(avatarBottom, panelBottom) - y,
  };
}

/**
 * 把"右下角锚点"夹到合法范围。
 *
 * ── 优先级（视口太小、物理上无法两全时按这个顺序牺牲）────────────────
 * 1. **并集左上角不越界** —— 跑到屏幕左上外面就彻底看不见了，最严重
 * 2. **形象本体完整可见** —— 它是拖动把柄，抓不到就再也拖不回来
 * 3. 并集右下角 —— 允许溢出（面板比视口高时无解，这不算错）
 *
 * ⚠ 踩过"过约束"：一开始想写成"并集四边都在视口内"，但面板高约 420px，
 * 视口一旦小于"面板 + 形象 + 留白"就**物理上不可能**满足，判据必然失败。
 * 诚实的做法是把优先级写清楚，并在**两条都做不到**时回落到默认位置
 * （而不是给出一个越界的值）。
 *
 * 视口足够大时（正常桌面），这些优先级会自然导出"并集四边都在留白内"。
 */
export function clampPos(
  pos: StagePos,
  size: StageSize,
  panel: { width: number; height: number } | null,
  vw: number,
  vh: number,
): StagePos {
  const maxRight = Math.max(EDGE_GAP, vw - size.size - EDGE_GAP);
  const maxBottom = Math.max(EDGE_GAP, vh - size.size - EDGE_GAP);

  /* 只按形象本体夹锚点：保证把柄抓得到 */
  const avatarOnly: StagePos = {
    right: Math.min(Math.max(EDGE_GAP, pos.right), maxRight),
    bottom: Math.min(Math.max(EDGE_GAP, pos.bottom), maxBottom),
  };
  if (!panel) return avatarOnly;

  /* 在只按形象夹取的基础上，再看并集左上角是否越界 */
  const rect = unionRect(avatarOnly, size, panel, vw, vh);
  const pushed: StagePos = {
    right: Math.max(0, rect.x < EDGE_GAP ? avatarOnly.right - (EDGE_GAP - rect.x) : avatarOnly.right),
    bottom: Math.max(0, rect.y < EDGE_GAP ? avatarOnly.bottom - (EDGE_GAP - rect.y) : avatarOnly.bottom),
  };

  /*
    验证推完之后两条硬约束是否**同时**成立：
      · 并集左上角不越界
      · 形象本体完整可见（锚点在 [0, vw-132] 内）
    做不到就说明视口小到无解，回落到默认位置 —— 那是一个"用户熟悉、且不会被
    任何一次 resize 越推越偏"的稳定值。
  */
  const check = unionRect(pushed, size, panel, vw, vh);
  const unionOk = check.x >= EDGE_GAP - 0.001 && check.y >= EDGE_GAP - 0.001;
  const avatarOk = pushed.right >= 0 && pushed.right <= maxRight && pushed.bottom >= 0 && pushed.bottom <= maxBottom;
  if (unionOk && avatarOk) return pushed;
  return { right: Math.min(24, maxRight), bottom: Math.min(120, maxBottom) };
}

/**
 * 拖动：由按下点与当前点算新的右下角锚点。
 *
 * 用**增量**而不是绝对坐标：绝对坐标要求知道元素当前的 left/top，
 * 而我们是 right/bottom 锚定，换算一次反而多一处出错机会。
 */
export function posFromDrag(start: StagePos & { x: number; y: number }, dx: number, dy: number): StagePos {
  return { right: Math.max(0, start.right - dx), bottom: Math.max(0, start.bottom - dy) };
}

/**
 * 缩放：由拖动距离算新尺寸。
 *
 * 把手在右下角，**向右下拖 = 变大**。
 *
 * ⚠ 取两轴**平均**，不是取较大者。踩过：`Math.max(dx, dy)` 在"斜着往左上拖"时
 * 会挑到较小的那个负数（dx=-10、dy=-30 → 取 -10），用户拖了一大段却只缩一点点，
 * 手感是"不跟手"。平均值在**单轴拖动**时退化为该轴的距离（另一轴≈0），
 * 在斜拖时等于两轴位移的均值 —— 两种情况都跟手。
 */
export function sizeFromResize(startSize: number, dx: number, dy: number, vw?: number, vh?: number): number {
  const cap = vw !== undefined && vh !== undefined ? maxSizeForViewport(vw, vh) : SIZE_MAX;
  return Math.min(cap, clampSize(startSize + (dx + dy) / 2));
}

/**
 * 缩放时**保持左上角不动**。
 *
 * ── 为什么需要这一步（用户口径）──────────────────────────────────────
 * 「现在的右下角拖动之后是向左上角缩放」。
 * 位置是以**右下角**为锚存的（`right`/`bottom`），所以尺寸一变，
 * 视觉上就是"往左上方向长"—— 右下角钉住、左上角跑掉。
 * 而把手在右下角，用户的心理模型是"我把右下角往外拉"，
 * 期望**左上角不动、右下角跟着手走**。
 *
 * 换算：要让左上角保持不动，尺寸增加多少，`right`/`bottom` 就要各减少多少
 * （离右边/下边的距离变大是因为元素本身变大了）。
 */
export function resizeKeepingTopLeft(
  pos: StagePos,
  prevSize: number,
  nextSize: number,
): StagePos {
  const delta = nextSize - prevSize;
  return {
    right: Math.max(0, pos.right - delta),
    bottom: Math.max(0, pos.bottom - delta),
  };
}

/** 读写记忆（localStorage 不可用时静默放弃，不影响功能） */
const STORE_KEY = "mumai.xiaomu.stage.v1";

export type StageMemory = { pos: StagePos | null; size: number };

export function readStageMemory(): StageMemory {
  const fallback: StageMemory = { pos: null, size: SIZE_DEFAULT };
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<StageMemory>;
    const size = clampSize(Number(parsed.size ?? SIZE_DEFAULT));
    const p = parsed.pos;
    const pos = p && Number.isFinite(p.right) && Number.isFinite(p.bottom)
      ? { right: Math.max(0, Number(p.right)), bottom: Math.max(0, Number(p.bottom)) }
      : null;
    return { pos, size };
  } catch {
    return fallback;
  }
}

export function writeStageMemory(memory: StageMemory): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(memory));
  } catch {
    /* 隐私模式下 localStorage 会抛错；记忆失败不该影响拖动本身 */
  }
}
