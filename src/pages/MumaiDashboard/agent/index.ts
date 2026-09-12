/**
 * 小木语音智能体 · 对外入口
 *
 * 调用方只需要两件事（**不需要改本目录下的任何文件**）：
 *
 *   1. 打开控制台 —— 派发全局事件即可，或直接调 openAgent()：
 *
 *        import { openAgent, AGENT_EVENT } from "./agent";
 *        openAgent("让小车去一号木柱");
 *        // 等价写法：
 *        window.dispatchEvent(new CustomEvent(AGENT_EVENT.OPEN, { detail: { question: "让小车去一号木柱" } }));
 *        window.dispatchEvent(new CustomEvent(AGENT_EVENT.CLOSE));
 *
 *   2. （可选）想让控制台待在应用自己的 React 树里，从而拿到 react-router 上下文：
 *
 *        import { AgentHost } from "./agent/AgentHost";
 *        ...
 *        <AgentHost />
 *
 * 兜底：没有渲染 <AgentHost /> 时，本模块会在首次收到 mumai:agent-open 时
 * 弹出一个独立的 React root，把控制台挂到 document.body 上。
 * 这条路径没有 Router 上下文，因此 VoiceConsole 会把 navigate 降级为 hash 路由
 * （项目用的是 HashRouter，hash 变化同样会真的跳页）；
 * 会话上下文缺失时回退到 seed 的通道数据，不会抛错、不会白屏。
 *
 * 注：这里刻意只导出常量与函数，组件在 AgentHost.tsx / VoiceConsole.tsx 里，
 * 以满足 eslint 的 react-refresh/only-export-components。
 */

export { AGENT_EVENT, closeAgent, openAgent, resetAgent, useAgentOpen } from "./api";
