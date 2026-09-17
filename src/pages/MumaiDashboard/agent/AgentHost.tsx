/**
 * 小木语音智能体 · 控制台宿主组件（可选的「应用内挂载点」）
 *
 * 在应用自己的 React 树里渲染一次 <AgentHost />，控制台就能拿到
 * react-router 的 navigate 与 MumaiProvider 的会话上下文。
 *
 * 本仓库当前的实际挂载点：`SmallWoodPanel.tsx`（面板展开时渲染一次）。
 * 它提供 Router 与会话上下文，因此导航走 react-router；
 * 另一条路径是 `api.tsx` 的 standalone 兜底（hash 路由），两者共用同一个 agent/store。
 *
 * ── 为什么控制台本体要懒加载（2026-09-17）──────────────────────────
 * 这条静态 import 链（SmallWoodPanel → AgentHost → VoiceConsole）会把
 * **整个控制台**（实时字幕 + ASR + TTS + executor + 工具目录）焊进主包，
 * 而 `api.tsx` 里那条 `import("./VoiceConsole")` 又想做懒加载 ——
 * 同一模块既静态又动态引入，构建器直接报 `INEFFECTIVE_DYNAMIC_IMPORT`：
 * 懒加载写了却完全无效。实测主包 `index-*.js` 因此带上 5 处「按住说话」文案。
 *
 * 改成 `lazy(() => import("./VoiceConsole"))` 后，控制台自成一个异步分包，
 * 只在**真正要显示时**才下载（本项目既有惯例：`routes.tsx`、`SensorWorkspace` 同写法）。
 *
 * ⚠ 只懒加载 VoiceConsole，**不懒加载 AgentHost 本身**：
 * `markHostMounted` 必须随面板挂载**立刻**执行。`api.tsx` 的兜底是这样判定的 ——
 * 收到打开事件后 `setTimeout(0)` 查 `hostCount === 0` 才挂 standalone；
 * 若连 AgentHost 也懒加载，动态 import 会晚于那个 `setTimeout(0)`，
 * 于是 hostCount 还是 0，**页面上会同时出现两个控制台**。
 */

import { Suspense, lazy, useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { markHostMounted, useAgentOpen } from "./api";

/** 控制台本体（异步分包；首次打开时下载） */
const VoiceConsole = lazy(() => import("./VoiceConsole"));

export function AgentHost() {
  const open = useAgentOpen();
  useEffect(() => {
    /* 立刻登记"应用内有宿主"，兜底挂载据此让路（见文件头说明） */
    markHostMounted(1);
    return () => markHostMounted(-1);
  }, []);
  if (!open || typeof document === "undefined") return null;
  return (
    <AgentPortal>
      {/*
        fallback 取 null：控制台是浮层，分包到达前什么都不显示即可 ——
        这里的加载在局域网内是毫秒级，加一个骨架反而会闪一下。
        与 `Demo1/map/scene.tsx`、`Demo2/map/index.tsx` 同一口径。
      */}
      <Suspense fallback={null}>
        <VoiceConsole />
      </Suspense>
    </AgentPortal>
  );
}

/** portal 挂到 body：避免被上层容器的 overflow / transform 裁掉 */
function AgentPortal({ children }: { children: ReactNode }) {
  return createPortal(children, document.body);
}

export default AgentHost;
