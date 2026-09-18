/**
 * 自主巡航任务 · 服务端实体这一侧的读写（工单页与建图巡航页共用）
 *
 * 用户 2026-09-18 口径：「在工单界面添加下发自主巡航任务功能，页面可以有小车数据，
 * 小车巡航任务预览，生成任务编号，这边是 shi 派发的，然后 ma 这边接受任务去建图巡航」。
 *
 * 分工写在这里，两个页面都照这个来：
 *   · **谁是任务** = 服务端 `mission` 实体（`kind: "cruise"`，带 `orderId`）；
 *     本模块只做"按工单挑出来"和"发命令"，不自己拼状态、不本地先行。
 *   · **任务编号**由服务端生成（`CR-<工单号日期段>-<两位流水>`），前端只显示 —— 见
 *     `server/services/workflow.mjs` 的 `nextCruiseTaskNo`。页面自己编一个号，
 *     换台电脑就会对不上。
 *   · 状态迁移一律走 `mission.ack / complete / cancel` 这三条命令总线动作，
 *     带上实体的 `expectedRevision`：两台电脑同时点"接受"只有一台会成功。
 */

import type { MissionEntity, SharedEntity } from "../api/client";
import { useSharedStore } from "./shared";

/**
 * 快照里 `mission` 这一种的元素形状。
 *
 * 页面用 `useSharedStore(missions)`（store/shared.ts 的选择器）拿到它 —— 那里是
 * data 类型唯一的收窄点；本模块只按 `orderId` 挑出属于某张工单的任务。
 */
export type MissionRecord = SharedEntity<MissionEntity>;

/** 终态：不再接受任何迁移（与 server/services/workflow.mjs 的 TERMINAL_MISSION_STATES 同源） */
export const TERMINAL_CRUISE_STATES: MissionEntity["state"][] = ["succeeded", "failed", "cancelled"];

export function isTerminalCruise(state: MissionEntity["state"]): boolean {
  return TERMINAL_CRUISE_STATES.includes(state);
}

/**
 * 某张工单下的巡航任务，最新的在前。
 *
 * 不带工单的通用任务（旧调用）不返回：工单页只认**属于这张工单**的任务，
 * 否则上一张工单的任务会串到这一张上（现场最难发现的那类错）。
 */
export function cruiseMissionsOfOrder(list: readonly MissionRecord[] | undefined, orderId: string | null | undefined): MissionEntity[] {
  if (!orderId) return [];
  return (list ?? [])
    .map((item) => item?.data)
    .filter((item): item is MissionEntity => Boolean(item) && item.orderId === orderId && item.kind !== "general")
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

/** 这张工单当前该盯的那条任务：未结束的优先，都结束了就给最近一条 */
export function activeCruiseMissionOfOrder(list: readonly MissionRecord[] | undefined, orderId: string | null | undefined): MissionEntity | null {
  const missions = cruiseMissionsOfOrder(list, orderId);
  return missions.find((item) => !isTerminalCruise(item.state)) ?? missions[0] ?? null;
}

/**
 * 全平台正在进行的巡航任务（建图巡航页的横幅用）。
 *
 * 与工单页的口径一致：未结束的优先；没有任何进行中的任务时回 null ——
 * 建图巡航页不该拿一条上周已完成的任务当"本次任务"。
 */
export function activeCruiseMission(list: readonly MissionRecord[] | undefined): MissionEntity | null {
  const cruises = (list ?? [])
    .map((item) => item?.data)
    .filter((item): item is MissionEntity => Boolean(item) && item.kind !== "general" && Boolean(item.orderId))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return cruises.find((item) => !isTerminalCruise(item.state)) ?? null;
}

export type CruiseDispatchBody = {
  orderId: string;
  orderNo: string;
  robotId: string;
  mapVersion: string | null;
  speedProfile: string;
  speedMps: number | null;
  laps: number;
  componentIds: string[];
  waypoints: { id: string; label: string; componentId: string | null; cell: [number, number] }[];
  plannedPath: [number, number][];
};

/** 下发：服务端生成任务编号并落一条 mission 实体（权限 mission:dispatch） */
export async function dispatchCruiseMission(body: CruiseDispatchBody): Promise<{ missionId: string; taskNo: string; state: string }> {
  const result = await useSharedStore.getState().send({
    action: "mission.create",
    entityId: null,
    payload: { ...body },
  });
  return result.result as unknown as { missionId: string; taskNo: string; state: string };
}

/** 接受任务：queued → running，服务端记下 acceptedBy/acceptedAt（"谁去建图巡航"就是谁） */
export async function acceptCruiseMission(mission: MissionEntity, revision: number): Promise<void> {
  await useSharedStore.getState().send({
    action: "mission.ack",
    entityId: mission.id,
    expectedRevision: revision,
    payload: {},
  });
}

export async function completeCruiseMission(mission: MissionEntity, revision: number): Promise<void> {
  await useSharedStore.getState().send({
    action: "mission.complete",
    entityId: mission.id,
    expectedRevision: revision,
    payload: {},
  });
}

export async function cancelCruiseMission(mission: MissionEntity, revision: number, reason?: string): Promise<void> {
  await useSharedStore.getState().send({
    action: "mission.cancel",
    entityId: mission.id,
    expectedRevision: revision,
    payload: reason ? { reason } : {},
  });
}

/** 实体 revision：命令总线按它做冲突检测，页面从共享 store 的实体上取 */
export function cruiseRevisionOf(list: readonly MissionRecord[] | undefined, missionId: string): number | null {
  return (list ?? []).find((item) => item.id === missionId)?.revision ?? null;
}
