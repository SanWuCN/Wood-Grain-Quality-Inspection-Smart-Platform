/**
 * 探：按一次快捷键之后，小木"多久听完、多久开口"（只打印，用来量"加快听的速度"的前后差）
 *
 * ── 为什么按 DOM 量、不去读 agent store ─────────────────────────────
 * `window.__mumaiAgent` **只在 dev 构建暴露**（`import.meta.env.DEV`），
 * 而 8000 发的是生产 `dist` —— 探针只能看用户真能看到的东西：
 *   · `听` = 气泡里那句触发语**逐字打全**（`.xd__user` 等于整句）；那是"听完了"；
 *   · `说` = 小木的回答出现在 `.xd__answer`（含思考 2.5–4s + 起播）。
 * 两个时刻相减就是"听"的耗时，也就是这次要加快的那一段。
 *
 * 用法：node --import ./tools/test-resolve-ts.mjs tools/探-快捷键响应时间.mjs [--url ...] [--rounds b:2,y:5,m:1]
 */
import { Machine, sleep } from "./browser-harness.mjs";

const ROOT = new URL("../", import.meta.url);
const { SCRIPT_SHORTCUT_ENTRIES } = await import(new URL("src/pages/MumaiDashboard/agent/scriptShortcutEntries.ts", ROOT).href);

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const BASE = argOf("url", process.env.MUMAI_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");
const KEYS = argOf("rounds", "b:2,y:5,m:1")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

const machine = new Machine({ name: "shortcut-timing", port: 9571, base: BASE, account: "shi" });
const results = [];

try {
  console.log(`快捷键响应时间 · ${BASE}`);
  await machine.start();
  if (!(await machine.login())) throw new Error("登录失败");
  await machine.evaluate(`location.hash = '#/'`);
  await sleep(1200);

  for (const key of KEYS) {
    const entry = SCRIPT_SHORTCUT_ENTRIES.find((item) => item.key === key);
    if (!entry) throw new Error(`条目表里没有 ${key}`);
    const [prefix, digit] = key.split(":");
    /* 清掉上一轮的气泡文本，免得拿旧文本判"听完了" */
    await machine.evaluate(`document.querySelectorAll('.xd__user, .xd__answer').forEach((n) => (n.textContent = '')); 1`);
    await sleep(150);

    const started = Date.now();
    await machine.evaluate(`(() => {
      const fire = (k) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k, code: 'Key' + k.toUpperCase(), ctrlKey: true, bubbles: true, cancelable: true }));
      fire(${JSON.stringify(prefix)}); fire(${JSON.stringify(digit)});
      return true;
    })()`);

    const HEARD = `(() => {
      const node = document.querySelector('.xd__user');
      const text = (node?.textContent || '').replace(/\\s+/g, '');
      return text === ${JSON.stringify(entry.text.replace(/\s+/g, ""))} ? Date.now() : null;
    })()`;
    const SPOKEN = `(() => ((document.querySelector('.xd__answer')?.textContent || '').trim().length > 6 ? Date.now() : null))()`;

    let heardMs = null;
    for (let i = 0; i < 300; i += 1) {
      const at = await machine.evaluate(HEARD);
      if (at) { heardMs = at - started; break; }
      await sleep(50);
    }
    let spokenMs = null;
    for (let i = 0; i < 400; i += 1) {
      const at = await machine.evaluate(SPOKEN);
      if (at) { spokenMs = at - started; break; }
      await sleep(50);
    }
    results.push({ key, label: entry.label, text: entry.text, heardMs, spokenMs });
    console.log(
      `  ${key.padEnd(4)} ${String(entry.label).slice(0, 22).padEnd(24)} 听完 ${heardMs === null ? "超时" : `${heardMs} ms`} · 开口 ${spokenMs === null ? "超时" : `${spokenMs} ms`}`,
    );
    /* 等这一轮播完再按下一键，否则会排在队列里 */
    await sleep(9000);
  }

  const ok = results.filter((item) => item.heardMs !== null);
  if (ok.length) {
    const avg = Math.round(ok.reduce((sum, item) => sum + item.heardMs, 0) / ok.length);
    console.log(`\n"听"的平均耗时：${avg} ms（${ok.length} 条样本）`);
  }
} catch (error) {
  console.error(`探针异常：${error?.message ?? error}`);
  process.exitCode = 1;
} finally {
  machine.kill();
}

