/**
 * 木脉智检 · 路由表
 *
 * PRD 2.2：一级导航八项，每项是一个独立页面（不是弹窗、不是抽屉）。
 * 外壳（顶栏 / 小木 / 状态条）在 AppShell 里，各页面只渲染自己的内容区。
 *
 * 页面文件统一放在 ./pages/ 下，页面用 URL 记录 job_id / component_id / batch_id
 * （PRD 2.2：复制链接即可让另一台电脑打开同一对象），因此查询参数由各页面自己读写。
 */

import { lazy } from "react";
import { Route, Routes } from "react-router";
import AppShell from "./AppShell";
import { Login, RequireLogin } from "./pages/Login";

const Overview = lazy(() => import("./pages/Overview"));
const Orders = lazy(() => import("./pages/Orders"));
const Mapping = lazy(() => import("./pages/Mapping"));
const Twin = lazy(() => import("./pages/Twin"));
const Hardware = lazy(() => import("./pages/Hardware"));
const Firmware = lazy(() => import("./pages/Firmware"));
const Knowledge = lazy(() => import("./pages/Knowledge"));
const Archive = lazy(() => import("./pages/Archive"));
const Present = lazy(() => import("./pages/Present"));

export default function RoutesTree() {
  return (
    <Routes>
      {/* 登录页在外壳之外：没有会话时先登录，不进 AppShell */}
      <Route path="/login" element={<Login />} />
      {/* 其余全部路由都要先有会话；未登录跳 /login（PRD 2.1 固定账号快捷登录） */}
      <Route
        element={
          <RequireLogin>
            <AppShell />
          </RequireLogin>
        }>
        <Route path="/" element={<Overview />} />
        <Route path="/orders" element={<Orders />} />
        <Route path="/mapping" element={<Mapping />} />
        <Route path="/twin" element={<Twin />} />
        <Route path="/hardware" element={<Hardware />} />
        <Route path="/firmware" element={<Firmware />} />
        <Route path="/knowledge" element={<Knowledge />} />
        <Route path="/archive" element={<Archive />} />
        <Route path="/present" element={<Present />} />
      </Route>
    </Routes>
  );
}
