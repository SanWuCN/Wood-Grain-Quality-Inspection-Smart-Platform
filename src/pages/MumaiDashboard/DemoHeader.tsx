/**
 * 木脉智检 · 顶栏
 *
 * 视觉沿用 sc-datav Demo2 的顶栏做法（`src/pages/Demo2/panel/headder.tsx`）：
 *   - 1920×85 的 SVG，preserveAspectRatio="none"，随宽度拉伸
 *   - 上下两条横线、中段分隔、左侧切角装饰
 *   - 标题在左上，导航在左下，状态在右上与右下
 *
 * 一级导航已从「文字 + 2px 底线」换成**药丸导航**（`./PillNav.tsx`，
 * 交互取自 React Bits 的 PillNav：悬停时从药丸底边长出圆形填充 + 文字滚入），
 * 配色回落到本平台的设计系统 token。
 *
 * 与上游的差异（有意为之）：
 *   上游那段 SVG 里，「四川电力全景感知平台 / 主平台 / 电力感知 …」这些字
 *   是**用路径画出来的矢量字形**。我们换成"木脉智检"后必须把这些字形路径全部去掉，
 *   只保留装饰线条，否则上游的字会原样显示出来。
 */

import { useMemo } from "react";
import type { ComponentProps, ReactNode } from "react";
import styled from "styled-components";
import { ACCOUNTS, COLORS, HEADER_HEIGHT } from "./design";
import { Icon, type IconName } from "./icons";
import PillNav, { type PillNavItem } from "./PillNav";

const ACCOUNT_OPTIONS = ACCOUNTS.map((item) => ({
  id: item.id,
  name: item.name,
  role: item.role,
  workspace: item.workspace,
}));

/** 装饰性边框：只画线，不含任何字形路径 */
const SvgFrame = () => (
  <svg
    fill="none"
    viewBox="0 0 1920 85"
    width="100%"
    height="100%"
    preserveAspectRatio="none"
    aria-hidden="true">
    {/* 上沿：左段实线 + 中段淡线 + 右段实线 */}
    <path fill="#3061DB" d="M1 0h120v2H1z" />
    <path fill="#3061DB" fillOpacity="0.35" d="M128 0h760v2H128z" />
    <path fill="#3061DB" d="M896 0h40v2H896z" />
    <path fill="#3061DB" fillOpacity="0.35" d="M944 0h600v2H944z" />
    <path fill="#3061DB" d="M1552 0h367v2h-367z" />

    {/* 下沿：整条实线 */}
    <path fill="#3061DB" d="M0 83h1920v2H0z" />

    {/* 第二行分隔线：把导航 / 通道与上行标题分开 */}
    <path fill="#3061DB" fillOpacity="0.22" d="M0 36h1920v1H0z" />

    {/* 左下切角装饰：三段斜线，呼应面板折角 */}
    <g fill="#3061DB" opacity="0.75">
      <path fillOpacity="0.9" d="M1420 47.469h3.44L1409.088 57h-3.44l14.352-9.531Z" />
      <path fillOpacity="0.7" d="M1426.355 47.469h3.44L1415.443 57h-3.44l14.352-9.531Z" />
      <path fillOpacity="0.5" d="M1432.709 47.469h3.44L1421.797 57h-3.44l14.352-9.531Z" />
    </g>

    {/* 品牌区底衬：一条短渐变，给标题压底 */}
    <path fill="url(#brandGlow)" d="M22 40h190v1H22z" />
    <defs>
      <linearGradient id="brandGlow" x1="22" x2="212" y1="40.5" y2="40.5" gradientUnits="userSpaceOnUse">
        <stop offset="0" stopColor="#789EFF" stopOpacity="0.55" />
        <stop offset="1" stopColor="#789EFF" stopOpacity="0" />
      </linearGradient>
    </defs>
  </svg>
);

/**
 * 顶栏分两行，避免把 8 项导航 + 4 路通道 + 时间 + 账号全塞进一行导致互相挤压：
 *   第一行：品牌标题（左） · 设备在线 / 时间 / 投屏 / 账号（右）
 *   第二行：一级导航（左） · 四路通道状态（右）
 * 总高仍是 HEADER_HEIGHT(85px)，与 Demo2 顶栏高度一致。
 */
const TitleWrapper = styled.header`
  position: relative;
  width: 100%;
  height: ${HEADER_HEIGHT}px;
  margin: 0;
  padding: 0;
  overflow: hidden;
  background: linear-gradient(180deg, rgba(4, 14, 32, 0.96), rgba(2, 8, 18, 0.9));
`;

const SvgLayer = styled.div`
  position: absolute;
  inset: 0;
  z-index: 1;
  pointer-events: none;

  svg {
    display: block;
  }
`;

/**
 * 品牌 + 标题：左上角，带切角底衬
 *
 * 品牌名用**团队字标本身**：`public/brand/mumai-wordmark-white.png`
 * （原图抠掉蓝色背景、重新着白色，含前面的小符号）。
 *
 * 为什么不再用系统字体写「木脉智检」：团队字标用的是 MumaiDisplay
 * （`public/font/pmzd.woff2`）那套偏斜、横画带切角的字，系统字体写出来
 * 字形对不上；这里直接贴字标，顶栏和登录页的字形才一致。
 * 所以左上角只有这一个图形，不再另外放一个符号（会和字标里自带的重复）。
 * 副标题仍是系统字体的小字 —— 它本来就属于界面文案，不属于字标。
 */
const Brand = styled.div`
  position: absolute;
  left: 22px;
  top: 10px;
  z-index: 2;
  display: flex;
  align-items: flex-end;
  gap: 12px;
  pointer-events: none;
  white-space: nowrap;

  img {
    height: 30px;
    width: auto;
    display: block;
    filter: drop-shadow(0 0 14px rgba(120, 158, 255, 0.35));
  }

  span {
    color: rgba(232, 239, 255, 0.42);
    font-size: 11px;
    letter-spacing: 0.24em;
    padding-bottom: 5px;
  }
`;

/**
 * 一级导航：药丸导航（PillNav）。
 *
 * 交互取自 React Bits 的 PillNav（悬停时从药丸底边长出一个圆把底色填满，
 * 图标与文字整体滚出、另一份滚入），配色与状态标记全部落回本平台的设计系统：
 *
 *   默认   文字 --text-secondary，图标 --mumai-icon-secondary
 *   悬停   圆填 --glow-cyan 的 14% 淡青（不是实心亮色，见下面 .mumai-pill-circle
 *          的说明），文字提到 --text-primary，图标提到 --mumai-icon-accent
 *   当前项 --fill-active 底色 + 1px --border-active 边线 + 2px --primary 底线
 *          + --glow-cyan 圆点；文字 --text-primary，图标 --mumai-icon-accent
 *
 * 位置仍是顶栏左下角（brand 在第一行左侧，导航在第二行左侧），
 * 因此这里只管定位与响应式，药丸本身的样式在下面 Pill 容器里。
 */
const NavLayer = styled(PillNav)`
  position: absolute;
  left: 22px;
  bottom: 6px;
  z-index: 3;
  /*
    不给 right —— 让容器按内容宽度收缩，右侧状态区的宽度与它无关。
    两者万一在窄屏撞上，CSS 里的 media query 负责收窄药丸，
    不靠这里硬撑一个宽度把药丸挤出可视区。
  */
  display: flex;
  align-items: center;
  min-width: 0;

  /*
    局部变量：药丸的尺寸档位集中在这里，
    窄屏的 media query 只改这几个数，不改结构。

    高度 40px：85px 顶栏分两行，第二行可用高度约 46px，40px 留出上下喘息；
    字号 14px 对齐规范 §3.2 的正文档（v1.1 明确 11px 不再作为常规阅读字号）。
  */
  --pill-h: 40px;
  --pill-pad-x: 14px;
  --pill-gap: 2px;
  --pill-font: var(--fs-table, 14px);

  .mumai-pill-list {
    display: flex;
    align-items: center;
    gap: var(--pill-gap);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .mumai-pill-list > li {
    display: flex;
  }

  .mumai-pill {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    height: var(--pill-h);
    padding: 0 var(--pill-pad-x);
    border: 1px solid transparent;
    border-radius: 9999px;
    /*
      background-color / border-color 交给 CSS 过渡（悬停淡青底 → 选中底的切换）；
      位移、缩放与**文字色**交给 gsap。

      文字色必须排除在这条过渡之外：gsap 每帧都在写内联 color，浏览器再对每个
      新值做一次 180ms 过渡，等于把同一条动画插值两遍 —— 手感就是「发涩、跟不上」。
    */
    transition:
      background-color var(--motion-fast, 180ms) ease,
      border-color var(--motion-fast, 180ms) ease;
    background: transparent;
    color: var(--text-secondary);
    font-family: var(--font-ui);
    font-size: var(--pill-font);
    font-weight: 500;
    letter-spacing: 0.04em;
    line-height: 1;
    white-space: nowrap;
    overflow: hidden;
    /* overflow: clip 让滚动尺寸不把填色圆算进去（圆比药丸高，见 PillNav 的半径公式） */
    overflow: clip;
    cursor: pointer;
  }

  /*
    图标取色统一走 --mumai-icon-tone（icons.tsx 在 svg 上写的就是这个变量的
    「语义色」入口）。默认态沿用 v2 素材包的次级图标色，让八枚图标比中文标签
    低一档、不跟文字抢注意力；悬停与当前项再分别提亮。

    选择器写成 && ＋完整路径：styled(组件) 模板里把规则**嵌套在
    .mumai-pill 内部**时，styled-components 会把组件类重复拼进选择器
    （生成 .hash .pill.hash .pill .icon 这种永远匹配不上的东西）。
    从顶层用 && 写全路径，生成的才是 .hash.hash .mumai-pill .mumai-icon。

    **改的是 color，不是 --mumai-icon-tone**：icons.tsx 会把 tone 变量
    以内联样式写在 svg 上，内联的变量永远赢，样式表再怎么提权重都盖不掉。
    所以这里直接改 svg 的 color —— 权重 (0,4,0) 高过 ui-assets-v2-icons.css
    里那条 .mumai-icon 的取色规则。
  */
  && .mumai-pill .mumai-icon {
    flex: 0 0 auto;
    color: var(--mumai-icon-secondary, #a7b5c3);
    transition: color var(--motion-fast, 180ms) ease;
  }

  /* 键盘焦点环：全站统一 2px（规范 §4、评审 R10） */
  .mumai-pill:focus-visible {
    outline: 2px solid var(--mumai-focus, #8ad9e9);
    outline-offset: 2px;
  }

  .mumai-pill-stack {
    display: inline-flex;
    align-items: center;
    /* 图标与中文标签间距 8px（PRD §4） */
    gap: 8px;
    line-height: 1;
    will-change: transform, opacity;
  }

  /*
    滚入层：绝对定位，不参与药丸宽度计算（否则药丸会宽出一个标签）。
    初始位置由 PillNav 的 gsap.set 写在元素上，这里只兜静态样式。
  */
  .mumai-pill-roll {
    position: absolute;
    left: var(--pill-pad-x);
    top: 50%;
    margin-top: calc(var(--pill-h) / -2);
    height: var(--pill-h);
    align-items: center;
    pointer-events: none;
  }

  /* 填色圆：宽高与 bottom 由 PillNav 按药丸实测尺寸实时写入 */
  .mumai-pill-circle {
    position: absolute;
    left: 50%;
    bottom: 0;
    display: block;
    border-radius: 50%;
    /*
      悬停填色：--glow-cyan 的淡青渐变 + 顶部一道高光边，不是实心亮色。

      实心 #5DE4FF 会把整枚药丸点亮，在深蓝黑顶栏里跳得厉害，还必须把文字与图标
      一起压成深色才读得清，与规范 §11「普通交互不发光、减少彩色」相冲。
      改成淡青底 + 亮字之后强度落在平台既有的选中底色那一档（--fill-*）；
      渐变让圆长上来时有体积感（配合 PillNav 里那段 1.06→1 的弹出），
      不是一块平铺的色。
    */
    background-image: linear-gradient(0deg, rgba(93, 228, 255, 0.2), rgba(93, 228, 255, 0.08));
    box-shadow: inset 0 1px 0 0 rgba(93, 228, 255, 0.55);
    pointer-events: none;
    will-change: transform;
  }

  /* ---- 悬停 / 键盘焦点：与 PillNav 维护的 is-hot 同步 ---- */

  /*
    颜色规则同时写 .is-hot（JS 在 enter / leave 里维护）与 :hover。
    前者是**权威状态**：gsap 会把文字色写成内联样式，只认 :hover 会出现
    「指针已经离开、内联深色还挂着」的脏状态；后者保证脚本没跑起来时仍有反馈。
  */
  .mumai-pill.is-hot,
  .mumai-pill:hover,
  .mumai-pill:focus-visible {
    color: var(--text-primary);
  }

  /* 悬停时图标提到强调色，与当前项同一套取色（背景是淡青，浅色图标才读得清） */
  && .mumai-pill.is-hot .mumai-icon,
  && .mumai-pill:hover .mumai-icon,
  && .mumai-pill:focus-visible .mumai-icon {
    color: var(--mumai-icon-accent, #6bcbe0);
  }

  /* 滚入层压在淡青圆上：用最亮的文字色，不能沿用默认次级色 */
  .mumai-pill.is-hot .mumai-pill-roll,
  .mumai-pill:hover .mumai-pill-roll {
    color: var(--text-primary);
  }

  /* ---- 当前项：底色 + 底线 + 圆点，三重标记（规范 §4） ---- */

  .mumai-pill.is-active {
    background: var(--fill-active);
    border-color: var(--border-active);
    box-shadow: inset 0 -2px 0 var(--primary);
    color: var(--text-primary);
    /* 给左侧圆点让出位置，避免选中时文字整体位移 */
    padding-left: calc(var(--pill-pad-x) + 12px);
  }

  /* 当前项用强调色图标（素材包的 accent，与 --glow-cyan 同族） */
  && .mumai-pill.is-active .mumai-icon {
    color: var(--mumai-icon-accent, #6bcbe0);
  }

  .mumai-pill.is-active::before {
    content: "";
    position: absolute;
    left: calc(var(--pill-pad-x) - 2px);
    top: 50%;
    width: 5px;
    height: 5px;
    margin-top: -2.5px;
    border-radius: 50%;
    background: var(--glow-cyan);
    pointer-events: none;
  }

  /* 当前项被悬停时：淡青圆叠在选中底色上，边线让位给圆，文字保持最亮 */
  .mumai-pill.is-active:hover,
  .mumai-pill.is-active:focus-visible {
    border-color: transparent;
    color: var(--text-primary);
  }

  /*
    减少动态效果（规范 §6.2 / 评审 V13）：不跑 gsap 的滚入动效，
    悬停改为静态底色，行为仍然明确。
  */
  @media (prefers-reduced-motion: reduce) {
    .mumai-pill {
      transition: none;
    }

    .mumai-pill:hover,
    .mumai-pill:focus-visible {
      background: var(--fill-strong);
      color: var(--text-primary);
    }

    .mumai-pill-circle {
      display: none;
    }
  }

  /*
    窄屏收窄 —— 三档与规范 §8 的分辨率基准对齐。
    这里是**收缩顺序**：先收间隙与内边距，再收图标，最后收字号，
    保证 1366 这一档八项导航仍然是完整可读的八个中文标签。
  */
  @media (max-width: 1720px) {
    --pill-pad-x: 10px;
  }

  @media (max-width: 1560px) {
    --pill-pad-x: 8px;
    --pill-gap: 1px;

    .mumai-icon {
      display: none;
    }

    .mumai-pill.is-active {
      padding-left: calc(var(--pill-pad-x) + 11px);
    }
  }

  @media (max-width: 1366px) {
    --pill-pad-x: 7px;
    --pill-font: var(--fs-aux, 13px);
  }
`;

/** 右上：设备在线 / 时间 / 投屏 / 账号（账号入口由调用方在 actions 里给） */
const TopRight = styled.div`
  position: absolute;
  right: 22px;
  top: 8px;
  z-index: 3;
  display: flex;
  align-items: center;
  gap: 12px;
  white-space: nowrap;
  font-size: 12px;

  .device {
    display: flex;
    align-items: center;
    color: rgba(232, 239, 255, 0.66);

    i {
      width: 7px;
      height: 7px;
      margin-right: 6px;
      background: ${COLORS.ok};
      border-radius: 50%;
      box-shadow: 0 0 10px ${COLORS.ok};
    }

    b {
      margin-left: 4px;
      color: ${COLORS.panelStroke};
    }
  }

  time {
    color: rgba(232, 239, 255, 0.42);
    font-size: 11px;
    font-family: ui-monospace, Consolas, monospace;
  }

  button {
    height: 30px;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 11px;
    border: 1px solid ${COLORS.panelStroke};
    background: rgba(48, 97, 219, 0.22);
    color: ${COLORS.textPrimary};
    font-size: 12px;
    cursor: pointer;
    clip-path: polygon(8px 0, 100% 0, 100% calc(100% - 8px), calc(100% - 8px) 100%, 0 100%, 0 8px);

    b {
      font-weight: 600;
    }

    small {
      color: ${COLORS.textSecondary};
      font-size: 10px;
    }
  }

  .account-select {
    height: 30px;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 9px;
    border: 1px solid ${COLORS.panelStroke};
    background: rgba(48, 97, 219, 0.22);
    color: ${COLORS.textPrimary};
    cursor: pointer;
    clip-path: polygon(8px 0, 100% 0, 100% calc(100% - 8px), calc(100% - 8px) 100%, 0 100%, 0 8px);

    svg {
      width: 15px;
      flex: 0 0 15px;
    }

    select {
      max-width: 150px;
      border: 0;
      background: transparent;
      color: ${COLORS.textPrimary};
      font-size: 11px;
      cursor: pointer;
      outline: none;

      option {
        background: #061228;
        color: #e8efff;
      }
    }
  }
`;

/** 右下：四路通道状态 */
const ChannelLayer = styled.div`
  position: absolute;
  right: 22px;
  bottom: 6px;
  z-index: 3;
  display: flex;
  align-items: center;
  gap: 8px;
`;

export interface DemoHeaderProps extends ComponentProps<typeof TitleWrapper> {
  /** icon 为 v2 素材包的 nav-* 图标名（design.ts 的 NAV_ITEMS 提供） */
  navItems: readonly { readonly key: string; readonly label: string; readonly icon: IconName }[];
  activeNav: string;
  onNav: (name: string) => void;
  /**
   * 当前账号。
   *
   * 只在渲染下拉选账号时用到（不提供 `onAccountChange` 时本组件不画账号）。
   * 必填是有意的：账号是顶栏的固定信息，调用方不该因为这里不再画它就把账号忘了传。
   */
  account: { name: string; role: string };
  /**
   * 提供时才渲染下拉选账号。
   *
   * 旧版总览页（`./index`，已不在路由表里）用它在顶栏切账号。
   * **不提供时这里什么都不渲染** —— 原来会给一个「账号名 + 角色」的只读按钮，
   * 而 Header 传进来的 `actions` 里已经有带账号名和角色的退出按钮，
   * 两个框并排出现就是「账号入口重复」（评审 V09 / P1「合并账号入口」），
   * 所以那个兜底按钮已删除。
   */
  onAccountChange?: (id: string) => void;
  time: Date;
  /** 顶栏右侧的状态项（平台 / 智能车 / 扫描仪 / 模型），由 Header 传进来 */
  statusExtra?: ReactNode;
  /**
   * 右上「状态正常 N/M」的计数。
   *
   * 原来是写死的 `4/4`（对应旧的四路通道）—— 设备真掉线了它也不会变，
   * 属于"看着像状态、其实是装饰"。现在由调用方按同一批状态项算出来，
   * 和顶栏右侧那四项永远一致。
   */
  statusSummary?: { ok: number; total: number };
  /**
   * 「投到展示窗口」「退出登录」等动作按钮。
   *
   * 账号入口也在这里：`Shell` → `Header` 给的是**唯一**的账号按钮
   * （图标 + 姓名 + 角色 + 退出），本组件不再自己画一个。
   */
  actions?: ReactNode;
}

export default function DemoHeader(props: DemoHeaderProps) {
  const {
    navItems,
    activeNav,
    onNav,
    account,
    onAccountChange,
    time,
    statusExtra,
    statusSummary,
    actions,
    ...rest
  } = props;

  /**
   * 一级导航项 → PillNav 的输入。
   *
   * renderIcon 返回 v2 素材包的 nav-* 图标（PRD §5）。
   * 尺寸取 16px：规范 §4 给导航的档位是 20px，但顶栏总高固定 85px、
   * 药丸高 40px，20px 图标会让药丸显得头重；16px 落在「工具栏 16–20px」
   * 区间内，而且 icons.tsx 对 16px 优先使用五枚 small 变体（为小尺寸重画过），
   * 八枚图标与中文标签的基线关系也更稳。窄屏时整列图标由 media query 隐藏。
   *
   * 图标旁有同义中文标签，因此对辅助技术隐藏（PRD §3.2 / DESIGN-SYSTEM）。
   */
  const pillItems = useMemo<PillNavItem[]>(
    () =>
      navItems.map((item) => ({
        key: item.key,
        label: item.label,
        renderIcon: () => <Icon name={item.icon} size={16} aria-hidden />,
      })),
    [navItems],
  );

  return (
    <TitleWrapper style={{ height: HEADER_HEIGHT }} {...rest}>
      <SvgLayer>
        <SvgFrame />
      </SvgLayer>

      <Brand>
        {/*
          团队字标（含符号），深色底用白色那一版；旁边的副标题是界面文案。
          字标本体已经写了品牌名，因此这里不再有同义的隐藏文本，
          alt 给「木脉智检」供辅助技术读取。
        */}
        <img src="/brand/mumai-wordmark-white.png" alt="木脉智检" />
        <span>古建筑智能巡检平台</span>
      </Brand>

      <TopRight>
        <span
          className="device"
          title={
            statusSummary
              ? `${statusSummary.total} 项状态里 ${statusSummary.ok} 项正常（平台 / 智能车 / 扫描仪 / 模型）`
              : undefined
          }>
          <i />
          {/*
            「设备在线 4/4」原来写死 —— 现在由 Shell 按顶栏右侧那四项现算，
            掉线时数字会跟着变，不会再出现「扫描仪离线但右上角仍写 4/4」。
          */}
          状态正常 <b>{statusSummary ? `${statusSummary.ok}/${statusSummary.total}` : "—"}</b>
        </span>
        <time>{time.toLocaleTimeString("zh-CN", { hour12: false })}</time>
        {actions}
        {onAccountChange ? (
          <label className="account-select">
            {/* PRD §3.3：user → identity-user（账号身份） */}
            <Icon name="identity-user" size={16} aria-hidden />
            <select
              value={ACCOUNT_OPTIONS.find((item) => item.name === account.name)?.id ?? "shen"}
              onChange={(event) => onAccountChange(event.target.value)}
              aria-label="切换账号">
              {ACCOUNT_OPTIONS.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} · {item.role}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </TopRight>

      {/*
        一级导航：药丸导航（PillNav）。
        调用方（Shell）传的 activeNav 是中文标签，这里换算成 key，
        再把点击换算回标签调 onNav —— 保持 Header/Shell 那一侧的接口不变。
      */}
      <NavLayer
        ariaLabel="主导航"
        items={pillItems}
        activeKey={pillItems.find((item) => item.label === activeNav)?.key ?? pillItems[0]?.key ?? ""}
        onSelect={(item) => onNav(item.label)}
      />

      <ChannelLayer>{statusExtra}</ChannelLayer>
    </TitleWrapper>
  );
}
