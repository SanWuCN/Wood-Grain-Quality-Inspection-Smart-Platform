/**
 * 大屏状态：地图模式 + 开场动画进度 + 地图↔右栏的联动选中
 *
 * 用 zustand 而不是 React state，是因为动画在 useFrame / gsap 时间线里高频更新，
 * 走 store 可以避免每帧触发布局重算；业务组件按需订阅具体字段。
 *
 * 选中态为什么放在这里（而不是各自 `useState`）：
 * 首页右栏「风险与工单」的工单选中、地图点位的选中、点位详情浮层三者必须联动
 * —— 选中工单 → 地图高亮对应点位；点击点位 → 右栏那条工单变选中。
 * 两个 `useState` 互相监听会绕成环，所以统一收敛到这一份 store（单一来源）。
 */

import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import { WORK_ORDER } from "../seed/scenario";
import { orderSiteId, siteOrderId } from "../seed/sites";

export type MapMode = "china" | "shanghai";

export interface DashboardState {
  mode: MapMode;
  /** 地图开场动画是否结束（左右面板据此依次入场） */
  introDone: boolean;
  /** 是否正在做「中国 → 上海」转场，转场中禁用交互与 orbit */
  transitioning: boolean;
  /** 悬停的区域名 */
  hoveredRegion: string | null;
  /** 当前选中的区域（上海模式下是区名） */
  focusRegion: string | null;
  /**
   * 当前选中的点位 id（地图点位与右栏工单共用）。
   * 只存 id，不存名字：名字可能重复，id 在种子内唯一。
   */
  selectedSiteId: string | null;
  /** 当前选中的工单号（右栏列表与地图点位共用） */
  selectedOrderId: string | null;
  setMode: (mode: MapMode) => void;
  setIntroDone: (done: boolean) => void;
  setTransitioning: (value: boolean) => void;
  setHoveredRegion: (name: string | null) => void;
  setFocusRegion: (name: string | null) => void;
  /** 选点位：同时把右栏工单切到该点位关联的那条（没有关联则清空工单选中） */
  selectSite: (siteId: string | null) => void;
  /** 选工单：同时把地图高亮切到该工单对应的点位（没有对应点位则清空点位选中） */
  selectOrder: (orderId: string | null) => void;
  /** 关闭点位详情浮层：点位与工单选中一起清掉，避免右栏还停在刚关掉的那条 */
  clearSite: () => void;
}

export const useDashboardStore = create<DashboardState>()(
  subscribeWithSelector((set) => ({
    mode: "china",
    introDone: false,
    transitioning: false,
    hoveredRegion: null,
    focusRegion: null,
    selectedSiteId: null,
    /**
     * 右栏默认停在「本轮工单」——设计稿里右栏一进来就选中 SH-2026-0901。
     * 但地图上初始不高亮任何点位（`selectedSiteId` 为 null）：一开场就亮一个点
     * 会和开场推镜头的动画抢注意力。
     */
    selectedOrderId: WORK_ORDER.id,
    setMode: (mode) => set({ mode }),
    setIntroDone: (introDone) => set({ introDone }),
    setTransitioning: (transitioning) => set({ transitioning }),
    setHoveredRegion: (hoveredRegion) => set({ hoveredRegion }),
    setFocusRegion: (focusRegion) => set({ focusRegion }),
    selectSite: (siteId) =>
      set({
        selectedSiteId: siteId,
        // 点位没有关联工单时清空工单选中，避免右栏停在上一条、看起来「点错了」
        selectedOrderId: siteId ? siteOrderId[siteId] ?? null : null,
      }),
    selectOrder: (orderId) =>
      set({
        selectedOrderId: orderId,
        // 工单涉及的点位可能不在当前地图模式里，此时不高亮任何点位
        selectedSiteId: orderId ? orderSiteId[orderId] ?? null : null,
      }),
    clearSite: () => set({ selectedSiteId: null, selectedOrderId: null }),
  })),
);

/** 开场动画与转场共用的「揭幕」进度：0 = 完全不可见，1 = 完全展开 */
export const introProgress = { value: 0 };
/** 飞线/光柱的入场进度 */
export const detailProgress = { value: 0 };

/**
 * 开场镜头是否已经启动。
 *
 * 时间线把这个标志置为 true，场景里的相机组件 watch 到之后开始推镜头。
 * 用共享标志而不是「注册回调」的原因：回调的注册时机和 effect 的执行顺序
 * 很容易错开（尤其配合 Suspense + StrictMode），一旦错开动画就静默不播。
 */
export const cameraIntro = { started: false };

/** 外部（按钮 / 面包屑）请求切换地图模式；由 MapScene 监听并播放转场 */
export const MAP_MODE_EVENT = "mumai:request-mode";
export function requestMapMode(mode: MapMode) {
  window.dispatchEvent(new CustomEvent<MapMode>(MAP_MODE_EVENT, { detail: mode }));
}
