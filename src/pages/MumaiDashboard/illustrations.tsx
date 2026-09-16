/**
 * 木脉智检 · v2 插图资源映射与组件
 *
 * 依据：木脉智检UI素材交接与平台部署修改PRD-v1.0 §5
 *
 *   「建立 illustrationManifest，以 id 映射 src、width、height、alt 和用途。
 *     设置宽高比避免加载跳动，object-fit 为 contain，不拉伸。
 *     头像按实际有效内容微调裁切，不切掉头部；其余插图保持完整。
 *     首屏关键头像可提前加载，非首屏装饰图延迟加载。」
 *
 *   「页面通过资源映射访问文件，不写桌面绝对路径、不写 file 协议、
 *     不引用远程素材网站。」
 *
 * 走 WebP 主用（PRD §2「网页优先 WebP」）：WebP 由 Vite 在构建期处理，
 * 产物文件名带内容哈希，变更插图后浏览器不会持续命中旧缓存。
 * PNG 母版同时发布在 public/ui-assets/v2/illustrations/ 作为必要回退文件，
 * 不进默认加载路径。
 */

import type { CSSProperties } from "react";

/* ------------------------------------------------------------------
   1. WebP 网页主用资源
   ------------------------------------------------------------------
   路径通过 Vite 的资源处理解析：构建后落在 dist/assets/<name>-<hash>.webp。
   ------------------------------------------------------------------ */

import i01Hero from "../../assets/ui-v2/illustrations/I01-ancient-timber-hero.webp";
import i01Background from "../../assets/ui-v2/illustrations/I01-ancient-timber-background-low-contrast.webp";
import i02Cart from "../../assets/ui-v2/illustrations/I02-inspection-cart-CONCEPT-pending-photo.webp";
import i03Scanner from "../../assets/ui-v2/illustrations/I03-scanner-device.webp";
import i04Xiaomu from "../../assets/ui-v2/illustrations/I04-xiaomu-assistant.webp";
import i05Knowledge from "../../assets/ui-v2/illustrations/I05-knowledge-guidance.webp";
import i06Scene from "../../assets/ui-v2/illustrations/I06-gaussian-scene-guidance.webp";

/** 资源 id */
export type IllustrationId =
  | "i01-hero"
  | "i01-background"
  | "i02-cart-concept"
  | "i03-scanner"
  | "i04-xiaomu"
  | "i05-knowledge-guidance"
  | "i06-gaussian-scene";

export interface IllustrationEntry {
  /** Vite 解析后的 URL（构建产物带内容哈希） */
  readonly src: string;
  /** 素材原始画布宽高：写进 img 的 width/height，避免加载跳动 */
  readonly width: number;
  readonly height: number;
  readonly alt: string;
  /** 用途（PRD §5 表格的页面 / 区域） */
  readonly usage: string;
  /** 素材包里的文件名，验收时核对用 */
  readonly source: string;
  /**
   * 是否首屏关键资源。
   * true  → loading="eager" + fetchPriority="high"（首屏关键头像提前加载）
   * false → loading="lazy"（非首屏装饰图延迟加载）
   */
  readonly aboveFold: boolean;
  /**
   * I02 是概念占位（PRD §1：「只用于引导，不能当作实物照片」）。
   * 组件据此拒绝把它渲染在「设备实拍」语义下。
   */
  readonly conceptPlaceholder?: boolean;
}

export const illustrationManifest: Readonly<Record<IllustrationId, IllustrationEntry>> = {
  "i01-hero": {
    src: i01Hero,
    width: 1600,
    height: 900,
    alt: "古建木构主视觉插图",
    usage: "登录与项目入口",
    source: "I01-ancient-timber-hero.webp",
    aboveFold: true,
  },
  "i01-background": {
    src: i01Background,
    width: 1600,
    height: 900,
    alt: "",
    usage: "登录页低对比背景层",
    source: "I01-ancient-timber-background-low-contrast.webp",
    // 低 Alpha 设计预期的装饰层：对辅助技术隐藏，也不抢占首屏加载
    aboveFold: false,
  },
  "i02-cart-concept": {
    src: i02Cart,
    width: 1024,
    height: 1024,
    alt: "巡检车概念示意图",
    usage: "待接入引导（不放在设备实拍标题下）",
    source: "I02-inspection-cart-CONCEPT-pending-photo.webp",
    aboveFold: false,
    conceptPlaceholder: true,
  },
  "i03-scanner": {
    src: i03Scanner,
    width: 1024,
    height: 1024,
    alt: "手持扫描仪设备外观",
    usage: "硬件详情与采集：设备卡",
    source: "I03-scanner-device.webp",
    aboveFold: false,
  },
  "i04-xiaomu": {
    src: i04Xiaomu,
    width: 1024,
    height: 1024,
    alt: "小木助手头像",
    usage: "知识库与小木入口（32–40px）/ 展开区（40–48px）",
    source: "I04-xiaomu-assistant.webp",
    aboveFold: true,
  },
  "i05-knowledge-guidance": {
    src: i05Knowledge,
    width: 1200,
    height: 900,
    alt: "知识资料汇聚与检索引导插图",
    usage: "知识库空态 / 引导",
    source: "I05-knowledge-guidance.webp",
    aboveFold: false,
  },
  "i06-gaussian-scene": {
    src: i06Scene,
    width: 1200,
    height: 900,
    alt: "高斯场景导入引导插图",
    usage: "数字孪生：仅无场景时展示",
    source: "I06-gaussian-scene-guidance.webp",
    aboveFold: false,
  },
};

/** 未进入默认加载路径的候选资源（PRD §2 / §5：保留为候选，默认不切换） */
export const illustrationCandidates = [
  {
    id: "i04-xiaomu-candidate-b",
    file: "I04-xiaomu-candidate-B-timber-symbol.webp",
    note: "小木候选 B（抽象木构符号）。默认采用 I04-xiaomu-assistant，不同时混用两版。",
  },
  {
    id: "i02-scanner-alt",
    file: "biz-handheld-scanner-alt.svg",
    note: "扫描仪备选轮廓。默认采用 biz-handheld-scanner。",
  },
] as const;

/* ------------------------------------------------------------------
   2. 组件
   ------------------------------------------------------------------ */

export interface IllustrationProps {
  id: IllustrationId;
  /** 显示高度（px）。宽度按素材比例自动，不拉伸 */
  height?: number;
  /** 附加类名 */
  className?: string;
  /**
   * 覆盖默认 alt。
   * 传空字符串表示「纯装饰」——此时对辅助技术隐藏（PRD：装饰图标 aria-hidden）。
   */
  alt?: string;
  /** 头像模式：圆角裁切，不切掉头部（PRD §5） */
  avatar?: boolean;
  /** 背景层模式：铺满容器、cover、低对比（登录页用） */
  backdrop?: boolean;
  /** 覆盖 object-position，用于头像按有效内容微调裁切 */
  objectPosition?: string;
}

/**
 * 插图组件。
 *
 * 宽高比由素材原始 width/height 提供：
 *   - 传 height 时按比例算出显示宽度，等比缩放；
 *   - 不传 height 时使用素材原始尺寸，交给容器 max-width 收缩。
 * 两种情况都保留 width/height 属性，浏览器能在图片到达前预留空间。
 */
export function Illustration({
  id,
  height,
  className,
  alt,
  avatar = false,
  backdrop = false,
  objectPosition,
}: IllustrationProps) {
  const entry = illustrationManifest[id];
  if (!entry) {
    // 与 Icon 的未知 name 同样处理：开发环境报清楚错误，不静默渲染空白
    const message = `[木脉智检 Illustration] 未知插图 id "${id}"`;
    if (import.meta.env.DEV) console.error(message);
    else console.warn(message);
    return null;
  }

  const displayWidth = height ? Math.round((height * entry.width) / entry.height) : entry.width;
  const displayHeight = height ?? entry.height;

  const classes = ["mumai-illustration"];
  if (avatar) classes.push("mumai-illustration--avatar");
  if (backdrop) classes.push("mumai-illustration--backdrop");
  else if (id === "i05-knowledge-guidance" || id === "i06-gaussian-scene") {
    classes.push("mumai-illustration--guide");
  }
  if (className) classes.push(className);

  // alt 显式传空字符串 = 装饰图；否则用清单里的 alt
  const resolvedAlt = alt !== undefined ? alt : entry.alt;
  const decorative = resolvedAlt === "";

  const style: CSSProperties = {};
  if (objectPosition) style.objectPosition = objectPosition;

  return (
    <img
      src={entry.src}
      width={displayWidth}
      height={displayHeight}
      alt={resolvedAlt}
      className={classes.join(" ")}
      style={style}
      // 首屏关键资源提前加载；非首屏装饰图延迟加载（PRD §5）
      loading={entry.aboveFold ? "eager" : "lazy"}
      fetchPriority={entry.aboveFold ? "high" : "low"}
      decoding="async"
      draggable={false}
      aria-hidden={decorative ? true : undefined}
      data-illustration={id}
    />
  );
}

/**
 * 设备卡里的插图容器。
 *
 * PRD §5 硬件详情与采集：「I03 放设备卡，采集相机、二维响应和关键结果保持主体」、
 * 「不把设备插图当实时相机帧」——所以这里永远带 figcaption 说明这是示意图，
 * 且 I02 概念占位会额外标出「概念示意」。
 */
export function DeviceFigure({
  id,
  caption,
  height = 140,
}: {
  id: IllustrationId;
  caption: string;
  height?: number;
}) {
  const entry = illustrationManifest[id];
  return (
    <figure className={`mumai-device-figure${entry?.conceptPlaceholder ? " mumai-device-figure--concept" : ""}`}>
      <Illustration id={id} height={height} alt={`${caption}（参考图，当前未接入相机）`} />
      <figcaption>{caption}</figcaption>
    </figure>
  );
}
