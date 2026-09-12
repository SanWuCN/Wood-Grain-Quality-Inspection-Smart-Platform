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
 */

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router";
import { ACCOUNTS, HEADER_HEIGHT, NAV_ITEMS } from "./design";
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

export default function Shell() {
  const location = useLocation();
  const navigate = useNavigate();
  const {
    accountId,
    setAccountId,
    assistantOpen,
    setAssistantOpen,
    channels,
    toasts,
    dismissToast,
    resetDemo,
    events,
    sessionId,
    currentOrder,
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

  const activeKey = useMemo(
    () => NAV_ITEMS.find((item) => item.path === location.pathname)?.key ?? "overview",
    [location.pathname],
  );
  const activeNavLabel = useMemo(
    () => NAV_ITEMS.find((item) => item.key === activeKey)?.label ?? "任务总览",
    [activeKey],
  );

  /**
   * 入场动画（对齐 Demo2）。
   *
   * 总览页有地图：等 `mapPlayComplete`（地图镜头推完，t≈2.5s）再让左右面板入场，
   * 两段动画咬合；其它页面没有地图，boot 一结束就播。
   */
  const mapPlayComplete = useConfigStore((state) => state.mapPlayComplete);
  const isOverview = location.pathname === "/";
  useShellEntrance(!booting && (isOverview ? mapPlayComplete : true), location.pathname);

  const handleAccountChange = useCallback(
    (id: string) => {
      setAccountId(id);
      const next = ACCOUNTS.find((item) => item.id === id);
      // 切换账号后进入该账号默认工作区
      if (next) navigate(next.page);
    },
    [navigate, setAccountId],
  );

  const handleNav = useCallback(
    (label: string) => {
      const item = NAV_ITEMS.find((entry) => entry.label === label);
      if (item) navigate(item.path);
    },
    [navigate],
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
        navItems={NAV_ITEMS}
        activeNav={activeNavLabel}
        onNav={handleNav}
        accountId={accountId}
        onAccountChange={handleAccountChange}
        onPresent={openPresent}
        onOpenDevices={() => navigate("/mapping")}
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
        {online ? (
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
        ) : null}

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
        <em>默认工作区：{account.workspace}</em>
        <button
          type="button"
          className="btn btn--ghost"
          onClick={resetDemo}
          title="装载阶段快照（演示控制）">
          装载快照
        </button>
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
