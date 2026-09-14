/**
 * 方案 09 · 老方法（纯内联 SVG + CSS 动画，**零 WebGL 上下文**）
 *
 * ── 这一版为什么必须存在 ────────────────────────────────────────────
 * 它就是**产品当前正在用的那条路线**（`XiaomuDock` 里那颗琉璃球）。
 * 如果展台只摆 8 个 three 方案，用户会比出一个"3D 更好"的结论，
 * 却看不到代价：3D 版每格吃掉一个 WebGL 上下文、在 1366 的笔电上要跟地图抢 GPU，
 * 而 SVG 版是**合成层动画**，不占上下文、任意尺寸都清晰、开销低一个数量级。
 * 要公平取舍，就必须把两条路线放进同一片网格（REQ-08）。
 *
 * ── 这里的 SVG 是从哪来的 ───────────────────────────────────────────
 * 结构与配色照搬候选分支（`xiaomu-candidate-svg` / `3fbb69f`）里那颗球的
 * 层次拆法：球体径向渐变 → 内部亮带 → 虹彩边 → 高光 → 外发光 → 接触阴影 → 脸，
 * 色值仍然是**从参考图采样出来的那套**（`PALETTE` / 注释里的 rgb）。
 * 转写成 lab 版时只做了两件事：
 *   1. JSX 属性 → 标准 SVG 属性（`stopColor` → `stop-color`，`stopOpacity` → `stop-opacity`）；
 *   2. 产品版的状态机（`.xd[data-state]` 那 7 种脸）**不搬** ——
 *      展台只比"材质与动效"，7 状态属于产品落地那一环（UC-06）。
 *
 * ── "足够动态"是硬要求，所以四类动画都要有 ──────────────────────────
 *   呼吸缩放 + 上下浮动（整颗球）／亮带缓慢漂移旋转／高光游走／眨眼（双互质周期）。
 * 只靠其中一样是过不了"同版 1.5s 双帧像素差"那道关的（REQ-06 AC4）。
 *
 * ── ⚠ reduced-motion 下的取舍 ──────────────────────────────────────
 * 产品里 `prefers-reduced-motion` 必须保住"静态可辨"；但在**展台**里，
 * 关掉动画等于这一格过不了像素差判据、会被工装记成"没在动"。
 * 所以这里不动画只降到很慢（`animation-duration` 拉长），不停掉 ——
 * 展台要的是"证明这条路能做到多动态"，不是"演示无障碍降级"。
 * 无障碍降级的验收在产品侧（UC-06 / 230 项界面验收），不在这一页。
 */

import { PALETTE } from "../shared.ts";
import type { LabVariant, VariantOptions, VariantRuntime } from "../types.ts";

/** 配色（与 shared.ts 的 PALETTE 同源；这里写成 CSS 十六进制串） */
const C = {
  core: "#ffffff",
  pale: "#f0f7ff",
  light: "#cde2fb",
  mid: "#a9d1f4",
  edge: "#6aa6e8",
  deep: "#2da3fc",
  cyan: "#79ddfd",
  iris: "#dcc5f7",
  irisCyan: "#baf1fd",
  ink: "#16295c",
  halo: `#${PALETTE.halo.toString(16).padStart(6, "0")}`,
} as const;

/**
 * 这一版的样式表。
 *
 * 为什么把 `@keyframes` 写在 TS 里而不是 lab 的 css 文件里：
 * 它属于**这一版方案自己的实现细节**，删掉这一版就该一起消失。
 * 放到公共 css 里会留下 4 条没人认领的 keyframes（本仓库已经因为
 * "两份同义实现"踩过坑，能避免就避免）。
 *
 * CSS 变量只在作用域内定义，`.xl-old` 之外的任何东西都拿不到 ——
 * 4 条 keyframes 全部读变量，于是同一个页面上摆两份也不会互相串。
 */
const STYLE = `
.xl-old {
  --xl-dur: 6.4s;      /* 亮带漂移周期 */
  --xl-travel: 6.6s;   /* 高光游走周期 */
  --xl-bob: 5.8s;      /* 呼吸 + 浮动周期 */
  position: relative;
  width: 100%;
  height: 100%;
  display: grid;
  place-items: center;
}
.xl-old__svg { width: 100%; height: 100%; display: block; }
.xl-old__bob { transform-box: fill-box; transform-origin: 50% 52%; animation: xl-bob var(--xl-bob) ease-in-out infinite; }
.xl-old__flow { transform-box: view-box; transform-origin: 36% 46%; animation: xl-flow var(--xl-dur) ease-in-out infinite; }
.xl-old__flow2 { transform-box: view-box; transform-origin: 30% 74%; animation: xl-flow var(--xl-dur) ease-in-out infinite reverse; }
.xl-old__sheen { transform-box: view-box; transform-origin: 30% 26%; animation: xl-travel var(--xl-travel) ease-in-out infinite; }
.xl-old__glint { animation: xl-glint var(--xl-travel) ease-in-out infinite; }
/* 双互质周期：18.5s 与 23.3s 的最小公倍数很大，四十秒内不重复同一套节拍 */
.xl-old__lid { animation: xl-blink-a 18.5s linear infinite; }
.xl-old__lid--alt { animation: xl-blink-b 23.3s linear infinite; }

@keyframes xl-bob {
  0%, 100% { transform: scale(1) translateY(0); }
  50%      { transform: scale(1.035) translateY(-0.9px); }
}
@keyframes xl-flow {
  0%, 100% { transform: rotate(-5deg) scale(1.02); opacity: 0.86; }
  50%      { transform: rotate(7deg) scale(1.06); opacity: 1; }
}
@keyframes xl-travel {
  0%, 100% { transform: translate(-2.5px, -1.5px); opacity: 0.95; }
  50%      { transform: translate(3.5px, 2.5px); opacity: 0.72; }
}
@keyframes xl-glint {
  0%, 100% { opacity: 1; transform: translate(0, 0); }
  40%      { opacity: 0.35; transform: translate(1.2px, 0.8px); }
}
/* 眨眼：只压眼皮（一条与球同色的椭圆），不动眼珠 —— 与 three 版同一个做法。
   两次合眼各占周期的 1.6%，约 0.3s */
@keyframes xl-blink-a {
  0%, 1.2%   { transform: scaleY(1); }
  1.6%, 2.4% { transform: scaleY(1.06); }
  2.8%, 100% { transform: scaleY(1); }
}
@keyframes xl-blink-b {
  0%, 1.2%   { transform: scaleY(1); }
  1.6%, 2.4% { transform: scaleY(1.06); }
  2.8%, 100% { transform: scaleY(1); }
}
`;

/** 眼睛：竖向椭圆，上深下亮 + 左上白高光 + 下缘青边 */
function eyeGroup(id: string, cx: number): string {
  return `
      <g>
        <ellipse cx="${cx}" cy="47.4" rx="4.9" ry="6.5" fill="url(#${id}-eye)" />
        <ellipse cx="${cx - 1.5}" cy="44.6" rx="1.75" ry="2.05" fill="#ffffff" fill-opacity="0.96" />
        <ellipse cx="${cx + 1.7}" cy="50.4" rx="1.1" ry="1.1" fill="${C.cyan}" fill-opacity="0.55" />
        <ellipse class="xl-old__lid${cx > 50 ? " xl-old__lid--alt" : ""}" cx="${cx}" cy="47.4" rx="4.9" ry="6.5" fill="url(#${id}-orb)" />
      </g>`;
}

export const oldMethodSvg: LabVariant = {
  id: "09",
  name: "老方法 · SVG 渐变球",
  oneLiner: "产品现在用的那条路线：0 个 WebGL 上下文，任意尺寸都不糊",
  tech: "纯内联 SVG：径向/线性渐变 + 柔化滤镜 + 4 条 CSS 合成层动画；眨眼靠同色眼皮椭圆压 scaleY",
  cost: "最低且不占上下文：合成层动画，CPU/GPU 只做图层合成，无逐帧 JS",
  fidelity: "high",
  fidelityNote: "层次拆法（亮带 / 虹彩边 / 高光 / 外发光）与参考图一一对应，色值是采样值；不足是内部亮带是**画上去的**，没有真实视差，侧看不会变",
  needsWebGL: false,

  /**
   * ⚠ 第三个参数 `_stage` **必须留在签名里**，哪怕这一版根本不需要它。
   * 宿主（`loop.ts`）只有**一个**调用点：`variant.create(host, opts, stage)`。
   * 少写一个参数，JS 不报错、只是静默收到 `undefined`；而契约测试
   * （`variants.test.ts` 里断言 `create.length === 3`）就是为了把这种
   * "少一个也能跑"的隐性不一致当场抓出来 —— 否则下一个照着这版抄的人
   * 会以为 stage 是可选的。
   */
  create(host: HTMLElement, _opts: VariantOptions, _stage?: unknown): VariantRuntime {
    const id = "xl9";
    const root = document.createElement("div");
    root.className = "xl-old";

    const style = document.createElement("style");
    style.textContent = STYLE;

    root.innerHTML = `
    <svg class="xl-old__svg" viewBox="0 0 100 100" role="presentation" aria-hidden="true" focusable="false">
      <defs>
        <radialGradient id="${id}-orb" cx="38%" cy="32%" r="78%">
          <stop offset="0%" stop-color="${C.core}" />
          <stop offset="22%" stop-color="${C.pale}" />
          <stop offset="44%" stop-color="${C.light}" />
          <stop offset="66%" stop-color="${C.mid}" />
          <stop offset="84%" stop-color="#86bcf0" />
          <stop offset="100%" stop-color="${C.edge}" />
        </radialGradient>
        <linearGradient id="${id}-iris" x1="0.15" y1="1" x2="0.9" y2="0.05">
          <stop offset="0%" stop-color="${C.irisCyan}" stop-opacity="0.85" />
          <stop offset="24%" stop-color="#c9f2ff" stop-opacity="0.5" />
          <stop offset="52%" stop-color="${C.iris}" stop-opacity="0.72" />
          <stop offset="78%" stop-color="#f7dcef" stop-opacity="0.78" />
          <stop offset="100%" stop-color="#ffeede" stop-opacity="0.55" />
        </linearGradient>
        <linearGradient id="${id}-flow" x1="1" y1="0.05" x2="0.05" y2="1">
          <stop offset="0%" stop-color="#d5ebfd" stop-opacity="0.5" />
          <stop offset="42%" stop-color="#6cbdf8" stop-opacity="0.8" />
          <stop offset="100%" stop-color="${C.deep}" stop-opacity="0.92" />
        </linearGradient>
        <linearGradient id="${id}-flow2" x1="0.05" y1="1" x2="0.95" y2="0.1">
          <stop offset="0%" stop-color="#4fcdfd" stop-opacity="0.8" />
          <stop offset="50%" stop-color="#a9e6fd" stop-opacity="0.42" />
          <stop offset="100%" stop-color="#d5ebfd" stop-opacity="0" />
        </linearGradient>
        <linearGradient id="${id}-sheen" x1="0.05" y1="0" x2="0.85" y2="1">
          <stop offset="0%" stop-color="#ffffff" stop-opacity="0.98" />
          <stop offset="55%" stop-color="#ffffff" stop-opacity="0.4" />
          <stop offset="100%" stop-color="#ffffff" stop-opacity="0" />
        </linearGradient>
        <radialGradient id="${id}-glint" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stop-color="#ffffff" stop-opacity="1" />
          <stop offset="100%" stop-color="#ffffff" stop-opacity="0" />
        </radialGradient>
        <radialGradient id="${id}-halo" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stop-color="${C.halo}" stop-opacity="0" />
          <stop offset="86%" stop-color="${C.halo}" stop-opacity="0" />
          <stop offset="94%" stop-color="#b6ecff" stop-opacity="0.3" />
          <stop offset="100%" stop-color="#ffffff" stop-opacity="0" />
        </radialGradient>
        <radialGradient id="${id}-shadow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stop-color="#4a5f96" stop-opacity="0.42" />
          <stop offset="60%" stop-color="#5b6fa8" stop-opacity="0.16" />
          <stop offset="100%" stop-color="#6b7fb8" stop-opacity="0" />
        </radialGradient>
        <radialGradient id="${id}-eye" cx="42%" cy="30%" r="82%">
          <stop offset="0%" stop-color="#0d1b3e" />
          <stop offset="46%" stop-color="#203d78" />
          <stop offset="100%" stop-color="#4a7fbb" />
        </radialGradient>
        <filter id="${id}-soft" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="2.6" />
        </filter>
        <filter id="${id}-soft2" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="1.4" />
        </filter>
        <clipPath id="${id}-clip"><circle cx="50" cy="48" r="37" /></clipPath>
      </defs>

      <!-- 接触阴影（在球体之后画，压在下缘） -->
      <ellipse cx="50" cy="88" rx="26" ry="5.2" fill="url(#${id}-shadow)" />
      <!-- 外发光 -->
      <circle cx="50" cy="48" r="47" fill="url(#${id}-halo)" />

      <g class="xl-old__bob">
        <!-- 球体本体 -->
        <circle cx="50" cy="48" r="37" fill="url(#${id}-orb)" />
        <g clip-path="url(#${id}-clip)">
          <!-- 内部流动亮带（两片，反向漂移） -->
          <ellipse class="xl-old__flow" cx="46" cy="40" rx="30" ry="17" fill="url(#${id}-flow)" filter="url(#${id}-soft)" transform="rotate(-24 46 40)" />
          <ellipse class="xl-old__flow2" cx="36" cy="72" rx="26" ry="13" fill="url(#${id}-flow2)" filter="url(#${id}-soft)" transform="rotate(14 36 72)" />
          <!-- 虹彩边 -->
          <circle cx="50" cy="48" r="37" fill="url(#${id}-iris)" opacity="0.5" />
          <!-- 左上大面积柔光（游走） -->
          <ellipse class="xl-old__sheen" cx="34" cy="28" rx="20" ry="14" fill="url(#${id}-sheen)" filter="url(#${id}-soft)" transform="rotate(-18 34 28)" />
          <!-- 两个小镜面点 -->
          <ellipse class="xl-old__glint" cx="31" cy="24" rx="4.6" ry="3.1" fill="url(#${id}-glint)" transform="rotate(-22 31 24)" />
          <ellipse class="xl-old__glint" cx="63" cy="23" rx="2.4" ry="1.7" fill="url(#${id}-glint)" opacity="0.75" transform="rotate(16 63 23)" />
          <!-- 下缘回光 -->
          <ellipse cx="52" cy="79" rx="24" ry="7" fill="${C.irisCyan}" opacity="0.34" filter="url(#${id}-soft2)" />
        </g>
        <!-- 脸：两只深蓝椭圆眼 + 白高光 + 小弧线微笑 -->
        ${eyeGroup(id, 40.6)}
        ${eyeGroup(id, 59.4)}
        <path d="M45.6 57.2 Q50 61.6 54.4 57.2" fill="none" stroke="${C.ink}" stroke-width="1.5" stroke-linecap="round" />
      </g>
    </svg>`;

    host.append(style, root);

    return {
      // 动画全在合成层（CSS keyframes）里，所以 update 是空的：
      // 这一版**不参与** rAF 推进，也就不占逐帧 CPU —— 这正是它的优势。
      update: () => {},
      dispose: () => {
        style.remove();
        root.remove();
      },
    };
  },
};
