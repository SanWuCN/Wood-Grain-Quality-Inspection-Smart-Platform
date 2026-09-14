/**
 * 小木形象方案展台 · 渲染宿主与**唯一**的 rAF 循环
 *
 * ── 为什么整个展台只能有一个 requestAnimationFrame ──────────────────
 * 9 个方案各订阅一个 rAF，会变成三件事同时出错：
 *   1. 9 份互相抢帧的回调，帧率谁都不准（而"实测 FPS"是本页的交付物之一）；
 *   2. **全局暂停做不到**：`paused` 只能一个个广播，中间那几毫秒画面还在动，
 *      截图工装量到的双帧像素差就不是 0 —— 用户会看到"按了暂停还在动"；
 *   3. 每个方案各写一遍暂停/焦点/测帧，等于把同一段逻辑抄 9 遍。
 * 所以：**一个 rAF 驱动全部**，方案只实现 `update(dt)` 与 `dispose()`。
 *
 * ── 本模块负责什么 ──────────────────────────────────────────────────
 *   LabLoop            循环、帧时钟、全局暂停、FPS 计量与合格判定
 *   舞台的建立与尺寸重排（resize 只 `setSize`，**不重建上下文**）
 *   单格失败隔离（某格抛错 → 只有那格显示提示，其余照常）
 *   上下文预算与降级提示（REQ-01 AC4/AC5）
 *
 * ── 本模块**不**负责什么 ────────────────────────────────────────────
 *   格子的 DOM 结构、标题文字、放大态样式 —— 那些在 `main.ts`。
 *   换句话说：这里只认 `VariantHandle`，不认识"格子长什么样"。
 *
 * ⚠ 老方法版（09）不建 WebGL 上下文：它只拿 `host` 元素，`stage` 用不上。
 *    差异只体现在 `LabVariant.needsWebGL` 一个布尔上 —— 循环本身不分叉。
 */

import { createFpsMeter, FPS_WINDOW_MS, type FpsMeter } from "./fps.ts";
import { createStage, type Stage } from "./shared.ts";
import type { LabVariant, VariantHandle, VariantRuntime } from "./types.ts";

/* ══════════════════════════════════════════════════════════════════
 * 默认参数
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 固定随机种子。
 *
 * 为什么写死：截图的**可重复性**是证据工装的前提 —— 同一个方案两次跑出
 * 略微不同的球，"双帧像素差"就分不清是"在动"还是"每次都不一样"。
 */
export const DEFAULT_SEED = 20260914;

/**
 * 清晰度倍率上限。
 *
 * `min(devicePixelRatio, 2)`：3x 屏上 9 块画布是 9 倍像素量，
 * 而展台要的是"都在动"，不是"都超清"。
 */
export function pixelRatioCap(): number {
  return Math.min(typeof devicePixelRatio === "number" ? devicePixelRatio : 1, 2);
}

/* ══════════════════════════════════════════════════════════════════
 * 类型
 * ══════════════════════════════════════════════════════════════════ */

/** 一格：一个方案 + 它自己的舞台/句柄/帧率表 */
export interface LabTile {
  variant: LabVariant;
  /** 该格的渲染宿主元素（WebGL 版会往里插一块 canvas） */
  host: HTMLElement;
  /** 这一格是否活着（初始化失败或降级时为 false） */
  ready: boolean;
  /** 初始化失败的原因；正常时为 null */
  error: string | null;
  handle: VariantHandle | null;
  stage: Stage | null;
  meter: FpsMeter;
  /** 宽度变化时通知这一格（宿主分发，方案作者不用管 resize 事件） */
  refit: ((width: number, height: number) => void) | null;
}

export interface LabLoopOptions {
  /** 每帧把该格的实测 FPS 回填到 DOM 上（由 main.ts 提供标签元素） */
  onFrame?: (tile: LabTile, fps: number) => void;
  /** WebGL 上下文预算。超出时按顺序把后面的 WebGL 格降级为静态占位 */
  contextBudget?: number;
}

/* ══════════════════════════════════════════════════════════════════
 * 错误呈现
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 把"这一格失败了"变成看得懂的一行字。
 *
 * 为什么不用 console.error 了事：失败的是**用户要用来做决策的展台**，
 * 一格空白（或一格纯灰）会被理解成"这一版没做"，而不是"这一版初始化失败了"。
 * REQ-01 AC3 要的就是这个区别。
 */
function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * 在格子中间贴一块"这一格失败了"的提示（不遮其它格）。
 *
 * ⚠ 整个函数体**必须能容忍没有 DOM**：它是失败路径上唯一的收尾动作，
 * 一旦它自己抛错，真正的失败原因（比如着色器编译不过）就被顶掉了 ——
 * 用户看到的是"document is not defined"，排查方向直接跑偏。
 * 这个坑是 `loop.test.ts` 的失败隔离用例当场抓出来的（Node 里没有 document）。
 */
export function markTileFailed(host: HTMLElement, message: string): void {
  try {
    host.classList?.add("lab-cell__canvas--failed");
    const doc = host.ownerDocument ?? globalThis.document;
    if (!doc) return;
    const box = doc.createElement("div");
    box.className = "lab-cell__fail";
    box.setAttribute("role", "note");
    const title = doc.createElement("strong");
    title.textContent = "这一版初始化失败";
    const detail = doc.createElement("span");
    detail.textContent = message;
    box.append(title, detail);
    host.append(box);
  } catch {
    // 提示渲染失败不是"再抛一次"的理由：调用方已经把 error 记在 tile.error 上了
  }
}

/* ══════════════════════════════════════════════════════════════════
 * 循环
 * ══════════════════════════════════════════════════════════════════ */

export class LabLoop {
  /** 注册顺序 = 页面左上到右下的顺序（编号即顺序） */
  readonly tiles: LabTile[] = [];

  private readonly onFrame?: (tile: LabTile, fps: number) => void;
  private readonly contextBudget: number;

  /** 全局暂停。**优先于单格状态**（REQ-04 AC5 / UC-03 备选 4b） */
  private paused = false;

  /** 当前放大独显的那一格；没有放大时为 null */
  private focused: LabTile | null = null;

  /**
   * 只看不动的诊断出口：把这一格的 three 对象暴露出去。
   *
   * 为什么值得留一个后门：构图类问题（球多大、脸占多少、有没有被裁）**在截图上
   * 只能靠眼睛估**，而"眼睛估"会把 0.14 世界单位的眼片看成"占了半个球"。
   * 有了它，探针可以直接问 three 要世界包围盒（`Box3.setFromObject`），
   * 结论是数字而不是观感。它不改变任何状态，也不给写入接口。
   */
  inspect(variantId: string): { tile: LabTile; stage: Stage | null } | null {
    const tile = this.tiles.find((t) => t.variant.id === variantId);
    return tile ? { tile, stage: tile.stage } : null;
  }

  private rafId = 0;
  private lastFrameMs = 0;
  private started = false;

  /** 全局 WebGL 上下文计数（含已失败的，用来判断预算） */
  private contexts = 0;

  /** 预算不足时被降级（不建上下文）的方案 id，页面据此显式提示（REQ-01 AC4） */
  readonly degraded: string[] = [];

  /**
   * **运行期**（首帧之后）抛错被停掉的格子。
   *
   * 与 `degraded` 分开记：一个是"压根没启动"，一个是"跑着跑着挂了"。
   * 混在一起会让排查方向跑偏（去看上下文预算，而真因是某个 update 里的空指针）。
   */
  readonly runtimeFailures: { id: string; error: string }[] = [];

  constructor(options: LabLoopOptions = {}) {
    this.onFrame = options.onFrame;
    this.contextBudget = options.contextBudget ?? 8;
  }

  /**
   * 挂一格方案。
   *
   * ⚠ 这里是**唯一**会调用 `variant.create()` 的地方，也是唯一的失败隔离点：
   * 需要 WebGL 的方案先建舞台，建不出来（没有 WebGL2 / 上下文超限 / 方案自己抛）
   * 就只毁这一格。
   */
  attach(variant: LabVariant, host: HTMLElement): LabTile {
    const tile: LabTile = {
      variant,
      host,
      ready: false,
      error: null,
      handle: null,
      stage: null,
      meter: createFpsMeter(FPS_WINDOW_MS),
      refit: null,
    };
    this.tiles.push(tile);

    const { width, height } = measure(host);

    try {
      let stage: Stage | null = null;
      if (variant.needsWebGL) {
        if (this.contexts >= this.contextBudget) {
          // 预算用尽：**不静默少画**，记下来由页面显式提示（REQ-01 AC4）
          this.degraded.push(variant.id);
          throw new Error(
            `WebGL 上下文预算已用尽（上限 ${this.contextBudget} 个），这一版降级为静态占位`,
          );
        }
        stage = createStage({ host, width, height });
        this.contexts += 1;
      }

      const runtime: VariantRuntime = variant.create(
        host,
        {
          width,
          height,
          pixelRatioCap: pixelRatioCap(),
          seed: DEFAULT_SEED,
        },
        /**
         * 老方法版拿到的是 `undefined`（它不需要舞台）。
         * 需要 WebGL 的版本由上面那段保证 stage 一定存在，所以这里**不做断言**：
         * 要是哪一版把 needsWebGL 标错了，它会在自己第一行 `.scene` 上抛出，
         * 被下面的 catch 隔在那一格里，页面显示"这一版初始化失败"（REQ-01 AC3）。
         */
        stage ?? undefined,
      );

      tile.stage = stage;
      tile.handle = this.wrap(runtime, stage, tile);
      /**
       * ⚠ 新挂上来的格子必须**继承循环当前的状态**。
       *
       * 不继承的后果：用户在暂停状态下让某些格重建（切走再切回、窗口重排触发重建、
       * 或页面按需追加一格），按钮还亮着"继续播放"（`aria-pressed="true"`），
       * 但新格子照跑 —— 状态与视觉不一致，正是 REQ-04 AC3 要防的。
       * 这个坑是 `loop.test.ts` 的「不推进时间轴」用例当场抓出来的。
       */
      tile.handle.setPaused(this.shouldTilePause(tile));
      tile.handle.setFocused(this.focused === tile);
      tile.refit = (w, h) => {
        if (!tile.stage) return;
        tile.stage.resize(w, h, pixelRatioCap());
      };
      // 尺寸与舞台对齐（首帧之前就设好，避免第一帧用错比例）
      tile.refit(width, height);
      tile.ready = true;
    } catch (err) {
      tile.error = describeError(err);
      markTileFailed(host, tile.error);
    }

    return tile;
  }

  /**
   * 把方案作者交出来的 `{update, dispose}` 补成完整句柄。
   *
   * 暂停/焦点/FPS 三件事**只在这里实现一次**：否则 9 个方案各写一遍，
   * 迟早有一版漏掉暂停 —— 而"按了暂停还在动"正是 UC-03 备选 4a 要防的。
   */
  private wrap(runtime: VariantRuntime, stage: Stage | null, tile: LabTile): VariantHandle {
    let paused = false;
    let focused = false;
    /**
     * 这一格自己的时间轴。
     *
     * 为什么宿主要替方案攒一个时钟：主体的**倾斜摆动**（复刻参考图那个角度）
     * 是宿主统一驱动的（见 `shared.ts` 的 `SUBJECT_TILT`），而它必须和方案内容
     * 一起在暂停时定住 —— 否则暂停后球的偏转还在慢慢游移，双帧像素差就不是 0，
     * 截图工装会判"暂停失败"。所以时钟放在暂停闸门**之后**累加。
     */
    let ownClock = 0;
    return {
      update: (dt: number) => {
        // 暂停时**不推进时间轴**：画面必须停在同一帧（双帧像素差 ≈ 0）
        if (paused) return;
        ownClock += dt;
        stage?.tilt(ownClock);
        runtime.update(dt);
      },
      dispose: () => {
        // 幂等：宿主可能在"重排"和"卸载"两处都调一次
        try {
          runtime.dispose();
        } finally {
          stage?.dispose();
        }
      },
      setPaused: (value: boolean) => {
        paused = value;
      },
      /**
       * 放大态标记。
       *
       * ⚠ 这里**故意只记不用**：`LabVariant.create()` 拿不到 handle（它自己就是
       * 被 create 造出来的），所以放大态只能"存下来供查询" —— 而"放大时其余格
       * 暂停、只留被放大那格重绘"这件事已经在 `renderFrame()` 里按 `this.focused`
       * 做掉了。真正需要知道放大态的是**调试与截图工装**：它们要能问一句
       * "这一格现在是不是放大态"，而不是靠读 CSS class 猜。
       * 方案作者想据焦点改细节时，可以在 `update()` 里读 `renderStats().focused`。
       */
      setFocused: (value: boolean) => {
        focused = value;
      },
      renderStats: () => ({
        // 实测值来自 rAF 时间戳，不是估算（REQ-06 AC2）
        fps: tile.meter.value(),
        // 当前状态一起回传，工装不必再去读 DOM
        paused,
        focused,
      }),
    };
  }

  /** 启动循环。重复调用是空操作（幂等）。 */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.rafId = requestAnimationFrame(this.tick);
  }

  stop(): void {
    this.started = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  /** 单帧。**测试与截图工装可以直接调它**，不必等 rAF。 */
  readonly tick = (now: number): void => {
    if (!this.started) return;
    const dt = this.lastFrameMs === 0 ? 0 : Math.min((now - this.lastFrameMs) / 1000, 0.25);
    this.lastFrameMs = now;
    this.renderFrame(dt, now);
    this.rafId = requestAnimationFrame(this.tick);
  };

  /**
   * 推进并渲染全部格子。
   *
   * `dt` 已按 0.25s 上限夹住：切标签页回来时 rAF 的间隔可能是几十秒，
   * 直接喂进去会让所有动画"跳"一大步 —— 看起来像坏了。
   */
  renderFrame(dt: number, nowMs: number = performance.now()): void {
    for (const tile of this.tiles) {
      if (!tile.ready || !tile.handle) continue;
      const focusedElsewhere = this.focused !== null && this.focused !== tile;
      if (this.paused) continue;
      // 放大某一格时，其余格暂停 —— 省下的 GPU 全给被放大那一格（UC-02 step 2）
      if (focusedElsewhere) continue;

      /**
       * ⚠ `update()` / `render()` 必须**逐格**保护。
       *
       * 这里原先是裸调用。一次 `stage.tiltGroup` 为 undefined（接口漏声明）就让
       * 8 个方案的首帧 update 抛错 —— 而抛在 rAF 回调里，**异常会把 `tick()` 后半段
       * 的 `requestAnimationFrame` 一起带走：整个展台永久停摆**，页面上却是
       * "9/9 就绪、有 FPS、无报错"。这类"静默全身瘫痪"是最难查的一种。
       *
       * 现在的行为：某一格每帧抛错 → 只停这一格（从 ready 摘掉并显示提示），
       * 其余格照常跑；错误进 `tile.error` 与 `degraded`，页面上看得见。
       */
      try {
        tile.handle.update(dt);
        tile.stage?.render();
      } catch (err) {
        tile.ready = false;
        tile.error = `渲染中抛错（该格已停）：${describeError(err)}`;
        this.runtimeFailures.push({ id: tile.variant.id, error: tile.error });
        if (tile.stage) markTileFailed(tile.host, tile.error);
        continue;
      }
      // 暂停中不喂时间戳：那量到的是浏览器空转的帧率，属于虚报（见 fps.ts 顶部说明）
      tile.meter.push(nowMs);
      this.onFrame?.(tile, tile.meter.value());
    }
  }

  /* ── 全局暂停（REQ-04）────────────────────────────────────────── */

  isPaused(): boolean {
    return this.paused;
  }

  /**
   * 切到指定暂停态（`undefined` = 取反）。
   *
   * 做成**幂等的目标态**而不是 toggle：快速连点（UC-03 备选 4a）时，
   * toggle 会把两次点击抵消成"没变"，而按目标态写则最后一次点击永远胜出。
   */
  setPaused(value?: boolean): boolean {
    const next = value ?? !this.paused;
    if (next === this.paused) return this.paused;
    this.paused = next;
    for (const tile of this.tiles) tile.handle?.setPaused(this.shouldTilePause(tile));
    if (!next) {
      // 恢复播放：时间戳与帧率都重新起算，不然窗口里混着暂停前的老样本
      this.lastFrameMs = 0;
      for (const tile of this.tiles) tile.meter.reset();
    }
    return this.paused;
  }

  /* ── 放大与还原（REQ-03 / UC-02）─────────────────────────────── */

  focusedTile(): LabTile | null {
    return this.focused;
  }

  /**
   * 放大某一格；传 null 还原。
   *
   * ⚠ 关键行为：**全局暂停优先**。暂停中放大某一格，那一格也必须保持暂停 ——
   * 否则用户按了暂停、点开一格看细节，画面却又动起来（REQ-03 AC4 / UC-02 备选 4b）。
   */
  setFocused(variantId: string | null): void {
    const next = variantId === null ? null : this.tiles.find((t) => t.variant.id === variantId) ?? null;
    const previous = this.focused;
    if (previous === next) return;
    this.focused = next;

    for (const tile of this.tiles) {
      tile.handle?.setFocused(tile === next);
      // 放大态 ≠ 播放态：暂停中不得因为放大而恢复渲染
      tile.handle?.setPaused(this.shouldTilePause(tile));
      // 放大前后帧率要重新计量，不能沿用格子态的数值（REQ-03 AC3）
      tile.meter.reset();
    }
    this.lastFrameMs = 0;
  }

  /**
   * 这一格**现在**该不该暂停 —— 全展台唯一的暂停判据。
   *
   * 两条规则，优先级从高到低：
   *   1. 全局暂停了就都暂停（REQ-04 AC5：全局优先于单格）；
   *   2. 有格子被放大时，**只有被放大那一格**继续渲染，其余暂停（UC-02 step 2）。
   *
   * ⚠ 抽成一个函数是**踩过坑**才做的：原来这条判据在 `setPaused()` 里写成了
   * `next || this.focused !== tile`，而 `focused === null` 时 `null !== tile` 恒为
   * `true` —— 于是"恢复播放"反而把**每一格**都暂停了：按钮显示已恢复，
   * 画面却永远定住。这个坑是 `loop.test.ts` 的「不推进时间轴」用例抓出来的
   * （恢复后 update 次数一直是 1，不再增长）。
   * 两个调用点（`setPaused` / `setFocused`）共用同一份判据，就不会再次各写各的。
   */
  private shouldTilePause(tile: LabTile): boolean {
    if (this.paused) return true;
    return this.focused !== null && this.focused !== tile;
  }

  /* ── 尺寸重排（REQ-05 AC4）────────────────────────────────────── */

  /**
   * 按新的格子尺寸重排全部舞台。
   *
   * **只 `setSize`，不重建上下文**：连续缩放窗口时每帧重建一次 WebGL 上下文，
   * 浏览器会在十几帧内耗尽上下文配额，后面的格子直接变黑。
   */
  refitAll(measureHost: (tile: LabTile) => { width: number; height: number }): void {
    for (const tile of this.tiles) {
      if (!tile.ready) continue;
      const size = measureHost(tile);
      if (size.width <= 0 || size.height <= 0) continue;
      tile.refit?.(size.width, size.height);
    }
  }

  /** 真的把资源放掉（页面卸载时调） */
  dispose(): void {
    this.stop();
    for (const tile of this.tiles) {
      if (!tile.ready) continue;
      tile.handle?.dispose();
      tile.handle = null;
      tile.stage = null;
      tile.ready = false;
    }
    this.tiles.length = 0;
    this.contexts = 0;
  }
}

/* ══════════════════════════════════════════════════════════════════
 * 能力探测
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 这台机器能不能开 WebGL2。
 *
 * 为什么不用 `WebGL.isWebGLAvailable()` 那类库：只探测一次、只用一次，
 * 建一块 1×1 的离屏 canvas 问一句就够，不值得为它引依赖。
 * 拿到上下文后**立刻丢掉**（`loseContext`），否则这一句探测本身就占掉一个配额 ——
 * 9 格 + 1 次探测正好可能顶到上限。
 */
export function detectWebGL2(): boolean {
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2");
    if (!gl) return false;
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return true;
  } catch {
    return false;
  }
}

/** 量一个格子的可用渲染尺寸（CSS 像素） */
export function measure(host: HTMLElement): { width: number; height: number } {
  const rect = host.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  return { width, height };
}
