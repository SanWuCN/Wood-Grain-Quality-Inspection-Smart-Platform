/**
 * 内网多主机同步 —— 服务端行为验收（真起服务、两台"机器"走 HTTP）
 *
 * 用户口径（2026-09-23）：「实际上项目就是面向结果展示的，但得做到内网多主机内容同步」。
 *
 * 这一组盯服务端这一侧的四件事：
 *   ① `xiaomu.round` 登记动作能收、能留痕（`agentTurn` 实体带轮次号/台词/页面落点/hostId）；
 *   ② **事件载荷里必须有台词**（第一版漏了：实体写进去了，但跟随端拿到的 payload 没有 text，
 *      于是"页面上一点反应都没有"而服务端看起来一切正常 —— 这条就是那次事故的回归锁）；
 *   ③ 事件里带发起端 hostId（跟随端据此忽略自己的回声，否则两台机器互相跟随）；
 *   ④ **工单页轮次要带出解析好的 `orderId`**（2026-09-30：只有 `nav` 声明时，
 *      跟随端没有那份绑定 → 退回"列表最新那张"，两块屏各开一张工单）；
 *   ⑤ 同一会话里**任何账号**都能广播（四个角色都可能站在演示机前说话），但没登录不行。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

test("小木回合广播：留痕、事件带台词与发起端、未登录被拦", async () => {
  const { startService } = await import("../index.mjs");
  const service = await startService({ port: 18097, host: "127.0.0.1", dbFile: ":memory:", quiet: true });
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
  const announce = (token, payload) =>
    call(token, "POST", "/api/commands", {
      sessionId: "demo-01",
      commandId: `cmd-${Math.random().toString(36).slice(2)}`,
      action: "xiaomu.round",
      entityId: null,
      payload,
    });

  const payload = {
    roundNo: "⑰",
    text: "清洗完成，待审核记录已列出，数据集已按物理样本分组。",
    nav: { route: "/firmware", tab: "dataset" },
    hostId: "host-presenter",
  };

  try {
    /* ---------- ① 未登录：广播被拦 ---------- */
    const anonymous = await announce(null, payload);
    assert.equal(anonymous.status, 401, "没登录不能广播");

    const shi = await login("shi");
    const ma = await login("ma");

    /* ---------- ② 登记 + 留痕 ---------- */
    const first = await announce(shi, payload);
    assert.equal(first.status, 200, `广播失败：${JSON.stringify(first.json)}`);
    assert.equal(first.json.entityKind, "agentTurn");
    assert.equal(first.json.entity.data.roundNo, "⑰");
    assert.equal(first.json.entity.data.text, payload.text);
    assert.equal(first.json.entity.data.hostId, "host-presenter");
    assert.equal(first.json.entity.data.by, "shi");
    assert.deepEqual(first.json.entity.data.nav, { route: "/firmware", tab: "dataset" });
    assert.equal(first.json.result.turnId, "TURN-0001");

    /* ---------- ③ 事件载荷必须带台词（事故回归锁） ---------- */
    const events = await call(shi, "GET", "/api/events?sessionId=demo-01&afterSeq=0");
    const event = events.json.events.filter((item) => item.type === "xiaomu.round").at(-1);
    assert.ok(event, "应当有一条 xiaomu.round 事件");
    assert.equal(event.payload.roundNo, "⑰");
    assert.equal(
      event.payload.text,
      payload.text,
      "事件里必须带台词 —— 跟随端是拿 WS 事件直接跟随的，缺文本就变成“页面毫无反应”",
    );
    assert.equal(event.payload.hostId, "host-presenter", "事件要带发起端 id：跟随端据此忽略自己的回声");
    assert.deepEqual(event.payload.nav, { route: "/firmware", tab: "dataset" });
    assert.equal(event.actorId, "shi");

    /* ---------- ④ 换个人（马）也能广播：四个角色都可能站在演示机前 ---------- */
    const second = await announce(ma, { ...payload, roundNo: "①", hostId: "host-other" });
    assert.equal(second.status, 200, "任何已登录账号都能广播自己的讲解回合");
    assert.equal(second.json.result.turnId, "TURN-0002", "留痕按序编号，能看出这是第几轮广播");

    /* ---------- ⑤ 缺轮次号 / 缺台词：拦下来（前端也有判据，这里保证坏数据进不来） ---------- */
    for (const [bad, code] of [
      [{ ...payload, roundNo: "" }, "BAD_ROUND"],
      [{ ...payload, text: "" }, "BAD_ROUND"],
    ]) {
      const rejected = await announce(shi, bad);
      assert.equal(rejected.status, 422, `${code} 应被拦下`);
      assert.equal(rejected.json.code, code);
    }

    /* ---------- ⑥ 第二台机器读得到留痕（面向结果展示：事后能核对谁讲了哪一轮） ---------- */
    const snapshot = await call(ma, "GET", "/api/sessions/demo-01/snapshot");
    const turns = snapshot.json.entities.agentTurn ?? [];
    assert.equal(turns.length, 2);
    assert.deepEqual(
      turns.map((item) => item.data.roundNo).sort(),
      ["①", "⑰"],
    );
    assert.ok(
      turns.every((item) => item.data.text && item.data.hostId),
      "每条留痕都要有台词与发起端",
    );

    /* ---------- ⑦ 工单页轮次：解析好的 `orderId` 要落库、也要进事件载荷 ---------- */
    const withOrder = await announce(shi, {
      roundNo: "②",
      text: "已整理为四项任务：现场建档、风险初筛、重点精扫和复核交付。",
      nav: { route: "order", order: "bound" },
      hostId: "host-presenter",
      orderId: "wo-round-sync-1",
    });
    assert.equal(withOrder.status, 200, `带工单的广播失败：${JSON.stringify(withOrder.json)}`);
    assert.equal(withOrder.json.entity.data.orderId, "wo-round-sync-1", "留痕里要能看出这一轮读的是哪张单");
    const eventsWithOrder = await call(shi, "GET", "/api/events?sessionId=demo-01&afterSeq=0");
    const orderEvent = eventsWithOrder.json.events.filter((item) => item.type === "xiaomu.round").at(-1);
    assert.equal(
      orderEvent.payload.orderId,
      "wo-round-sync-1",
      "载荷里不放 orderId，跟随端就只能退回“列表最新那张”（两块屏各开一张工单）",
    );
    /* 没带 orderId 的轮次读成 null，不许变成空串或 undefined（跟随端按 null 走原口径） */
    const plainEvent = eventsWithOrder.json.events.filter((item) => item.type === "xiaomu.round")[0];
    assert.equal(plainEvent.payload.orderId, null, "非工单轮次应当是 null");
    const emptyOrder = await announce(shi, { ...payload, orderId: "" });
    assert.equal(emptyOrder.status, 200);
    assert.equal(emptyOrder.json.entity.data.orderId, null, "空串不是一张工单");
  } finally {
    await service.close?.();
  }
});
