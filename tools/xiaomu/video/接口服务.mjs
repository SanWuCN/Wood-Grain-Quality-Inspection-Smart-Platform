/**
 * video-alpha-gif · 调用接口
 *
 * 三种用法，覆盖"脚本调 / 服务调 / 页面调"：
 *   1. 模块：import { alphaGif, probeVideo } from "./抠透明GIF.mjs"
 *   2. CLI ：node 抠透明GIF.mjs <in.mp4> -o out.gif --size 240 --fps 12
 *   3. HTTP：node 接口服务.mjs → POST /alpha-gif  （JSON 入参 / 出参）
 *
 * ── 为什么还要一个 HTTP 接口 ────────────────────────────────────────
 * 形象资源是**产品侧**要用的东西（小木的眨眼/思考动画），而产品是走 8000 那台
 * 共享服务的。把转码能力做成一个本地 HTTP 端点，前端就能"传视频、拿 GIF 路径"，
 * 不必在浏览器里跑 ffmpeg（也跑不了）。
 *
 * 默认端口 8090，只监听 127.0.0.1。
 *
 * 用法：
 *   node 接口服务.mjs [--port 8090]
 *   curl -X POST http://127.0.0.1:8090/alpha-gif -H "Content-Type: application/json" \
 *        -d '{"input":"D:/平台/xiaomu-assets/videos/blink.mp4","size":240,"fps":12}'
 *   GET /health  → 探活
 */
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync } from "node:fs";
import { extname, resolve } from "node:path";
import { keyGreenScreen } from "./抠绿幕.mjs";

const argv = process.argv.slice(2);
const portArg = argv.indexOf("--port");
const PORT = portArg >= 0 ? +argv[portArg + 1] : 8090;
const OUT_DIR = resolve("D:\\平台\\xiaomu-assets\\out");

/** 参数校验：宁可 400 说清楚，也不要抛 500 */
function parseBody(body) {
  if (!body || typeof body !== "object") throw new Error("请求体必须是 JSON 对象");
  const input = body.input;
  if (typeof input !== "string" || !input.trim()) throw new Error("缺少 input（视频绝对路径）");
  if (!existsSync(input)) throw new Error("input 不存在：" + input);
  if (![".mp4", ".mov", ".webm", ".mkv", ".avi"].includes(extname(input).toLowerCase())) {
    throw new Error("不支持的输入格式（支持 mp4/mov/webm/mkv/avi）：" + extname(input));
  }
  const num = (v, dflt, lo, hi) => {
    if (v === undefined || v === null) return dflt;
    const n = Number(v);
    if (!Number.isFinite(n) || n < lo || n > hi) throw new Error("参数超出范围（" + lo + "~" + hi + "）：" + v);
    return n;
  };
  return {
    input: resolve(input),
    out: body.out ? resolve(body.out) : undefined,
    size: num(body.size, 240, 32, 1440),
    fps: num(body.fps, 12, 1, 60),
    /* 亮度阈值：省略时按视频自适应（见下） */
    lumTop: body.lumTop === undefined ? undefined : num(body.lumTop, 0.75, 0.2, 0.99),
    lumBottom: body.lumBottom === undefined ? undefined : num(body.lumBottom, 0.75, 0.2, 0.99),
    solid: num(body.solid, 0.22, 0.02, 0.6),

    hold: num(body.hold, 0.92, 0.3, 1.2),
    webm: body.webm !== false,
  };
}

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const json = (code, obj) => {
    const s = JSON.stringify(obj, null, 2);
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(s) });
    res.end(s);
  };

  if (req.method === "GET" && url.pathname === "/health") {
    return json(200, { ok: true, service: "video-alpha-gif", port: PORT });
  }
  if (req.method === "GET" && url.pathname === "/probe") {
    const input = url.searchParams.get("input");
    if (!input || !existsSync(input)) return json(400, { ok: false, error: "缺少或不存在 input" });
    try { return json(200, { ok: true, probe: probeVideo(input) }); }
    catch (e) { return json(500, { ok: false, error: String(e.message || e) }); }
  }
  if (req.method === "POST" && url.pathname === "/alpha-gif") {
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 1 << 20) req.destroy(); });
    req.on("end", () => {
      try {
        const body = JSON.parse(raw || "{}");
        if (typeof body.input !== "string" || !existsSync(body.input)) {
          return json(400, { ok: false, error: "input 必须是存在的视频绝对路径" });
        }
        mkdirSync(OUT_DIR, { recursive: true });
        const r = keyGreenScreen({
          input: body.input,
          out: body.out ? resolve(body.out) : resolve(OUT_DIR, "out.gif"),
          size: body.size || 240,
          fps: body.fps || 12,
          /* t=绿度阈值、w=过渡带宽；省略用默认（实测这批素材 0.405/0.05 通吃） */
          t: body.t, w: body.w,
          webm: body.webm !== false,
        });
        return json(200, { ok: true, result: r });
      } catch (e2) {
        return json(400, { ok: false, error: String(e2.message || e2) });
      }
    });
    return undefined;
  }  return json(404, { ok: false, error: "未知路径。可用：GET /health、GET /probe?input=、POST /alpha-gif" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("video-alpha-gif 接口已启动：http://127.0.0.1:" + PORT);
  console.log("  GET  /health");
  console.log("  GET  /probe?input=<视频路径>");
  console.log("  POST /alpha-gif  {\"input\":\"...\",\"size\":240,\"fps\":12}");
});
