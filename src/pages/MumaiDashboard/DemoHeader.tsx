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
import { Icon } from "./icons";

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

/** 品牌 + 标题：左上角，带切角底衬 */
const Brand = styled.div`
  position: absolute;
  left: 22px;
  top: 10px;
  z-index: 2;
  display: flex;
  align-items: baseline;
  gap: 10px;
  pointer-events: none;
  white-space: nowrap;

  b {
    font-size: 26px;
    font-weight: 600;
    letter-spacing: 0.16em;
    color: ${COLORS.textPrimary};
    text-shadow: 0 0 22px rgba(120, 158, 255, 0.65);
  }

  span {
    color: rgba(232, 239, 255, 0.42);
    font-size: 11px;
    letter-spacing: 0.24em;
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
    transition: color 0.2s, text-shadow 0.2s;

    &:hover {
      color: #ffffff;
    }

    &.is-active {
      color: #ffffff;
      text-shadow: 0 0 12px rgba(120, 158, 255, 0.9);
      box-shadow: inset 0 -2px 0 ${COLORS.panelStroke};
    }
  }
`;

/** 右上：设备在线 / 时间 / 投屏 / 账号 */
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
  navItems: readonly { readonly key: string; readonly label: string }[];
  activeNav: string;
  onNav: (name: string) => void;
  account: { name: string; role: string };
  onAccountChange?: (id: string) => void;
  time: Date;
  /** 设备通道状态等，挂在右侧状态区最前面 */
  statusExtra?: ReactNode;
  /** 「投到展示窗口」等附加动作，挂在账号按钮前 */
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
        <b>木脉智检</b>
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
            <Icon name="user" />
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
        ) : (
          <button type="button">
            <b>{account.name}</b>
            <small>{account.role}</small>
          </button>
        )}
      </TopRight>

      <NavLayer aria-label="主导航">
        {navItems.map((item) => (
          <button
            key={item.key}
            type="button"
            className={activeNav === item.label ? "is-active" : ""}
            onClick={() => onNav(item.label)}>
            {item.label}
          </button>
        ))}
      </NavLayer>

      <ChannelLayer>{statusExtra}</ChannelLayer>
    </TitleWrapper>
  );
}
