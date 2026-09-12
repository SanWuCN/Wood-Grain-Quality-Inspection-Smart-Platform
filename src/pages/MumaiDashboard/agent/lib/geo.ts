/**
 * 小木语音智能体 · 栅格几何
 *
 * 距离与路径长度都从 seed 的栅格坐标算出来（GRID_MAP.resolutionM 是唯一的口径），
 * 不在回复里硬编码「24.6m」这类数字。
 */

import { GRID_MAP, MISSION } from "../../seed/scenario";

export type Cell = [number, number];

/** 栅格距离（米）：格距 × 欧氏格数，保留一位小数 */
export function routeDistance(from: Cell, to: Cell): number {
  const cells = Math.hypot(to[0] - from[0], to[1] - from[1]);
  return Math.round(cells * GRID_MAP.resolutionM * 10) / 10;
}

/** 折线总长度（米）：平台计划路径 / 实际路径都用它算 */
export function pathLength(path: Cell[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i += 1) total += routeDistance(path[i - 1], path[i]);
  return Math.round(total * 10) / 10;
}

/** 计划路径总里程（MISSION.plannedPath 直接算，和页面显示的口径一致） */
export function plannedPathLength(): number {
  return pathLength(MISSION.plannedPath);
}

export function formatDistance(meters: number): string {
  return `${meters} m`;
}
