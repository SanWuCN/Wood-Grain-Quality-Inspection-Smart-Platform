/**
 * 木脉智检 · 公共壳（PRD 2.2）
 *
 * 本文件只做一件事：把全部路由页面包进同一个会话状态提供者。
 * 具体外壳（顶栏 / 一级导航 / 小木浮层）在 Shell.tsx。
 */

import { MumaiProvider } from "./context";
import Shell from "./Shell";

export default function AppShell() {
  return (
    <MumaiProvider>
      <Shell />
    </MumaiProvider>
  );
}
