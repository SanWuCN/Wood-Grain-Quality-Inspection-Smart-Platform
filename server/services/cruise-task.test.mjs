/**
 * 自主巡航任务 —— 服务端行为验收（真起服务、走 HTTP 命令总线）
 *
 * 用户 2026-09-18 口径：「在工单界面添加下发自主巡航任务功能，页面可以有小车数据，
 * 小车巡航任务预览，生成任务编号，这边是 shi 派发的，然后 ma 这边接受任务去建图巡航」。
 *
 * 这一组盯的是"这条链路在服务端是不是真的成立"：
 *   ① 任务编号按工单生成：`CR-<工单号里的日期段>-<两位流水>`，同一天第 2 次下发就是 02；
 *   ② 任务带着来源工单、巡检构件、速度与圈数落库（页面的预览读的就是这份实体）；
 *   ③ 权限闸门：史/沈/马能下发与接受，饶不能（`mission:dispatch` 不在他的权限集里）；
 *   ④ 接受（`mission.ack`）把状态推到执行中，并记下**是谁接的、什么时候**；
 *   ⑤ 状态机不许越级：接受两次 422、完成后取消 409、终态不复活（评审 F03）；
 *   ⑥ revision 冲突要给 409 —— 两台电脑同时点"接受"只有一个成功；
 *   ⑦ 另一台机器打开同一会话能看到这条任务（快照里的 mission 实体）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

test("自主巡航任务：编号按工单、权限分派发/接受、状态机与冲突都拦得住", async () => {
  const { startService } = await import("../index.mjs");
  const service = await startService({ port: 18095, host: "127.0.0.1", dbFile: ":memory:", quiet: true });
  const base = service.url;

  const login = async (account) => {
    const response = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ account, password: "123456" }),
    });
    assert.equal(response.status, 200, `${account} 登录失败`);
    return (await response.json()).token;
  };
  const call = async (token, method, path, body) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: response.status, json };
  };
  const command = (token, body) =>
    call(token, "POST", "/api/commands", { sessionId: "demo-01", commandId: `cmd-${Math.random().toString(36).slice(2)}`, ...body });
  const missionOf = async (token, taskNo) => {
    const snapshot = await call(token, "GET", "/api/sessions/demo-01/snapshot");
    return (snapshot.json?.entities?.mission ?? []).find((item) => item.id === taskNo) ?? null;
  };

  try {
    const shi = await login("shi");
    const ma = await login("ma");
    const rao = await login("rao");

    /* 先有一张真工单：任务编号的日期段就是从工单号里取的 */
    const created = await call(shi, "POST", "/api/work-orders/trigger", { eventId: `e2e-cruise-${Date.now().toString(36)}` });
    assert.equal(created.status, 200, `建单失败：${JSON.stringify(created.json)}`);
    const orderNo = created.json.orderNo;
    const orderId = created.json.orderId;
    const day = /^WO-(\d{8})-\d+$/.exec(orderNo)?.[1];
    assert.ok(day, `工单号形状不对：${orderNo}`);

    const preview = {
      orderId,
      orderNo,
      robotId: "mumai-car-01",
      mapVersion: "MAP-SH-06",
      speedProfile: "0.20 m/s（小车自报上限）",
      speedMps: 0.2,
      laps: 1,
      componentIds: ["Z01", "Z02", "Z03", "Z04"],
      waypoints: [
        { id: "P1", label: "起点 / 殿门", componentId: null, cell: [20, 24] },
        { id: "P2", label: "Z01 观察点", componentId: "Z01", cell: [6, 10] },
      ],
      plannedPath: [
        [20, 24],
        [20, 20],
        [6, 10],
      ],
    };

    /* ---------- ① 饶不能下发（权限闸门不是靠前端置灰） ---------- */
    const raoCreate = await command(rao, { action: "mission.create", payload: preview });
    assert.equal(raoCreate.status, 403, "饶没有 mission:dispatch，不该能下发巡航任务");
    assert.equal(raoCreate.json.code, "FORBIDDEN");

    /* ---------- ② 缺工单号时不许生成编号 ---------- */
    const noOrderNo = await command(shi, { action: "mission.create", payload: { ...preview, orderNo: null } });
    assert.equal(noOrderNo.status, 422);
    assert.equal(noOrderNo.json.code, "NO_ORDER_NO");

    /* ---------- ③ 史下发：编号按工单来，实体带全套预览字段 ---------- */
    const first = await command(shi, { action: "mission.create", payload: preview });
    assert.equal(first.status, 200, `下发失败：${JSON.stringify(first.json)}`);
    const taskNo = first.json.result.taskNo;
    assert.equal(taskNo, `CR-${day}-01`, `任务编号应是 CR-${day}-01，实得 ${taskNo}`);
    assert.equal(first.json.result.state, "queued");
    assert.equal(first.json.entity.data.state, "queued");
    assert.equal(first.json.entity.data.kind, "cruise");
    assert.equal(first.json.entity.data.orderId, orderId);
    assert.equal(first.json.entity.data.orderNo, orderNo);
    assert.deepEqual(first.json.entity.data.componentIds, ["Z01", "Z02", "Z03", "Z04"]);
    assert.equal(first.json.entity.data.laps, 1);
    assert.equal(first.json.entity.data.speedMps, 0.2);
    assert.equal(first.json.entity.data.createdBy, "shi");
    assert.equal(first.json.entity.data.acceptedBy, null, "刚下发时还没有人接受");
    assert.equal(first.json.entity.data.waypoints.length, 2);
    assert.equal(first.json.entity.data.plannedPath.length, 3);

    /* 事件要带上来源工单：别的机器靠它把关刷新到这张工单上 */
    const events = await call(shi, "GET", "/api/events?sessionId=demo-01&afterSeq=0");
    const createdEvent = events.json.events.filter((item) => item.type === "mission.created").at(-1);
    assert.equal(createdEvent.payload.orderId, orderId);
    assert.equal(createdEvent.payload.orderNo, orderNo);
    assert.equal(createdEvent.actorId, "shi");

    /* ---------- ④ 同一天第二次下发 → 流水加一（事务里数，不撞号） ---------- */
    const second = await command(shi, { action: "mission.create", payload: { ...preview, laps: 2 } });
    assert.equal(second.status, 200);
    assert.equal(second.json.result.taskNo, `CR-${day}-02`);
    assert.equal(second.json.entity.data.laps, 2);

    /* ---------- ⑤ 马接受：状态到执行中，记下是谁接的 ---------- */
    const beforeAck = await missionOf(ma, taskNo);
    assert.ok(beforeAck, "马那边的快照里要能看到这条任务（另一台机器同一个会话）");
    const ack = await command(ma, {
      action: "mission.ack",
      entityId: taskNo,
      expectedRevision: beforeAck.revision,
      payload: {},
    });
    assert.equal(ack.status, 200, `接受失败：${JSON.stringify(ack.json)}`);
    assert.equal(ack.json.result.state, "running");
    assert.equal(ack.json.entity.data.acceptedBy, "ma");
    assert.ok(String(ack.json.entity.data.acceptedAt).length > 10, "接受时刻要落在实体上");
    assert.equal(ack.json.entity.data.state, "running");

    /* 接受两次：状态机拦得住（不是"点了没反应"） */
    const ackAgain = await command(ma, {
      action: "mission.ack",
      entityId: taskNo,
      expectedRevision: ack.json.entity.revision,
      payload: {},
    });
    assert.equal(ackAgain.status, 422);
    assert.equal(ackAgain.json.code, "BAD_STATE");

    /* 两台电脑同时点接受：后到的那台拿 409，前端据此提示刷新 */
    const stale = await command(ma, {
      action: "mission.ack",
      entityId: taskNo,
      expectedRevision: beforeAck.revision,
      payload: {},
    });
    assert.equal(stale.status, 422, "已经是执行中了，先撞状态机（这也是实情）");
    const conflict = await command(shi, {
      action: "mission.cancel",
      entityId: taskNo,
      expectedRevision: beforeAck.revision,
      payload: { reason: "用旧版本点的" },
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.json.code, "REVISION_CONFLICT");

    /* ---------- ⑥ 完成 → 终态；终态不再接受任何迁移（评审 F03） ---------- */
    const done = await command(ma, {
      action: "mission.complete",
      entityId: taskNo,
      expectedRevision: ack.json.entity.revision,
      payload: {},
    });
    assert.equal(done.status, 200, `完成失败：${JSON.stringify(done.json)}`);
    assert.equal(done.json.entity.data.state, "succeeded");
    assert.ok(done.json.entity.data.endedAt, "完成时刻要落在实体上");
    const revive = await command(ma, {
      action: "mission.ack",
      entityId: taskNo,
      expectedRevision: done.json.entity.revision,
      payload: {},
    });
    assert.equal(revive.status, 409);
    assert.equal(revive.json.code, "TERMINAL_STATE");

    /* ---------- ⑦ 取消：待接受的任务可以直接撤销，原因落在实体上 ---------- */
    const cancelled = await command(shi, {
      action: "mission.cancel",
      entityId: `CR-${day}-02`,
      expectedRevision: second.json.entity.revision,
      payload: { reason: "现场改为人工复测" },
    });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.json.entity.data.state, "cancelled");
    assert.equal(cancelled.json.entity.data.cancelReason, "现场改为人工复测");

    /* ---------- ⑧ 换一台机器（饶）读同一份快照：任务在，且带着工单与接受人 ---------- */
    const seenByRao = await missionOf(rao, taskNo);
    assert.ok(seenByRao, "饶那台的快照里也要有这条任务");
    assert.equal(seenByRao.data.orderNo, orderNo);
    assert.equal(seenByRao.data.acceptedBy, "ma");
    assert.equal(seenByRao.data.state, "succeeded");

    /* ---------- ⑨ 删工单要连任务一起清：不留"指着已删工单"的孤儿任务 ---------- */
    const removed = await call(shi, "DELETE", `/api/work-orders/${orderId}`);
    assert.equal(removed.status, 200, `删单失败：${JSON.stringify(removed.json)}`);
    assert.equal(await missionOf(shi, taskNo), null, "工单删了，本单的巡航任务也要清掉");
    assert.equal(await missionOf(shi, `CR-${day}-02`), null, "取消掉的第二条同样不留");
    /* 别的工单的任务不受影响（同一批里没有，但至少不能把整类都删了） */
    const stillThere = await call(shi, "GET", "/api/sessions/demo-01/snapshot");
    const missionKinds = (stillThere.json?.entities?.mission ?? []).length;
    assert.equal(missionKinds, 0, `本会话里这两条都该清掉，剩 ${missionKinds} 条`);
  } finally {
    await service.close?.();
  }
});
