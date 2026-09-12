/**
 * 木脉智检 · 大屏总览（旧版单页实现，作为 pages/Overview.tsx 的布局参考保留）
 *
 * 说明：本文件已不参与路由 —— PRD 2.2 要求八个一级页面各自独立，
 * 总览页在 `pages/Overview.tsx`。这里保留旧的单页大屏布局，
 * 供总览页重构时对照（左右浮层的内容组织、指标分组、图例口径）。
 * 路由与外壳见 `Shell.tsx` / `AppShell.tsx`。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import DemoMap from "./mapDemo";
import DemoHeader from "./DemoHeader";
import { requestMapMode, useDashboardStore } from "./map/store";
import { STATUS_COLOR } from "./map/status";
import {
  chinaSites,
  moduleCopy,
  shanghaiSites,
  workOrders,
  type SiteStatus,
  type WorkOrder,
} from "./data";
import { ACCOUNTS, NAV_ITEMS } from "./design";
import { Icon } from "./icons";
import { Panel, Stat } from "./Panel";
import { DistrictBars, TrendChart } from "./TrendChart";
import WorkOrderModal from "./WorkOrderModal";
import ModuleDrawer from "./ModuleDrawer";
import { usePanelEntrance } from "./usePanelEntrance";

const legendItems: { status: SiteStatus; label: string }[] = [
  { status: "collected", label: "已采集" },
  { status: "inspected", label: "已巡检" },
  { status: "risk", label: "风险点" },
  { status: "workorder", label: "工单点" },
];

/** 顶栏右侧的账号（PRD 2.1 的四人之一，演示里固定为项目经理） */
const headerAccount = ACCOUNTS[0];

export default function Dashboard() {
  const mode = useDashboardStore((state) => state.mode);
  const introDone = useDashboardStore((state) => state.introDone);
  const transitioning = useDashboardStore((state) => state.transitioning);

  const [selectedSite, setSelectedSite] = useState("sh");
  const [selectedOrderId, setSelectedOrderId] = useState("SH-2026-0901");
  const [activeNav, setActiveNav] = useState("任务总览");
  const [drawer, setDrawer] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [clock, setClock] = useState(() => new Date());
  const [focused] = useState<string | null>(null);

  const { shellRef, topRef, leftRefs, rightRefs } = usePanelEntrance(introDone);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  // 做转场时先关掉弹层，避免遮挡地图
  useEffect(() => {
    if (!transitioning) return;
    setModalOpen(false);
    setDrawer(null);
  }, [transitioning]);

  const sites = mode === "china" ? chinaSites : shanghaiSites;
  const selected = sites.find((site) => site.id === selectedSite) ?? sites[0];
  const selectedOrder = useMemo(
    () => workOrders.find((order) => order.id === selectedOrderId) ?? workOrders[0],
    [selectedOrderId],
  );

  const enterShanghai = useCallback(() => {
    setSelectedSite("sh");
    setSelectedOrderId("SH-2026-0901");
    requestMapMode("shanghai");
  }, []);
  const returnChina = useCallback(() => requestMapMode("china"), []);
  const chooseOrder = useCallback((order: WorkOrder) => {
    setSelectedOrderId(order.id);
    if (order.id === "SH-2026-0901") {
      setSelectedSite("sh");
    }
  }, []);
  const activateNav = useCallback(
    (name: string) => {
      setActiveNav(name);
      if (name === "任务总览") setDrawer(null);
      else if (moduleCopy[name]) setDrawer(name);
    },
    [],
  );

  const goShanghai = mode === "china" ? enterShanghai : returnChina;

  return (
    <main className={`dashboard-shell ${introDone ? "is-ready" : ""}`} ref={shellRef}>
      <div className="ambient ambient--one" />
      <div className="ambient ambient--two" />

      <DemoHeader
        ref={topRef}
        navItems={NAV_ITEMS}
        activeNav={activeNav}
        onNav={activateNav}
        account={{ name: headerAccount.name, role: headerAccount.role }}
        time={clock}
      />

      <div className="dashboard-grid">
        <aside className="left-rail">
          <Panel
            title={mode === "china" ? "全国巡检态势" : "上海巡检态势"}
            ref={leftRefs[0]}>
            <div className="stat-stack">
              {mode === "china" ? (
                <>
                  <Stat icon={<Icon name="pin" />} label="已覆盖省份" value="8" />
                  <Stat icon={<Icon name="temple" />} label="古建点位" value="24" />
                  <Stat icon={<Icon name="check" />} label="完成巡检" value="18" note="完成率 75%" />
                </>
              ) : (
                <>
                  <Stat icon={<Icon name="temple" />} label="古建点位" value="6" />
                  <Stat icon={<Icon name="check" />} label="完成巡检" value="4" note="完成率 67%" />
                  <Stat icon={<Icon name="alert" />} label="风险构件" value="3" tone="red" />
                </>
              )}
            </div>
          </Panel>
          <Panel
            title={mode === "china" ? "近六月巡检趋势" : "区县分布"}
            extra={<small>单位：次</small>}
            className="chart-panel"
            ref={leftRefs[1]}>
            {mode === "china" ? <TrendChart /> : <DistrictBars />}
          </Panel>
        </aside>

        <section className="map-stage">
          <div className="map-breadcrumb">
            <button className={mode === "china" ? "is-current" : ""} onClick={returnChina}>
              全国总览
            </button>
            <span>/</span>
            <button className={mode === "shanghai" ? "is-current" : ""} onClick={enterShanghai}>
              上海市
            </button>
            {focused ? (
              <>
                <span>/</span>
                <b>{focused}</b>
              </>
            ) : null}
          </div>

          <DemoMap
            mode={mode}
            onReady={() => useDashboardStore.getState().setIntroDone(true)}
          />

          <div className="map-vignette" />

          <div className="map-controls">
            <div className="legend">
              {legendItems.map((item) => (
                <span key={item.status}>
                  <i style={{ background: STATUS_COLOR[item.status] }} />
                  {item.label}
                </span>
              ))}
            </div>
            <button className="button button--map" onClick={goShanghai} disabled={transitioning}>
              {mode === "china" ? "进入上海" : "返回全国"}
              <Icon name="arrow" />
            </button>
          </div>

          <div className="map-caption">
            <span>当前焦点</span>
            <strong>
              {selected?.province ?? selected?.district} · {selected?.name}
            </strong>
            <em>{selected?.risk ?? "巡检记录已归档"}</em>
          </div>

          <div className="map-hint">
            <Icon name="pin" /> 拖拽旋转 · 滚轮缩放 · 点击上海下钻
          </div>

          {drawer ? (
            <ModuleDrawer
              name={drawer}
              onClose={() => {
                setDrawer(null);
                setActiveNav("任务总览");
              }}
              onOpenOrder={() => {
                setDrawer(null);
                setModalOpen(true);
              }}
            />
          ) : null}
        </section>

        <aside className="right-rail">
          <Panel
            title="风险与工单"
            ref={rightRefs[0]}>
            <div className="risk-counters">
              <Stat icon={<Icon name="alert" />} label="高风险" value="3" tone="red" />
              <Stat icon={<Icon name="alert" />} label="待处理" value="7" tone="amber" />
              <Stat icon={<Icon name="order" />} label="处理中" value="4" />
            </div>
          </Panel>
          <Panel
            title="工单列表"
            extra={<button className="link-button">查看全部 ›</button>}
            className="orders-panel"
            ref={rightRefs[1]}>
            <div className="orders-head">
              <span>工单编号</span>
              <span>点位</span>
              <span>风险</span>
              <span>状态</span>
            </div>
            <div className="orders-list">
              {workOrders.map((order) => (
                <button
                  key={order.id}
                  onClick={() => chooseOrder(order)}
                  className={selectedOrderId === order.id ? "is-selected" : ""}>
                  <span>{order.id}</span>
                  <span>
                    {order.site} {order.component}
                  </span>
                  <span className={`level level--${order.level[0]}`}>{order.level}</span>
                  <span className={`status status--${order.status}`}>{order.status}</span>
                </button>
              ))}
            </div>
          </Panel>
          <Panel
            title="当前工单"
            className="current-order"
            ref={rightRefs[2]}>
            <div className="order-focus">
              <div className="order-focus__visual">
                <Icon name="temple" />
                <span>{selectedOrder.component}</span>
              </div>
              <div>
                <small>{selectedOrder.id}</small>
                <h3>
                  {selectedOrder.district} · {selectedOrder.site}
                </h3>
                <p>
                  <Icon name="pin" />
                  {selectedOrder.component} 下部
                </p>
                <p className="danger">
                  <Icon name="alert" />
                  {selectedOrder.finding} {selectedOrder.score}
                </p>
              </div>
            </div>
            <button className="button button--primary button--full" onClick={() => setModalOpen(true)}>
              查看工单
              <Icon name="arrow" />
            </button>
          </Panel>
        </aside>
      </div>

      <footer className="statusbar">
        <div className="motto">让古建被看见 · 让历史有未来</div>
        <div>
          <span>
            数据源 <b>演示回放</b>
          </span>
          <span>实时位置 31.2304°N 121.4737°E</span>
          <time>
            {clock.toLocaleDateString("zh-CN")}{" "}
            {clock.toLocaleTimeString("zh-CN", { hour12: false })}
          </time>
        </div>
      </footer>

      <button
        className={`assistant-fab ${assistantOpen ? "is-open" : ""}`}
        onClick={() => setAssistantOpen((open) => !open)}
        aria-label="打开小木助手">
        <Icon name="bot" />
        <span>小木</span>
      </button>
      {assistantOpen ? (
        <aside className="assistant-panel">
          <header>
            <div>
              <Icon name="bot" />
              <span>
                <b>小木助手</b>
                <small>工具链已就绪</small>
              </span>
            </div>
            <button onClick={() => setAssistantOpen(false)}>
              <Icon name="close" />
            </button>
          </header>
          <div className="assistant-message">
            我已定位上海示例寺 Z04 的历史记录与当前工单。你可以继续查看证据，或切换到数字孪生场景。
          </div>
          <button
            onClick={() => {
              setAssistantOpen(false);
              setModalOpen(true);
            }}>
            打开 Z04 工单
          </button>
          <button
            onClick={() => {
              setAssistantOpen(false);
              activateNav("数字孪生");
            }}>
            定位数字孪生场景
          </button>
        </aside>
      ) : null}
      {modalOpen ? <WorkOrderModal order={selectedOrder} onClose={() => setModalOpen(false)} /> : null}
    </main>
  );
}
