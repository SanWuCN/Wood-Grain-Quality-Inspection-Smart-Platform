import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";

interface ConfigStore {
  /** 地形主体入场完成，允许面板与业务标签出现（时间线 2.1s）。 */
  mapPlayComplete: boolean;
  /** 地形、法线与底盘资源加载结束，场景可以准备首帧。 */
  sceneReady: boolean;
  /** 加载层是否覆盖场景；跟随实际渲染帧移除。 */
  veiled: boolean;
  /** 场景完成预热帧，开始可见开场。 */
  introStarted: boolean;
  toggle: (key: keyof Omit<ConfigStore, "toggle" | "reset">) => void;
  reset: () => void;
}

export const useConfigStore = create<ConfigStore>()(
  subscribeWithSelector((set, _, store) => ({
    mapPlayComplete: false,
    sceneReady: false,
    veiled: true,
    introStarted: false,
    toggle: (key) => set((s) => ({ [key]: !s[key] })),
    reset: () => set(store.getInitialState()),
  }))
);
