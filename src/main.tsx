import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router";
import App from "./App.tsx";
import "./index.css";
import "./pages/MumaiDashboard/dashboard.css";
/**
 * 常驻唤醒通道（P0）。
 *
 * 模块作用域挂 `window.__mumaiWake`。**默认不自动开麦** ——
 * 页面一加载就弹麦克风授权很打扰人，而且浏览器要求用户手势。
 *
 * ── 但用户显式开过一次之后要记住（本轮新增）─────────────────────
 * 「每次打开都要手动点一次启用」是用户点名要去掉的负担。
 * 所以开关状态写进 `localStorage`（见 wakeChannel 的 readWakePreference），
 * 下次加载时**只有当用户上次是开着的时候**才自动恢复：
 *   · 用户从没开过 → 什么都不做（保持"不打扰"）；
 *   · 用户上次开着 → 自动恢复常驻聆听；此时麦克风权限通常已经授予，
 *     不会弹窗；若权限被拒，通道自己会进入如实的错误态（不会静默假装在听）；
 *   · 用户上次关掉 → 保持关闭，不会"自己又开起来"。
 * 用 `catch` 吞掉失败：自动恢复失败不该影响页面其它部分。
 */
import { readWakePreference, wakeChannel } from "./pages/MumaiDashboard/agent/wakeChannel";

/**
 * 自动恢复前先看权限：**只有已经授权过才静默恢复**。
 *
 * 如果用户上次开着、但权限是"每次询问"，那自动 start() 等于每次打开页面
 * 都弹一次授权框 —— 比"手动点一下"更烦，也违背当初"不打扰"的设计。
 * 所以只在 `granted` 时恢复；`prompt`/`denied` 保持原来的手动模式
 * （`denied` 时若强行 start()，界面会进错误态，等于一进页面就报错）。
 */
async function restoreWakeIfAllowed(): Promise<void> {
  if (!readWakePreference()) return;
  try {
    const status = await navigator.permissions?.query({ name: "microphone" as PermissionName });
    if (status && status.state !== "granted") return;
  } catch {
    /* 浏览器不支持 permissions.query（Safari 等）：不冒险，保持手动模式 */
    return;
  }
  try {
    await wakeChannel().start();
  } catch (error) {
    console.warn("[wake] 自动恢复常驻唤醒失败（上次是开启状态）", error);
  }
}

void restoreWakeIfAllowed();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </StrictMode>
);
