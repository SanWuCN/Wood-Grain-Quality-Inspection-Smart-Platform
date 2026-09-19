/**
 * 探针：**同一台机器开两个浏览器端**，看「同步实测 × 本轮同步」怎么把
 * 「收不到」与「没跟上」分开说（用户 2026-10-01 长期口径下的排查口径）
 *
 * 做法（两台真浏览器，同一台服务器；与 `验收-多机同步` 同一套起法）：
 *   ① 两台都登录、都连上 → A 的端明细里应当有 2 台端；
 *   ② A 讲一轮 → B 跟上 → A 的「本轮同步」应当报"都在这一轮的页面上"；
 *   ③ 在 A 上开一次同步实测 → 若 B 在时限内回执，判据是**不插话**（实测通过就没什么可补充的）；
 *      若 B 没回执，则那句话必须落在「更像是推送/连接没到（不是没跟上）」这一档。
 *
 * ⚠ 这一条是**探针**不是验收：回执快慢取决于本机负载，两种结果都算通过，
 * 关键是把面板上那句话原样打出来供人工核对（措辞错了两台机器读起来会误导人）。
 *
 * 用法：node --import ./tools/test-resolve-ts.mjs tools/探-实测与跟页.mjs
 */
import { Machine, sleep } from "./browser-harness.mjs";

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const BASE = argOf("url", process.env.MUMAI_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");

const A = new Machine({ name: "hint-a", port: 9617, base: BASE, account: "shi" });
const B = new Machine({ name: "hint-b", port: 9618, base: BASE, account: "shen" });

const ROW = (label) => `(() => {
  const row = [...document.querySelectorAll('.cs-lan li')].find((node) => (node.textContent || '').includes(${JSON.stringify(label)}));
  return row ? (row.innerText || '').replace(/\\s+/g, ' ').trim() : null;
})()`;

try {
  console.log(`实测 × 跟页 探针 · ${BASE}`);
  await A.start();
  await B.start();
  if (!(await A.login())) throw new Error("A 登录失败（shi）");
  if (!(await B.login())) throw new Error("B 登录失败（shen）");
  await sleep(2500);

  /* ① A 讲一轮（⑨ 建图巡航），B 跟随 */
  await A.evaluate(`(() => {
    const fire = (key) => window.dispatchEvent(new KeyboardEvent('keydown', { key, code: 'Key' + key.toUpperCase(), ctrlKey: true, bubbles: true, cancelable: true }));
    fire('b'); fire('9');
    return true;
  })()`);
  await sleep(12_000);
  const bHash = await B.evaluate(`location.hash`);
  console.log(`  B 跟到的页面：${bHash}`);

  /* ② 打开 A 的排练控制台，读「本轮同步」 */
  await A.evaluate(`location.hash = '#/console'; 1`);
  await sleep(3000);
  const syncRow = await A.waitFor(ROW("本轮同步"), { timeoutMs: 15_000 });
  console.log(`  本轮同步：${syncRow ?? "（没读到）"}`);

  /* ③ 在 A 上开一次同步实测（点按钮），然后读「同步实测」那一行 */
  const clicked = await A.evaluate(`(() => {
    const row = [...document.querySelectorAll('.cs-lan li')].find((node) => (node.textContent || '').includes('同步实测'));
    const button = row && [...row.querySelectorAll('button')].find((node) => (node.textContent || '').includes('开一次实测'));
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`);
  console.log(`  开了同步实测：${clicked}`);
  const probeRow = await A.waitFor(ROW("同步实测"), { timeoutMs: 20_000 });
  await sleep(9000);
  const probeRowFinal = await A.evaluate(ROW("同步实测"));
  console.log(`  同步实测（刚点完）：${probeRow ?? "（没读到）"}`);
  console.log(`  同步实测（9 秒后）：${probeRowFinal ?? "（没读到）"}`);

  const checks = [
    ["① 两台端都连上（本轮同步读到端数）", Boolean(syncRow && /台端|只有本机/.test(syncRow))],
    ["② 同步实测那一行给得出结论", Boolean(probeRowFinal && /可见|收到|没在听|等端回执/.test(probeRowFinal))],
    [
      "③ 没回执时必须说清是「推送/连接没到」还是「没跟上」",
      Boolean(
        !probeRowFinal ||
          /可见 \d+\/\d+/.test(probeRowFinal) ||
          /更像是推送\/连接没到|先让它跟页|没在听/.test(probeRowFinal),
      ),
    ],
  ];
  for (const [name, ok] of checks) console.log(`  ${ok ? "✓" : "✗"} ${name}`);
  const shot = await A.shot("实测与跟页");
  if (shot) console.log(`  截图：${shot}`);
  const bad = checks.filter(([, ok]) => !ok).length;
  console.log(bad === 0 ? "\n✓ 实测 × 跟页：全部通过" : `\n✗ 有 ${bad} 项未通过`);
  process.exitCode = bad === 0 ? 0 : 1;
} catch (error) {
  console.error(`探针异常：${error?.stack ?? error}`);
  process.exitCode = 1;
} finally {
  B.kill();
  A.kill();
}
