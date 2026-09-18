/**
 * 多机协同现场排查 —— 服务端行为验收（真起服务、真连 WebSocket）
 *
 * 用户 2026-09-18 报的问题：「我这边添加工单，沈那边收不到；沈那边派发人员，
 * 我这边也同步不到。」—— 两边都不动只有两种可能：写的不是同一台服务器，
 * 或者有一台的实时通道断了。这一组盯的就是**平台能不能自己把这两件事说清楚**：
 *
 *   ① `/api/sessions/:id/peers` 报出每台端的**对端地址**、账号、当前页面、
 *      打开多久、最近动静，以及这台服务器能被哪些地址打开（含虚拟局域网那条）；
 *   ② 同步实测走的是**和工单事件同一条路**：真写一条事件 → 广播 → 端回执，
 *      结论是"M/N 台端在 x 秒内收到"，没回的端要点名；
 *   ③ 写请求留痕：最近谁从哪台机器写了什么（含状态码），且**只有管理员能看**；
 *   ④ 实测事件必须进得了事件流（可回放），不是一条只在内存里的假消息。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { WebSocket } from "ws";

test("多机协同：端明细、同步实测回执、写入来源留痕、实测事件进事件流", async () => {
  const { startService } = await import("../index.mjs");
  const service = await startService({ port: 18091, host: "127.0.0.1", dbFile: ":memory:", quiet: true });
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
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  /* 端要在①之后才连：先证明"一台端都没有时明细是空的"，再连 —— 顺序反了就测不出这一点 */
  let socket = null;

  try {
    const shi = await login("shi");
    const rao = await login("rao");

    /* ---------- ① 服务器身份 + 地址清单 ---------- */
    const peersNoEnd = await call(shi, "GET", "/api/sessions/demo-01/peers");
    assert.equal(peersNoEnd.status, 200);
    const info = peersNoEnd.json;
    assert.equal(info.sessionId, "demo-01");
    assert.ok(info.server?.hostname, "要报出这台服务器的主机名");
    assert.equal(info.server.dbFile, ":memory:", "要如实报出数据在哪个库文件里（内存库也照实说）");
    assert.ok(String(info.server.startedAt).length > 10, "要报出服务启动时刻");
    assert.ok(Array.isArray(info.addresses), "地址清单必须是数组（读不到就如实空着）");
    for (const item of info.addresses) {
      assert.match(item.url, /^http:\/\/[\d.]+(:\d+)?$/, `地址长这样才对：${item.url}`);
      assert.ok(["lan", "vpn"].includes(item.kind), `地址类别只有 lan/vpn：${item.kind}`);
      assert.ok(item.iface, "每条地址要带网卡名（现场要照着念）");
    }
    assert.ok(
      info.addresses.filter((item) => item.recommended).length <= 1,
      "最多只能推荐一条地址，多了等于没推荐",
    );
    assert.deepEqual(
      info.lanUrls,
      info.addresses.filter((item) => item.kind === "lan").map((item) => item.url),
      "老字段 lanUrls 必须与新清单里的局域网地址一致",
    );
    assert.deepEqual(info.ends, [], "还没连端时明细必须是空数组");

    /* ---------- ② 连上一台端（自报身份）→ 明细里出现它 ---------- */
    socket = new WebSocket(`${base.replace(/^http/, "ws")}/ws?sessionId=demo-01`);
    await new Promise((resolvePromise, reject) => {
      socket.once("open", resolvePromise);
      socket.once("error", reject);
    });
    const received = [];
    socket.on("message", (raw) => {
      let message = null;
      try {
        message = JSON.parse(String(raw));
      } catch {
        return;
      }
      received.push(message);
      if (message.kind === "event" && message.type === "sync.probe") {
        socket.send(JSON.stringify({ kind: "sync-ack", probeId: message.payload?.probeId }));
      }
    });
    socket.send(JSON.stringify({ kind: "who", accountId: "shen", accountName: "沈", page: "#/orders" }));
    let withEnd = null;
    for (let i = 0; i < 40; i += 1) {
      withEnd = (await call(shi, "GET", "/api/sessions/demo-01/peers")).json;
      if (withEnd.ends?.length) break;
      await sleep(100);
    }
    assert.equal(withEnd.peers >= 1, true, "房间里的端数要跟着涨");
    assert.equal(withEnd.ends.length, 1, `明细里应有 1 台端：${JSON.stringify(withEnd.ends)}`);
    const end = withEnd.ends[0];
    assert.equal(end.address, "127.0.0.1", "对端地址取 TCP 事实（本机测试就是 127.0.0.1）");
    assert.equal(end.accountId, "shen", "账号来自端自报（只用于把端对上人）");
    assert.equal(end.page, "#/orders");
    assert.ok(typeof end.idleMs === "number" && end.idleMs >= 0, "要给出最近动静距今多久");

    /* ---------- ③ 实测只有管理员能开；开了之后端回执 → 结论通过 ---------- */
    const forbidden = await call(rao, "POST", "/api/console/sync-probe", { sessionId: "demo-01" });
    assert.equal(forbidden.status, 403, "非管理员不能开同步实测");
    const writeLogForbidden = await call(rao, "GET", "/api/console/write-log");
    assert.equal(writeLogForbidden.status, 403, "非管理员不能看写入来源");

    const opened = await call(shi, "POST", "/api/console/sync-probe", { sessionId: "demo-01" });
    assert.equal(opened.status, 200, `开实测失败：${JSON.stringify(opened.json)}`);
    const probeId = opened.json.probeId;
    assert.ok(probeId, "实测要有一个 id，页面靠它查结论");
    assert.equal(opened.json.ends, 1, "下发那一刻房间里有 1 台端");
    assert.equal(opened.json.ok, false, "还没回执时结论不能是「通过」");
    assert.ok(opened.json.seq > 0, "实测事件要真的写进事件流（有 seq）");

    let result = null;
    for (let i = 0; i < 40; i += 1) {
      result = (await call(shi, "GET", `/api/console/sync-probe/${probeId}`)).json;
      if (result?.acked?.length) break;
      await sleep(100);
    }
    assert.equal(result?.acked?.length, 1, `端没回执：${JSON.stringify(result)}`);
    assert.equal(result.ok, true, "一台端回了执、一共一台端 → 结论是通过");
    assert.deepEqual(result.pending, [], "没有没回的端");
    assert.ok(typeof result.lastAckMs === "number" && result.lastAckMs >= 0, "要给出「几秒内全网可见」的用时");
    assert.equal(result.acked[0].address, "127.0.0.1");
    assert.equal(result.acked[0].accountId, "shen");

    /* 刷新页面后还能念出上一次的结论（不至于"刚才那条到底过没过"说不清） */
    const latest = await call(shi, "GET", "/api/console/sync-probe");
    assert.equal(latest.json.probe?.probeId, probeId);
    const missing = await call(shi, "GET", "/api/console/sync-probe/probe-不存在");
    assert.equal(missing.status, 404, "过期的实测要如实报 404，不编一个结论出来");

    /* ---------- ④ 实测事件确实在事件流里（可回放、可追） ---------- */
    const events = await call(shi, "GET", "/api/events?sessionId=demo-01&afterSeq=0");
    assert.equal(events.status, 200);
    const probeEvent = events.json.events.find((item) => item.type === "sync.probe");
    assert.ok(probeEvent, "事件流里要有 sync.probe");
    assert.equal(probeEvent.payload.probeId, probeId);
    assert.equal(probeEvent.actorId, "shi");

    /* ---------- ⑤ 写入来源：刚才那两条写请求都要留痕（含被拒的那条） ---------- */
    const log = await call(shi, "GET", "/api/console/write-log?limit=50");
    assert.equal(log.status, 200);
    assert.ok(log.json.entries.length >= 2, `写入来源至少要记到刚才两条：${JSON.stringify(log.json.entries)}`);
    const byPath = (path) => log.json.entries.filter((item) => item.path === path);
    const probeWrites = byPath("/api/console/sync-probe");
    assert.equal(probeWrites.length, 2, "成功一条 + 被拒一条都要留痕（被拒的那条正是现场要看的）");
    assert.ok(
      probeWrites.some((item) => item.status === 200 && item.actorId === "shi" && item.address === "127.0.0.1"),
      `成功那条要记到账号与来源地址：${JSON.stringify(probeWrites)}`,
    );
    assert.ok(
      probeWrites.some((item) => item.status === 403 && item.actorId === "rao"),
      `被拒那条要记到 403 与账号：${JSON.stringify(probeWrites)}`,
    );
    assert.equal(log.json.server.dbFile, ":memory:");
    assert.ok(log.json.ends.some((item) => item.accountId === "shen"), "写入来源里要能对上端列表");
    /* 只读请求不该进来凑数 */
    assert.ok(!log.json.entries.some((item) => item.method === "GET"), "只读请求不记");
  } finally {
    try {
      socket?.close();
    } catch {
      /* 已经断了 */
    }
    await service.close?.();
  }
});
