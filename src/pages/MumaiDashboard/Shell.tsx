/**
 * 木脉智检 · 外壳布局
 *
 * 布局结论（对齐 Demo2 的真实布局）：
 *   Demo2 是「Canvas 铺满视口 + 面板 absolute 浮在其上」，地图可用宽度是整屏。
 *   因此这里**不放左侧导航栏**——顶栏的 NavLayer 已经是完整的一级导航，
 *   再放一条竖导航只会白白吃掉地图宽度。内容区铺满顶栏以下的全部空间，
 *   需要浮层的页面自己在内容区里用 absolute 定位。
 *
 * PRD 15：所有页有加载 / 空数据 / 错误 / 断线状态。
 *
 * 本文件另外负责三件与角色权限有关的事（PRD 2.1 / 2.2）：
 *   1) 一级导航按当前角色的权限过滤后再渲染
 *   2) 直接输入无权限的 URL 时拦截内容区，给中性提示并给一个能回去的按钮
 *   3) 顶栏右上角显示当前账号与角色，并提供退出登录
 */

import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Outlet, useLocation, useNavigate } from "react-router";
import NumberAnimation from "@/components/numberAnimation";
import { ACCOUNTS, HEADER_HEIGHT, NAV_ITEMS } from "./design";
import {
  allowsPath,
  isRegisteredPath,
  navFor,
  PERMISSION_LABEL,
  ROUTE_PERMISSION,
  workspacePath,
} from "./auth";
import Header, { type HeaderStatusItem } from "./Header";
import SmallWoodPanel from "./SmallWoodPanel";
import { Icon } from "./icons";
import { Illustration } from "./illustrations";
import { useMumai } from "./context";
import { holderLabel, VIEW_LABEL, viewTypeForPath, writeFocus } from "./focus";
import { useShellEntrance } from "./entrance";
import LoadingVeil from "./LoadingVeil";
import { useConfigStore } from "./mapDemo/stores";
import { COMPONENTS, CURRENT_RISKS, DEVICES, SCAN_BATCHES } from "./seed/scenario";
import type { Mission } from "./seed/types";
import { useDeviceLink } from "./device/useDeviceLink";
import { VERSION_ITEMS } from "./seed/versions";
import type { Tone } from "./lib";
import { HANDHELD_DEVICE_ID } from "./device/types";
import { useWorkOrderShortcut } from "./useWorkOrderShortcut";
import { isWorkOrderEvent, useWorkOrderStore } from "./store/workOrders";
import { useSharedStore } from "./store/shared";
import "./appshell.css";
import "./pages.css";
/*
  建图巡航页（`/mapping`，小车真实数据）的样式单独一份。
  不并进 pages.css：那份已经八千多行，而这一页的类名全部以 `cart-` 前缀成组，
  单独一份更好定位、也避免和旧「建图巡检」的 `map-*` / `rviz*` 类互相打架。
*/
import "./cart.css";
// UI 视觉素材 v2.0：主题变量作用域 + 图标/插图样式（PRD §4）
// 必须放在平台样式之后 —— 作用域内的 v2 变量要能覆盖同名的兜底色
import "./styles/ui-assets-v2.css";
import "./ui-assets-v2-icons.css";

/** 无权限提示：说明原因 + 一个能回到本角色工作区的按钮，不白屏、不报错 */
function PermissionNotice({ pathname }: { pathname: string }) {
  const navigate = useNavigate();
  const { accountId } = useMumai();
  const account = ACCOUNTS.find((item) => item.id === accountId) ?? ACCOUNTS[0];
  const required = ROUTE_PERMISSION[pathname] ?? [];
  const nav = NAV_ITEMS.find((item) => item.path === pathname);

  return (
    <div className="appshell__denied">
      <div className="appshell__denied-box">
        <span className="appshell__denied-dot" />
        <strong>当前角色无此页面权限</strong>
        <em>
          {account.name} · {account.role}
          {nav ? `，不包含「${nav.label}」` : ""}。该页面需要
          {required.length > 0
            ? required.map((item) => `「${PERMISSION_LABEL[item]}」`).join(" 或 ")
            : "独立管理权限"}
          ，请使用具备该权限的账号，或回到本角色的默认工作区。
        </em>
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => navigate(workspacePath(account.id), { replace: true })}>
          回到{account.workspace}
        </button>
      </div>
    </div>
  );
}

/**
 * 未知地址提示（routes.tsx 的 `*` 兜底路由渲染它）。
 *
 * 与「无权限」分开：地址压根不存在时不能报「当前角色无此页面权限」，
 * 那会把用户支到「换账号」这条错路上。这里直说地址不对，并给回工作区的出口。
 *
 * 做成独立组件而不是让 Shell 直接渲染，是因为 Shell 只在**有 route 匹配**时才
 * 挂载 —— 未登记的地址一个 route 都不匹配，外壳根本不渲染，页面全黑。
 * 所以必须在路由表里放一个 `path="*"` 把外壳拉起来，再由 Shell 放行 Outlet。
 */
export function UnknownRoute() {
  const navigate = useNavigate();
  const location = useLocation();
  const { accountId } = useMumai();
  const account = ACCOUNTS.find((item) => item.id === accountId) ?? ACCOUNTS[0];

  return (
    <div className="appshell__denied">
      <div className="appshell__denied-box">
        <span className="appshell__denied-dot" />
        <strong>页面不存在</strong>
        <em>
          <code className="appshell__denied-path">{location.pathname}</code>
          不是本平台的页面地址，可能来自已下线的旧链接。请从顶部导航进入，或回到
          {account.name} 的默认工作区。
        </em>
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => navigate(workspacePath(account.id), { replace: true })}>
          回到{account.workspace}
        </button>
      </div>
    </div>
  );
}

export default function Shell() {
  const location = useLocation();
  const navigate = useNavigate();
  /*
    顶栏状态区接真实来源：平台（共享服务通道）、智能车（当前任务）、扫描仪（终端链路，
    5 秒慢轮询就够 —— 硬件页自己有 2 秒的那一份）、模型（版本台账）。
    原来这四格是四路通道 + 种子里的固定时间戳，掉线了也不会变，属于"看着像状态"。
  */
  const deviceLink = useDeviceLink(HANDHELD_DEVICE_ID, { pollMs: 5000 });
  const {
    accountId,
    assistantOpen,
    setAssistantOpen,
    toasts,
    dismissToast,
    toast,
    can,
    events,
    sessionId,
    currentOrder,
    logout,
    mission,
    sharedStatus,
    sharedError,
  } = useMumai();

  const [booting, setBooting] = useState(true);
  const [online, setOnline] = useState(true);

  useEffect(() => {
    const timer = window.setTimeout(() => setBooting(false), 620);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const onOffline = () => setOnline(false);
    const onOnline = () => setOnline(true);
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    return () => {
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
    };
  }, []);

  useEffect(() => {
    document.title = "木脉智检 · 古建筑智能巡检平台";
  }, []);

  /* ------------------------------------------------------------------ *
   * 隐藏快捷键 Ctrl + Q + L：小木接单 → 平台工单（PRD §3）
   *
   * 注册点放在外壳上，所以每个已登录页面都能触发；触发器本身负责按键序列识别、
   * 幂等事件 ID 与失败重试，这里只负责「告诉用户发生了什么」。
   * 平台上**不显示**任何快捷键提示，也不加来单入口。
   * ------------------------------------------------------------------ */
  useWorkOrderShortcut({
    onCreated: useCallback(
      ({ orderNo, orderId, created }) => {
        toast(
          created ? `收到新工单 ${orderNo}，待项目经理指派` : `新工单 ${orderNo} 已存在（重复触发未重复建单）`,
          created ? "ok" : "warn",
          { label: "查看", to: `/orders?order=${encodeURIComponent(orderId)}` },
        );
      },
      [toast],
    ),
    onFailed: useCallback(
      (message: string) => {
        // 失败绝不显示成功通知（PRD §3.1）
        toast(`工单创建失败：${message}`, "danger");
      },
      [toast],
    ),
  });

  /**
   * 别的端建了单 / 改了工单 → 本端列表与详情跟着刷新。
   * 事件体不带完整实体，收到就重拉一次列表（PRD §3.1「工单列表实时刷新」）。
   */
  const lastSharedEvent = useSharedStore((state) => state.lastEvent);
  useEffect(() => {
    if (!isWorkOrderEvent(lastSharedEvent?.type)) return;
    void useWorkOrderStore.getState().refresh();
    const selected = useWorkOrderStore.getState().detail?.order.id;
    if (selected && selected === lastSharedEvent?.entityId) void useWorkOrderStore.getState().select(selected);
  }, [lastSharedEvent]);

  const account = useMemo(
    () => ACCOUNTS.find((item) => item.id === accountId) ?? ACCOUNTS[0],
    [accountId],
  );

  /* ---- PRD 2.2：导航按角色过滤 ---- */

  const permittedNav = useMemo(() => navFor(accountId), [accountId]);

  // 本角色能进的最后一个页面：无权限时优先回到它
  const lastAllowed = useRef<string>(account.page);
  useEffect(() => {
    if (allowsPath(accountId, location.pathname)) lastAllowed.current = location.pathname;
  }, [accountId, location.pathname]);

  const allowed = allowsPath(accountId, location.pathname);

  const activeKey = useMemo(
    () => permittedNav.find((item) => item.path === location.pathname)?.key ?? permittedNav[0]?.key ?? "overview",
    [location.pathname, permittedNav],
  );
  const activeNavLabel = useMemo(
    () => permittedNav.find((item) => item.key === activeKey)?.label ?? permittedNav[0]?.label ?? "任务总览",
    [activeKey, permittedNav],
  );

  /**
   * 顶栏右侧四格状态：平台 / 智能车 / 扫描仪 / 模型。
   *
   * 每一格都接真实来源，而且**没有数据就说没有数据**（「未接入」「—」），
   * 不拿种子里的固定值充数 —— 顶栏是四台电脑都会盯着的那一行，
   * 它写错一个状态，现场就要多问一轮。
   */
  const statusItems = useMemo<HeaderStatusItem[]>(() => {
    /* 平台：浏览器到共享服务的实时通道（WebSocket + 快照） */
    const platformText =
      sharedStatus === "online" ? "正常" : sharedStatus === "connecting" ? "连接中" : sharedStatus === "offline" ? "离线" : "未连接";
    const platformTone: Tone =
      sharedStatus === "online" ? "ok" : sharedStatus === "connecting" ? "warn" : "danger";

    /* 智能车：当前巡检任务的状态（平台自己的工作流状态，不是设备遥测） */
    const MISSION_TONE: Record<Mission["state"], Tone> = {
      草稿: "muted",
      已预览: "info",
      等待机器人确认: "warn",
      执行中: "ok",
      已暂停: "warn",
      已完成: "ok",
      已取消: "danger",
    };
    const missionTone = MISSION_TONE[mission.state] ?? "muted";

    /*
      扫描仪：手持终端链路（真机优先，没上报过就说未接入）。

      `text` 的类型放宽到 `ReactNode`：延迟 / 离线两格里的秒数是**会变的数**
      （5 秒慢轮询，每轮都可能变），拼成模板串就写死了 —— 只能整块重画，也没有动效。
      改成节点之后，<NumberAnimation> 每一轮都从屏幕上那个数平滑滚到新数。
      其余几格仍给字符串，渲染结果与之前逐字一致。

      外面那层 `<span>` 不是多余的包裹：chip 是 `inline-flex + gap:5px`（pages.css
      的 .chip），节点直接摊在 chip 里会被拆成「延迟」「5」「s」三个 flex 项，
      gap 会在中间各插一道 5px，整格比原来宽约 10px —— 顶栏这一行本来就窄且会被裁切。
      包成一个文本项之后，chip 的 flex 项仍是「点 + 文字」，版式与模板串逐像素一致。

      `title` 保持纯字符串：悬停说明是固定文案，不是「会变的数」，
      给它上动效只会让 tooltip 每秒重写一次。
    */
    const model = deviceLink.view?.report?.hardware?.model;
    const age = deviceLink.view?.ageSec ?? 0;
    const scanner: { text: ReactNode; tone: Tone; title: string } = (() => {
      switch (deviceLink.phase) {
        case "live":
          return {
            text: "真机在线",
            tone: "ok",
            title: `${model ?? "手持终端"} · ${age} 秒前上报${deviceLink.view?.link.socketConnected ? " · 设备通道已建立" : ""}`,
          };
        case "stale":
          return {
            /*
              空格与「s」都写在 JSX 里：同一行的空格会被保留，秒数只是中间那一段。
              `group={false}` 是为了**文本与改动前逐字一致**：这里是「已经过去多少秒」的
              计时读数，原来的模板串写的就是 `延迟 1200s`；默认的千分位会把它渲染成
              「延迟 1,200s」，凭空多一个字符，而顶栏这一行本来就窄、还会被裁切。
              序号 / 计时 / 编号一类值都按这个口径（不给千分位），
              真正的「数量」（场数、实体数）才用默认的千分位。
            */
            text: (
              <span>
                延迟 <NumberAnimation value={age} group={false} />s
              </span>
            ),
            tone: "warn",
            title: `${model ?? "手持终端"} · 已 ${age} 秒没有新数据`,
          };
        case "offline":
          return {
            text: (
              <span>
                离线 <NumberAnimation value={age} group={false} />s
              </span>
            ),
            tone: "danger",
            title: `${model ?? "手持终端"} · 已离线 ${age} 秒，硬件页保留最后一份数据`,
          };
        case "waiting":
          return { text: "未接入", tone: "muted", title: "终端还没上报过设备数据；硬件详情页显示的是演示种子数据" };
        case "unavailable":
          return { text: "通道不可达", tone: "danger", title: deviceLink.error || "读不到设备数据" };
        default:
          return { text: "读取中", tone: "info", title: "正在读取设备数据" };
      }
    })();

    /* 模型：终端上报的演示模型版本优先，没有就用平台版本台账里的当前值 */
    const modelVersion =
      deviceLink.view?.report?.versions?.model ?? VERSION_ITEMS.find((item) => item.key === "model")?.current ?? "—";
    const pipeline = VERSION_ITEMS.find((item) => item.key === "pipeline")?.current ?? "—";

    return [
      {
        key: "platform",
        label: "平台",
        text: platformText,
        tone: platformTone,
        title:
          sharedStatus === "online"
            ? `共享服务在线 · 会话 ${sessionId}`
            : sharedError || "共享服务连接未建立",
      },
      {
        key: "cart",
        label: "智能车",
        text: mission.state,
        tone: missionTone,
        title: `${mission.robotId} · 地图 ${mission.mapVersion ?? "—"} · ${mission.speedProfile}`,
      },
      {
        key: "scanner",
        label: "扫描仪",
        text: scanner.text,
        tone: scanner.tone,
        title: scanner.title,
      },
      {
        key: "model",
        label: "模型",
        text: modelVersion,
        tone: "info",
        title: `演示模型（不是控制器固件） · 推理流水线 ${pipeline}`,
      },
    ];
  }, [deviceLink, mission, sessionId, sharedError, sharedStatus]);

  /** 右上角计数与四格状态同源：不写死 4/4，掉线时数字会跟着变 */
  const statusSummary = useMemo(() => {
    const ok = statusItems.filter((item) => item.tone === "ok" || item.tone === "info").length;
    return { ok, total: statusItems.length };
  }, [statusItems]);

  /**
   * 「投到展示窗口」（PRD 2.2 / 评审 F13）。
   *
   * 投出去的是**当前这一页对应的展示视图 + 焦点对象**，不再只是一张静态总览：
   * 在孪生页投放就看场景，在训练页投放就看曲线。写入走服务端命令，
   * 于是别的电脑上开着的 /present 也会跟着切 —— 评审要的正是这一点
   * （localStorage 只能在同一台浏览器内传）。
   *
   * 非持有人切换会被服务端 409 拒绝：这时如实告诉用户「当前由谁持有」，
   * 不打开一个假装投放成功的大屏。
   */
  const openPresent = useCallback(async () => {
    const search = new URLSearchParams(location.search);
    const payload = {
      holderId: accountId,
      viewType: viewTypeForPath(location.pathname),
      orderId: search.get("order") ?? currentOrder.id,
      componentId: search.get("component") ?? CURRENT_RISKS[0]?.componentId ?? COMPONENTS[0].id,
      batchId: search.get("batch") ?? SCAN_BATCHES[0]?.batchId ?? "",
      sceneId: search.get("scene"),
    };

    let result = await writeFocus(payload);
    if (!result.ok && result.holderId && result.holderId !== accountId) {
      /*
       * 控制权在别人手上：PRD §2.2 要求「换人时显式交接」，不能悄悄抢过来。
       * 第一次点只是被告知「现在是谁」，再点一次才真的接管 —— 这样台上不会因为
       * 误触就把别人的画面切走。接管动作本身由服务端记录在事件流里。
       */
      const confirmed = window.confirm(
        `${holderLabel(result.holderId)} 正在投屏。接管后对方的大屏画面会被你切走，确认接管？`,
      );
      if (!confirmed) {
        toast(`投屏由 ${holderLabel(result.holderId)} 持有，未接管`, "warn");
        return;
      }
      result = await writeFocus({ ...payload, hold: true });
    }

    if (!result.ok) {
      toast(result.message, "danger");
      return;
    }
    toast(`已投放：${VIEW_LABEL[result.focus.viewType]}`, "ok");
    window.open("#/present", "_blank", "noopener");
  }, [accountId, currentOrder, location.pathname, location.search, toast]);

  // 已登录状态下不再提供角色切换：账号只能从登录页进入，避免在顶栏绕过角色限制
  const handleLogout = useCallback(() => {
    logout();
    navigate("/login", { replace: true });
  }, [logout, navigate]);

  /**
   * 入场动画（对齐 Demo2）。
   *
   * 总览页有地图：等 `mapPlayComplete`（地图镜头推完，t≈2.5s）再让左右面板入场，
   * 两段动画咬合；其它页面没有地图，boot 一结束就播。
   */
  const mapPlayComplete = useConfigStore((state) => state.mapPlayComplete);
  const isOverview = location.pathname === "/";
  useShellEntrance(!booting && (isOverview ? mapPlayComplete : true), location.pathname);

  const handleNav = useCallback(
    (label: string) => {
      const item = permittedNav.find((entry) => entry.label === label);
      if (item) navigate(item.path);
    },
    [navigate, permittedNav],
  );

  // 大屏展示窗口：presentation 角色，纯展示、无外壳
  const isPresent = location.pathname === "/present";

  if (isPresent) {
    return (
      <div className="appshell appshell--present mumai-ui-v2">
        <Suspense fallback={<div className="appshell__boot"><strong>正在打开大屏</strong></div>}>
          <Outlet />
        </Suspense>
      </div>
    );
  }

  return (
    <div
      className="appshell mumai-ui-v2"
      style={{ ["--appshell-header" as string]: `${HEADER_HEIGHT}px` }}>
      <Header
        statusItems={statusItems}
        statusSummary={statusSummary}
        navItems={permittedNav}
        activeNav={activeNavLabel}
        onNav={handleNav}
        accountId={accountId}
        can={can}
        onLogout={handleLogout}
        onPresent={openPresent}
        onConsole={() => navigate("/console")}
        onOpenDevices={() => {
          if (allowsPath(accountId, "/mapping")) navigate("/mapping");
          else navigate(lastAllowed.current);
        }}
      />

      <main className="appshell__stage">
        {/*
          内容区必须**立刻**渲染，装载浮层叠在它上面。

          原来这里是 `{!booting && <Outlet/>}` —— 装载浮层占位的 620ms 里页面根本没挂载，
          地图的开场推镜头要等浮层消失才开始，于是「页面加载 → 全部就位」被拉长到约 6 秒，
          而规范 §6.2 要求开场动画落在 2.4–3.2s。
          改成浮层只做覆盖、不阻塞挂载之后，镜头从 t≈0 就开始推，整段回到 Demo2 的节奏。
        */}
        {!online ? null : (
          <Suspense fallback={<LoadingVeil />}>
            {/*
              路由守卫，分三种情况，不能合并：
                ① 地址未登记（如拆页前的 #/adapt）→ 放行 Outlet，由 routes.tsx
                   的 `*` 兜底渲染「页面不存在」。这类地址 allowsPath 也是 false，
                   但报「无权限」是错的 —— 用户会去换账号，而问题在地址。
                ② 地址登记了、本角色没权限 → PermissionNotice。
                ③ 正常 → 渲染页面。
            */}
            {isRegisteredPath(location.pathname) && !allowed ? (
              <PermissionNotice pathname={location.pathname} />
            ) : (
              <Outlet />
            )}
          </Suspense>
        )}

        {booting && !isOverview ? (
          <div className="appshell__boot">
            <div className="appshell__boot-mark">
              <i />
              <i />
              <i />
            </div>
            <strong>正在装载演示种子</strong>
            <em>scenario / work order / environment / RAG index snapshot</em>
            <div className="appshell__boot-bar">
              <i />
            </div>
          </div>
        ) : null}

        {!booting && !online ? (
          <div className="appshell__boot appshell__boot--warn">
            <strong>网络已断开</strong>
            <em>
              本地索引与种子数据仍可浏览；需要服务端的操作保持等待状态，断线只影响请求通道。
            </em>
            <button type="button" className="btn" onClick={() => setOnline(true)}>
              使用本地快照继续
            </button>
          </div>
        ) : null}
      </main>

      {!booting ? (
        <button
          type="button"
          className={`appshell__fab ${assistantOpen ? "is-open" : ""}`}
          onClick={() => setAssistantOpen(!assistantOpen)}
          aria-label="小木助手"
          aria-expanded={assistantOpen}>
          {/*
            PRD §5 知识库与小木：「默认 I04 头像 32–40px；展开区 40–48px」、
            「16/24px 使用线性图标」。

            52px 圆内只有 34px 的画面，而 I04 是深色设备头像，缩到 34px 后主体
            只剩十几个像素、在深底上对比度也不够（实测截图里几乎看不出是什么）。
            因此这里按 PRD 的口径做**分层**：
              · 小尺寸入口（34px）用素材包的小木线性版（xiaomu-line-24）
              · I04 实拍头像放到展开区，用 40–48px 呈现（见 SmallWoodPanel）
            两者都是素材包内的正式资源，没有自绘替代物。
          */}
          <Illustration id="i04-xiaomu" height={34} avatar alt="" className="appshell__fab-avatar" />
          <Icon name="identity-agent" size={24} className="appshell__fab-icon" aria-hidden />
          <span>小木</span>
        </button>
      ) : null}
      {assistantOpen && !booting ? <SmallWoodPanel /> : null}

      <div className="appshell__login">
        <span>
          <i />
          {account.name} · {account.role}
        </span>
        <em>
          账号 {account.login} · 默认工作区：{account.workspace} · 可见导航 {permittedNav.length}/8
        </em>
      </div>

      <div className="appshell__toasts" role="status" aria-live="polite">
        {toasts.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`toast toast--${item.tone}`}
            onClick={() => {
              /*
                带去向的通知：点它跳过去查看（新工单到达时的「查看」）。
                **不自动跳页** —— 用户可能正在填表单，草稿必须保留（PRD §3.1）。
              */
              if (item.action) navigate(item.action.to);
              dismissToast(item.id);
            }}>
            {item.text}
            {item.action ? <em className="toast__action">{item.action.label}</em> : null}
          </button>
        ))}
      </div>

      <div className="appshell__ticker">
        <span>
          数据源 <b>演示回放</b>
        </span>
        {/*
          会话号与事件序号都**不做**动效：
            · 会话号是标识，一个会话从建立到结束都不会变；
            · `事件 seq 1001` 是单调递增的**序号**（1000 起算），不是量测值 ——
              它只会 +1，滚动看不出任何信息；而且序号按标识口径书写，
              没有千分位，交给 NumberAnimation 会按数量口径渲染成「1,001」，
              与原来的文本不一致（评审实测过这一条）。
          （`可见导航 N/8` 同理不做：分母是字面量 8，属于标签，不是运行时读数。）
        */}
        <span>会话 {sessionId} · 事件 seq {1000 + events.length}</span>
        <span>{DEVICES.realCart.name} 未获运动权限（只读监视）</span>
        <span>地图 · 位姿 · 视频 · 车辆 四路通道独立状态</span>
      </div>
    </div>
  );
}
