/**
 * 探针：按某一轮的快捷键，看**屏幕上到底有什么**（落点页 + 可见内容）
 *
 * 用法：
 *   node --import ./tools/test-resolve-ts.mjs tools/探-某一轮落点.mjs --round 1
 *   … --round 23 --wait 12000        等更久再截图（默认 9 秒）
 *
 * 打印：hash、页面标题、可见面板/区块标题、正文前若干字（用来判断"空不空"）。
 */
import { Machine, sleep } from "./browser-harness.mjs";

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const BASE = argOf("url", process.env.MUMAI_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");
const ROUND = Number(argOf("round", "1"));
const WAIT = Number(argOf("wait", "9000"));

const machine = new Machine({ name: `r${ROUND}`, port: 9601, base: BASE, account: "shi" });

try {
  await machine.start();
  if (!(await machine.login())) throw new Error("登录失败（shi）");
  await sleep(1500);
  await machine.evaluate(`(() => {
    const segment = ${ROUND} <= 10 ? 'b' : ${ROUND} <= 20 ? 'y' : 'm';
    /* 段内数字 1…9、**0 代表第 10 条**：第 10 轮 = Ctrl+B+0、第 20 轮 = Ctrl+Y+0 */
    const digit = (${ROUND} - 1) % 10 === 9 ? '0' : String((${ROUND} - 1) % 10 + 1);
    const fire = (key) => window.dispatchEvent(new KeyboardEvent('keydown', { key, code: 'Key' + key.toUpperCase(), ctrlKey: true, bubbles: true, cancelable: true }));
    fire(segment);
    fire(digit);
    return true;
  })()`);
  await sleep(WAIT);
  const view = await machine.evaluate(`(() => {
    const visible = (node) => node && node.offsetParent !== null;
    const titles = [...document.querySelectorAll('.panel, .kb-panel, section')]
      .filter((node) => visible(node))
      .map((node) => {
        const head = node.querySelector('h1, h2, h3, h4, .panel__title, header');
        return head ? (head.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40) : '';
      })
      .filter(Boolean);
    const body = (document.querySelector('main')?.innerText || document.body.innerText || '').replace(/\\s+/g, ' ').trim();
    const inputs = [...document.querySelectorAll('input')].filter((node) => visible(node))
      .map((node) => ({ placeholder: node.getAttribute('placeholder') || '', value: node.value }));
    return { hash: location.hash, titles: titles.slice(0, 14), inputs, bodyHead: body.slice(0, 400), bodyLen: body.length };
  })()`);
  console.log(`第 ${ROUND} 轮落点：${view.hash}`);
  console.log("可见区块：");
  view.titles.forEach((t) => console.log(`   · ${t}`));
  if (view.inputs.length) console.log("输入框：", JSON.stringify(view.inputs));
  console.log(`正文长度 ${view.bodyLen}；正文开头：\n   ${view.bodyHead}`);
  const shot = await machine.shot(`落点-第${ROUND}轮`);
  console.log(`截图：${shot}`);
} catch (error) {
  console.error(`探针异常：${error?.stack ?? error}`);
  process.exitCode = 1;
} finally {
  machine.kill();
}
