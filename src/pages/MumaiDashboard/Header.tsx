/**
 * 木脉智检 · 应用顶栏
 *
 * PRD 2.2：设备状态与个人账号放在顶部；顶栏高度固定 HEADER_HEIGHT(85px)。
 *
 * 真件是 `./DemoHeader`（视觉照抄 Demo2 的 panel/headder.tsx，viewBox 1920x85）。
 * 这里只做接线：把导航、账号、通道状态、时间喂给它，不再自己画一套顶栏。
 *
 * 右上角的账号入口只有一处（本文件的 `.appshell__logout`：账号身份图标 + 姓名 +
 * 角色 + 退出），DemoHeader 自己不再画账号框 —— 理由见下面 actions 里的注释。
 */

import { useEffect, useState, type ReactNode } from "react";
import { ACCOUNTS } from "./design";
import type { Permission } from "./auth";
import { Icon, type IconName } from "./icons";
import { StatusChip } from "./ui";
import type { Tone } from "./lib";
import DemoHeader from "./DemoHeader";

/**
 * 顶栏右侧的一个状态项。
 *
 * 原来是四路通道（地图 / 位姿 / 视频 / 车辆）带更新时间戳 —— 那四行对看板的人
 * 没有信息量：地图与位姿本来就归巡检车、手持端只有视频一路，时间戳还是种子里的
 * 固定值（14:22:31 这种，永远不动）。现在换成四个**观众真的会问**的对象，
 * 每一项的状态都来自真实来源：
 *
 *   平台    —— 浏览器与共享服务的实时通道（`useSharedStore().status`）
 *   智能车  —— 当前巡检任务的状态（`useMumai().mission.state`）
 *   扫描仪  —— 手持终端链路（`useDeviceLink`：真机在线 / 延迟 / 离线 / 未接入）
 *   模型    —— 当前演示模型版本（终端上报优先，否则平台版本台账）
 *
 * 时间与来源不再挤在版面上，全部放进 `title`（悬停可见）。
 */
export type HeaderStatusItem = {
  key: string;
  label: string;
  /**
   * 状态词：正常 / 执行中 / 真机在线 / 延迟 12s …
   *
   * 类型从 `string` 放宽到 `ReactNode`：扫描仪那一格的秒数是从手持终端链路快照里
   * 算出来的**会变的数**（`useDeviceLink` 的 ageSec，5 秒一轮），拼成模板串就等于
   * 把它写死了 —— 只能整块重画，也上不了数字动效。改成节点后可以把
   * `<NumberAnimation>` 放进状态词中间；`StatusChip` 的 `text` 同样吃 `ReactNode`。
   * 另外三格仍然传字符串，渲染结果与之前逐字一致。
   */
  text: ReactNode;
  tone: Tone;
  /** 悬停说明：来源、时间、原因 —— 原来占版面的那一列时间戳挪到这里 */
  title: string;
};

function StatusStrip({ items, onOpen }: { items: HeaderStatusItem[]; onOpen?: () => void }) {
  return (
    <div className="appshell__channels" role="group" aria-label="平台与设备状态">
      {items.map((item) => (
        <button key={item.key} type="button" onClick={onOpen} title={item.title}>
          <span className="appshell__channels-label">{item.label}</span>
          <StatusChip text={item.text} tone={item.tone} />
        </button>
      ))}
    </div>
  );
}

export interface HeaderProps {
  /** 顶栏右侧的状态项：平台 / 智能车 / 扫描仪 / 模型（由 Shell 组装） */
  statusItems: HeaderStatusItem[];
  /** 顶栏左上「状态正常 N/M」的计数，与 statusItems 同源，不另写死一个数 */
  statusSummary: { ok: number; total: number };
  /** icon 为 v2 素材包的 nav-* 图标名，与 DemoHeader 的导航图标一致 */
  navItems: readonly {
    readonly key: string;
    readonly label: string;
    readonly icon: IconName;
  }[];
  activeNav: string;
  onNav: (label: string) => void;
  accountId: string;
  /** 权限判断：排练控制台入口按 console:admin 显示 */
  can: (permission: Permission) => boolean;
  /**
   * 退出登录。右上角那一块账号入口（图标 + 姓名 + 角色 + 退出）点下去就是它。
   *
   * 这里**不传 onAccountChange**：账号只能从登录页进入，
   * 顶栏提供角色下拉就等于绕开角色权限（PRD 2.1 把角色限制在后端，演示版
   * 至少要做到「换角色必须重新登录」）。
   */
  onLogout?: () => void;
  onPresent?: () => void;
  /** 打开排练控制台（仅 console:admin） */
  onConsole?: () => void;
  onOpenDevices?: () => void;
}

export default function Header({
  statusItems,
  statusSummary,
  navItems,
  activeNav,
  onNav,
  accountId,
  can,
  onLogout,
  onPresent,
  onConsole,
  onOpenDevices,
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
        statusSummary={statusSummary}
        statusExtra={<StatusStrip items={statusItems} onOpen={onOpenDevices} />}
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
                {/*
                  PRD §3.3 迁移表：「database、wave、arrow 保留原图标 ——
                  新包没有同义替代时继续使用」。排练控制台的会话/快照属于数据语义，
                  v2 的 44 枚里没有会话或快照图标，因此保留 database，不改图形。
                */}
                <Icon name="database" size={20} aria-hidden />
                排练控制台
              </button>
            ) : null}
            <button
              type="button"
              className="appshell__present"
              onClick={onPresent}
              title="投屏">
              {/*
                PRD §3.3：「arrow 保留原图标」。投到展示窗口是「把当前画面送出去」，
                v2 的 action-* 里没有对应语义（action-upload 是上传文件），保留箭头。
              */}
              <Icon name="arrow" size={20} aria-hidden />
              投到展示窗口
            </button>
            {/*
              账号入口：顶栏右上角**只此一个**（评审 V09 / P1「合并账号入口」）。

              原来这里是「退出登录」按钮，而 DemoHeader 在没有 onAccountChange 时
              还会自己画一个「账号名 + 角色」的只读按钮，于是同一个人名并排出现两次、
              两个框，其中一个还是不可点的装饰 —— 既重复又容易误点。
              现在那个只读按钮已从 DemoHeader 删除，账号信息全部收进这一个按钮：
              图标（账号身份） + 姓名 + 角色 + 分隔线 + 退出。

              整块可点即退出登录：原来「退出」只是这个按钮里的一小段文字，
              现在它旁边那个只读框没了，退出就是这个账号入口本身的行为。
            */}
            <button
              type="button"
              className="appshell__logout"
              onClick={onLogout}
              title={`退出登录：${account.name} · ${account.role}（账号 ${account.login}）`}>
              {/*
                PRD §3.3：user → identity-user（账号身份，已迁移）。
                按钮本身有中文文字，图标对辅助技术隐藏。
              */}
              <Icon name="identity-user" size={20} aria-hidden />
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
