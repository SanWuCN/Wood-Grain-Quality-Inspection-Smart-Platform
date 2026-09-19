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
import { createProbeBook, normalizeClientAddress } from "./collab.mjs";

export function createHub({ server, db, path = "/ws", noServer = false }) {
  /*
    两种接法：
      · 默认（noServer=false）：自己挂在 HTTP server 上，只服务 `path` —— 老行为不变；
      · noServer=true：由 index.mjs 统一做 upgrade 路由（设备通道 `/ws/devices/{id}`
        也要走同一个端口）。**不能让两个 WebSocketServer 都挂 server**：`ws` 对
        路径不匹配的 upgrade 会直接回 400 并销毁 socket，设备通道还没轮到就被掐了。
  */
  const wss = noServer ? new WebSocketServer({ noServer: true }) : new WebSocketServer({ server, path });
  const matches = (request) => new URL(request.url, "http://localhost").pathname === path;
  /** sessionId → Set<ws> */
  const rooms = new Map();
  /**
   * 「同步实测」分母里算"还活着"的窗口：客户端每 15 秒 ping 一次（`PING_EVERY_MS`），
   * 超过这个时间没动静的端不进分母（半开连接，永远不会回执）——见 `openProbe` 的说明。
   */
  const PROBE_ALIVE_MS = 30_000;
  /** 同步实测簿：谁开了实测、哪几台端回了执（多机协同现场排查用） */
  const probes = createProbeBook();
  let endSeq = 0;

  /**
   * 每个端（一个打开的页面 = 一条 WebSocket = 一台端）。
   *
   * `address` 是**服务端看到的 TCP 对端地址**，不是页面自己报的 —— 现场要回答的
   * 「这条写入来自哪台机器」必须取传输层事实。账号与页面是页面自报的，只用于
   * 把端对上人（不参与任何权限判定：权限走 HTTP 的令牌）。
   */
  const endOf = (socket) => socket.__end ?? null;

  const endSummary = (end) => ({
    id: end.id,
    address: end.address,
    sessionId: end.sessionId,
    accountId: end.accountId,
    accountName: end.accountName,
    page: end.page,
    openedAt: new Date(end.openedAtMs).toISOString(),
    lastSeenAt: new Date(end.lastSeenAt).toISOString(),
    /** 从打开到现在多久、最近一次有动静是多久以前（现场判断"这条通道还活着吗"） */
    openedMs: Date.now() - end.openedAtMs,
    idleMs: Date.now() - end.lastSeenAt,
  });

  const roomEnds = (sessionId) =>
    [...(rooms.get(sessionId) ?? [])]
      .filter((socket) => socket.readyState === socket.OPEN)
      .map(endOf)
      .filter(Boolean)
      .map(endSummary);

  wss.on("connection", (socket, request) => {
    const url = new URL(request.url, "http://localhost");
    const sessionId = url.searchParams.get("sessionId") ?? "demo-01";
    const afterSeq = Number(url.searchParams.get("afterSeq") ?? 0);

    if (!rooms.has(sessionId)) rooms.set(sessionId, new Set());
    rooms.get(sessionId).add(socket);

    const end = {
      id: `end-${(endSeq += 1)}`,
      address: normalizeClientAddress(request.socket?.remoteAddress),
      sessionId,
      accountId: null,
      accountName: null,
      page: null,
      openedAtMs: Date.now(),
      lastSeenAt: Date.now(),
    };
    socket.__end = end;

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
      end.lastSeenAt = Date.now();
    });
    socket.on("message", (raw) => {
      end.lastSeenAt = Date.now();
      const text = raw.toString();
      // 老客户端只发一个字符串 "ping"（应用层保活，避免代理掐掉空闲连接）
      if (text === "ping") {
        socket.send(JSON.stringify({ kind: "pong", at: Date.now() }));
        return;
      }
      let message = null;
      try {
        message = JSON.parse(text);
      } catch {
        return;
      }
      if (message?.kind === "ping") {
        end.page = typeof message.page === "string" ? message.page : end.page;
        end.accountId = typeof message.accountId === "string" ? message.accountId : end.accountId;
        socket.send(JSON.stringify({ kind: "pong", at: Date.now() }));
        return;
      }
      // 页面自报身份：只用来把端对上人，权限仍然只认 HTTP 令牌
      if (message?.kind === "who") {
        end.accountId = typeof message.accountId === "string" ? message.accountId : end.accountId;
        end.accountName = typeof message.accountName === "string" ? message.accountName : end.accountName;
        end.page = typeof message.page === "string" ? message.page : end.page;
        return;
      }
      if (message?.kind === "sync-ack") {
        const probe = probes.ack(message.probeId, {
          endId: end.id,
          address: end.address,
          accountId: end.accountId ?? message.accountId ?? null,
          page: end.page ?? message.page ?? null,
        });
        if (probe) socket.send(JSON.stringify({ kind: "sync-ack-ok", probeId: message.probeId, acked: probe.acked.length, ends: probe.ends }));
        return;
      }
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
    /**
     * 小车状态专用广播：**不挂在会话房间、也不是 kind:"event"**。
     *
     * 两条都不能省：
     *   · 不是 event —— 共享 store 收到 event 会重拉整份快照。小车 2 Hz 推状态，
     *     挂在事件通道上就是每秒两次全量重拉，四端同时打开会把平台打满；
     *   · 不按会话 —— 小车不属于某一场排练会话，任何打开建图巡航页的人看到的
     *     都是同一台车的同一份状态。
     * 页面自己按需要订阅 `kind:"cart"`，其它页面收到直接忽略。
     */
    broadcastCart(payload) {
      const text = JSON.stringify({ kind: "cart", ...payload });
      let sent = 0;
      for (const socket of wss.clients) {
        if (socket.readyState === socket.OPEN && socket.bufferedAmount < 512 * 1024) {
          socket.send(text);
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
    /**
     * 某个会话房间里有几台端连着。
     *
     * 为什么要单独给"每房间"的数：多机演示时用户要能看见
     * 「我这台 + 另外几台都连上了没有」。总数（`clientCount`）会把别的会话房间
     * 也算进来，换会话之后看着像"人都到齐了"其实没有。
     */
    peerCount(sessionId) {
      return rooms.get(sessionId)?.size ?? 0;
    },
    /**
     * 房间里每台端的明细：**TCP 对端地址** + 账号 + 当前页面 + 打开多久 + 最近动静。
     *
     * 这一格回答的是用户 2026-09-18 报的那个问题：「我这边添加工单，沈那边收不到」。
     * 如果沈那台根本没出现在这个列表里，那他不是收不到，而是**没连到这台服务器**
     * （多半在自己电脑上开着另一份副本）—— 页面上要能直接看出这件事。
     */
    ends(sessionId) {
      return roomEnds(sessionId);
    },
    /** 所有会话房间里的端（排查"换过会话"时用） */
    allEnds() {
      const list = [];
      for (const sessionId of rooms.keys()) list.push(...roomEnds(sessionId));
      return list;
    },
    /**
     * 开一次同步实测：把"这条写入有几台端真收到了"变成可读的数字。
     *
     * 顺序由调用方定（先 `appendEvent` 真写一条事件、再广播、然后开簿），
     * 这里只负责记下"下发那一刻房间里有哪几台端"，等它们的回执。
     */
    openProbe(sessionId, { probeId, seq = null, from = {} }) {
      const ends = roomEnds(sessionId);
      /*
        ⚠ **分母只算"还活着"的端**（用户 2026-10-01 长期口径下的排查口径）。
        房间里会留着**半开连接**：浏览器被强杀 / 笔记本休眠 / 切网之后，TCP 既不报错
        也不触发 close —— socket 仍是 OPEN，于是它一直在名单里，却永远不会回执。
        实测现场读到的是"只有 2/3 台收到"，让人以为同步坏了；其实第三台早就没了。
        现在超过 `PROBE_ALIVE_MS` 没动静的端不进分母，单独报 `stale` 给界面说明。
      */
      const alive = ends.filter((end) => (end.idleMs ?? 0) <= PROBE_ALIVE_MS);
      return probes.open({
        probeId,
        sessionId,
        seq,
        from,
        ends: alive,
        stale: ends.length - alive.length,
      });
    },
    probeStatus(probeId) {
      return probes.get(probeId);
    },
    latestProbe() {
      return probes.latest();
    },
    /**
     * 由 index.mjs 的 upgrade 路由调用。
     * 不是本通道的路径 **原样退回**（不写响应、不销毁 socket），交给下一个通道；
     * 是本通道才真正完成握手。
     */
    handleUpgrade(request, socket, head) {
      if (!matches(request)) return false;
      wss.handleUpgrade(request, socket, head, (ws, req) => wss.emit("connection", ws, req));
      return true;
    },
    close() {
      clearInterval(heartbeat);
      for (const socket of wss.clients) socket.terminate();
      wss.close();
    },
  };
}
