import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";

interface ConfigStore {
  mapPlayComplete: boolean;
  /**
   * 地表贴图烤好了没有（A01）。
   *
   * 与 `mapPlayComplete` 是两个时刻：这个在贴图就绪的那一帧置位（撤加载遮罩），
   * 后者在镜头推完时置位（左右面板入场），中间隔着整个 2.5 秒开场。
   * 放在同一个 store 里，是因为这套 setState 机制在本模块已经跑通；
   * 走 props 回调多一层，出问题时不好定位。
   */
  sceneReady: boolean;
  /** 遮罩揭开了没有：base 的开场时间线等它，保证「揭幕」与「开场」同帧 */
  introArmed: boolean;
  /**
   * 加载遮罩是否还盖着。
   *
   * 放在 store 而不是组件 useState：组件重挂载会丢本地状态，
   * 遮罩就会在地图已经画好之后又盖回来（实测 t=8s 有地图、t=12s 变黑）。
   */
  veiled: boolean;
  toggle: (key: keyof Omit<ConfigStore, "toggle" | "reset">) => void;
  reset: () => void;
}

export const useConfigStore = create<ConfigStore>()(
  subscribeWithSelector((set, _, store) => ({
    mapPlayComplete: false,
    sceneReady: false,
    introArmed: false,
    veiled: true,
    toggle: (key) => set((s) => ({ [key]: !s[key] })),
    reset: () => set(store.getInitialState()),
  }))
);
