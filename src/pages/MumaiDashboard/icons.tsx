/**
 * 木脉智检 · 统一图标组件（UI 视觉素材 v2.0）
 *
 * 依据：木脉智检UI素材交接与平台部署修改PRD-v1.0 §3
 *
 *   3.1 内联 SVG：沿用现有做法（直接返回 React SVG 节点、描边用 currentColor），
 *       不能把新 SVG 全改成 <img>——外部 SVG 图像不会继承页面的 currentColor。
 *       静态节点来自 tools/build-ui-v2-icons.mjs 的构建期生成，运行时不解析 SVG。
 *
 *   3.2 接口：name / size / tone / className（+ 原生 SVGProps）。
 *       size 支持 16 / 20 / 24 / 32，默认 20；tone 为 default / secondary /
 *       success / warning / error / disabled / accent，实际颜色由 CSS 变量提供。
 *       16px 优先匹配五枚 small 变体；其他名称回退标准版，不显示空白。
 *       未知 name：开发环境报清楚错误，生产环境用中性占位并记录，
 *       **不能把所有未知图标替换成绿色对勾**。
 *
 *   3.3 旧名称迁移：旧 name 保留为兼容别名，逐个页面改成明确业务名。
 *       迁移表里「保留原图标」的几个（pin / route / database / wave / arrow /
 *       temple / cube / layers）刻意不映射到新图形：
 *       新包没有同义替代时继续使用，避免用错误的新图形替代正确语义。
 */

import type { CSSProperties, SVGProps } from "react";
import {
  UI_V2_ICON_NAMES,
  UI_V2_ICON_PATHS,
  UI_V2_ICON_SOURCE,
  UI_V2_SMALL_PATHS,
  UI_V2_SMALL_SOURCE,
  type UiV2IconName,
} from "../../assets/ui-v2/icons/generated";

/* ------------------------------------------------------------------
   1. 旧名称 → 新资源（PRD §3.3 迁移表）
   ------------------------------------------------------------------
   迁移表是**决策规则**，不是机械替换：下面每一行都注明了判断依据。
   ------------------------------------------------------------------ */

/** 有等价新图标的旧名：可直接替换，保留别名只为不改动未迁移的调用点 */
const ALIASES = {
  order: "nav-orders",
  user: "identity-user",
  bot: "identity-agent",
  close: "action-close",
  alert: "status-warning",
  play: "action-play",
  pause: "action-pause",
  save: "action-save",
  send: "action-send",
  book: "nav-knowledge",
} as const satisfies Record<string, UiV2IconName>;

/**
 * 保留原图形的旧名（PRD §3.3：新包没有同义替代时继续使用）。
 * 这些名字走下面的 LEGACY_PATHS，不映射到 v2 图形。
 *
 *   pin     真地图定位保留 map pin（人工标记改用 biz-manual-mark，两者不同）
 *   route   路线图标新包无同义替代
 *   arrow   通用箭头保留
 *   database 数据库图标保留（数据波形不改成装饰融合图标）
 *   wave    数据波形保留
 *   temple  古建入口：不把单根木柱强行当整座寺庙，保留原图形
 *   cube    模型 / 立方体语义与新包 nav-model 不完全等价，保留
 *   layers  图层语义与新包 nav-twin 不完全等价，保留
 *   check   审核入口日历勾：status-success 是「已完成」圆勾，语义不同，
 *           状态展示改用 status-success，审核入口继续用原图形
 *   sliders 参数滑杆：与 action-settings（系统设置齿轮）分开，保留原图形
 */
const LEGACY_NAMES = [
  "pin",
  "route",
  "arrow",
  "database",
  "wave",
  "temple",
  "cube",
  "layers",
  "check",
  "sliders",
] as const;

type LegacyName = (typeof LEGACY_NAMES)[number];

/**
 * 保留的旧图形。
 *
 * 与改动前 icons.tsx 的 paths 逐字一致（描边仍走 currentColor / 1.8），
 * 保证「保留原图标」的那些调用点在视觉上零变化。
 */
const LEGACY_PATHS: Record<LegacyName, React.ReactNode> = {
  pin: (
    <>
      <path d="M12 21s6-5.2 6-11a6 6 0 1 0-12 0c0 5.8 6 11 6 11Z" />
      <circle cx="12" cy="10" r="2.1" />
    </>
  ),
  route: (
    <>
      <circle cx="5" cy="6" r="2" />
      <circle cx="19" cy="18" r="2" />
      <path d="M7 6h6a4 4 0 0 1 0 8H9a3 3 0 0 0 0 6h8" />
    </>
  ),
  arrow: <path d="M5 12h14M14 7l5 5-5 5" />,
  database: (
    <>
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
    </>
  ),
  wave: (
    <>
      <path d="M2 14c3-8 5 8 8 0s5 6 8-2 4 4 4 4" />
      <path d="M2 20h20" />
    </>
  ),
  temple: <path d="M3 9h18L12 3 3 9Zm2 1v9m4-9v9m6-9v9m4-9v9M2 21h20" />,
  cube: (
    <>
      <path d="M12 2.6 21 7v10l-9 4.4L3 17V7l9-4.4Z" />
      <path d="M3 7l9 4.4L21 7M12 11.4V21.4" />
    </>
  ),
  layers: (
    <>
      <path d="M12 3 3 8l9 5 9-5-9-5Z" />
      <path d="M3 13l9 5 9-5" />
    </>
  ),
  check: (
    <>
      <rect x="4" y="5" width="16" height="16" rx="2" />
      <path d="M8 4V2m8 2V2M7.5 13l3 3 6-7" />
    </>
  ),
  sliders: (
    <>
      <path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h9M17 17h3" />
      <circle cx="15" cy="7" r="2" />
      <circle cx="9" cy="12" r="2" />
      <circle cx="15" cy="17" r="2" />
    </>
  ),
};

/** 组件对外接受的 name 全集：v2 图标名 + v2 别名键 + 保留的旧名 */
export type IconName = UiV2IconName | keyof typeof ALIASES | LegacyName;

/** 运行时判定用（含别名键与旧名） */
const KNOWN_NAMES = new Set<string>([
  ...UI_V2_ICON_NAMES,
  ...Object.keys(ALIASES),
  ...LEGACY_NAMES,
]);

/* ------------------------------------------------------------------
   2. size / tone
   ------------------------------------------------------------------ */

/** PRD §3.2：size 支持 16、20、24、32，默认 20 */
export type IconSize = 16 | 20 | 24 | 32;

/**
 * PRD §4 / §3.2：tone 只表达语义，实际颜色由 CSS 变量提供。
 * 变量定义在 ui-assets-v2.css 的 .mumai-ui-v2 作用域里。
 */
export type IconTone =
  | "default"
  | "secondary"
  | "accent"
  | "success"
  | "warning"
  | "error"
  | "disabled";

const SIZES: ReadonlySet<number> = new Set([16, 20, 24, 32]);

/**
 * tone → 语义色（PRD §4 的 v2 取值表）。
 *
 * 为什么把色值写在这里而不是只写 `var(--mumai-icon-accent)` 间接引用：
 * 图标会出现在**主题作用域之外**的地方（例如登录页外壳、portal 到 body 的浮层），
 * 那些位置没有 `.mumai-ui-v2` 祖先，`var()` 会解析成空值，图标就退回
 * `currentColor` —— 实测「投到展示窗口」按钮里的图标因此变成了平台主色蓝。
 *
 * 所以这里把口径确定下来：组件内联给出该 tone 的 v2 色值，
 * ui-assets-v2.css 的 `.mumai-ui-v2` 作用域里仍保留同名变量供 CSS 侧消费
 * （两处值必须一致，改一处要改另一处）。色值不散落到页面里，
 * 页面上仍然只写 `tone="accent"` 这样的语义。
 */
const TONE_COLOR: Readonly<Record<IconTone, string>> = {
  default: "#dce5ed",
  secondary: "#a7b5c3",
  accent: "#6bcbe0",
  success: "#68d6a5",
  warning: "#f0bd63",
  error: "#ff969c",
  disabled: "#627080",
};

/* ------------------------------------------------------------------
   3. 未知 name 的处理（PRD §3.2）
   ------------------------------------------------------------------ */

/**
 * 生产环境的中性占位。
 *
 * PRD 明确「不能把所有未知图标替换为绿色对勾」——那会把「图标缺失」
 * 伪装成「一切正常」。这里用**中性问号圆**，视觉上就是「这里缺东西」，
 * 同时 console.warn 记录一次，便于构建后核对。
 */
const PLACEHOLDER = (
  <>
    <circle cx="12" cy="12" r="9" strokeDasharray="3 3" />
    <path d="M9.6 9.4a2.5 2.5 0 0 1 4.9.6c0 1.6-2.5 1.9-2.5 3.4" />
    <path d="M12 17h.01" />
  </>
);

const warned = new Set<string>();

function resolveIcon(name: IconName, size: number): React.ReactNode {
  if (ALIASES[name as keyof typeof ALIASES]) {
    return UI_V2_ICON_PATHS[ALIASES[name as keyof typeof ALIASES]];
  }
  if (LEGACY_PATHS[name as LegacyName]) {
    return LEGACY_PATHS[name as LegacyName];
  }
  // 16px 优先匹配 five small 变体（PRD §3.2）
  if (size === 16 && UI_V2_SMALL_PATHS[name]) {
    return UI_V2_SMALL_PATHS[name];
  }
  return UI_V2_ICON_PATHS[name as UiV2IconName];
}

/* ------------------------------------------------------------------
   4. 组件
   ------------------------------------------------------------------ */

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "name" | "width" | "height"> {
  name: IconName;
  /** 16 / 20 / 24 / 32，默认 20（PRD §3.2） */
  size?: IconSize;
  /** 语义色，默认 default（PRD §3.2） */
  tone?: IconTone;
  /**
   * 无障碍名称。
   *
   * - 纯图标按钮：在**外层 button** 上写中文 aria-label（PRD §3.2），
   *   此时图标本身保持 aria-hidden。
   * - 需要把图标作为独立可访问对象时才传 label，此时 aria-hidden=false。
   *
   * 类型上刻意不接受 boolean，避免写出 label={true} 这种无意义用法。
   */
  label?: string;
}

export function Icon({ name, size = 20, tone = "default", label, ...props }: IconProps) {
  const known = KNOWN_NAMES.has(name);
  if (!known && !warned.has(name)) {
    warned.add(name);
    const message = `[木脉智检 Icon] 未知图标名 "${name}"：已使用中性占位。可用名称见 src/assets/ui-v2/icons/generated.tsx`;
    // 开发环境报清楚错误（PRD §3.2），生产环境只记录一次
    if (import.meta.env.DEV) console.error(message);
    else console.warn(message);
  }

  const px = SIZES.has(size) ? size : 20;
  const path = known ? resolveIcon(name, px) : PLACEHOLDER;
  const color = TONE_COLOR[tone];

  return (
    <svg
      viewBox="0 0 24 24"
      width={px}
      height={px}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="mumai-icon"
      data-icon={name}
      data-tone={tone}
      aria-hidden={label ? undefined : true}
      role={label ? "img" : undefined}
      aria-label={label}
      style={
        {
          ["--mumai-icon-size" as string]: `${px}px`,
          /*
            语义色只通过**变量**下发，不在这里直接写 color：
            内联的 color 会赢过页面样式表里的 `.xxx svg { color: … }`，
            那些规则是页面用来做局部统一的（例如附件列表、列表勾选），
            内联写死会把它们的口径一起锁住。
            实际取色在 ui-assets-v2-icons.css 的 `.mumai-icon { color: var(--mumai-icon-tone) }`。
            变量给两级：作用域内可覆盖的 v2 变量 + 组件内置的兜底色值，
            这样即使图标落在 .mumai-ui-v2 之外（登录页外壳、portal 浮层）也不会退回 currentColor。
          */
          ["--mumai-icon-tone" as string]: `var(--mumai-icon-${tone}, ${color})`,
        } as CSSProperties
      }
      {...props}>
      {path}
    </svg>
  );
}

/** 供调试面板 / 验收脚本列出全部可用图标名 */
export const ICON_NAMES = UI_V2_ICON_NAMES;

/** 16px 专用简化版对应的标准图标名（PRD §3.2 五枚） */
export const ICON_SMALL_VARIANTS = Object.keys(UI_V2_SMALL_PATHS);

/** 素材包文件 → 来源路径，验收时核对「实际接入素材清单」用 */
export { UI_V2_ICON_SOURCE, UI_V2_SMALL_SOURCE };
