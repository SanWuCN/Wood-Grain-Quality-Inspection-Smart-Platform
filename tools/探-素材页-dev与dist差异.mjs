/**
 * 探：素材质检页（⑩）在 5173（dev）与 8000（dist）上到底差了什么（只打印）
 *
 * 背景：验收-小木带路 在同一台机器上跑，8000 全绿、5173 稳定红两条
 * （「需重看的画面」「切片检查」与「预置结果」）。要看清是**渲染差异**还是**取数时序**。
 */
import { Machine, sleep } from "./browser-harness.mjs";

const KEYS = ["需重看的画面", "切片检查", "切片与重建前检查", "预置结果", "缺失文件", "关键帧"];

for (const [name, base] of [["5173 dev", "http://127.0.0.1:5173"], ["8000 dist", "http://127.0.0.1:8000"]]) {
  const machine = new Machine({ name: `materials-${name.split(" ")[0]}`, port: name.startsWith("5173") ? 9573 : 9574, base, account: "shi" });
  try {
    await machine.start();
    if (!(await machine.login())) throw new Error("登录失败");
    await machine.evaluate(`location.hash = '#/materials'`);
    /* dev 首次加载要拉一堆模块：给它足够时间，再连续采样看是不是"晚到" */
    for (const wait of [1500, 4000, 8000]) {
      await sleep(wait === 1500 ? 1500 : 2500);
      const state = await machine.evaluate(`(() => {
        const text = document.body.innerText || '';
        const panels = [...document.querySelectorAll('.panel__title, .panel h3, h3')].map((n) => (n.textContent || '').trim()).slice(0, 12);
        const hits = ${JSON.stringify(KEYS)}.filter((k) => text.includes(k));
        return { len: text.length, hits, panels };
      })()`);
      console.log(`${name} @${wait}ms：正文 ${state.len} 字 · 命中 [${state.hits.join(" / ")}]`);
      if (wait === 8000) console.log(`${name} 面板标题：${state.panels.join(" | ")}`);
    }
  } catch (error) {
    console.error(`${name} 异常：${error?.message ?? error}`);
  } finally {
    machine.kill();
  }
}
