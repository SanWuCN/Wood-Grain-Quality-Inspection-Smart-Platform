/**
 * 语音通道代理 · 单测（起一个假桥接层，真的连一次）
 *
 * ── 为什么这几条值得钉住 ──────────────────────────────────────────
 * 代理转发里有两个错**不会报错、只会让语音变哑**：
 *   1. 二进制帧被当文本发（`send(data)` 少写 `{binary:true}`）——
 *      对端拿到的是乱码 PCM，识别器的输入是噪声；现象是"能连上但喊不动"；
 *   2. 握手期间客户端已经开始推音频，而上游还没 open，直接丢 ——
 *      丢掉的正好是开头那几百毫秒（"小木小木"四个字就在里面）。
 * 这两条都在这里用真实的 socket 验掉，不靠读代码。
 *
 * 另外两条是"别误伤"：不认识的路径必须原样退回（`false`），
 * 否则升级路由会把设备通道或事件通道的 upgrade 吃掉。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";

import { createVoiceProxy, probeVoiceProxy } from "./voice-proxy.mjs";

/** 起一个"假桥接层"：HTTP 回 JSON，WS 回声（并把收到的分片类型原样回传） */
async function startFakeBridge() {
  const http = createServer((req, res) => {
    if (req.url?.startsWith("/voice-api/health")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ready: true, state: "ready", bridge: { upstream: "127.0.0.1:8770" } }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: "NOT_FOUND" }));
  });
  const wss = new WebSocketServer({ noServer: true });
  http.on("upgrade", (request, socket, head) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (pathname !== "/voice-wake" && pathname !== "/voice-asr") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws, req) => {
      /* 立刻回一帧"服务端就绪"，同时把收到的每一帧按类型回声 */
      ws.send(JSON.stringify({ type: "ready", path: new URL(req.url ?? "/", "http://x").pathname }));
      ws.on("message", (data, isBinary) => ws.send(data, { binary: isBinary }));
    });
  });

  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  const port = http.address().port;
  return {
    port,
    close() {
      for (const client of wss.clients) client.terminate();
      wss.close();
      http.close();
    },
  };
}

test("HTTP：/voice-api/* 被转给桥接层；不认识的路径原样退回", async () => {
  const bridge = await startFakeBridge();
  const proxy = createVoiceProxy({
    wsTarget: `ws://127.0.0.1:${bridge.port}`,
    httpTarget: `http://127.0.0.1:${bridge.port}`,
  });
  const server = createServer((req, res) => {
    if (proxy.handleHttp(req, res)) return;
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not-proxied");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    const ok = await fetch(`http://127.0.0.1:${port}/voice-api/health`);
    const body = await ok.json();
    assert.equal(ok.status, 200);
    assert.equal(body.ready, true, "桥接层的 JSON 必须原样透传（不是 SPA 兜底的 HTML）");

    const other = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(other.status, 404, "非 /voice-api 的请求不该被这个代理吃掉");
    assert.equal(await other.text(), "not-proxied");
  } finally {
    server.close();
    proxy.close();
    bridge.close();
  }
});

test("WebSocket：/voice-wake 能连上，二进制帧原样转发（PCM 不能变文本）", async () => {
  const bridge = await startFakeBridge();
  const proxy = createVoiceProxy({
    wsTarget: `ws://127.0.0.1:${bridge.port}`,
    httpTarget: `http://127.0.0.1:${bridge.port}`,
  });
  const server = createServer();
  server.on("upgrade", (request, socket, head) => {
    if (proxy.handleUpgrade(request, socket, head)) return;
    socket.destroy();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    const { WebSocket } = await import("ws");
    const client = new WebSocket(`ws://127.0.0.1:${port}/voice-wake`);
    const frames = [];
    const ready = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 4000);
      client.on("message", (data, isBinary) => {
        frames.push({ data, isBinary });
        if (frames.length === 1) {
          clearTimeout(timer);
          resolve(true);
        }
      });
      client.on("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
    assert.equal(ready, true, "必须能完成握手并收到服务端首帧（被 destroy 的话这里就红）");
    assert.match(String(frames[0].data), /"type":"ready"/, "首帧应当是桥接层的 ready");

    /* 发一帧**二进制**（真音频就是二进制），回声必须还是二进制且内容一致 */
    const pcm = Buffer.from([0x01, 0x02, 0x80, 0xff, 0x00, 0x7f]);
    const echoed = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 4000);
      client.on("message", (data, isBinary) => {
        if (frames.length >= 1 && isBinary) {
          clearTimeout(timer);
          resolve({ data, isBinary });
        }
      });
      client.send(pcm, { binary: true });
    });
    assert.ok(echoed, "二进制帧必须被原样送回来（丢了就说明握手期消息被吃掉）");
    assert.equal(echoed.isBinary, true, "帧类型必须还是二进制 —— 变成文本帧的话识别器拿到的是乱码");
    assert.deepEqual([...echoed.data], [...pcm], "内容必须逐字节一致");
    client.close();
  } finally {
    server.close();
    proxy.close();
    bridge.close();
  }
});

test("不认识的 /voice-* 路径不会被误接（避免吃掉别的 upgrade）", () => {
  const proxy = createVoiceProxy();
  assert.equal(proxy.matches({ url: "/voice-wake" }), true);
  assert.equal(proxy.matches({ url: "/voice-asr" }), true);
  assert.equal(proxy.matches({ url: "/ws" }), false, "事件通道不能落到语音代理上");
  assert.equal(proxy.matches({ url: "/ws/devices/D1" }), false, "设备通道不能落到语音代理上");
  assert.equal(proxy.matches({ url: "/voice-nope" }), false);
  assert.equal(proxy.matchesHttp("/voice-api/health"), true);
  assert.equal(proxy.matchesHttp("/voice-api"), true);
  assert.equal(proxy.matchesHttp("/api/health"), false);
});

test("probeVoiceProxy：桥接层不在时如实报 false，而不是抛错", async () => {
  /* 挑一个几乎不可能有人监听的端口 */
  const out = await probeVoiceProxy("http://127.0.0.1:9");
  assert.equal(out.http, false);
  assert.ok(out.detail.length > 0, "失败也要带原因，便于启动日志里说明");
});
