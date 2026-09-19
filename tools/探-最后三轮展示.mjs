/**
 * 探针：剧本最后三轮（㉓㉔㉕）在工单详情页上**逐块出现**的过程
 *
 * 用户口径 2026-10-01：「平台最后几个对话需要更好的平台展示，而不只是跳转下页面」。
 * 这条探针每轮按一次快捷键，然后每 400ms 采样一次"哪几块看得见"，
 * 把"念到哪、亮到哪"记下来（人工核对 + 出图）。
 *
 * 用法：node --import ./tools/test-resolve-ts.mjs tools/探-最后三轮展示.mjs
 */
import { Machine, sleep } from "./browser-harness.mjs";

const BASE = (process.argv.includes("--url") ? process.argv[process.argv.indexOf("--url") + 1] : "http://127.0.0.1:8000").replace(/\/$/, "");
const machine = new Machine({ name: "deliv", port: 9599, base: BASE, account: "shi" });

/** 快捷键：21–25 段是 Ctrl+M+1…5 → ㉓ = M+3 */
const ROUNDS = [
  { key: "m", digit: "3", label: "㉓" },
  { key: "m", digit: "4", label: "㉔" },
  { key: "m", digit: "5", label: "㉕" },
];

const PROBE = `(() => {
  if (!window.__deliv) {
    window.__deliv = [];
    const sample = () => {
      const panels = [...document.querySelectorAll('.deliv')].map((list) => {
        const panel = list.closest('.wop-reveal');
        const visible = panel ? panel.offsetParent !== null : false;
        const blocks = [...list.querySelectorAll('.deliv__block')].map((block) => ({
          title: (block.querySelector('dt')?.textContent || '').trim(),
          visible: block.offsetParent !== null,
        }));
        return { visible, blocks };
      });
      const panelTitles = [...document.querySelectorAll('.wop-reveal')]
        .filter((node) => node.offsetParent !== null && node.querySelector('.deliv'))
        .map((node) => (node.querySelector('h3, .panel__title, header')?.textContent || '').trim().slice(0, 24));
      window.__deliv.push({ t: Date.now(), panels, panelTitles });
    };
    window.__delivTimer = setInterval(sample, 400);
    sample();
  }
  return true;
})()`;

try {
  console.log(`最后三轮展示探针 · ${BASE}`);
  await machine.start();
  if (!(await machine.login())) throw new Error("登录失败（shi）");

  for (const round of ROUNDS) {
    /* 每轮前重载一次：揭示计划挂在页面内存里，刷新才是"干净的一轮" */
    await machine.evaluate(`location.hash = '#/orders'`);
    await sleep(1500);
    await machine.evaluate(`location.reload()`);
    await sleep(3000);
    await machine.waitFor(`Boolean(document.querySelector('.wop-actions'))`, { timeoutMs: 15_000 });
    await machine.evaluate(PROBE);
    await machine.evaluate(`(() => {
      const fire = (key) => window.dispatchEvent(new KeyboardEvent('keydown', { key, code: 'Key' + key.toUpperCase(), ctrlKey: true, bubbles: true, cancelable: true }));
      fire(${JSON.stringify(round.key)});
      fire(${JSON.stringify(round.digit)});
      return true;
    })()`);
    /*
      等两个时刻再截图，别用固定秒数（说多长取决于台词与思考时间）：
        ① 「聚焦」= 生成物面板只剩这一轮那一块（说明揭示计划已登记、别的两份已收起）
        ② 「全亮」= 那一块的子块全出现
    */
    const panelsVisible = `[...document.querySelectorAll('.deliv')].filter((list) => list.closest('.wop-reveal')?.offsetParent !== null).length`;
    await machine.waitFor(`(() => { const n = ${panelsVisible}; return n === 1 ? true : null; })()`, {
      timeoutMs: 25_000,
    });
    await sleep(900);
    const focused = await machine.shot(`最后三轮-${round.label}-聚焦`);
    const blocks = `(() => {
      const list = [...document.querySelectorAll('.deliv')].find((item) => item.closest('.wop-reveal')?.offsetParent !== null);
      if (!list) return null;
      const all = [...list.querySelectorAll('.deliv__block')];
      const shown = all.filter((block) => block.offsetParent !== null);
      return shown.length === all.length ? shown.length : null;
    })()`;
    await machine.waitFor(blocks, { timeoutMs: 20_000 });
    const late = await machine.shot(`最后三轮-${round.label}-全亮`);
    const timeline = await machine.evaluate(`(() => {
      clearInterval(window.__delivTimer);
      const samples = window.__deliv || [];
      window.__deliv = null;
      /* 压缩成"可见块数变化"的时间线 */
      const lines = [];
      let last = '';
      for (const item of samples) {
        const active = item.panels.filter((p) => p.visible);
        const signature = active.map((p) => p.blocks.filter((b) => b.visible).map((b) => b.title).join('+')).join(' | ');
        if (signature !== last) {
          lines.push(signature || '（还没有生成物面板）');
          last = signature;
        }
      }
      return lines;
    })()`);
    console.log(`── ${round.label} 可见块变化（每行 = 一次变化）`);
    (timeline ?? []).forEach((line) => console.log(`     ${line}`));
    console.log(`     截图：${focused} / ${late}`);
  }
} catch (error) {
  console.error(`探针异常：${error?.stack ?? error}`);
  process.exitCode = 1;
} finally {
  machine.kill();
}
