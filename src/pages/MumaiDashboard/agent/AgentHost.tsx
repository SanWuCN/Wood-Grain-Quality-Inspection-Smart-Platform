/**
 * 小木语音智能体 · 控制台宿主组件（可选的「应用内挂载点」）
 *
 * 在应用自己的 React 树里渲染一次 <AgentHost />，控制台就能拿到
 * react-router 的 navigate 与 MumaiProvider 的会话上下文。
 *
 * 本仓库当前没有渲染它（Shell.tsx 属于并行任务的文件，不能改），
 * 因此实际生效的是 api.tsx 里的 standalone 兜底挂载；
 * 两种路径共用同一个 agent/store，行为一致，差别只在导航方式
 * （standalone 走 hash，应用内走 react-router）。
 */

import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import VoiceConsole from "./VoiceConsole";
import { markHostMounted, useAgentOpen } from "./api";

export function AgentHost() {
  const open = useAgentOpen();
  useEffect(() => {
    markHostMounted(1);
    return () => markHostMounted(-1);
  }, []);
  if (!open || typeof document === "undefined") return null;
  return <AgentPortal>{<VoiceConsole />}</AgentPortal>;
}

/** portal 挂到 body：避免被上层容器的 overflow / transform 裁掉 */
function AgentPortal({ children }: { children: ReactNode }) {
  return createPortal(children, document.body);
}

export default AgentHost;
