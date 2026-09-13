/**
 * 平台资源（总览「平台数据」+ 资源弹窗）
 *
 * 数据来自 `/api/platform/resources`：**运行后端那台主机**的实测值，经服务端
 * 版本化映射后的统一快照。主卡与弹窗读同一份快照（PRD §7 MOD-08 / §9.4）。
 *
 * 几条硬规则（都来自 PRD，别在这里改）：
 *   · 前端**不做映射、不做随机**：所有比例、扰动、功耗都在服务端算好（RES-19）。
 *   · 轮询 2 秒（§9.1）；旧快照按 snapshotId 忽略，避免界面倒退（ERR-07）。
 *   · 浏览器切到后台降频，回到前台立刻刷一次，不补播遗漏动画（§10.3 / ANI-13）。
 *   · 失败不编数：保留上一份并标 `error`，界面显示「连接中断」。
 */

import { useEffect, useRef, useState } from "react";
import { api, type PlatformHistory, type PlatformResources } from "../api/client";

/** 前沿采样时钟：GPU / 内存 / 网络 2 秒（§9.1） */
const POLL_MS = 2000;
/** 页面隐藏时的降频间隔（§10.3「浏览器切到后台可降低渲染频率」） */
const HIDDEN_POLL_MS = 10000;
/** 网络历史窗口（§8.2 网络页签：最近 60 秒） */
const HISTORY_WINDOW_SEC = 60;

export type PlatformResourcesState = {
  data: PlatformResources | null;
  history: PlatformHistory["points"];
  error: string;
  loaded: boolean;
};

/** 夹具名（仅开发环境有效）：`?fixture=f1` 放在 hash 后的查询串里 */
function readFixtureFromUrl(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const [, search = ""] = window.location.hash.split("?");
  const value = new URLSearchParams(search).get("fixture");
  return value ?? undefined;
}

export function usePlatformResources(active = true): PlatformResourcesState {
  const [state, setState] = useState<PlatformResourcesState>({ data: null, history: [], error: "", loaded: false });
  const disposed = useRef(false);
  const lastSnapshot = useRef<string>("");

  useEffect(() => {
    disposed.current = false;
    if (!active) return;
    const fixture = readFixtureFromUrl();

    const load = async () => {
      try {
        const data = await api.platformResources(fixture);
        if (disposed.current) return;
        /* 旧快照直接忽略：snapshotId 没变说明是同一份，变了才更新（ERR-07） */
        if (data.snapshotId === lastSnapshot.current) {
          setState((previous) => ({ ...previous, error: "" }));
          return;
        }
        lastSnapshot.current = data.snapshotId;
        setState((previous) => ({ ...previous, data, error: "", loaded: true }));
      } catch (error) {
        if (disposed.current) return;
        const message =
          (error as { message?: string })?.message ??
          (error instanceof Error ? error.message : "读取失败");
        setState((previous) => ({ ...previous, error: message }));
      }
    };

    /* 网络历史单独取：它比快照慢（60 秒窗口），跟着快照每 2 秒拉一次没必要 */
    const loadHistory = async () => {
      try {
        const history = await api.platformResourceHistory(HISTORY_WINDOW_SEC);
        if (!disposed.current) setState((previous) => ({ ...previous, history: history.points }));
      } catch {
        /* 历史拉不到不影响主卡：曲线退化成空态 */
      }
    };

    void load();
    void loadHistory();

    let timer = window.setInterval(() => void load(), POLL_MS);
    const historyTimer = window.setInterval(() => void loadHistory(), 5000);

    const onVisibility = () => {
      window.clearInterval(timer);
      if (document.hidden) {
        timer = window.setInterval(() => void load(), HIDDEN_POLL_MS);
      } else {
        /* 回到前台先刷新一次，再恢复 2 秒（ANI-13） */
        void load();
        void loadHistory();
        timer = window.setInterval(() => void load(), POLL_MS);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      disposed.current = true;
      window.clearInterval(timer);
      window.clearInterval(historyTimer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [active]);

  return state;
}

/* ------------------------------------------------------------------ *
 * 展示格式化（主卡与弹窗共用，避免两处各写一份）
 * ------------------------------------------------------------------ */

export const DASH = "—";

/** 存储：十进制 TB，两位小数（§9.2 / RES-27） */
export function tb(value: number | null | undefined, digits = 2): string {
  return typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(digits)} TB` : DASH;
}

/** 内存 / 显存：GiB，整数或不带小数 */
export function gib(value: number | null | undefined, digits = 0): string {
  return typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(digits)} GiB` : DASH;
}

/** 窗口内的紧凑内存写法：672 G */
export function gibShort(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(0)} G` : DASH;
}

/** 功耗：W → 超过 1000 同时给 kW（§8.1 要求 W / kW 不撑高换行） */
export function power(value: number | null | undefined): { w: string; kw: string | null } {
  if (typeof value !== "number" || !Number.isFinite(value)) return { w: DASH, kw: null };
  const rounded = Math.round(value);
  return { w: `${rounded} W`, kw: rounded >= 1000 ? `${(value / 1000).toFixed(2)} kW` : null };
}

/**
 * 网络：十进制 B/s → KB/s / MB/s / GB/s（§9.7 / RES-27）。
 * **不用 Mbps**：真实速率乘 300 之后是字节速率，混用 bit 与 byte 是明确的验收失败项。
 */
export function bytesPerSec(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return DASH;
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)} GB/s`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(0)} MB/s`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(0)} KB/s`;
  return `${value.toFixed(0)} B/s`;
}

/** 百分比：显示一位小数，判档用未舍入值（由服务端决定） */
export function percent(value: number | null | undefined, digits = 1): string {
  return typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(digits)}%` : DASH;
}

/** 占用比例 → 进度条宽度（clamp 到 0–100，null 时不画） */
export function barWidth(ratio: number | null | undefined): number | null {
  if (typeof ratio !== "number" || !Number.isFinite(ratio)) return null;
  return Math.round(Math.min(1, Math.max(0, ratio)) * 100);
}

export const LOAD_TEXT = {
  idle: "空闲",
  low: "低负载",
  medium: "中负载",
  high: "高负载",
  unknown: "负载未知",
} as const;

export const LOAD_TONE = {
  idle: "muted",
  low: "ok",
  medium: "warn",
  high: "danger",
  unknown: "muted",
} as const;

export const QUALITY_TEXT = {
  fresh: "实时",
  stale: "数据过期",
  unavailable: "数据不可用",
} as const;

/** 资源弹窗的五个页签（PRD §8.2）。主卡每行点击后直接打开对应页签 */
export type ResourceTab = "storage" | "memory" | "gpu" | "power" | "network";

export const RESOURCE_TABS: { key: ResourceTab; label: string }[] = [
  { key: "storage", label: "存储" },
  { key: "memory", label: "内存" },
  { key: "gpu", label: "GPU" },
  { key: "power", label: "功耗" },
  { key: "network", label: "网络" },
];

/**
 * 主卡与弹窗共用的历史曲线数据（网络页签）。
 * 快照里没有历史，所以这里单独取一次 60 秒窗口（§8.2 / MOD-05）。
 */
export function usePlatformHistory(active: boolean): PlatformHistory["points"] {
  const [points, setPoints] = useState<PlatformHistory["points"]>([]);
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    const load = async () => {
      try {
        const history = await api.platformResourceHistory(60);
        if (!disposed) setPoints(history.points);
      } catch {
        /* 拉不到保持空态，弹窗里画一条空曲线而不是假数据 */
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 5000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [active]);
  return points;
}
