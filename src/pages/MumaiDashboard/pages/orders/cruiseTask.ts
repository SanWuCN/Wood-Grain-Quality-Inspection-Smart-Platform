/**
 * 自主巡航任务 · 页面侧的纯逻辑（工单页与建图巡航页共用）
 *
 * 这一层只做三件事，全部可单测、不碰网络也不碰 React：
 *   ① **预览怎么算**：航点数、巡检构件、计划里程、预计时长、速度 —— 里程用
 *      `agent/lib/geo.ts` 的 `pathLength()` 算（栅格 10 cm/格是唯一口径，
 *      与小木口播的「计划里程」同源，页面绝不自己写一个数）；
 *   ② **下发前能不能点**：权限、工单状态、是否已有进行中的任务，各给一句人能读的原因；
 *   ③ **状态与经手人怎么说**：任务编号、状态文案与色调、「谁派发 · 谁接受」那一行。
 *
 * 任务编号由服务端生成（`CR-<工单号日期段>-<两位流水>`），这里只格式化显示。
 */

import { pathLength } from "../../agent/lib/geo";
import { actorShortName } from "../../api/accounts";
import type { MissionEntity, MissionWaypoint } from "../../api/client";
import { GRID_MAP, PLANNED_PATH, WAYPOINTS } from "../../seed/scenario";

export type ChipTone = "ok" | "warn" | "danger" | "info" | "muted";

/** 平台侧任务状态 → 现场话术（与 server/services/workflow.mjs 的 label 同源） */
export const CRUISE_STATE_META: Record<MissionEntity["state"], { text: string; tone: ChipTone }> = {
  queued: { text: "待接受", tone: "warn" },
  running: { text: "执行中", tone: "ok" },
  paused: { text: "已暂停", tone: "warn" },
  succeeded: { text: "已完成", tone: "ok" },
  failed: { text: "失败", tone: "danger" },
  cancelled: { text: "已取消", tone: "muted" },
};

export function missionStateText(state: MissionEntity["state"] | null | undefined): string {
  if (!state) return "未下发";
  return CRUISE_STATE_META[state]?.text ?? state;
}

export function missionStateTone(state: MissionEntity["state"] | null | undefined): ChipTone {
  if (!state) return "muted";
  return CRUISE_STATE_META[state]?.tone ?? "info";
}

/** `MM-DD HH:mm`：任务列表一行里要塞编号、状态、人、时间，秒没有意义 */
export function cruiseTimeText(value: string | null | undefined): string {
  if (!value) return "—";
  const matched = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  return matched ? `${matched[2]}-${matched[3]} ${matched[4]}:${matched[5]}` : value;
}

/** 「史 派发 · 马昱天 已接受（09-18 11:20）」——现场问"这活谁派谁接"就念这一行 */
export function cruisePeopleLine(mission: MissionEntity | null): string {
  if (!mission) return "—";
  const parts = [`${actorShortName(mission.createdBy)} 派发`];
  if (mission.acceptedBy) parts.push(`${actorShortName(mission.acceptedBy)} 已接受（${cruiseTimeText(mission.acceptedAt)}）`);
  else if (mission.state === "cancelled") parts.push("未接受即撤销");
  else parts.push("等待接受");
  return parts.join(" · ");
}

export type CruisePreview = {
  waypointCount: number;
  componentIds: string[];
  /** 单圈计划里程（米）：栅格坐标按 GRID_MAP.resolutionM 折算 */
  lengthM: number;
  laps: number;
  /** 全程里程 = 单圈 × 圈数 */
  totalLengthM: number;
  /** 预计时长（秒）：全程里程 ÷ 速度；没有速度就是 null（不编一个默认速度） */
  etaSec: number | null;
  etaText: string;
  speedText: string;
};

/** 时长读法：90 秒 → 「1 分 30 秒」；不足一分钟按秒说 */
export function durationText(sec: number | null): string {
  if (sec === null || !Number.isFinite(sec) || sec <= 0) return "—";
  if (sec < 60) return `${Math.round(sec)} 秒`;
  const minutes = Math.floor(sec / 60);
  const rest = Math.round(sec % 60);
  return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分`;
}

/**
 * 巡航任务预览：**所有数字都从传进来的航点与路径算**，不读全局常量。
 * 这样建图巡航页拿车端航点、工单页拿平台计划航点，用的是同一套算法。
 */
export function cruisePreview(input: {
  waypoints: MissionWaypoint[];
  plannedPath: [number, number][];
  speedMps: number | null;
  laps: number;
}): CruisePreview {
  const laps = Math.min(5, Math.max(1, Math.round(input.laps || 1)));
  const lengthM = pathLength(input.plannedPath);
  const totalLengthM = Math.round(lengthM * laps * 10) / 10;
  const etaSec = input.speedMps && input.speedMps > 0 ? totalLengthM / input.speedMps : null;
  return {
    waypointCount: input.waypoints.length,
    componentIds: [...new Set(input.waypoints.map((item) => item.componentId).filter((id): id is string => Boolean(id)))],
    lengthM,
    laps,
    totalLengthM,
    etaSec,
    etaText: durationText(etaSec),
    speedText: input.speedMps && input.speedMps > 0 ? `${input.speedMps.toFixed(2)} m/s` : "—",
  };
}

/** 平台计划航线（PRD 里的四柱外侧一圈）：工单页的预览与下发都以它为底 */
export function plannedCruiseWaypoints(): MissionWaypoint[] {
  return WAYPOINTS.map((item) => ({
    id: item.id,
    label: item.label,
    componentId: item.componentId,
    cell: item.cell,
  }));
}

export function plannedCruisePath(): [number, number][] {
  return PLANNED_PATH.map((cell) => [cell[0], cell[1]]);
}

/** 栅格口径（10 cm/格）：预览下面的小字要写清"这个里程是怎么来的" */
export function gridNote(): string {
  return `计划里程按栅格 ${GRID_MAP.resolutionM} m/格折算，与小木口播同一来源`;
}

/**
 * 下发前能不能点。返回 null 表示可以。
 *
 * 四条判据各说各的原因，页面照这句显示（不是"点了没反应"）：
 * 权限 / 工单状态 / 已有进行中的任务 / 有没有可下发的内容。
 */
export function cruiseBlockReason(input: {
  canDispatch: boolean;
  orderStatus: string;
  existing: MissionEntity | null;
  waypointCount: number;
}): string | null {
  if (!input.canDispatch) return "你在本单没有下发自主巡航任务的权限（需要 mission:dispatch）";
  if (input.orderStatus === "已归档") return "工单已归档，不能再下发";
  if (input.orderStatus === "已暂停") return `工单已暂停，暂停期间不新下发（暂停前状态见工单摘要）`;
  if (input.existing) {
    return `本单已有进行中的巡航任务 ${input.existing.id}（${missionStateText(input.existing.state)}）：先完成或撤销它`;
  }
  if (input.waypointCount === 0) return "没有可下发的航点";
  return null;
}

/**
 * 接受/完成/撤销按钮对**当前账号**该不该亮。
 *
 * 服务端按 `mission:dispatch`（接受、完成）与 `mission:monitor`（撤销）判；
 * 这里只是把同一套判据提前到界面上，避免点了才被打回来。
 */
export function cruiseActionBlock(input: {
  mission: MissionEntity | null;
  canDispatch: boolean;
  canMonitor: boolean;
}): { accept: string | null; complete: string | null; cancel: string | null } {
  const mission = input.mission;
  if (!mission) return { accept: null, complete: null, cancel: null };
  const accept =
    mission.state === "queued"
      ? input.canDispatch
        ? null
        : "接受任务需要 mission:dispatch 权限"
      : `任务当前是「${missionStateText(mission.state)}」，不能接受`;
  const complete =
    mission.state === "running"
      ? input.canDispatch
        ? null
        : "完成任务需要 mission:dispatch 权限"
      : `只有执行中的任务能标记完成（当前「${missionStateText(mission.state)}」）`;
  const cancel =
    mission.state === "queued" || mission.state === "running" || mission.state === "paused"
      ? input.canMonitor || input.canDispatch
        ? null
        : "撤销任务需要 mission:monitor 权限"
      : `任务已是终态「${missionStateText(mission.state)}」`;
  return { accept, complete, cancel };
}

/**
 * 下发的载荷：服务端认这些字段（见 `mission.create`）。
 *
 * `robotId` 取小车自报的 device_id，取不到就用平台台账里的演示车；
 * `mapVersion` 优先用小车当前加载的图，其次退回平台场景版本。
 */
export function cruisePayload(input: {
  orderId: string;
  orderNo: string;
  robotId: string | null;
  mapVersion: string | null;
  speedMps: number | null;
  speedProfile: string;
  laps: number;
}) {
  const waypoints = plannedCruiseWaypoints();
  return {
    orderId: input.orderId,
    orderNo: input.orderNo,
    robotId: input.robotId ?? "mumai-car-01",
    mapVersion: input.mapVersion,
    speedProfile: input.speedProfile,
    speedMps: input.speedMps,
    laps: Math.min(5, Math.max(1, Math.round(input.laps || 1))),
    componentIds: [...new Set(waypoints.map((item) => item.componentId).filter((id): id is string => Boolean(id)))],
    waypoints,
    plannedPath: plannedCruisePath(),
  };
}
