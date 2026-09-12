/**
 * 木脉智检 · 应用顶栏
 *
 * PRD 2.2：设备状态与个人账号放在顶部；顶栏高度固定 HEADER_HEIGHT(85px)。
 *
 * 真件是 `./DemoHeader`（视觉照抄 Demo2 的 panel/headder.tsx，viewBox 1920x85）。
 * 这里只做接线：把导航、账号、通道状态、时间喂给它，不再自己画一套顶栏。
 */

import { useEffect, useState, type ReactNode } from "react";
import { ACCOUNTS } from "./design";
import type { Permission } from "./auth";
import { Icon } from "./icons";
import { StatusChip } from "./ui";
import type { Tone } from "./lib";
import type { ChannelStatus } from "./seed/types";
import DemoHeader from "./DemoHeader";

const channelTone: Record<ChannelStatus["state"], Tone> = {
  online: "ok",
  stale: "warn",
  offline: "danger",
};

const channelStateText: Record<ChannelStatus["state"], string> = {
  online: "正常",
  stale: "延迟",
  offline: "断开",
};

/** 四路通道状态：地图 / 位姿 / 视频 / 车辆（PRD 3.2「任一路断流只影响该通道」） */
function ChannelStrip({ channels, onOpen }: { channels: ChannelStatus[]; onOpen?: () => void }) {
  return (
    <div className="appshell__channels" role="group" aria-label="设备通道状态">
      {channels.map((channel) => (
        <button
          key={channel.key}
          type="button"
          onClick={onOpen}
          title={`${channel.source} · 更新于 ${channel.updatedAt}`}>
          <span className="appshell__channels-label">{channel.label}</span>
          <StatusChip text={channelStateText[channel.state]} tone={channelTone[channel.state]} />
          <em>{channel.updatedAt}</em>
        </button>
      ))}
    </div>
  );
}

export interface HeaderProps {
  channels: ChannelStatus[];
  navItems: readonly { readonly key: string; readonly label: string }[];
  activeNav: string;
  onNav: (label: string) => void;
  accountId: string;
  /** 权限判断：排练控制台入口按 console:admin 显示 */
  can: (permission: Permission) => boolean;
  /**
   * 退出登录。
   *
   * 这里**不再传 onAccountChange**：账号只能从登录页进入，
   * 顶栏提供角色下拉就等于绕开角色权限（PRD 2.1 把角色限制放在后端，演示版
   * 至少要做到「换角色必须重新登录」）。
   */
  onLogout?: () => void;
  onPresent?: () => void;
  /** 打开排练控制台（仅 console:admin） */
  onConsole?: () => void;
  onOpenDevices?: () => void;
  extra?: ReactNode;
}

export default function Header({
  channels,
  navItems,
  activeNav,
  onNav,
  accountId,
  can,
  onLogout,
  onPresent,
  onConsole,
  onOpenDevices,
  extra,
}: HeaderProps) {
  // 本地时钟：顶栏时间每秒走一格
  const [time, setTime] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setTime(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const account = ACCOUNTS.find((item) => item.id === accountId) ?? ACCOUNTS[0];

  return (
    <header className="appshell__header appshell__header--native">
      <DemoHeader
        navItems={navItems}
        activeNav={activeNav}
        onNav={onNav}
        account={{ name: account.name, role: account.role }}
        time={time}
        statusExtra={
          <>
            <ChannelStrip channels={channels} onOpen={onOpenDevices} />
            {extra}
          </>
        }
        actions={
          <>
            {/*
              排练控制台入口：只给有 console:admin 的角色（沈 / 史）。
              刻意不放进一级导航 —— PRD §11 说管理员排练控制独立于日常岗位，
              业务导航保持八项（design.ts 的 NAV_ITEMS 里也有同样的说明）。
            */}
            {can("console:admin") ? (
              <button
                type="button"
                className="appshell__present"
                onClick={onConsole}
                title="排练控制台：新建演示会话、捕获与恢复阶段快照">
                <Icon name="database" />
                排练控制台
              </button>
            ) : null}
            <button
              type="button"
              className="appshell__present"
              onClick={onPresent}
              title="投屏">
              <Icon name="arrow" />
              投到展示窗口
            </button>
            <button
              type="button"
              className="appshell__logout"
              onClick={onLogout}
              title={`退出登录：${account.name} · ${account.role}（账号 ${account.login}）`}>
              <Icon name="user" />
              <b>{account.name}</b>
              <small>{account.role}</small>
              <em>退出</em>
            </button>
          </>
        }
      />
    </header>
  );
}
