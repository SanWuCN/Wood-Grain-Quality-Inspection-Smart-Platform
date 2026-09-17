/**
 * 语音通道自检：三条 `/voice-*` 通道在生产服务（8000）上是不是真的通。
 *
 * 用户口径（2026-09-17）：「我现在语音识别功能是被剔除了吗」——
 * 事实是本地识别服务一直在跑，但生产服务只代理了 `/api` 与 `/ws`，
 * `/voice-*` 的代理原来只写在 vite 配置里，所以只有从 5173 打开时语音才通。
 *
 * 这个脚本按"浏览器会怎么连"去连，四条判据都能证伪：
 *   ① `GET /voice-api/health` 必须回 **JSON**（回 HTML 就说明落到了 SPA 兜底 = 没代理）；
 *   ② `ws://<host>/voice-wake` 必须完成握手并收到服务端消息（不是被 destroy）；
 *   ③ `ws://<host>/voice-asr` 同样要能连上（一句话识别通道）；
 *   ④ 反证：`ws://<host>/ws`（事件通道）与设备通道**不受影响**（顺序改动没踩到它们）。
 *
 * 用法：node tools/验收-语音通道.mjs [--base http://127.0.0.1:8000]
 */
const baseArg = process.argv.indexOf("--base");
const BASE = baseArg >= 0 ? process.argv[baseArg + 1] : "http://127.0.0.1:8000";
const WS_BASE = BASE.replace(/^http/, "ws");

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? `　（${detail}）` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 连一条 WS，等 opened/firstMessage，返回结果（超时即算失败） */
async function probeWs(path, { timeoutMs = 8000, keepMs = 1200 } = {}) {
  return new Promise((resolve) => {
    const out = { path, opened: false, messages: [], closedCode: null, error: null };
    let ws;
    try {
      ws = new WebSocket(`${WS_BASE}${path}`);
    } catch (cause) {
      out.error = String(cause?.message ?? cause);
      resolve(out);
      return;
    }
    const done = (() => {
      let timer = null;
      return () => {
        if (timer) clearTimeout(timer);
        try {
          ws.close();
        } catch {
          /* 已经关了 */
        }
        resolve(out);
      };
    })();
    const timeout = setTimeout(done, timeoutMs);
    ws.addEventListener("open", () => {
      out.opened = true;
      /* 多留一会儿收服务端的首帧（桥接层会报 ready/stage） */
      setTimeout(() => {
        clearTimeout(timeout);
        done();
      }, keepMs);
    });
    ws.addEventListener("message", (e) => {
      if (out.messages.length < 4) out.messages.push(String(e.data).slice(0, 160));
    });
    ws.addEventListener("close", (e) => {
      out.closedCode = e.code;
    });
    ws.addEventListener("error", () => {
      out.error = out.error ?? "socket error";
    });
  });
}

console.log(`目标服务器：${BASE}\n`);

/* ---------- ① /voice-api/health 必须是 JSON ---------- */
try {
  const r = await fetch(`${BASE}/voice-api/health`);
  const text = await r.text();
  const isJson = text.trim().startsWith("{");
  let detail = `HTTP ${r.status}`;
  if (isJson) {
    const j = JSON.parse(text);
    detail += `　state=${j.state}　upstream=${j.bridge?.upstream ?? "?"}　model=${String(j.model ?? "").split("\\").pop()}`;
  } else {
    detail += `　拿到的是 HTML（长度 ${text.length}）= 落到了 SPA 兜底，说明没代理`;
  }
  check("/voice-api/health 回 JSON（不是 SPA 兜底的 HTML）", r.ok && isJson, detail);
} catch (cause) {
  check("/voice-api/health 回 JSON（不是 SPA 兜底的 HTML）", false, String(cause?.message ?? cause));
}

/* ---------- ② /voice-wake：唤醒长连接 ---------- */
const wake = await probeWs("/voice-wake");
check(
  "/voice-wake 能完成握手（常驻唤醒不再被 destroy）",
  wake.opened,
  wake.opened ? "已连上" : `未连上（error=${wake.error ?? "无"}）`,
);
check(
  "/voice-wake 收到服务端首帧（桥接层已就绪）",
  wake.messages.length > 0,
  wake.messages[0] ?? "（没有消息）",
);

/* ---------- ③ /voice-asr：一句话识别通道 ---------- */
const asr = await probeWs("/voice-asr", { keepMs: 800 });
check("/voice-asr 能完成握手", asr.opened, asr.opened ? "已连上" : `未连上（error=${asr.error ?? "无"}）`);

/* ---------- ④ 反证：事件通道与设备通道没被这次改动踩到 ---------- */
await sleep(200);
const events = await probeWs("/ws?sessionId=demo-01&afterSeq=0", { keepMs: 800 });
check("/ws 事件通道仍然正常（hello 还在）", events.opened && events.messages.length > 0, events.messages[0] ?? "（没有消息）");
const bad = await probeWs("/voice-nope", { timeoutMs: 2500, keepMs: 300 });
check("不认识的 /voice-* 路径不会被误接（如实断开）", !bad.opened, bad.opened ? "竟然连上了" : `已断开（code=${bad.closedCode ?? "?"}）`);

console.log(`\n${fail === 0 ? "全部通过" : `${fail} 项未通过`}（通过 ${pass}）`);
process.exit(fail === 0 ? 0 : 1);
