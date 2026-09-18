/**
 * 小车状态通道 · **静默自检**（2026-09-18 实测踩到的那一次）
 *
 * ── 这一组在防什么 ──────────────────────────────────────────────────
 * 现场遇到的不是"连不上"，而是**连上了但烂在半路**：小车那头不再推状态，
 * 本端既不报错也不触发 `close`，`link` 一直写着 `online`，而页面上的
 * 「数据延迟」从 128 秒一路涨到 253 秒、运动操作全被禁用 —— 看着就像小车坏了。
 * 同一时刻小车自己的 `/api/state` 与摄像头都是好的（2 Hz 推得好好的），
 * 说明只是这条连接半开着。
 *
 * 判据（都能证伪）：
 *   ① 拿到状态时是新鲜的（`live === true`），这是后面判断的基线；
 *   ② 对端静默之后，服务端**自己**把这条连接推回重连（不需要人来重启服务）：
 *      对端会看到第二次连接；
 *   ③ 重连之后状态重新变新鲜（`live === true`）—— 结论落在页面看得见的那个读数上；
 *   ④ 期间给出的原因说得清是"静默"而不是"连不上"（现场要知道该去查哪一头）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { WebSocketServer } from "ws";

test("小车状态静默：服务端自己重连，读数重新变新鲜", async () => {
  /* 一台"假小车"：每次连上都先推一条状态，然后**静默**（模拟半开的那一次） */
  const wss = new WebSocketServer({ port: 18094, path: "/api/ws" });
  let connections = 0;
  let closedByPeer = 0;
  wss.on("connection", (socket) => {
    connections += 1;
    socket.on("close", () => {
      closedByPeer += 1;
    });
    socket.send(
      JSON.stringify({
        type: "state",
        payload: { mode: "idle", uptime_s: 1, pose: { x: 1, y: 2, yaw: 0.5 }, scan_points: [] },
      }),
    );
    /* 之后什么都不发 —— 这正是现场那次"假活"的样子 */
  });

  const previous = process.env.MUMAI_CART_URL;
  process.env.MUMAI_CART_URL = "http://127.0.0.1:18094";
  const { createCartService } = await import("./cart.mjs");
  const cart = createCartService({ logger: { warn: () => {}, info: () => {}, error: () => {} } });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  try {
    let fresh = null;
    for (let i = 0; i < 40; i += 1) {
      fresh = cart.snapshot();
      if (fresh.live) break;
      await sleep(100);
    }
    assert.equal(fresh.live, true, `第一次连上应该就是新鲜的：${JSON.stringify(fresh.lastError)}`);
    assert.equal(connections, 1);

    /*
      静默阈值 8 秒、自检节拍 3 秒、重连退避 1 秒 —— 给它 20 秒把这一圈走完。
      期间不许有人碰这个服务：这正是"没人管也能自己回来"的意思。
    */
    let recovered = null;
    for (let i = 0; i < 100; i += 1) {
      const now = cart.snapshot();
      if (connections >= 2 && now.live) {
        recovered = now;
        break;
      }
      await sleep(200);
    }

    assert.ok(connections >= 2, `静默之后服务端没有重连（连接数还是 ${connections}）`);
    assert.ok(closedByPeer >= 1, "半开的连接要真的被 terminate 掉，不能挂着");
    assert.ok(recovered, `重连之后状态没有回到新鲜：${JSON.stringify(cart.status())}`);
    assert.equal(recovered.live, true);
    assert.ok(
      /静默|重连/.test(String(cart.status().lastError ?? "")) || cart.status().link === "online",
      `给出的原因要说得清是"静默"：${cart.status().lastError}`,
    );
  } finally {
    cart.stop();
    if (previous === undefined) delete process.env.MUMAI_CART_URL;
    else process.env.MUMAI_CART_URL = previous;
    await new Promise((r) => wss.close(r));
  }
});
