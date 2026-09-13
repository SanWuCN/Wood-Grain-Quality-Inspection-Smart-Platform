/**
 * 小木 · 运行上下文取用（语音控制台与右下角气泡**共用这一份**）
 *
 * ── 为什么必须共用（PRD §10.2 / AC-06）────────────────────────────
 *
 * 小木可能挂在两个地方：
 *   1. 应用 React 树内（有 `MumaiProvider` 与 react-router）—— 右下角气泡走这条
 *   2. standalone 兜底 root（没有 Provider、没有 Router）—— 开发诊断用的全屏控制台
 *
 * 两种挂载下，同一句话必须给出**同一份事实值**（AC-06：点击 / 文字 / 语音 /
 * 串口四个入口对同一意图返回同一事实值）。而事实值依赖会话上下文
 * （阶段 / 账号 / 数据来源 / 通道摘要）。这段"取不到就退回默认值"的逻辑
 * 一旦在两个组件里各写一份，迟早会漂移 —— 所以收在这里。
 *
 * 原来的实现只存在于 `VoiceConsole.tsx` 内部（`useSession` / `useAgentNavigate`），
 * 本文件是把它们**原样搬出来**，行为不变。
 */

import { useCallback } from "react";
import { useNavigate } from "react-router";
import { useMumai } from "../context";
import { CHANNELS } from "../seed/scenario";

/**
 * 执行器要用到的会话快照。
 *
 * `sourceMode` 是 **字面量联合**（`"demo" | "real"`）而不是 `string`：
 * 它要直接喂给 `Runtime.session`（`Pick<FactContext, …>`），
 * 而 FactContext 里这个字段是联合类型。写成 `string` 会在赋值处报 TS2322 ——
 * 这个错误只在把两个组件里的同名类型合并成一份时才暴露出来
 * （原先各写一份，各自和 FactContext 对得上，但两份之间其实不一致）。
 */
export type SessionInfo = {
  stageKey: string;
  accountLabel: string;
  sourceMode: "demo" | "real";
  channelSummary: string;
};

/** 通道摘要文案：四条采集/服务通道的状态合成一句话 */
export function channelSummaryOf(channels: { label: string; state: string; ageSec: number }[]): string {
  return channels
    .map(
      (item) =>
        `${item.label}${item.state === "online" ? "在线" : item.state === "stale" ? `延迟${item.ageSec}s` : "离线"}`,
    )
    .join("、");
}

/**
 * 取会话上下文。
 *
 * 对 `useMumai()` 做**可选**处理：它脱离 Provider 会抛错（见 context.tsx 的最后一行），
 * 而 standalone 挂载正是"没有 Provider"的情况。缺上下文时不抛，
 * 只是把上下文类信息退回到 seed 的默认值 —— 这与原来的行为完全一致。
 */
export function useAgentSession(): SessionInfo {
  let mumai: ReturnType<typeof useMumai> | null = null;
  try {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- 该 hook 在 Provider 内永远可用，脱离 Provider 时由 catch 兜底
    mumai = useMumai();
  } catch {
    mumai = null;
  }
  const channels = mumai?.channels ?? CHANNELS;
  return {
    stageKey: mumai?.stage ?? "",
    accountLabel: mumai?.accountId ?? "未登录会话",
    sourceMode: mumai?.deviceSource ?? "demo",
    channelSummary: channelSummaryOf(channels),
  };
}

/**
 * 取导航函数。
 *
 * 有 Router 就用 react-router 的 navigate；standalone root 里没有 Router，
 * 降级成写 hash（项目用的是 HashRouter，认 hash 变化）。
 */
export function useAgentNavigate(): (to: string) => void {
  let navigate: ReturnType<typeof useNavigate> | null = null;
  try {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- 同上：脱离 Router 时由 catch 兜底
    navigate = useNavigate();
  } catch {
    navigate = null;
  }
  return useCallback(
    (to: string) => {
      if (navigate) {
        navigate(to);
        return;
      }
      if (typeof window !== "undefined") window.location.hash = `#${to}`;
    },
    [navigate],
  );
}
