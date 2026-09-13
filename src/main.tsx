import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router";
import App from "./App.tsx";
import "./index.css";
import "./pages/MumaiDashboard/dashboard.css";
/**
 * 常驻唤醒通道（P0）。
 *
 * 只在模块作用域挂 `window.__mumaiWake`，**不自动开麦** ——
 * 页面一加载就弹麦克风授权很打扰人，而且浏览器要求用户手势。
 * 由 UI 开关或验收脚本显式调用 `__mumaiWake.start()`。
 */
import "./pages/MumaiDashboard/agent/wakeChannel";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </StrictMode>
);
