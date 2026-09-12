import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";

interface ConfigStore {
  mapPlayComplete: boolean;
  toggle: (key: keyof Omit<ConfigStore, "toggle">) => void;
  reset: () => void;
}

export const useConfigStore = create<ConfigStore>()(
  subscribeWithSelector((set, _, store) => ({
    mapPlayComplete: false,
    toggle: (key) => set((s) => ({ [key]: !s[key] })),
    reset: () => set(store.getInitialState()),
  }))
);
