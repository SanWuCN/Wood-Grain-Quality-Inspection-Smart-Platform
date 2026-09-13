/**
 * 木脉智检 · 顶栏
 *
 * 视觉沿用 sc-datav Demo2 的顶栏做法（`src/pages/Demo2/panel/headder.tsx`）：
 *   - 1920×85 的 SVG，preserveAspectRatio="none"，随宽度拉伸
 *   - 配色只用 #3061DB / #789EFF / #FFF
 *   - 上下两条横线、中段分隔、左侧切角装饰、右侧导航标签框
 *   - 标题居中，导航在左、状态在右
 *
 * 与上游的差异（有意为之）：
 *   上游那段 SVG 里，「四川电力全景感知平台 / 主平台 / 电力感知 …」这些字
 *   是**用路径画出来的矢量字形**。我们换成"木脉智检"后必须把这些字形路径全部去掉，
 *   只保留装饰线条，否则上游的字会原样显示出来。
 */

import type { ComponentProps, ReactNode } from "react";
import styled from "styled-components";
import { ACCOUNTS, COLORS, HEADER_HEIGHT } from "./design";
import { Icon, type IconName } from "./icons";

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

const NavLayer = styled.nav`
  position: absolute;
  left: 22px;
  bottom: 6px;
  z-index: 3;
  display: flex;
  align-items: center;
  gap: 1px;

  button {
    border: 0;
    background: transparent;
    padding: 4px 9px;
    font-size: 12px;
    letter-spacing: 0.06em;
    color: rgba(232, 239, 255, 0.62);
    cursor: pointer;
    white-space: nowrap;
    transition: color 0.2s, text-shadow 0.2s, background-color 0.2s;

    /*
       PRD §4/§5：导航图标 20px，图标与中文标签间距 8px，统一大小与标签基线。
       PRD §4：「选中态同时有底色或边线、文字变化，不能仅变色」——
       所以 .is-active 给了底色 + 文字提亮 + 下边线，三重变化。
    */
    display: inline-flex;
    align-items: center;
    gap: 8px;

    .mumai-icon {
      /* 默认态用 v2 的次级图标色，避免八个图标比中文标签更抢眼 */
      color: var(--mumai-icon-secondary, rgba(232, 239, 255, 0.62));
      transition: color 0.2s;
    }

    &:hover {
      color: #ffffff;
      background: var(--mumai-selected-background, rgba(48, 97, 219, 0.18));

      .mumai-icon {
        color: var(--mumai-icon-default, #dce5ed);
      }
    }

    &.is-active {
      color: #ffffff;
      text-shadow: 0 0 12px rgba(120, 158, 255, 0.9);
      background: var(--mumai-selected-background, rgba(48, 97, 219, 0.28));
      box-shadow: inset 0 -2px 0 var(--mumai-accent, ${COLORS.panelStroke});

      .mumai-icon {
        color: var(--mumai-accent, #6bcbe0);
      }
    }

    /* 键盘焦点：2px 可见焦点环（PRD §4） */
    &:focus-visible {
      outline: 2px solid var(--mumai-focus, #8ad9e9);
      outline-offset: 2px;
    }
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
  /** 设备通道状态等，挂在右侧状态区最前面 */
  statusExtra?: ReactNode;
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
    actions,
    ...rest
  } = props;

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
        <span className="device">
          <i />
          设备在线 <b>4/4</b>
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

      <NavLayer aria-label="主导航">
        {navItems.map((item) => {
          const active = activeNav === item.label;
          return (
            <button
              key={item.key}
              type="button"
              className={active ? "is-active" : ""}
              onClick={() => onNav(item.label)}
              // 当前项给辅助技术一个明确状态，不只靠颜色（PRD §4）
              aria-current={active ? "page" : undefined}>
              {/*
                PRD §4：导航图标默认 20px。
                图标旁有同义中文标签，因此对辅助技术隐藏（PRD §3.2 / DESIGN-SYSTEM）。
              */}
              <Icon name={item.icon} size={20} aria-hidden />
              {item.label}
            </button>
          );
        })}
      </NavLayer>

      <ChannelLayer>{statusExtra}</ChannelLayer>
    </TitleWrapper>
  );
}
