/**
 * 探针：把小木气泡截一张图（改动前后各拍一张，人工看图用）
 *
 * 用法：node --import ./tools/test-resolve-ts.mjs tools/探-小木气泡截图.mjs [--name 气泡-改前]
 */
import { Machine, sleep } from "./browser-harness.mjs";

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const BASE = argOf("url", process.env.MUMAI_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");
const NAME = argOf("name", "小木气泡");

const machine = new Machine({ name: "dock-shot", port: 9597, base: BASE, account: "shi" });

try {
  await machine.start();
  if (!(await machine.login())) throw new Error("登录失败");
  await machine.evaluate(`location.hash = '#/orders'`);
  await sleep(1500);
  /* 气泡没展开就按 Alt+E 展开（与现场同一条快捷键） */
  const opened = await machine.evaluate(`(() => {
    if (document.querySelector('.xd__panel')) return 'already';
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', altKey: true, bubbles: true, cancelable: true }));
    return 'dispatched';
  })()`);
  await sleep(1200);
  /* 可按一轮快捷键，让气泡里有真回复（+note）—— 那是"投影时观众看到的样子" */
  const round = argOf("round", "");
  if (round) {
    await machine.evaluate(`(() => {
      const segment = Number(${JSON.stringify(round)}) <= 10 ? 'b' : Number(${JSON.stringify(round)}) <= 20 ? 'y' : 'm';
      const number = String((Number(${JSON.stringify(round)}) - 1) % 10 + 1);
      const fire = (key) => window.dispatchEvent(new KeyboardEvent('keydown', { key, code: 'Key' + key.toUpperCase(), ctrlKey: true, bubbles: true, cancelable: true }));
      fire(segment);
      fire(number);
      return true;
    })()`);
    await sleep(6000);
  }
  const shape = await machine.evaluate(`(() => {
    const panel = document.querySelector('.xd__panel');
    if (!panel) return null;
    const rect = panel.getBoundingClientRect();
    return {
      opened: ${JSON.stringify(opened)},
      box: [Math.round(rect.width), Math.round(rect.height)],
      foldText: [...panel.querySelectorAll('.xd__fold-btn')].map((node) => (node.textContent || '').trim()),
      keysRows: panel.querySelectorAll('.xd__keys li').length,
      hintToggle: (panel.querySelector('.xd__hint-toggle')?.textContent || '').trim() || null,
    };
  })()`);
  console.log("气泡：", JSON.stringify(shape));
  const shot = await machine.shot(NAME);
  console.log(`截图：${shot}`);
} catch (error) {
  console.error(`探针异常：${error?.stack ?? error}`);
  process.exitCode = 1;
} finally {
  machine.kill();
}
