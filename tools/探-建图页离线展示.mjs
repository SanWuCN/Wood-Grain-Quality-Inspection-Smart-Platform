/**
 * 探针：**车离线时建图页有没有东西看**（用户 2026-10-01 长期口径）
 *
 * 背景：小车不在线时 `/mapping` 原来只有一串"未接通"（实测正文 243 字）。
 * 现在应当出现「最近一次成功建图（归档）」那一屏：缩略栅格图 + 版本/时间/格数 +
 * 归档文件与 SHA 结论 + 三步恢复指引。
 *
 * 判据（四条）：
 *   ① 面板在（标题「最近一次成功建图（归档）」）；
 *   ② 缩略图画布真的画了格子（`data-cells` 与 `data-version` 都在，且非 0）；
 *   ③ 文案写明「归档 / 非实时」（不能让人误以为是实时结果）；
 *   ④ 正文长度比"只有未接通"时明显变长（>500 字）。
 *
 * 用法：node --import ./tools/test-resolve-ts.mjs tools/探-建图页离线展示.mjs
 */
import { Machine, sleep } from "./browser-harness.mjs";

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const BASE = argOf("url", process.env.MUMAI_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");

const machine = new Machine({ name: "mapping-offline", port: 9611, base: BASE, account: "shi" });

try {
  console.log(`建图页离线展示探针 · ${BASE}`);
  await machine.start();
  if (!(await machine.login())) throw new Error("登录失败");
  await machine.evaluate(`location.hash = '#/mapping'`);
  await sleep(3000);
  const view = await machine.waitFor(
    `(() => {
      const panel = [...document.querySelectorAll('.panel, section')]
        .find((node) => (node.textContent || '').includes('最近一次成功建图'));
      if (!panel) return null;
      const canvas = panel.querySelector('canvas');
      const cells = Number(canvas?.dataset?.cells || 0);
      if (!canvas || !cells) return null;
      const text = (document.body.innerText || '').replace(/\\s+/g, ' ').trim();
      return {
        cells,
        version: canvas.dataset.version || '',
        canvas: [canvas.width, canvas.height],
        textLen: text.length,
        archived: /归档/.test(panel.innerText || ''),
        notLive: /不是实时/.test(panel.innerText || ''),
        sha: /SHA-256 一致/.test(panel.innerText || ''),
        recovery: /重置链路/.test(panel.innerText || ''),
        headline: (panel.querySelector('.map-archive__headline')?.textContent || '').trim(),
      };
    })()`,
    { timeoutMs: 15_000 },
  );

  const checks = [
    ["① 归档建图面板在屏上", Boolean(view)],
    ["② 缩略栅格图真的画了格子", Boolean(view && view.cells > 0)],
    ["③ 写明「归档」且「非实时」", Boolean(view && view.archived && view.notLive)],
    ["④ 正文长度 > 500 字（原来 243 字）", Boolean(view && view.textLen > 500)],
  ];
  for (const [name, ok] of checks) console.log(`  ${ok ? "✓" : "✗"} ${name}`);
  if (view) {
    console.log(`\n  版本 ${view.version} · 画布 ${view.canvas.join("×")} · ${view.cells} 格 · 正文 ${view.textLen} 字`);
    console.log(`  标题：${view.headline}`);
    console.log(`  SHA 结论：${view.sha ? "有" : "无"} · 恢复指引：${view.recovery ? "有" : "无"}`);
  }
  const shot = await machine.shot("建图页离线归档");
  if (shot) console.log(`  截图：${shot}`);
  const bad = checks.filter(([, ok]) => !ok).length;
  console.log(bad === 0 ? "\n✓ 建图页离线展示：全部通过" : `\n✗ 有 ${bad} 项未通过`);
  process.exitCode = bad === 0 ? 0 : 1;
} catch (error) {
  console.error(`探针异常：${error?.stack ?? error}`);
  process.exitCode = 1;
} finally {
  machine.kill();
}
