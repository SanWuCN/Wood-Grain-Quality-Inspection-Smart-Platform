/**
 * 形象页三态截图（独立探针，不依赖旧验证脚本的过时选择器）
 * 用法：node tools/rebuild/拍三态.mjs [URL]
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const OUT = resolve("D:\\平台\\voice-module", "shots", "xiaomu-rebuild");
const URL = process.argv[2] || "http://127.0.0.1:5199/xiaomu-rebuild.html";
const PROFILE = resolve("D:\\平台\\voice-module", "tmp-cdp-tristate");
const PORT = 9378;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exe = ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`].find((p) => existsSync(p));

rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const ch = spawn(exe, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  "--no-first-run", "--disable-extensions", "--hide-scrollbars", "--window-size=1000,1200", URL], { stdio: "ignore" });

try {
  let u = null;
  for (let i = 0; i < 40 && !u; i += 1) {
    await sleep(400);
    try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      u = l.find((t) => t.type === "page" && t.url.includes("5199"))?.webSocketDebuggerUrl ?? null; } catch { /* */ }
  }
  const ws = new WebSocket(u);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let id = 0; const w = new Map();
  ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (w.has(m.id)) { w.get(m.id)(m); w.delete(m.id); } });
  const send = (m, p = {}) => new Promise((res) => { const i = ++id; w.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  const ev = async (x) => {
    const r = await send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) return { __err: String(r.result.exceptionDetails.exception?.description ?? "").slice(0, 200) };
    return r.result?.result?.value;
  };
  await send("Page.enable"); await send("Runtime.enable");
  await sleep(2600);

  console.log("把手：" + JSON.stringify(await ev("({ hasCheck: !!window.__xiaomuCheck, hasClipplay: !!document.getElementById('clipplay'), stage: !!document.querySelector('.stage') })")));

  /* 点按钮切换（走真实用户路径，不直接调函数） */
  for (const st of ["idle", "talking", "thinking"]) {
    const clicked = await ev(`(() => { const b = document.querySelector('.state[data-state="${st}"]'); if (!b) return "no-button"; b.click(); return "clicked"; })()`);
    await sleep(1200);
    const info = await ev("(() => { const c = document.getElementById('clipplay'); const ball = document.getElementById('ball'); return { clipSrc: c && c.getAttribute('src'), clipShown: c && c.style.display !== 'none', ballHidden: ball && ball.style.visibility === 'hidden', tag: (document.getElementById('tagAvatar') || {}).textContent }; })()");
    const box = await ev("(() => { const r = document.querySelector('.stage').getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }; })()");
    const png = (await send("Page.captureScreenshot", { format: "png", clip: { ...box, scale: 1 } }))?.result?.data;
    if (png) writeFileSync(resolve(OUT, "三态-" + st + ".png"), Buffer.from(png, "base64"));
    console.log(`${st}: 点击=${clicked} → ${JSON.stringify(info)}`);
  }
  ws.close();
} catch (e) {
  console.error("失败：" + (e instanceof Error ? e.message : String(e)));
  process.exitCode = 1;
} finally {
  ch.kill();
  setImmediate(() => process.exit(process.exitCode ?? 0));
}
