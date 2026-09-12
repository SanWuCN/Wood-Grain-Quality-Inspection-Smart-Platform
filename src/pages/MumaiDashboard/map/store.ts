/**
 * 大屏状态：地图模式 + 开场动画进度
 *
 * 用 zustand 而不是 React state，是因为动画在 useFrame / gsap 时间线里高频更新，
 * 走 store 可以避免每帧触发布局重算；业务组件按需订阅具体字段。
 */

import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";

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
  setMode: (mode: MapMode) => void;
  setIntroDone: (done: boolean) => void;
  setTransitioning: (value: boolean) => void;
  setHoveredRegion: (name: string | null) => void;
  setFocusRegion: (name: string | null) => void;
}

export const useDashboardStore = create<DashboardState>()(
  subscribeWithSelector((set) => ({
    mode: "china",
    introDone: false,
    transitioning: false,
    hoveredRegion: null,
    focusRegion: null,
    setMode: (mode) => set({ mode }),
    setIntroDone: (introDone) => set({ introDone }),
    setTransitioning: (transitioning) => set({ transitioning }),
    setHoveredRegion: (hoveredRegion) => set({ hoveredRegion }),
    setFocusRegion: (focusRegion) => set({ focusRegion }),
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
