/**
 * 自主巡航任务页面逻辑 —— 单测
 *
 * 盯三件事：
 *   · 预览里的里程与小木口播**同一个来源**（`pathLength(PLANNED_PATH)`，
 *     跑这条断言就是防止哪天页面自己写一个数）；
 *   · 下发前的四道闸门各给一句人能读的原因（权限 / 归档 / 暂停 / 已有进行中任务）；
 *   · 「谁派发 · 谁接受」这一行不能靠猜：没接受就写"等待接受"，撤销了就写"未接受即撤销"。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { plannedPathLength } from "../../agent/lib/geo";
import type { MissionEntity } from "../../api/client";
import {
  CRUISE_STATE_META,
  cruiseActionBlock,
  cruiseBlockReason,
  cruisePayload,
  cruisePeopleLine,
  cruisePreview,
  cruiseTimeText,
  durationText,
  missionStateText,
  missionStateTone,
  plannedCruisePath,
  plannedCruiseWaypoints,
} from "./cruiseTask";

const mission = (over: Partial<MissionEntity> = {}): MissionEntity => ({
  id: "CR-20260918-01",
  kind: "cruise",
  orderId: "wo-20260918-0006",
  orderNo: "WO-20260918-0006",
  robotId: "mumai-car-01",
  mapVersion: "MAP-SH-06",
  speedProfile: "0.20 m/s（小车自报上限）",
  speedMps: 0.2,
  laps: 1,
  state: "queued",
  waypoints: plannedCruiseWaypoints(),
  plannedPath: plannedCruisePath(),
  createdBy: "shi",
  createdAt: "2026-09-18T03:20:00.000Z",
  acceptedBy: null,
  acceptedAt: null,
  endedAt: null,
  cancelReason: null,
  ...over,
});

test("状态文案与色调：六种状态各有说法，没有任务时是「未下发」", () => {
  assert.equal(missionStateText(null), "未下发");
  assert.equal(missionStateTone(null), "muted");
  assert.equal(missionStateText("queued"), "待接受");
  assert.equal(missionStateText("running"), "执行中");
  assert.equal(missionStateText("succeeded"), "已完成");
  assert.equal(missionStateTone("queued"), "warn");
  assert.equal(missionStateTone("running"), "ok");
  assert.equal(missionStateTone("cancelled"), "muted");
  assert.deepEqual(Object.keys(CRUISE_STATE_META).sort(), ["cancelled", "failed", "paused", "queued", "running", "succeeded"]);
});

test("时间与经手人：谁派发 / 谁接受 / 未接受即撤销", () => {
  assert.equal(cruiseTimeText("2026-09-18T03:20:00.000Z"), "09-18 03:20");
  assert.equal(cruiseTimeText(null), "—");
  assert.equal(cruisePeopleLine(null), "—");
  assert.equal(cruisePeopleLine(mission()), "史 派发 · 等待接受");
  assert.equal(
    cruisePeopleLine(mission({ state: "running", acceptedBy: "ma", acceptedAt: "2026-09-18T03:25:00.000Z" })),
    "史 派发 · 马昱天 已接受（09-18 03:25）",
  );
  assert.equal(cruisePeopleLine(mission({ state: "cancelled" })), "史 派发 · 未接受即撤销");
});

test("时长读法：不足一分钟按秒，超过按分秒", () => {
  assert.equal(durationText(45), "45 秒");
  assert.equal(durationText(123), "2 分 3 秒");
  assert.equal(durationText(120), "2 分");
  assert.equal(durationText(null), "—");
  assert.equal(durationText(0), "—");
});

test("预览：里程与小木口播同一个来源，圈数与用时都是算出来的", () => {
  const preview = cruisePreview({
    waypoints: plannedCruiseWaypoints(),
    plannedPath: plannedCruisePath(),
    speedMps: 0.2,
    laps: 1,
  });
  assert.equal(preview.waypointCount, 6, "平台计划航线是 P1—P6 六个点");
  assert.deepEqual(preview.componentIds, ["Z01", "Z02", "Z03", "Z04"], "巡检构件从航点上取，去重");
  assert.equal(preview.lengthM, plannedPathLength(), "里程必须与 agent/lib/geo 的口径一致");
  assert.equal(preview.laps, 1);
  assert.equal(preview.totalLengthM, preview.lengthM);
  assert.equal(preview.speedText, "0.20 m/s");
  assert.equal(preview.etaSec, preview.totalLengthM / 0.2);
  assert.equal(preview.etaText, durationText(preview.totalLengthM / 0.2));

  const twice = cruisePreview({
    waypoints: plannedCruiseWaypoints(),
    plannedPath: plannedCruisePath(),
    speedMps: 0.2,
    laps: 2,
  });
  assert.equal(twice.totalLengthM, Math.round(preview.lengthM * 2 * 10) / 10);
  assert.ok((twice.etaSec ?? 0) > (preview.etaSec ?? 0), "两圈比一圈久");
});

test("预览：速度未知时不给用时，也不编一个默认速度出来", () => {
  const preview = cruisePreview({ waypoints: plannedCruiseWaypoints(), plannedPath: plannedCruisePath(), speedMps: null, laps: 1 });
  assert.equal(preview.speedText, "—");
  assert.equal(preview.etaSec, null);
  assert.equal(preview.etaText, "—");
  /* 圈数越界一律夹到 1–5，避免手滑传进来一个 0 或 99 */
  assert.equal(cruisePreview({ waypoints: [], plannedPath: [], speedMps: 0.2, laps: 0 }).laps, 1);
  assert.equal(cruisePreview({ waypoints: [], plannedPath: [], speedMps: 0.2, laps: 99 }).laps, 5);
});

test("下发闸门：权限 / 归档 / 暂停 / 已有进行中任务，各给一句原因", () => {
  const base = { canDispatch: true, orderStatus: "待准备", existing: null, waypointCount: 6 };
  assert.equal(cruiseBlockReason(base), null);
  assert.match(String(cruiseBlockReason({ ...base, canDispatch: false })), /mission:dispatch/);
  assert.match(String(cruiseBlockReason({ ...base, orderStatus: "已归档" })), /已归档/);
  assert.match(String(cruiseBlockReason({ ...base, orderStatus: "已暂停" })), /已暂停/);
  const busy = cruiseBlockReason({ ...base, existing: mission() });
  assert.match(String(busy), /CR-20260918-01/);
  assert.match(String(busy), /待接受/);
  assert.match(String(cruiseBlockReason({ ...base, waypointCount: 0 })), /没有可下发的航点/);
  /* 已完成的历史任务不算"进行中"，可以再下发一次 */
  assert.equal(cruiseBlockReason({ ...base, existing: null }), null);
});

test("按钮闸门：接受只对「待接受」、完成只对「执行中」、撤销看 monitor 权限", () => {
  const queued = cruiseActionBlock({ mission: mission(), canDispatch: true, canMonitor: false });
  assert.equal(queued.accept, null, "史/马都有 mission:dispatch，能接受");
  assert.match(String(queued.complete), /只有执行中的任务/);
  assert.equal(queued.cancel, null, "下发权也能撤销待接受的任务");

  const running = cruiseActionBlock({ mission: mission({ state: "running" }), canDispatch: true, canMonitor: true });
  assert.match(String(running.accept), /执行中/);
  assert.equal(running.complete, null);
  assert.equal(running.cancel, null);

  const noRight = cruiseActionBlock({ mission: mission(), canDispatch: false, canMonitor: false });
  assert.match(String(noRight.accept), /mission:dispatch/);
  assert.match(String(noRight.cancel), /mission:monitor/);

  const done = cruiseActionBlock({ mission: mission({ state: "succeeded" }), canDispatch: true, canMonitor: true });
  assert.match(String(done.cancel), /终态/);
  assert.equal(cruiseActionBlock({ mission: null, canDispatch: true, canMonitor: true }).accept, null);
});

test("下发载荷：构件去重、圈数夹紧、机器人缺省值明确", () => {
  const payload = cruisePayload({
    orderId: "wo-20260918-0006",
    orderNo: "WO-20260918-0006",
    robotId: null,
    mapVersion: "MAP-SH-06",
    speedMps: 0.2,
    speedProfile: "0.20 m/s（小车自报上限）",
    laps: 3,
  });
  assert.equal(payload.orderNo, "WO-20260918-0006");
  assert.deepEqual(payload.componentIds, ["Z01", "Z02", "Z03", "Z04"]);
  assert.equal(payload.laps, 3);
  assert.equal(payload.robotId, "mumai-car-01", "取不到车端 device_id 时用平台台账里的演示车");
  assert.equal(payload.waypoints.length, plannedCruiseWaypoints().length);
  assert.deepEqual(payload.plannedPath, plannedCruisePath());
  assert.equal(payload.speedMps, 0.2);
});
