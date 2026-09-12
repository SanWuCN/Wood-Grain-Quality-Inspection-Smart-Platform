/**
 * 展示焦点 · 大屏当前演示对象（PRD 2.2）
 *
 * 「投到展示窗口」打开的 /present 是独立浏览器上下文，React 状态传不过去，
 * 所以这里用 localStorage 做**单一来源**：本端写入、大屏端订阅读取，
 * 并用 BroadcastChannel / storage 事件让已经打开的大屏窗口实时跟上。
 *
 * 这里只存「当前演示对象」的标识与控制权持有人，不复制任何业务数据；
 * 工单、构件、批次的完整内容仍由 seed/scenario.ts 提供。
 */

import { useSyncExternalStore } from "react";
import { ACCOUNTS } from "./design";
import { COMPONENTS, SCAN_BATCHES, WORK_ORDER } from "./seed/scenario";
import { nowStamp } from "./lib";

export type PresentFocus = {
  /** 当前工单 */
  orderId: string;
  /** 当前构件（Z01–Z04） */
  componentId: string;
  /** 当前批次 */
  batchId: string;
  /** 展示控制权持有人（账号 id） */
  holderId: string;
  /** 最近一次投放时间 */
  deliveredAt: string;
};

const STORAGE_KEY = "mumai.present-focus";
const CHANNEL_NAME = "mumai.present-focus";

/** 控制权持有人显示名：账号表是唯一来源 */
export function holderLabel(holderId: string): string {
  const account = ACCOUNTS.find((item) => item.id === holderId) ?? ACCOUNTS[0];
  return `${account.name} · ${account.role}`;
}

/** 默认演示对象：当前工单 + 首个构件 + 首个采集批次，全部取自种子；尚未投放时没有投放时间 */
export function defaultFocus(): PresentFocus {
  return {
    orderId: WORK_ORDER.id,
    componentId: WORK_ORDER.componentIds[0] ?? COMPONENTS[0].id,
    batchId: SCAN_BATCHES[0]?.batchId ?? "",
    holderId: ACCOUNTS[0].id,
    deliveredAt: "",
  };
}

let snapshot: PresentFocus | null = null;
const listeners = new Set<() => void>();

/** 跨窗口通道；不支持时退化为 storage 事件 */
const channel =
  typeof window !== "undefined" && "BroadcastChannel" in window
    ? new BroadcastChannel(CHANNEL_NAME)
    : null;

function emit() {
  listeners.forEach((listener) => listener());
}

function parseFocus(raw: string | null): PresentFocus | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PresentFocus>;
    return { ...defaultFocus(), ...parsed };
  } catch {
    // 快照损坏时回退到种子默认值，不影响大屏
    return null;
  }
}

function readFocus(): PresentFocus {
  if (snapshot) return snapshot;
  let stored: PresentFocus | null = null;
  try {
    stored = parseFocus(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    // 隐私模式下没有 localStorage，退化为单窗口内存态
    stored = null;
  }
  snapshot = stored ?? defaultFocus();
  return snapshot;
}

function applyFocus(next: PresentFocus) {
  snapshot = next;
  emit();
}

/** 本端投放：写入共享焦点（工单 / 构件 / 批次 / 控制权持有人） */
export function writeFocus(patch: Partial<PresentFocus> & { holderId: string }): PresentFocus {
  const next: PresentFocus = { ...readFocus(), ...patch, deliveredAt: nowStamp() };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // 写入失败时至少保证当前窗口状态一致
  }
  channel?.postMessage(next);
  applyFocus(next);
  return next;
}

/** 大屏端订阅：跨窗口用 BroadcastChannel，同源标签页兜底用 storage 事件 */
if (typeof window !== "undefined") {
  channel?.addEventListener("message", (event: MessageEvent<PresentFocus>) => {
    applyFocus({ ...defaultFocus(), ...event.data });
  });
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY) return;
    const next = parseFocus(event.newValue);
    if (next) applyFocus(next);
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function usePresentFocus(): PresentFocus {
  return useSyncExternalStore(subscribe, readFocus, readFocus);
}
