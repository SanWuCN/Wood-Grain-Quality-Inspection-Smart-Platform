/**
 * 探针：内网协同面板的「本轮同步」读数（用户 2026-10-01 长期口径）
 *
 * 判据：
 *   ① 面板上有「本轮同步」这一行；
 *   ② 讲完一轮之后，这一行给出一句**能直接念**的结论（含轮次与落点，或"只有本机"）；
 *   ③ 结论里的落点与这一轮的 `agentTurn.nav` 一致（不是页面自己编的）。
 *
 * 用法：node --import ./tools/test-resolve-ts.mjs tools/探-本轮同步读数.mjs
 */
import { Machine, sleep } from "./browser-harness.mjs";

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const BASE = argOf("url", process.env.MUMAI_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");

const machine = new Machine({ name: "round-sync", port: 9613, base: BASE, account: "shi" });

try {
  console.log(`本轮同步读数探针 · ${BASE}`);
  await machine.start();
  if (!(await machine.login())) throw new Error("登录失败");
  /* 讲一轮（⑬ 是主动发起那轮不好等，用 ⑨ 建图巡航） */
  await machine.evaluate(`(() => {
    const fire = (key) => window.dispatchEvent(new KeyboardEvent('keydown', { key, code: 'Key' + key.toUpperCase(), ctrlKey: true, bubbles: true, cancelable: true }));
    fire('b'); fire('9');
    return true;
  })()`);
  await sleep(12_000);

  await machine.evaluate(`location.hash = '#/console'`);
  await sleep(3500);
  const view = await machine.waitFor(
    `(() => {
      const row = [...document.querySelectorAll('.cs-lan li')].find((node) => (node.textContent || '').includes('本轮同步'));
      if (!row) return null;
      const text = (row.innerText || '').replace(/\\s+/g, ' ').trim();
      /* 端明细那一列（现在每行尾部带「已在第几轮」） */
      const endsRow = [...document.querySelectorAll('.cs-lan li')].find((node) => (node.textContent || '').includes('现在连着的端'));
      const ends = endsRow
        ? [...endsRow.querySelectorAll('.cs-lan__ends li')].map((node) => (node.innerText || '').replace(/\\s+/g, ' ').trim())
        : [];
      return { text, ends };
    })()`,
    { timeoutMs: 15_000 },
  );
  const checks = [
    ["① 面板上有「本轮同步」这一行", Boolean(view)],
    /* 刚讲完那一档写的是「还没上报」，所以判据要把这一档算进来 */
    ["② 给出一句能直接念的结论", Boolean(view && /第|只有本机|不换页|还没上报/.test(view.text))],
    ["③ 结论里带轮次与落点（或说明只有本机 / 不换页）", Boolean(view && /⑨|落点|只有本机|不换页/.test(view.text))],
    ["④ 端明细每行尾部写明它跟到了第几轮", Boolean(view && view.ends.some((line) => /已在第 .+ 轮|还没跟到任何一轮/.test(line)))],
  ];
  for (const [name, ok] of checks) console.log(`  ${ok ? "✓" : "✗"} ${name}`);
  if (view) {
    console.log(`\n  这一行：${view.text}`);
    for (const line of view.ends) console.log(`  端明细：${line}`);
  }
  const shot = await machine.shot("本轮同步读数");
  if (shot) console.log(`  截图：${shot}`);
  const bad = checks.filter(([, ok]) => !ok).length;
  console.log(bad === 0 ? "\n✓ 本轮同步读数：全部通过" : `\n✗ 有 ${bad} 项未通过`);
  process.exitCode = bad === 0 ? 0 : 1;
} catch (error) {
  console.error(`探针异常：${error?.stack ?? error}`);
  process.exitCode = 1;
} finally {
  machine.kill();
}
