/**
 * 一次性的链路自检：浏览器 → 桥接(8780) → ASR(8770) 的 WebSocket 能不能连上。
 *
 * 为什么要单独测这条：`/voice-api/health` 只是 HTTP 探活（桥接转发 ASR 的 /health），
 * 它绿**不代表** WebSocket 升级（`/asr` 转发）是通的 —— 而现场"喊不醒"最常见的原因
 * 就是升级被拒（路径写错、代理拦截、上游没起）。所以这里真的握一次手。
 *
 * 用法：node tools/_自检-语音链路.mjs
 */
const BRIDGE_WS = process.env.BRIDGE_WS ?? "ws://127.0.0.1:8780/asr";
const TIMEOUT_MS = 8000;

if (typeof WebSocket === "undefined") {
  console.error("本机 Node 没有内置 WebSocket（需要 Node 22+），无法自检");
  process.exit(2);
}

const started = Date.now();
const ws = new WebSocket(BRIDGE_WS, { headers: { Origin: "http://192.168.31.202:8000" } });

const done = (code, message) => {
  console.log(`  ${message}（耗时 ${Date.now() - started}ms）`);
  try {
    ws.close();
  } catch {
    /* 关不掉就算了，进程自己会退 */
  }
  process.exit(code);
};

const timer = setTimeout(
  () => done(1, `✘ ${TIMEOUT_MS}ms 内没有完成 WebSocket 握手 —— 现场会表现为「喊不醒」`),
  TIMEOUT_MS,
);

ws.addEventListener("open", () => {
  console.log(`  ✔ WebSocket 已连上 ${BRIDGE_WS}`);
  /* 连上之后等第一条服务端消息（ready），确认上游 ASR 真的在会话里 */
});

ws.addEventListener("message", (event) => {
  const text = typeof event.data === "string" ? event.data : "<二进制帧>";
  console.log(`  ← 服务端消息：${text.slice(0, 140)}`);
  let type = "";
  try {
    type = JSON.parse(text).type ?? "";
  } catch {
    /* 不是 JSON 就只打印原文 */
  }
  clearTimeout(timer);
  if (type === "ready") done(0, "✔ 上游 ASR 已就绪（收到 ready）");
  else done(0, `✔ 握手与首帧正常（首帧 type=${type || "未知"}）`);
});

ws.addEventListener("error", (event) => {
  clearTimeout(timer);
  done(1, `✘ WebSocket 出错：${event.message ?? event.error?.message ?? "未知错误"}`);
});

ws.addEventListener("close", (event) => {
  clearTimeout(timer);
  done(1, `✘ 连接被关闭：code=${event.code} reason=${event.reason || "（无）"}`);
});
