/**
 * 手持终端链路 · 轮询与预览
 *
 * 终端每 2 秒推一份设备数据，硬件页按同样的节奏取最后一份就够了
 * （终端文档 §1：硬件页是人看的，不需要更高频率）。
 *
 * 这一层的职责是**把「有没有真机数据」变成一个明确的状态**，页面据此决定
 * 显示真机读数还是退回种子数据 —— 而不是让页面到处写 `report?.xxx ?? seed.xxx`：
 *
 *   loading      正在取第一份
 *   live         有上报，且距现在 ≤ 6 秒（终端口径：3 × 上报周期）
 *   stale        6—15 秒没有新数据（页面要标「延迟」，不能继续当真）
 *   offline      > 15 秒没有新数据（设备掉线；最后一份数据仍显示，但标明离线）
 *   waiting      连上了平台，但设备一份都没推过 → 「等待设备上报」
 *   unavailable  平台服务不可达（页面退回种子并说明原因）
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { api, readToken } from "../api/client";
import type { DeviceEvent, DeviceHardwareView } from "./types";

export type DevicePhase = "loading" | "live" | "stale" | "offline" | "waiting" | "unavailable";

export type DeviceLink = {
  phase: DevicePhase;
  view: DeviceHardwareView | null;
  events: DeviceEvent[];
  error: string;
  /** 手动重取一次（命令下发后想立刻看到回执时用） */
  refresh: () => void;
  /** 最近一次取到数据的时刻（本地时钟，页面上写「刚刚更新」用） */
  updatedAt: number;
};

/** 与终端文档一致：6 秒 = 3 × 上报周期，15 秒 = 终端自己的 offlineAfterS */
const STALE_AFTER_MS = 6000;
const OFFLINE_AFTER_MS = 15000;

function phaseOf(view: DeviceHardwareView): DevicePhase {
  if (!view.report) return "waiting";
  const ageMs = (view.ageSec ?? 0) * 1000;
  if (ageMs <= STALE_AFTER_MS) return "live";
  if (ageMs <= OFFLINE_AFTER_MS) return "stale";
  return "offline";
}

export function useDeviceLink(
  deviceId: string,
  { pollMs = 2000, eventsMs = 5000, enabled = true }: { pollMs?: number; eventsMs?: number; enabled?: boolean } = {},
): DeviceLink {
  const [view, setView] = useState<DeviceHardwareView | null>(null);
  const [events, setEvents] = useState<DeviceEvent[]>([]);
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState(0);
  const [version, setVersion] = useState(0);
  const disposed = useRef(false);

  const refresh = useCallback(() => setVersion((n) => n + 1), []);

  useEffect(() => {
    disposed.current = false;
    if (!enabled) return undefined;
    let loading = false;

    const poll = async () => {
      if (loading || disposed.current) return;
      /*
        还没登录令牌时不发请求：页面挂载早于 `ensureSession` 完成，先打一轮
        必然是 401，控制台里全是红字，排查真问题时要先穿过这些噪音。
        轮询不会停 —— 令牌一到位，下一轮自然就取到了。
      */
      if (!readToken()) return;
      loading = true;
      try {
        const next = await api.deviceHardware(deviceId);
        if (!disposed.current) {
          setView(next);
          setUpdatedAt(Date.now());
          setError("");
        }
      } catch (cause) {
        if (!disposed.current) {
          // 服务不可达 / 未登录：保留上一份数据，只是明确标出「取不到」
          setError(cause instanceof Error ? cause.message : "设备数据读取失败");
        }
      } finally {
        loading = false;
      }
    };

    const pollEvents = async () => {
      if (disposed.current || !readToken()) return;
      try {
        const next = await api.deviceEvents(deviceId, 40);
        if (!disposed.current) setEvents(next.events);
      } catch {
        /* 事件是附加信息，取不到不影响硬件读数 */
      }
    };

    poll();
    pollEvents();
    const timer = window.setInterval(poll, pollMs);
    const eventTimer = window.setInterval(pollEvents, eventsMs);
    return () => {
      disposed.current = true;
      window.clearInterval(timer);
      window.clearInterval(eventTimer);
    };
  }, [deviceId, pollMs, eventsMs, enabled, version]);

  const phase: DevicePhase = !enabled
    ? "waiting"
    : error && !view
      ? "unavailable"
      : view
        ? phaseOf(view)
        : "loading";

  return { phase, view, events, error, refresh, updatedAt };
}

/**
 * 低帧率预览图（终端 1—2 fps 推，不是归档图像）。
 *
 * 用 blob + objectURL 而不是把 URL 直接塞进 `<img src>`：这条接口要登录令牌，
 * 而 `<img>` 带不了 Authorization 头。取到新一帧就释放上一帧，避免内存泄漏。
 */
export function useDevicePreview(deviceId: string, enabled: boolean, intervalMs = 1500) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [at, setAt] = useState(0);

  useEffect(() => {
    if (!enabled) {
      setUrl(null);
      setError("");
      return undefined;
    }
    let disposed = false;
    let current: string | null = null;

    const tick = async () => {
      try {
        const response = await fetch(`/api/devices/${encodeURIComponent(deviceId)}/preview/latest`, {
          headers: { authorization: `Bearer ${readToken() ?? ""}` },
          signal: AbortSignal.timeout(4000),
        });
        if (!response.ok) {
          throw new Error(response.status === 404 ? "设备还没有推过预览帧" : `预览读取失败（HTTP ${response.status}）`);
        }
        const blob = await response.blob();
        if (disposed) return;
        const next = URL.createObjectURL(blob);
        if (current) URL.revokeObjectURL(current);
        current = next;
        setUrl(next);
        setAt(Date.now());
        setError("");
      } catch (cause) {
        if (!disposed) setError(cause instanceof Error ? cause.message : "预览不可用");
      }
    };

    tick();
    const timer = window.setInterval(tick, intervalMs);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      if (current) URL.revokeObjectURL(current);
    };
  }, [deviceId, enabled, intervalMs]);

  return { url, error, at };
}
