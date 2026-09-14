/**
 * 小木形象方案展台 · FPS 实测与合格判据（REQ-06 AC2/AC3，UC-01 step 5）
 *
 * ── 这个模块只做一件事：把"多少帧"变成"敢写进对照表的数" ──────────────
 * 对照表里那一列 FPS 是用户做决策的直接依据（"这版跑不动就不选"）。
 * 所以它有两个不能妥协的性质：
 *   · **实测**：喂进来的是 rAF 的真实时间戳，不是估算；
 *   · **不虚报**：窗口没填满、连持续时长都没到 3 秒时，`isPassing()` 必须是 false，
 *     不能在数字好看的时候就提前放行。
 *
 * ── 为什么"合格"要看两个量而不是一个 ────────────────────────────────
 *   value()        最近 1000ms 的平均帧率 —— 回答"现在多快"。
 *   isPassing()    窗口填满 + 值 ≥30 + **已连续 ≥3000ms** —— 回答"稳不稳"。
 * 只看前者的话，一个启动时编译着色器卡 2 秒、之后勉强 31 FPS 的版本会被判合格；
 * 而用户点开它的时候，第一眼看到的就是那 2 秒的卡。3 秒门槛把这段抓出来。
 *
 * ── ⚠ 全局暂停期间不要 push() ───────────────────────────────────────
 * 暂停时画面不重绘，但 rAF 还在跑。若照喂不误，窗口值会被"暂停期间的帧率"
 * 顶上去 —— 那是浏览器空转的帧率，不是这一版的渲染帧率，属于虚报。
 * 调用方（`shared.ts` 的 LabLoop）在暂停时跳过 push，本模块不做这个判断：
 * 它不认识"暂停"，只认识时间戳。
 */

/** 采样窗口（ms）。1 秒是 design.md 定死的值 */
export const FPS_WINDOW_MS = 1000;

/** 合格门槛（FPS）。动效要"看得出在动"，30 是硬指标 */
export const PASS_FPS = 30;

/** 连续合格时长门槛（ms）。只看窗口值会被启动卡顿骗过 */
export const PASS_STREAK_MS = 3000;

/**
 * 窗口内最多留多少个时间戳。
 *
 * 1000ms @240FPS 是 240 个，留一倍余量。有上限是必须的：
 * 暂停中若被误喂（或未来有人接了别的帧源），无上限的数组就是一处慢性泄漏。
 */
const MAX_SAMPLES = 512;

/**
 * 保留边界的宽容量（ms）。
 *
 * ⚠ 这个常数是**踩过一次坑**才有的：第一版的裁剪规则是
 * `stamp < now - windowMs` 就丢。于是窗口里最老的样本永远比 `now` 新不到 1000ms
 * 一点点（60FPS 下稳定在 983ms）——`span >= windowMs` 这个"窗口已填满"的判据
 * **永远不成立**，`isPassing()` 恒为 false。
 * 实测：连续喂 5 秒 60FPS，`passingForMs()` 一直是 0。
 *
 * 修法：裁剪时多留一个"刚滑出窗口"的样本（最多 250ms 之前）。
 * 这样窗口跨度落在 [1000, 1250] 区间内，"填满"能在 1 秒出头成立，
 * 而稳态下 span ≈ 1000 + 一帧间隔，算出来的帧率仍然准。
 * 250ms 也顺带是"一帧到底能有多长"的上界：比这更长的间隔本身就是卡顿，
 * 不该继续占着窗口位置。
 */
const KEEP_MARGIN_MS = 250;

export interface FpsMeter {
  /** 喂一个 rAF 时间戳（ms，来自 `requestAnimationFrame(now)`）。乱序/重复会被忽略 */
  push(nowMs: number): void;
  /** 最近 FPS_WINDOW_MS 的平均帧率。样本不足 2 个时返回 0（一帧算不出帧率） */
  value(): number;
  /** 窗口内的时间戳个数。给"是否填满"和内存占用做断言用 */
  sampleCount(): number;
  /** 是否已连续 ≥PASS_STREAK_MS 保持"窗口填满且 value() ≥ PASS_FPS" */
  isPassing(): boolean;
  /** 已连续合格了多久（ms）。从未合格过时是 0 */
  passingForMs(): number;
  /** 清空重来。放大态要重新计量 FPS（UC-02 AC3）时必须调它 */
  reset(): void;
}

export function createFpsMeter(windowMs: number = FPS_WINDOW_MS): FpsMeter {
  /** 环形缓冲。用数组 + 头指针而不是 shift()：shift 是 O(n)，每帧都调 */
  const stamps: number[] = [];
  let head = 0;
  let last = Number.NEGATIVE_INFINITY;

  /** 连续合格是从哪一刻开始的（ms）；未在合格状态时为 null */
  let passSince: number | null = null;

  /**
   * 上一次 push 的间隔（ms）。
   *
   * 判"卡顿"用的是**帧间间隔**，不是"窗口里最老样本到现在的距离"：
   * 窗口宽 1000ms，那个距离在任何时刻都 ≈1000ms，用它当判据会把
   * "连续合格"永远打断（第一版就是这么写的，测试当场抓到：
   * 「连续满 3 秒」永远不成立）。
   */
  let lastGap = 0;

  /**
   * 历史上出现过一次长卡顿。
   *
   * 为什么要单独记一个脏位：卡顿发生后，窗口里的低帧率样本会**慢慢滑出**，
   * 于是 `value()` 会先从低值回升 —— 但"连续合格 ≥3 秒"这件事已经被打断了，
   * 必须重新完整攒满 3 秒才能再判合格。只有把"被打断过"记下来，
   * 才能保证 `passingForMs()` 在打断那一刻如实归零（而不是显示"已合格 4 秒"）。
   * 一旦连续合格时长重新超过窗口宽度，说明窗口里已经没有卡顿样本了，脏位清掉。
   */
  let stalled = false;

  const size = () => stamps.length - head;

  /**
   * 窗口均值。抽成局部函数而不是让 isPassing() 调 `this.value()`：
   * 后者依赖调用方的 this 绑定，模块级导出被解构之后就会静默算错。
   */
  const windowFps = (): number => {
    const count = size();
    if (count < 2) return 0;
    const span = stamps[stamps.length - 1] - stamps[head];
    if (!(span > 0)) return 0;
    // count 个样本之间有 count-1 个间隔
    return ((count - 1) * 1000) / span;
  };

  const windowSpan = (): number => {
    if (size() < 2) return 0;
    return stamps[stamps.length - 1] - stamps[head];
  };

  /** 丢弃窗口之外的时间戳。至少留 2 个（一帧算不出帧率） */
  const trim = (now: number) => {
    const cutoff = now - windowMs - KEEP_MARGIN_MS;
    while (size() > 2 && stamps[head] < cutoff) {
      head += 1;
    }
    // 头指针走远了就压实一次，避免数组无限增长
    if (head > MAX_SAMPLES) {
      stamps.splice(0, head);
      head = 0;
    }
  };

  /**
   * 在**每一帧**推进"连续合格"状态机。
   *
   * ── 为什么必须在 push 里推进，而不是查询时现算 ──────────────────────
   * 第一版把它写在 `isPassing()` 里，结果是：`passingForMs()` 的值取决于
   * **你什么时候来问**。测试连喂 5 秒 60FPS（帧率一秒都不差），
   * 只在最后问一次时，起跑线被设在"最老的样本"上，答出 1233ms ——
   * 而正确答案是"从第 1.85 秒起就一直达标，已经 3 秒多"。
   * 一个会随查询时刻变化的"连续时长"是假数字，而对照表要的正是这个数。
   * 所以：状态机每帧走一步，查询只读结果。
   */
  const tick = (now: number) => {
    // 窗口必须填满：span 至少要覆盖一个完整窗口，否则"连续"的分母是假的
    if (windowSpan() < windowMs || windowFps() < PASS_FPS) {
      passSince = null;
      return;
    }
    if (passSince === null) {
      passSince = stamps[head];
      stalled = false;
      return;
    }
    if (stalled && now - passSince >= windowMs) {
      // 连续时长又攒过一个窗口宽度 → 卡顿样本已经滑出窗口，脏位清掉
      stalled = false;
    }
  };

  return {
    push(nowMs: number): void {
      // 回退 / 重复的时间戳：忽略。真实 rAF 不会这样，但截图工装注入的
      // 时间轴与测试喂的假时间轴会 —— 让窗口值算出 NaN 是更糟的失败方式。
      if (!Number.isFinite(nowMs) || nowMs <= last) return;
      /**
       * ⚠ 第一帧**不算卡顿**。
       * 第一帧的 `last` 是 -Infinity，差值必然是 Infinity —— 直接判就会把
       * 每一个新建的 meter 都永久标记成"卡过顿"，于是 isPassing() 恒为 false。
       * （这个坑是 2.5 的测试当场抓出来的：连续喂 5 秒 60FPS，合格时长一直是 0。）
       */
      if (last !== Number.NEGATIVE_INFINITY) {
        lastGap = nowMs - last;
        if (lastGap > windowMs) stalled = true;
      } else {
        lastGap = 0;
      }
      last = nowMs;
      stamps.push(nowMs);
      trim(nowMs);
      tick(nowMs);
    },

    value(): number {
      return windowFps();
    },

    sampleCount(): number {
      return size();
    },

    passingForMs(): number {
      if (passSince === null) return 0;
      return Math.max(0, last - passSince);
    },

    isPassing(): boolean {
      if (passSince === null || stalled) return false;
      return last - passSince >= PASS_STREAK_MS;
    },

    reset(): void {
      stamps.length = 0;
      head = 0;
      last = Number.NEGATIVE_INFINITY;
      lastGap = 0;
      passSince = null;
      stalled = false;
    },
  };
}
