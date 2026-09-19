/**
 * 探针：**已经在数字孪生页时，再触发一轮对话会不会把它整屏重新加载**
 * （用户 2026-10-01：「正常已经到数字孪生页面展示了，触发对话原地跳转一下反而导致数字孪生重新加载」）
 *
 * 判据（三条，任一命中就是"重新加载了"）：
 *   ① 加载浮层「正在加载重建产物」再次出现；
 *   ② 模型文件（`.sog`）被再下载一次（`performance.getEntriesByType('resource')` 计数增加）；
 *   ③ 画布被换掉（canvas 元素引用变化 / 宽高从 0 重新长出来）。
 *
 * 用法：
 *   node --import ./tools/test-resolve-ts.mjs tools/探-孪生重复导航.mjs            # 已在孪生页再触发 ⑪
 *   … --round 11 --pre twin        # 先停在孪生页
 *   … --pre blank                  # 先停在别的页，作为对照
 */
import { Machine, sleep } from "./browser-harness.mjs";

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const BASE = argOf("url", process.env.MUMAI_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");
const ROUND = Number(argOf("round", "11"));
const PRE = argOf("pre", "twin");

const machine = new Machine({ name: "twin-reload", port: 9609, base: BASE, account: "shi" });

/**
 * 记录"当前这一屏的状态"：模型下载次数、加载浮层、画布尺寸
 *
 * ⚠ `performance.getEntriesByType('resource')` 默认只留 **250 条**：这一页加载的资源
 * 正好把这个缓冲塞满（实测 assets=250），模型那条会被挤掉 —— 于是"模型有没有被再下载"
 * 永远读到 0，看着像"从没加载过"（假绿）。所以启动时先 `setResourceTimingBufferSize`，
 * 触发前再 `clearResourceTimings()` 把计数清零。
 */
const SNAPSHOT = `(() => {
  const resources = performance.getEntriesByType('resource').map((item) => item.name);
  const overlay = document.body.innerText.includes('正在加载重建产物');
  const canvas = document.querySelector('.twin-stage canvas');
  const loading = document.querySelector('.splat-stage__load');
  return {
    sog: resources.filter((url) => url.includes('.sog')).length,
    assets: resources.length,
    overlay,
    loading: Boolean(loading),
    canvas: canvas ? [canvas.width, canvas.height] : null,
    hash: location.hash,
  };
})()`;

try {
  await machine.start();
  if (!(await machine.login())) throw new Error("登录失败");
  await machine.evaluate(`performance.setResourceTimingBufferSize?.(2000); 1`);
  /* 起始页：`twin` = `#/twin`；`twin-comp` = `#/twin?component=Z04`（⑪ 之后的状态）；其余按给定路径 */
  const startHash = PRE === "twin" ? "#/twin" : PRE === "twin-comp" ? "#/twin?component=Z04" : `#/${PRE === "blank" ? "orders" : PRE}`;
  await machine.evaluate(`location.hash = ${JSON.stringify(startHash)}`);
  await machine.waitFor(`Boolean(document.querySelector('.page--twin, .orders-page, .page--orders'))`, { timeoutMs: 15_000 });
  /* 等模型真的加载完（打关键帧按钮可用 = 画面已出画） */
  await machine.waitFor(`(() => {
    const button = [...document.querySelectorAll('button')].find((node) => (node.textContent || '').includes('打关键帧'));
    return button && !button.disabled ? true : null;
  })()`, { timeoutMs: 40_000 });
  await sleep(1500);
  /* 清零资源计数：之后只要再出现一条 .sog，就说明模型被重新下载了 */
  await machine.evaluate(`performance.clearResourceTimings(); 1`);
  await sleep(300);
  const before = await machine.evaluate(SNAPSHOT);
  console.log("触发前：", JSON.stringify(before));

  const segment = ROUND <= 10 ? "b" : ROUND <= 20 ? "y" : "m";
  const digit = (ROUND - 1) % 10 === 9 ? "0" : String(((ROUND - 1) % 10) + 1);
  await machine.evaluate(`(() => {
    const fire = (key) => window.dispatchEvent(new KeyboardEvent('keydown', { key, code: 'Key' + key.toUpperCase(), ctrlKey: true, bubbles: true, cancelable: true }));
    fire(${JSON.stringify(segment)});
    fire(${JSON.stringify(digit)});
    return true;
  })()`);

  /* 触发后 20 秒里，每 300ms 采样一次：只要出现过加载浮层 / sog 计数变多 就算重新加载 */
  let peakSog = before.sog;
  let sawOverlay = false;
  let canvasChanged = false;
  for (let i = 0; i < 70; i += 1) {
    await sleep(300);
    const now = await machine.evaluate(SNAPSHOT);
    peakSog = Math.max(peakSog, now.sog);
    if (!before.overlay && now.overlay) sawOverlay = true;
    if (before.canvas && now.canvas && (now.canvas[0] === 0 || now.canvas[1] === 0)) canvasChanged = true;
  }
  const after = await machine.evaluate(SNAPSHOT);
  console.log("触发后：", JSON.stringify(after));
  console.log("");
  console.log(`① 加载浮层再次出现：${sawOverlay ? "是 ❌" : "否 ✅"}`);
  console.log(`② 模型被再下载：${peakSog > before.sog ? `是 ❌（${before.sog} → ${peakSog}）` : `否 ✅（${before.sog}）`}`);
  console.log(`③ 画布被换掉（尺寸归零）：${canvasChanged ? "是 ❌" : "否 ✅"}`);
  console.log(`   落点：${before.hash} → ${after.hash}`);
} catch (error) {
  console.error(`探针异常：${error?.stack ?? error}`);
  process.exitCode = 1;
} finally {
  machine.kill();
}
