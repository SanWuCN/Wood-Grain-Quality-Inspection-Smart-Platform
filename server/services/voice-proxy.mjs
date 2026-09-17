/**
 * 语音通道代理（生产服务侧）—— 把 `/voice-*` 转给本机语音桥接层。
 *
 * ── 为什么需要它（用户 2026-09-17 的疑问）────────────────────────────
 * 用户问：「我现在语音识别功能是被剔除了吗」。
 *
 * 事实是**没有被剔除**：本机语音链路一直在跑 ——
 *   Python 识别服务（8770，`voice-module/runtime/python312/python.exe server.py`）
 *   ← 桥接层（8780，`voice-module/bridge/server.mjs`）。
 * 但页面的三条语音通道（`/voice-asr`、`/voice-wake`、`/voice-api`）**只在
 * `vite.config.ts` 里配了代理** —— 也就是说只有从开发服务器（5173）打开页面时
 * 语音才通；一旦用生产服务（`node server/index.mjs --static dist`，8000）打开，
 * upgrade 路由里没人认 `/voice-wake`，socket 直接被销毁 →
 * 画面上「常驻唤醒」永远连不上，看起来就像"语音识别被剔除了"。
 *
 * 这个文件把那三条通道在**生产服务里补齐**，规则与 vite 的那份逐条一致：
 *   · `/voice-asr`、`/voice-wake` 是 WebSocket（两条独立连接，不合并：
 *     前者一次连接=一句话，后者是长连接一直在听）；
 *   · `/voice-api` 是普通 HTTP（桥接层的状态/健康查询）；
 *   · 目标地址可用 `MUMAI_VOICE`（ws）与 `MUMAI_VOICE_HTTP`（http）覆盖，
 *     与 vite.config.ts 用的**同名环境变量**，两处不会各配一套。
 *
 * ⚠ 桥接层只绑 127.0.0.1（这是有意的：它是本机的硬件侧服务）。
 *   跨机器的浏览器麦克风本来也会被浏览器的安全上下文规则挡掉
 *   （http + 内网 IP 不给 `navigator.mediaDevices`），所以这里**不做**对外暴露，
 *   只把"本机页面 → 本机语音服务"这一段接起来。
 *
 * ⚠ 不使用第三方代理依赖：仓库里已经有 `ws`，WebSocket 转发用它与 `ws` 的
 *   `noServer` 模式手写；HTTP 转发用 node:http。加起来不到百行，行为可读可测。
 */

import { request as httpRequest } from "node:http";
import { WebSocket, WebSocketServer } from "ws";

/** 需要转发的 WebSocket 路径（与 vite.config.ts 的两条一致） */
const WS_PATHS = ["/voice-asr", "/voice-wake"];

/** HTTP 前缀（桥接层自己就挂在 `/voice-api` 下，所以**不重写路径**） */
const HTTP_PREFIX = "/voice-api";

const DEFAULT_WS_TARGET = process.env.MUMAI_VOICE ?? "ws://127.0.0.1:8780";
const DEFAULT_HTTP_TARGET = process.env.MUMAI_VOICE_HTTP ?? "http://127.0.0.1:8780";

/**
 * @param {{ wsTarget?: string, httpTarget?: string, logger?: Console }} [options]
 */
export function createVoiceProxy({ wsTarget = DEFAULT_WS_TARGET, httpTarget = DEFAULT_HTTP_TARGET, logger = console } = {}) {
  const wss = new WebSocketServer({ noServer: true });
  const httpUrl = new URL(httpTarget);

  const matches = (request) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    return WS_PATHS.includes(pathname);
  };

  const matchesHttp = (pathname) => pathname === HTTP_PREFIX || pathname.startsWith(`${HTTP_PREFIX}/`);

  /**
   * 转发一次 upgrade。
   *
   * 三处细节都是踩过才知道的：
   *   1. **二进制要保持**：唤醒通道推的是 PCM（binary frame），
   *      `send(data, { binary: isBinary })` 少一个参数就会变成文本帧，
   *      对端拿到一堆乱码而不是音频；
   *   2. **握手期间的消息要排队**：客户端连上后可能立刻开始推音频，
   *      而上游还没 open —— 直接丢会丢掉开头几百毫秒（正好是"小木小木"）；
   *   3. **两头同生共死**：任意一侧关闭/出错都要把另一侧也关掉，
   *      否则会留下"看着连着、其实对面早没了"的半死连接。
   */
  const handleUpgrade = (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (!WS_PATHS.includes(url.pathname)) return false;

    wss.handleUpgrade(request, socket, head, (client) => {
      const target = `${wsTarget.replace(/\/$/, "")}${url.pathname}${url.search}`;
      let upstream;
      try {
        upstream = new WebSocket(target);
      } catch (cause) {
        logger.warn?.(`[voice] 连接语音桥失败：${cause?.message ?? cause}`);
        client.close(1011, "voice bridge unavailable");
        return;
      }

      const pending = [];
      let open = false;

      client.on("message", (data, isBinary) => {
        if (open && upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
        else if (pending.length < 64) pending.push([data, isBinary]);
      });

      upstream.on("open", () => {
        open = true;
        for (const [data, isBinary] of pending.splice(0)) {
          if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
        }
      });
      upstream.on("message", (data, isBinary) => {
        if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
      });
      upstream.on("close", () => {
        try {
          client.close();
        } catch {
          /* 已经关了 */
        }
      });
      upstream.on("error", (cause) => {
        logger.warn?.(`[voice] 语音桥通道出错：${cause?.message ?? cause}`);
        try {
          client.close(1011, "voice bridge error");
        } catch {
          /* 同上 */
        }
      });
      client.on("close", () => {
        try {
          upstream.close();
        } catch {
          /* 同上 */
        }
      });
      client.on("error", () => {
        try {
          upstream.close();
        } catch {
          /* 同上 */
        }
      });
    });
    return true;
  };

  /**
   * 转发一次 `/voice-api/*` 请求。
   *
   * 桥接层不在时**如实回 502**（带 code），而不是让 SPA 兜底回一张 HTML ——
   * 后者会让前端把 HTML 当 JSON 解析，报出"Unexpected token <"这类与真因无关的错。
   */
  const handleHttp = (req, res) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (!matchesHttp(pathname)) return false;

    const proxyReq = httpRequest(
      {
        hostname: httpUrl.hostname,
        port: httpUrl.port || 80,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: `${httpUrl.hostname}:${httpUrl.port || 80}` },
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.pipe(res);
      },
    );
    proxyReq.on("error", (cause) => {
      logger.warn?.(`[voice] 语音桥 HTTP 不可用：${cause?.message ?? cause}`);
      if (res.headersSent) {
        res.end();
        return;
      }
      res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          code: "VOICE_BRIDGE_DOWN",
          message: "本机语音桥接层不可用（8780）",
          fieldErrors: [],
          retryable: true,
        }),
      );
    });
    req.pipe(proxyReq);
    return true;
  };

  return {
    matches,
    matchesHttp,
    handleUpgrade,
    handleHttp,
    /** 供启动日志与自检使用：这两条是本代理认识的全部路径 */
    paths: { ws: [...WS_PATHS], http: HTTP_PREFIX },
    targets: { ws: wsTarget, http: httpTarget },
    close() {
      for (const socket of wss.clients) socket.terminate();
      wss.close();
    },
  };
}

/**
 * 自检：这个代理（在 8000 上）能不能把三条语音通道送到桥接层。
 * 打印一行结论，不抛错 —— 服务启动不该因为语音服务没起就失败。
 *
 * 判据全部可证伪：
 *   · `/voice-api/health` 必须回 **JSON**（回 HTML 就说明落到了 SPA 兜底 = 没代理）；
 *   · `/voice-wake` 必须能**完成 WebSocket 握手**（101），而不是被销毁。
 */
export async function probeVoiceProxy(base = "http://127.0.0.1:8780") {
  const out = { http: false, ws: false, detail: "" };
  try {
    const r = await fetch(`${base}/voice-api/health`);
    const text = await r.text();
    out.http = r.ok && text.trim().startsWith("{");
    const j = (() => {
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    })();
    out.detail = j ? `ready=${j.ready} state=${j.state} upstream=${j.bridge?.upstream ?? "?"}` : text.slice(0, 60);
  } catch (cause) {
    out.detail = `HTTP 探测失败：${cause?.message ?? cause}`;
  }
  return out;
}
