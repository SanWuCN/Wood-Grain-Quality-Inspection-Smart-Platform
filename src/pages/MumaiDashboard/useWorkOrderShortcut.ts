/**
 * 隐藏快捷键 Ctrl + Q + L（PRD-工单指派与扫描仪下发-v1.0 §3）
 *
 * 这是**受控的场景触发方式**：平台页面上没有「古建单位来单」入口、菜单、按钮，
 * 也没有任何快捷键提示，只有这一条按键序列。
 *
 * 口径逐条照 PRD：
 *   · 按住 Ctrl，先按 Q，再在 1.5 秒内按 L；Ctrl + Q 之后按 L 同样有效；
 *   · Mac 用 Control，不替换成 Command；
 *   · 忽略长按产生的 repeat；释放 Ctrl、窗口失焦、超时都清掉序列；
 *   · 输入框 / 文本域 / 可编辑区域 / 输入法组字期间不触发；
 *   · 一次完整触发只提交一次；请求没回来之前再触发不重复提交；
 *   · 失败不显示成功通知，**沿用原事件 ID 重试**（服务端按事件 ID 幂等，
 *     换 ID 就等于把一次按键变成两张工单）。
 */

import { useCallback, useEffect, useRef } from "react";
import { useWorkOrderStore } from "./store/workOrders";

/** 按键序列的有效窗口：Q 与 L 之间超过这个时间就不算一次触发（PRD §3.1） */
const SEQUENCE_WINDOW_MS = 1500;

/** 失败重试间隔与次数：网络恢复后重试**原事件 ID**，不新建事件 */
const RETRY_DELAY_MS = 3000;
const MAX_RETRIES = 5;

function isEditable(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element || !element.tagName) return false;
  const tag = element.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || element.isContentEditable === true;
}

export type OrderShortcutHandlers = {
  /** 工单已创建（或重复触发命中已有工单） */
  onCreated: (info: { orderNo: string; orderId: string; created: boolean }) => void;
  /** 触发失败（网络/服务不可用）；不显示成功通知 */
  onFailed: (message: string) => void;
};

/**
 * 注册快捷键。
 *
 * 监听挂在**捕获阶段**：页面里几个面板自己也有按键处理，
 * 冒泡阶段再收就晚了，`preventDefault()` 也拦不住。
 */
export function useWorkOrderShortcut({ onCreated, onFailed }: OrderShortcutHandlers) {
  /** 一次按键序列对应的事件 ID：重试期间保持不变，服务端据此幂等 */
  const pendingEvent = useRef<{ eventId: string; attempts: number } | null>(null);
  const retryTimer = useRef(0);
  const handlers = useRef({ onCreated, onFailed });
  handlers.current = { onCreated, onFailed };

  const submit = useCallback(async (eventId: string) => {
    const store = useWorkOrderStore.getState();
    if (store.triggering) return;
    const result = await store.trigger(eventId);
    if (result) {
      pendingEvent.current = null;
      handlers.current.onCreated({ orderNo: result.orderNo, orderId: result.orderId, created: result.created });
      return;
    }
    const error = useWorkOrderStore.getState().error;
    const current = pendingEvent.current;
    if (!error?.retryable || !current || current.attempts >= MAX_RETRIES) {
      pendingEvent.current = null;
      handlers.current.onFailed(error?.message ?? "工单创建失败");
      return;
    }
    // 失败不换事件 ID：服务端按它幂等，重试拿到的是同一张工单
    current.attempts += 1;
    retryTimer.current = window.setTimeout(() => void submit(eventId), RETRY_DELAY_MS);
  }, []);

  useEffect(() => {
    let qPressedAt = 0;
    const reset = () => {
      qPressedAt = 0;
    };

    const onKeyDown = (event: KeyboardEvent) => {
      // 长按产生的 repeat、输入法组字期间一律不参与序列判定
      if (event.repeat || event.isComposing) return;
      if (!event.ctrlKey || event.metaKey || event.altKey) {
        if (!event.ctrlKey) reset();
        return;
      }
      if (isEditable(event.target)) return;
      const key = event.key.toLowerCase();
      if (key === "q") {
        // 只对这一条序列处理默认行为：Ctrl+Q / Ctrl+L 各有浏览器默认动作
        event.preventDefault();
        qPressedAt = performance.now();
        return;
      }
      if (key === "l") {
        const withinWindow = qPressedAt > 0 && performance.now() - qPressedAt <= SEQUENCE_WINDOW_MS;
        qPressedAt = 0;
        if (!withinWindow) return;
        event.preventDefault();
        const store = useWorkOrderStore.getState();
        if (store.triggering) return;
        if (pendingEvent.current) return; // 上一轮还在重试，不重复提交
        const eventId = `evt-${crypto.randomUUID()}`;
        pendingEvent.current = { eventId, attempts: 0 };
        void submit(eventId);
        return;
      }
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Control" || !event.ctrlKey) reset();
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", reset);
      window.clearTimeout(retryTimer.current);
    };
  }, [submit]);
}
