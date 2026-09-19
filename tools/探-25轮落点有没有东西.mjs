/**
 * 探针：25 轮**逐轮落点有没有东西看**（用户 2026-10-01：「跳那啥都没有评委看什么」）
 *
 * 做法：一轮一轮按快捷键，等它念完（含思考），然后记下落点 hash、正文长度、
 * 可见的面板标题，以及页面上有没有"空态"字样。最后打一张表 —— 正文短 + 全是空态
 * 的那几行就是"跳过去没东西看"的嫌疑。
 *
 * 用法：node --import ./tools/test-resolve-ts.mjs tools/探-25轮落点有没有东西.mjs [--from 1] [--to 25]
 */
import { Machine, sleep } from "./browser-harness.mjs";

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const BASE = argOf("url", process.env.MUMAI_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");
const FROM = Number(argOf("from", "1"));
const TO = Number(argOf("to", "25"));
/** 每轮等多久再采样：听（1–2s）+ 思考（2.5–4s）+ 念完（长句 ~12s）+ 跳转 */
const WAIT = Number(argOf("wait", "17000"));

const EMPTY_MARKS = ["暂无", "没有作业记录", "从左侧选择一条证据", "还没有", "请选择", "未收到", "空态", "无数据", "不适用"];

const machine = new Machine({ name: "sweep", port: 9603, base: BASE, account: "shi" });

try {
  console.log(`25 轮落点体检 · ${BASE} · 第 ${FROM}–${TO} 轮`);
  await machine.start();
  if (!(await machine.login())) throw new Error("登录失败（shi）");
  await sleep(2000);

  const rows = [];
  for (let round = FROM; round <= TO; round += 1) {
    const segment = round <= 10 ? "b" : round <= 20 ? "y" : "m";
    /*
      ⚠ 段内数字是 1…9、**0 代表第 10 条**（`scriptShortcutSequence`）：第 10 轮 = Ctrl+B+0、
      第 20 轮 = Ctrl+Y+0。第一版按 `(n-1)%10+1` 算，第 10/20 轮发的是 "10"/"20" 这种
      不存在的键 —— 页面根本没跳，体检表上却记成"这两轮落在别处/内容少"（假数据）。
    */
    const digit = ((round - 1) % 10) === 9 ? "0" : String(((round - 1) % 10) + 1);
    await machine.evaluate(`(() => {
      const fire = (key) => window.dispatchEvent(new KeyboardEvent('keydown', { key, code: 'Key' + key.toUpperCase(), ctrlKey: true, bubbles: true, cancelable: true }));
      fire(${JSON.stringify(segment)});
      fire(${JSON.stringify(digit)});
      return true;
    })()`);
    await sleep(WAIT);
    const view = await machine.evaluate(`(() => {
      const text = (document.querySelector('main')?.innerText || document.body.innerText || '').replace(/\\s+/g, ' ').trim();
      const titles = [...document.querySelectorAll('.panel, section')]
        .filter((node) => node.offsetParent !== null)
        .map((node) => (node.querySelector('h1, h2, h3, h4, .panel__title, header')?.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 22))
        .filter(Boolean);
      return { hash: location.hash, len: text.length, text: text.slice(-260), titles: titles.slice(0, 5) };
    })()`);
    const marks = EMPTY_MARKS.filter((mark) => view.text.includes(mark));
    rows.push({ round, ...view, marks });
    console.log(
      `  ${String(round).padStart(2)} 轮 → ${view.hash.slice(0, 46).padEnd(46)} 正文 ${String(view.len).padStart(5)} 字` +
        (marks.length ? `　空态词：${marks.join("、")}` : ""),
    );
    if (view.titles.length) console.log(`        区块：${view.titles.join(" / ")}`);
  }

  console.log("\n正文最短的 6 轮（嫌疑最大）：");
  [...rows].sort((a, b) => a.len - b.len).slice(0, 6).forEach((row) => {
    console.log(`  ${row.round} 轮 · ${row.len} 字 · ${row.hash}`);
    console.log(`     尾部：${row.text.slice(-120)}`);
  });
} catch (error) {
  console.error(`探针异常：${error?.stack ?? error}`);
  process.exitCode = 1;
} finally {
  machine.kill();
}
