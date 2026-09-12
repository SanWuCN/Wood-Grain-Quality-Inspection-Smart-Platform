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

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router";
import { ACCOUNTS, HEADER_HEIGHT, NAV_ITEMS } from "./design";
import {
  allowsPath,
  navFor,
  PERMISSION_LABEL,
  ROUTE_PERMISSION,
  workspacePath,
} from "./auth";
import Header from "./Header";
import SmallWoodPanel from "./SmallWoodPanel";
import { Icon } from "./icons";
import { useMumai } from "./context";
import { writeFocus } from "./focus";
import { useShellEntrance } from "./entrance";
import { useConfigStore } from "./mapDemo/stores";
import { COMPONENTS, CURRENT_RISKS, DEVICES, SCAN_BATCHES } from "./seed/scenario";
import "./appshell.css";
import "./pages.css";

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

export default function Shell() {
  const location = useLocation();
  const navigate = useNavigate();
  const {
    accountId,
    assistantOpen,
    setAssistantOpen,
    channels,
    toasts,
    dismissToast,
    events,
    sessionId,
    currentOrder,
    logout,
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

  // PRD 2.2：投放时把当前焦点（工单 / 构件 / 批次）与控制权持有人写进共享焦点，
  // 大屏窗口 /present 读同一份状态，不再各存一套。
  const openPresent = useCallback(() => {
    const search = new URLSearchParams(location.search);
    writeFocus({
      holderId: accountId,
      orderId: search.get("order") ?? currentOrder.id,
      componentId:
        search.get("component") ?? CURRENT_RISKS[0]?.componentId ?? COMPONENTS[0].id,
      batchId: search.get("batch") ?? SCAN_BATCHES[0]?.batchId ?? "",
    });
    window.open("#/present", "_blank", "noopener");
  }, [accountId, currentOrder, location.search]);

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
      <div className="appshell appshell--present">
        <Suspense fallback={<div className="appshell__boot"><strong>正在打开大屏</strong></div>}>
          <Outlet />
        </Suspense>
      </div>
    );
  }

  return (
    <div className="appshell" style={{ ["--appshell-header" as string]: `${HEADER_HEIGHT}px` }}>
      <Header
        channels={channels}
        navItems={permittedNav}
        activeNav={activeNavLabel}
        onNav={handleNav}
        accountId={accountId}
        onLogout={handleLogout}
        onPresent={openPresent}
        onOpenDevices={() => {
          if (allowsPath(accountId, "/mapping")) navigate("/mapping");
          else navigate(lastAllowed.current);
        }}
        extra={<span className="appshell__source">{DEVICES.scanner.name} · 模拟采集</span>}
      />

      <main className="appshell__stage">
        {/*
          内容区必须**立刻**渲染，装载浮层叠在它上面。

          原来这里是 `{!booting && <Outlet/>}` —— 装载浮层占位的 620ms 里页面根本没挂载，
          地图的开场推镜头要等浮层消失才开始，于是「页面加载 → 全部就位」被拉长到约 6 秒，
          而规范 §6.2 要求开场动画落在 2.4–3.2s。
          改成浮层只做覆盖、不阻塞挂载之后，镜头从 t≈0 就开始推，整段回到 Demo2 的节奏。
        */}
        {!online ? null : !allowed ? (
          // 路由守卫：无权限的路由不渲染页面内容，给提示 + 回默认工作区
          <PermissionNotice pathname={location.pathname} />
        ) : (
          <Suspense
            fallback={
              <div className="appshell__boot">
                <strong>正在打开页面</strong>
                <div className="appshell__boot-bar">
                  <i />
                </div>
              </div>
            }>
            <Outlet />
          </Suspense>
        )}

        {booting ? (
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
          aria-label="小木助手">
          <Icon name="bot" />
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
            onClick={() => dismissToast(item.id)}>
            {item.text}
          </button>
        ))}
      </div>

      <div className="appshell__ticker">
        <span>
          数据源 <b>演示回放</b>
        </span>
        <span>会话 {sessionId} · 事件 seq {1000 + events.length}</span>
        <span>{DEVICES.realCart.name} 未获运动权限（只读监视）</span>
        <span>地图 · 位姿 · 视频 · 车辆 四路通道独立状态</span>
      </div>
    </div>
  );
}
