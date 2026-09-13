/**
 * 木脉智检 · 公共壳（PRD 2.2）
 *
 * 本文件只做一件事：把全部路由页面包进同一个会话状态提供者。
 * 具体外壳（顶栏 / 一级导航 / 小木浮层）在 Shell.tsx。
 *
 * ── 为什么常驻小木挂在这里，而不是挂进 Shell 或 body（PRD FR-06）──
 *
 * 右下角的小木必须**始终在场**：换了页面还在、关掉面板还在。
 * 但它的执行链路要两样东西：
 *   · `useNavigate()`  —— react-router 上下文（导航类意图要用）
 *   · `useMumai()`     —— 会话上下文（事实表要用 stage/账号/通道摘要）
 * 挂到 body 上（像 VoiceOverlay 那样）拿不到这两个，事实值就会与点击/文字入口不一致，
 * 而 PRD AC-06 明确要求"四入口对同一意图返回同一事实值"。
 *
 * 挂在 AppShell 里则天然两者都有，而且**每个已登录页面都会渲染它**，
 * 生命周期正好是"整个应用"，不是"某一个页面"。
 */
import { MumaiProvider } from "./context";
import Shell from "./Shell";
import XiaomuDock from "./agent/XiaomuDock";

export default function AppShell() {
  return (
    <MumaiProvider>
      <Shell />
      <XiaomuDock />
    </MumaiProvider>
  );
}
