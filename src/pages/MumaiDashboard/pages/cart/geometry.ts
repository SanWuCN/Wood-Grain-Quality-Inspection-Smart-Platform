/**
 * 建图巡航页的坐标换算与文案口径
 *
 * 单独一份的原因有两个，都不是风格问题：
 *   1. 坐标换算是**这一页最容易错的地方**，文档 §3 给了完整公式，写在一个文件里
 *      只维护一遍，比散在画布、航点列表、定位工具里各写一遍可靠得多；
 *   2. 带非组件导出的模块会让 React Fast Refresh 整体失效
 *      （`react-refresh/only-export-components`），转换、格式化这类纯函数
 *      本来也不该和组件混在一个文件里。
 */

import type { CartMapMeta, CartPose } from "./api";

/* ------------------------------------------------------------------ *
 * 视图（画布缩放与平移）
 * ------------------------------------------------------------------ */

/**
 * 视图状态：缩放相对地图原始像素，平移单位是屏幕像素。
 *
 * 放在这里而不是画布组件里，是因为**页面的「重置视图」按钮与画布共用同一份
 * 语义**；而且带非组件导出的模块会让 Fast Refresh 失效，常量与纯函数
 * 本来也不该和组件混在一个文件里。
 */
export type MapView = { scale: number; dx: number; dy: number };

export const MIN_SCALE = 0.12;
export const MAX_SCALE = 12;
export const DEFAULT_VIEW: MapView = { scale: 1, dx: 0, dy: 0 };

export function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/** 把视图限制在「地图不会跑出画面」的范围内，防止拖到找不回来 */
export function clampView(view: MapView, map: CartMapMeta, width: number, height: number): MapView {
  const scale = clampScale(view.scale);
  const w = map.width * scale;
  const h = map.height * scale;
  const margin = 80;
  const maxDx = Math.max(margin, (w - width) / 2 + margin);
  const maxDy = Math.max(margin, (h - height) / 2 + margin);
  return {
    scale,
    dx: Math.min(maxDx, Math.max(-maxDx, view.dx)),
    dy: Math.min(maxDy, Math.max(-maxDy, view.dy)),
  };
}

/**
 * 按已知区域取景：让 `bounds` 里那块已知地图基本铺满画布。
 *
 * 两个上限是有意的：
 *   · `maxScale = 2` —— 再放大只是把 PNG 的像素拉成色块，看不出更多信息；
 *   · `fill = 0.82` —— 留一圈余量，否则地图边缘紧贴画布，看起来像被裁掉了。
 * 没有 `bounds`（老地图）时退回整幅图取景。
 */
export function fitView(map: CartMapMeta, width: number, height: number, fill = 0.82, maxScale = 2): MapView {
  const [left, top, right, bottom] = map.bounds ?? [0, 0, map.width, map.height];
  const w = Math.max(1, right - left);
  const h = Math.max(1, bottom - top);
  const scale = clampScale(Math.min((width * fill) / w, (height * fill) / h, maxScale));
  // bounds 中心相对图像中心的偏移，乘以缩放就是需要在屏幕上平移的量
  const cx = (left + right) / 2 - map.width / 2;
  const cy = (top + bottom) / 2 - map.height / 2;
  return clampView({ scale, dx: -cx * scale, dy: -cy * scale }, map, width, height);
}

/* ------------------------------------------------------------------ *
 * 坐标（文档 §3）
 * ------------------------------------------------------------------ */

/**
 * 世界坐标 → 图像像素。
 *
 * PNG 左上角为原点、y 向下；ROS grid 左下角为原点、y 向上，所以中间必须过
 * `gy = height - v` 这一步。旋转项用 origin.yaw 的**逆旋转**：
 *   x = origin.x + cos(yaw)·a − sin(yaw)·b
 *   y = origin.y + sin(yaw)·a + cos(yaw)·b
 */
export function worldToImage(map: CartMapMeta, point: { x: number; y: number }): { u: number; v: number } {
  const { resolution: r, origin, height } = map;
  const dx = point.x - origin.x;
  const dy = point.y - origin.y;
  const cos = Math.cos(origin.yaw ?? 0);
  const sin = Math.sin(origin.yaw ?? 0);
  const a = cos * dx + sin * dy;
  const b = -sin * dx + cos * dy;
  return { u: a / r, v: height - b / r };
}

/**
 * 图像像素 → 世界坐标。
 *
 * 取整数像素中心时先 `u+0.5, v+0.5`（文档 §3）；调用方负责这一步，
 * 这样「连续坐标画线」和「整数格取点」两种用法都能用同一个函数。
 */
export function imageToWorld(map: CartMapMeta, u: number, v: number): { x: number; y: number } {
  const { resolution: r, origin, height } = map;
  const a = u * r;
  const b = (height - v) * r;
  const cos = Math.cos(origin.yaw ?? 0);
  const sin = Math.sin(origin.yaw ?? 0);
  return {
    x: origin.x + cos * a - sin * b,
    y: origin.y + sin * a + cos * b,
  };
}

/** 目标 yaw：起点拖向终点的 atan2(dy, dx)，范围 [-π, π]（文档 §3） */
export function yawBetween(from: { x: number; y: number }, to: { x: number; y: number }): number {
  return Math.atan2(to.y - from.y, to.x - from.x);
}

export function degrees(rad: number | null | undefined, digits = 0): string {
  if (rad === null || rad === undefined || !Number.isFinite(rad)) return "—";
  return `${((rad * 180) / Math.PI).toFixed(digits)}°`;
}

/** 坐标是否落在地图范围内（页面先本地拦一次，少一次必然失败的请求） */
export function insideMap(map: CartMapMeta | null | undefined, point: CartPose): boolean {
  if (!map) return false;
  const { u, v } = worldToImage(map, point);
  return u >= 0 && v >= 0 && u <= map.width && v <= map.height;
}

/* ------------------------------------------------------------------ *
 * 文案口径
 * ------------------------------------------------------------------ */

const MODE_TEXT: Record<string, string> = {
  idle: "待机",
  mapping: "建图中",
  navigation: "巡航中",
};

const MISSION_TEXT: Record<string, string> = {
  idle: "无任务",
  accepting: "已接收",
  running: "执行中",
  pausing: "暂停中",
  paused: "已暂停",
  stopping: "停止中",
  stopped: "已停止",
  completed: "已完成",
  failed: "失败",
};

/** 小车 mode 的中文（文档 §2 只有三个值） */
export function modeStateText(mode?: string | null): string {
  if (!mode) return "—";
  return MODE_TEXT[mode] ?? mode;
}

/** mission.state 的中文（文档 §5 的九个状态，一个不少） */
export function missionStateText(state?: string | null): string {
  if (!state) return "—";
  return MISSION_TEXT[state] ?? state;
}

/** 任务是否处于「占着车」的状态（此时不允许切图、重启建图） */
export function missionBlocks(missonState?: string | null): boolean {
  return ["accepting", "running", "pausing", "paused", "stopping"].includes(String(missonState ?? ""));
}
