/**
 * 小木形象方案展台 · 页面入口
 *
 * ── 这一页是什么 ────────────────────────────────────────────────────
 * 它是**选型工装，不是产品页面**：并排实时渲染 9 版"小木"候选形象
 * （8 版 three 实现 + 1 版产品在用的老方法），供挑选者当场比较并拍板。
 * 所以它刻意不进产品路由表（PRD 里没有这一页），
 * 也不需要登录态/数据接口 —— 打开就能比。
 *
 * ── 分工 ────────────────────────────────────────────────────────────
 *   `variants/index.ts` 登记方案（加方案只改那里）
 *   `loop.ts`           一个 rAF 驱动全部格子 + 暂停/焦点/FPS 实测 + 失败隔离
 *   **本文件**          格子的 DOM、顶部控件、自适应列数、以及把三者接起来
 *
 * ── 三条不能违反的规则（都写进了 tasks.md 的验收）────────────────────
 *   1. **一格失败不许拖垮整页**：`loop.attach()` 内部已经把失败隔在该格里，
 *      这里只负责把提示渲染出来（REQ-01 AC3）。
 *   2. **resize 只改尺寸，不重建**：列数变了只改 CSS 变量 + 让各格 `setSize`（REQ-05 AC4）。
 *   3. **暂停后画面必须真的不动**：`aria-pressed` 与视觉必须一致（REQ-04 AC3）。
 */

import "./xiaomu-lab.css";
import { columnsFor } from "./layout.ts";
import { detectWebGL2, LabLoop, measure, type LabTile } from "./loop.ts";
import { assertValidRegistry } from "./registry.ts";
import { ALL_VARIANTS } from "./variants/index.ts";

/**
 * 页面骨架。
 *
 * 为什么全用 DOM API 拼而不是写进 html 文件：格子数量、标题文字都来自方案清单，
 * 写死在 html 里就有**两份同义数据**，加一版方案要改两个地方。
 * 骨架里只有"壳"，一切与方案有关的文字都从 `LabVariant` 来。
 */
function buildSkeleton(root: HTMLElement): {
  grid: HTMLElement;
  pauseBtn: HTMLButtonElement;
  status: HTMLElement;
  notice: HTMLElement;
} {
  const header = document.createElement("header");
  header.className = "lab-head";

  const titleBox = document.createElement("div");
  const h1 = document.createElement("h1");
  h1.textContent = "小木形象候选方案 · 展台";
  const sub = document.createElement("p");
  sub.className = "lab-head__sub";
  sub.textContent =
    "9 版候选并排实时渲染：8 版 three.js（渐变半透明 / 3D）+ 1 版产品在用的老方法（纯 SVG，零 WebGL 上下文）。点任意一格放大细看，Esc 还原。";
  titleBox.append(h1, sub);

  const controls = document.createElement("div");
  controls.className = "lab-head__controls";

  const pauseBtn = document.createElement("button");
  pauseBtn.type = "button";
  pauseBtn.id = "lab-pause";
  pauseBtn.className = "lab-btn";
  pauseBtn.setAttribute("aria-pressed", "false");
  pauseBtn.textContent = "暂停全部";

  const status = document.createElement("p");
  status.className = "lab-status";
  status.id = "lab-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.textContent = "正在初始化…";

  controls.append(pauseBtn);
  header.append(titleBox, controls);

  const notice = document.createElement("p");
  notice.className = "lab-notice";
  notice.id = "lab-notice";
  notice.hidden = true;

  const grid = document.createElement("main");
  grid.className = "lab-grid";
  grid.id = "lab-grid";

  root.append(header, status, notice, grid);
  return { grid, pauseBtn, status, notice };
}

/** 一格的 DOM：画布宿主 + 编号/名字/一句话/技术/FPS 标注 */
function buildCell(variantId: string, name: string, oneLiner: string, tech: string, needsWebGL: boolean): {
  cell: HTMLElement;
  canvasHost: HTMLElement;
  fpsEl: HTMLElement;
} {
  const cell = document.createElement("section");
  cell.className = "lab-cell";
  cell.dataset.variant = variantId;
  // 无障碍：每一格是一块可聚焦区域，键盘用户也能放大（REQ-04 键盘可达）
  cell.tabIndex = 0;
  cell.setAttribute("role", "group");
  cell.setAttribute("aria-label", `方案 ${variantId} ${name}`);

  const stage = document.createElement("div");
  stage.className = "lab-cell__stage";

  const canvasHost = document.createElement("div");
  canvasHost.className = "lab-cell__canvas";
  canvasHost.dataset.host = variantId;

  const badge = document.createElement("span");
  badge.className = "lab-cell__badge";
  badge.textContent = variantId;
  const techTag = document.createElement("span");
  techTag.className = "lab-cell__tag";
  techTag.textContent = needsWebGL ? "WebGL" : "非 WebGL";
  if (!needsWebGL) techTag.classList.add("lab-cell__tag--dom");

  const fpsEl = document.createElement("span");
  fpsEl.className = "lab-cell__fps";
  fpsEl.dataset.fps = variantId;
  fpsEl.textContent = "FPS —";

  stage.append(canvasHost, badge, techTag, fpsEl);

  const meta = document.createElement("div");
  meta.className = "lab-cell__meta";
  const h2 = document.createElement("h2");
  h2.className = "lab-cell__name";
  h2.textContent = name;
  const pitch = document.createElement("p");
  pitch.className = "lab-cell__pitch";
  pitch.textContent = oneLiner;
  const techEl = document.createElement("p");
  techEl.className = "lab-cell__tech";
  techEl.textContent = tech;
  meta.append(h2, pitch, techEl);

  cell.append(stage, meta);
  return { cell, canvasHost, fpsEl };
}

function boot(): void {
  const root = document.getElementById("lab-root");
  if (!root) throw new Error('页面缺少 #lab-root 挂载点（xiaomu-lab.html）');

  // ── 1. 注册表先校验（REQ-01 AC2 / 4d）：宁可整页报错，也不静默少画一格
  try {
    assertValidRegistry(ALL_VARIANTS);
  } catch (err) {
    root.innerHTML = "";
    const box = document.createElement("pre");
    box.className = "lab-fatal";
    box.textContent = `方案注册表不合法，展台没有启动：\n\n${err instanceof Error ? err.message : String(err)}`;
    root.append(box);
    return;
  }

  const { grid, pauseBtn, status, notice } = buildSkeleton(root);

  // ── 2. 能力探测（REQ-01 AC5）：整机没有 WebGL2 时，把话说在前面
  const hasWebGL2 = detectWebGL2();
  const webglCount = ALL_VARIANTS.filter((v) => v.needsWebGL).length;
  if (!hasWebGL2) {
    notice.hidden = false;
    notice.textContent = `这台浏览器/机器没有可用的 WebGL2：${webglCount} 版 three 方案会显示为静态占位（不影响第 09 版老方法，它不需要 WebGL）。`;
  }

  /**
   * 上下文预算：浏览器通常允许约 16 个 WebGL 上下文，但 9 块并排时
   * 每块都要能稳定跑满 30 FPS，所以留出余量。超出预算的格子**不静默少画**，
   * 而是降级 + 页面显式提示（REQ-01 AC4）。
   */
  const contextBudget = Math.min(webglCount, 12);

  const loop = new LabLoop({
    contextBudget,
    onFrame: (tile, fps) => {
      const el = tile.host.parentElement?.querySelector<HTMLElement>(`.lab-cell__fps`);
      if (!el) return;
      const value = Math.round(fps);
      el.textContent = `FPS ${value}`;
      // 与 fps.ts 的门槛保持一致（≥30 且连续 3s），这里只做颜色提示，
      // 不在这里判合格 —— 合格与否由 `isPassing()` 说，页面不自己造第二套判据
      const passing = tile.meter.isPassing();
      el.dataset.state = passing ? "pass" : fps > 0 ? "measuring" : "idle";
    },
  });

  // ── 3. 建格子并挂方案
  const tiles: LabTile[] = [];
  for (const variant of ALL_VARIANTS) {
    const { cell, canvasHost, fpsEl } = buildCell(
      variant.id,
      variant.name,
      variant.oneLiner,
      variant.tech,
      variant.needsWebGL,
    );
    grid.append(cell);
    const tile = loop.attach(variant, canvasHost);
    if (!tile.ready) {
      fpsEl.textContent = "FPS —";
      cell.dataset.state = "failed";
    }
    tiles.push(tile);
  }

  const readyCount = tiles.filter((t) => t.ready).length;
  const failed = tiles.filter((t) => !t.ready);

  // ── 4. 自适应列数（纯函数推导，REQ-05）
  const applyColumns = () => {
    const columns = columnsFor(window.innerWidth);
    grid.style.setProperty("--lab-columns", String(columns));
  };
  applyColumns();

  /**
   * resize：列数变了只改 CSS 变量，再让每格按**新的实测尺寸**重排渲染器。
   *
   * 为什么要等一帧：CSS 变量刚改完，`getBoundingClientRect()` 读到的可能还是旧尺寸，
   * 直接用旧尺寸调 `setSize` 会让画布比例差一档（直到下一次 resize 才纠正）。
   * 所以尺寸读取放在 rAF 里做，且**合并连续事件**——拖窗口时每像素触发一次 resize，
   * 每次都重排就是白烧 CPU（REQ-05 AC4 的"最终收敛到最后一次宽度"）。
   */
  let pendingRefit = 0;
  const scheduleRefit = () => {
    if (pendingRefit) return;
    pendingRefit = requestAnimationFrame(() => {
      pendingRefit = 0;
      applyColumns();
      loop.refitAll((tile) => measure(tile.host));
    });
  };
  window.addEventListener("resize", scheduleRefit);
  // 首帧之后强制对齐一次：此时字体/滚动条都已定型，量到的才是真尺寸
  requestAnimationFrame(() => loop.refitAll((tile) => measure(tile.host)));

  // ── 5. 全局暂停 / 重播（REQ-04）
  const paintPause = (paused: boolean) => {
    pauseBtn.setAttribute("aria-pressed", paused ? "true" : "false");
    pauseBtn.textContent = paused ? "继续播放" : "暂停全部";
    grid.dataset.paused = paused ? "true" : "false";
  };

  pauseBtn.addEventListener("click", () => {
    // 目标态而不是取反：连点（UC-03 备选 4a）时最后一次点击永远胜出
    const paused = loop.setPaused();
    paintPause(paused);
  });

  // ── 6. 放大与还原（REQ-03）
  const paintFocus = (variantId: string | null) => {
    for (const tile of tiles) {
      const cell = grid.querySelector<HTMLElement>(`[data-variant="${tile.variant.id}"]`);
      if (!cell) continue;
      const isFocused = variantId === tile.variant.id;
      cell.classList.toggle("lab-cell--focused", isFocused);
      cell.classList.toggle("lab-cell--dimmed", variantId !== null && !isFocused);
    }
    grid.dataset.focused = variantId ?? "";
  };

  const focusVariant = (variantId: string | null) => {
    loop.setFocused(variantId);
    paintFocus(loop.focusedTile()?.variant.id ?? null);
    // 放大后尺寸变了：下一帧按新尺寸重排（REQ-03 AC5：不溢出、不裁切）
    scheduleRefit();
  };

  for (const cell of grid.querySelectorAll<HTMLElement>(".lab-cell")) {
    const id = cell.dataset.variant;
    if (!id) continue;
    cell.addEventListener("click", () => {
      focusVariant(loop.focusedTile()?.variant.id === id ? null : id);
    });
    cell.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        focusVariant(loop.focusedTile()?.variant.id === id ? null : id);
      }
    });
  }
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && loop.focusedTile()) focusVariant(null);
  });

  // ── 7. 起跑
  loop.start();
  paintPause(loop.isPaused());
  paintFocus(null);

  const degradedNote = loop.degraded.length
    ? `；${loop.degraded.length} 版因上下文预算降级（${loop.degraded.join("、")}）`
    : "";
  const failedNote = failed.length ? `；${failed.length} 版初始化失败` : "";
  status.textContent = `已加载 ${readyCount} / ${ALL_VARIANTS.length} 版${degradedNote}${failedNote}。每格右上角是**实测** FPS（连续 3 秒 ≥30 才算合格）。`;
  if (failed.length || loop.degraded.length) {
    notice.hidden = false;
    const parts: string[] = [];
    if (loop.degraded.length) {
      parts.push(
        `以下方案因为 WebGL 上下文预算（上限 ${contextBudget} 个）没有启动：${loop.degraded.join("、")}`,
      );
    }
    for (const tile of failed) {
      parts.push(`方案 ${tile.variant.id}「${tile.variant.name}」初始化失败：${tile.error}`);
    }
    notice.textContent = parts.join("；");
  }

  // 页面卸载时把上下文放掉，避免来回切换页面耗光配额
  window.addEventListener("pagehide", () => loop.dispose(), { once: true });

  /**
   * 给截图工装留一个只读把手。
   *
   * 工装要的是"实测 FPS"和其它硬指标，而不是自己再实现一遍计量：
   * 暴露 `loop` 让工装能读到每一格 `renderStats()` 与 `meter.isPassing()`，
   * **但不给它任何写接口**（工装不许替页面改状态，否则证据就不是页面的了）。
   */
  Object.defineProperty(window, "__xiaomuLab", {
    value: Object.freeze({
      variants: ALL_VARIANTS.map((v) => ({
        id: v.id,
        name: v.name,
        needsWebGL: v.needsWebGL,
        cost: v.cost,
        fidelity: v.fidelity,
        fidelityNote: v.fidelityNote,
      })),
      tileCount: tiles.length,
      readyCount,
      degraded: [...loop.degraded],
      fps: () => tiles.map((t) => ({ id: t.variant.id, ready: t.ready, stats: t.handle?.renderStats() ?? null })),
      isPaused: () => loop.isPaused(),
      focused: () => loop.focusedTile()?.variant.id ?? null,
      /**
       * 构图诊断：把某一格的 three 相机与场景交出去，供探针问真实的世界尺寸。
       * 只读 —— 拿到 `stage` 也不能改页面状态，改的是它自己的探针进程里的结论。
       */
      inspect: (variantId: string) => {
        const hit = loop.inspect(variantId);
        if (!hit || !hit.stage) return null;
        return { camera: hit.stage.camera, scene: hit.stage.scene, floatGroup: hit.stage.floatGroup, size: hit.stage.size };
      },
    }),
    configurable: true,
  });
}

boot();
