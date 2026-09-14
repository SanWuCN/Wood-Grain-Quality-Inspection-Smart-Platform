/**
 * 小木形象方案展台 · 方案接口（契约层）
 *
 * ── 这个文件是"契约"，不是"工具"────────────────────────────────────
 * 展台页只认 `LabVariant`：加一个方案 = 在 `src/lab/variants/` 下加一个文件、
 * 在 `src/lab/variants/index.ts` 里挂一行，`main.ts` 与 `loop.ts` 都不用改。
 *
 * ── 为什么拆成 LabVariant / VariantRuntime / VariantHandle 三层 ──────
 *   LabVariant       静态描述（编号、名字、一句话、技术、开销、接近度）+ 一个 `create()`。
 *                    这些字段是**纯数据**，能在 Node 里断言（任务 2.7）。
 *   VariantRuntime   `create()` 的返回：方案作者**只需实现这两个**
 *                    （`update(t)` 推进时间轴 + `dispose()` 释放自己建的东西）。
 *   VariantHandle    宿主补齐后的完整句柄：多出 setPaused / setFocused / renderStats。
 *                    补齐的位置是 `loop.ts` 的 `LabLoop.attach()` —— 一处补齐，
 *                    9 个方案都拿到同样的暂停/焦点/测帧语义。
 *
 * ── 老方法那一版（09）为什么也走这个接口 ────────────────────────────
 * 它是 DOM/SVG 而不是 WebGL，但"能不能暂停、能不能放大、有没有在动"这三件事
 * 和 WebGL 版一模一样。给它开一个平行接口，展台页就得写两套循环 ——
 * 那是"半暂停"（UC-03 备选 4a）的温床。所以差异只体现在 `needsWebGL` 一个布尔上。
 *
 * ── ⚠ 契约漂移的教训（2026-09-14 复核发现）─────────────────────────
 * 上一轮 `design.md §2` 写下的这版契约用了 `Stage`/`StageObject`/`StageCamera`
 * 三个抽象接口，而**变体素材是更早的 spike**，它们用的是 `shared.ts` 里那个
 * 带 `renderer/scene/camera/floatGroup` 的**具体** `Stage`。两边从没对上过：
 * `tsc -b` 22 处报错、变体一头也接不进注册表。
 * 修法是让契约服从已经写好、已经验证过的实现（`shared.ts` + 7 个变体），
 * 而不是反过来给 7 个变体重写一遍。所以：
 *   · `Stage` 直接**引用** `shared.ts` 的实现，不再另写一份影子接口；
 *   · 字段名与素材对齐（`oneLiner` / `needsWebGL`），不再造第二套同义字段。
 * 一个契约只有在"实现方与消费方都能编译过"时才算契约，否则只是文档。
 */

// ⚠ 扩展名必须写全 `.ts`：Node 原生 ESM 解析器不做 bundler 式补全，
// `node --test src/lab/*.test.ts` 是本项目唯一的单测入口（不新增依赖）。
// tsconfig.app.json 已开 allowImportingTsExtensions，写全扩展名不影响 tsc -b。
import type { Stage } from "./shared.ts";

/** 展台页给 `create()` 的入参 */
export interface VariantOptions {
  /** 画布 CSS 尺寸（像素）。方案据此挑几何精度/离屏缓冲大小 */
  width: number;
  height: number;
  /**
   * 清晰度倍率上限。
   * 取 `min(devicePixelRatio, 2)` 而不是直接用 dpr：9 个画布在 3x 屏上
   * 是 9 倍的像素量，显卡直接跪 —— 而展台要的是"都在动"，不是"都超清"。
   */
  pixelRatioCap: number;
  /** 随机种子。同一个 seed 必须得到同一颗球（截图工装的可重复性靠它） */
  seed: number;
}

/**
 * `create()` 的返回：**方案作者只需实现这两个**。
 * 另外三个（setPaused/setFocused/renderStats）由 `loop.ts` 补齐。
 */
export interface VariantRuntime {
  /**
   * 推进到时间轴 `t` 秒。
   *
   * ⚠ 方案**不许**自己订阅 rAF。9 个 rAF 会互相抢帧，而且全局暂停时
   * 必然出现"有的格停了、有的格还在跑"（UC-03 备选 4a 的"半暂停"）。
   * 整个展台只有**一个** rAF，就是 `loop.ts` 的 `LabLoop`。
   *
   * 纯函数式约定：同样的 `t` 必须得到同样的画面（暂停时帧不推进，像素差才 ≈ 0）。
   * 所以方案内部不许读 `performance.now()` 或 `Date.now()`。
   */
  update(t: number): void;
  /** **幂等**：释放几何/材质/贴图。重复调用不得抛错（UC-02 释放） */
  dispose(): void;
}

/** `create()` 的完整返回：另外三个方法由宿主补齐 */
export interface VariantHandle extends VariantRuntime {
  /** 全局暂停广播（REQ-04）。暂停后 update 不再推进，画面停在同一帧 */
  setPaused(paused: boolean): void;
  /** 放大态标记（REQ-03 AC1）。方案可据此强化细节（本版不据此改变动画时间轴） */
  setFocused(focused: boolean): void;
  /**
   * **实测**状态（REQ-06 AC2）。不许估算、不许拿固定值充数。
   *
   * `paused`/`focused` 一起回传，是为了让**截图工装与调试**能问一句
   * "这一格现在什么状态"，而不是靠读 CSS class 猜 —— 猜错的后果是
   * 工装拍到一张"暂停中了但看起来像在动"的图，还把它当成证据。
   */
  renderStats(): { fps: number; paused: boolean; focused: boolean };
}

/** 展台上的一版方案 */
export interface LabVariant {
  /** "01".."09"，全局唯一（REQ-01 AC2 由 registry 强制） */
  id: string;
  /** 短名，格子标题用 */
  name: string;
  /** 一句话特点（格子展示，REQ-02 AC2） */
  oneLiner: string;
  /** 技术要点（格子展示，REQ-02 AC2） */
  tech: string;
  /** 老方法版为 `false`（REQ-08 AC1）。true 的格子才需要 WebGL 上下文 */
  needsWebGL: boolean;
  /** 粗略开销：定性档位 + 一句为什么。对照表直接用 */
  cost: string;
  /** 与参考图的接近度自评，对照表直接用 */
  fidelity: "high" | "mid" | "low";
  /** 接近度理由（对照表直接用） */
  fidelityNote: string;
  /**
   * 建场景。**失败要抛**，由调用方隔离成"只这一格失败"（REQ-01 AC3）。
   *
   * WebGL 版：向宿主要一块 `stage`，把物体挂到 `stage.floatGroup` / `stage.scene`。
   * 老方法版：直接往 `host` 里放 DOM/SVG，拿到的是 `undefined`。
   *
   * 三个参数**一个都不能少**（老方法版写 `_stage` 占位）：
   * 宿主只有**一个**调用点，少写一个不会报错、只会静默收到 `undefined`。
   * `variants.test.ts` 盯着 `create.length === 3` 就是为了防这种隐性不一致。
   */
  create(host: HTMLElement, opts: VariantOptions, stage: Stage | undefined): VariantRuntime;
}

/** 注册表上限（REQ-01 AC4）：浏览器 WebGL 上下文约 16 个，12 是留了余量的档 */
export const MAX_VARIANTS = 12;
