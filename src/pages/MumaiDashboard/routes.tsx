/**
 * 木脉智检 · 路由表
 *
 * PRD 2.2：一级导航八项，每项是一个独立页面（不是弹窗、不是抽屉）。
 * 外壳（顶栏 / 小木 / 状态条）在 AppShell 里，各页面只渲染自己的内容区。
 *
 * 页面文件统一放在 ./pages/ 下，页面用 URL 记录 job_id / component_id / batch_id
 * （PRD 2.2：复制链接即可让另一台电脑打开同一对象），因此查询参数由各页面自己读写。
 */

import { Suspense, lazy } from "react";
import { Route, Routes } from "react-router";
import AppShell from "./AppShell";
import { UnknownRoute } from "./Shell";
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
const Console = lazy(() => import("./pages/Console"));

/**
 * 懒加载路由的挂起兜底（用户报「首屏圆环一闪，然后蓝屏，等有画面就全部突然出来」）。
 *
 * 原来这里**没有 `<Suspense>` 边界**。所有页面都是 `lazy()` 的，chunk 未到达时
 * 组件抛 Promise 挂起 —— React 18 在没有边界的情况下会让**整个根**挂起，
 * 页面上什么都不渲染。于是：
 *
 *   index.html 的 #boot 圆环（首屏）→ React 挂载、#boot 被清掉
 *   → 路由 chunk 还在路上，根挂起，**第二次蓝屏**
 *   → chunk 到了，地图与面板一次性出现
 *
 * 加上这层边界之后，挂起期间显示的是同一套底圈圈，与 #boot、与地图自己的遮罩
 * 首尾相接，全程没有空档。
 */
function RouteFallback() {
  return (
    <div className="map-veil">
      <div className="map-veil__core">
        <span className="map-veil__rings" aria-hidden="true">
          <i className="map-veil__ring map-veil__ring--outer" />
          <i className="map-veil__ring map-veil__ring--mid" />
          <i className="map-veil__ring map-veil__ring--inner" />
        </span>
        <b>木脉智检</b>
        <span className="map-veil__ascii">MAP INITIALIZING</span>
        <i className="map-veil__line" />
      </div>
    </div>
  );
}

export default function RoutesTree() {
  return (
    <Suspense fallback={<RouteFallback />}>
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
        {/* 排练控制台（PRD §11）：管理员新建会话与恢复阶段快照 */}
        <Route path="/console" element={<Console />} />
        {/*
          兜底路由：没有它的时候，访问一个未登记的地址（例如拆页前的
          `#/adapt`）会让 React Router 一个 route 都不匹配 —— 连这层带外壳的
          布局路由都不挂载，整页没有任何 DOM，现象是**纯黑屏**，只有 console
          里一行 "No routes matched location"。加了它之后外壳一定会渲染，
          Shell 再把 Outlet 放行到这里，给出「页面不存在」而不是黑屏。
        */}
        <Route path="*" element={<UnknownRoute />} />
      </Route>
      </Routes>
    </Suspense>
  );
}
