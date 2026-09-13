/**
 * 共享服务 · 事件广播（WebSocket）
 *
 * 四台电脑的同步靠这里（PRD §5.3 明确：浏览器 BroadcastChannel 只管同一个
 * 浏览器存储分区内的窗口，跨电脑必须走 WebSocket）。
 *
 * 协议很薄：服务端单向推 `{seq, type, ...}`，客户端不通过它发命令 ——
 * 写操作一律走 POST /api/commands，保持「命令有 commandId、事件按 seq 消费」
 * 这一条链路唯一。
 *
 * 重连：客户端带 `?sessionId=&afterSeq=`，连上后先把缺口事件补发一遍，
 * 再进入实时推送。缺口超过保留范围时让客户端拉全量快照（PRD §7）。
 */

import { WebSocketServer } from "ws";
import { eventsSince, getSession } from "./session.mjs";

export function createHub({ server, db, path = "/ws" }) {
  const wss = new WebSocketServer({ server, path });
  /** sessionId → Set<ws> */
  const rooms = new Map();

  wss.on("connection", (socket, request) => {
    const url = new URL(request.url, "http://localhost");
    const sessionId = url.searchParams.get("sessionId") ?? "demo-01";
    const afterSeq = Number(url.searchParams.get("afterSeq") ?? 0);

    if (!rooms.has(sessionId)) rooms.set(sessionId, new Set());
    rooms.get(sessionId).add(socket);

    // 补缺口：重连后先看到断线期间发生的事，再进入实时流
    const session = getSession(db, sessionId);
    if (session) {
      const missed = eventsSince(db, sessionId, afterSeq);
      for (const event of missed) {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ kind: "event", ...event }));
      }
      socket.send(
        JSON.stringify({
          kind: "hello",
          sessionId,
          lastSeq: session.lastSeq,
          replayed: missed.length,
          serverTime: new Date().toISOString(),
        }),
      );
    } else {
      socket.send(JSON.stringify({ kind: "error", code: "NO_SESSION", message: `演示会话 ${sessionId} 不存在` }));
    }

    // 心跳：局域网里笔记本休眠/切网后连接会变成「假活」，靠它发现
    socket.isAlive = true;
    socket.on("pong", () => {
      socket.isAlive = true;
    });
    socket.on("message", (raw) => {
      // 只认一个客户端主动消息：ping（应用层保活，避免代理掐掉空闲连接）
      if (raw.toString() === "ping") socket.send(JSON.stringify({ kind: "pong", at: Date.now() }));
    });
    socket.on("close", () => {
      rooms.get(sessionId)?.delete(socket);
    });
    socket.on("error", () => {
      rooms.get(sessionId)?.delete(socket);
    });
  });

  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (socket.isAlive === false) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      try {
        socket.ping();
      } catch {
        /* 连接已经没了，下一轮会被 terminate */
      }
    }
  }, 20000);
  heartbeat.unref?.();

  return {
    broadcastSensor(sessionId, frame) {
      const payload = JSON.stringify({ kind: "sensor", sessionId, frame });
      for (const socket of rooms.get(sessionId) ?? []) {
        if (socket.readyState === socket.OPEN && socket.bufferedAmount < 256 * 1024) socket.send(payload);
      }
    },
    broadcast(sessionId, event) {
      const room = rooms.get(sessionId);
      if (!room?.size) return 0;
      const payload = JSON.stringify({ kind: "event", sessionId, ...event });
      let sent = 0;
      for (const socket of room) {
        if (socket.readyState === socket.OPEN) {
          socket.send(payload);
          sent += 1;
        }
      }
      return sent;
    },
    clientCount() {
      let total = 0;
      for (const room of rooms.values()) total += room.size;
      return total;
    },
    close() {
      clearInterval(heartbeat);
      for (const socket of wss.clients) socket.terminate();
      wss.close();
    },
  };
}
