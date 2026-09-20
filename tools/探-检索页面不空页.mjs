/**
 * 探针：知识库检索页**在任何时刻都不是空白**（用户 2026-10-02：
 * 「这个对话，页面保持检索中没东西就没意思了」——截图里页面停在「检索中…」、什么都没有）。
 *
 * 做法：先打开检索页（不带 q），手动填入 ① 的那一问并点「检索」，
 * 然后**每 60 毫秒**采样一次，直到结果出现；期间记录是否看到过「正在检索」这块面板。
 * 判据：① 采样期间页面**始终**有内容（要么「正在检索」、要么「检索结果」）；② 最终出结果。
 *
 * 用法：node --import ./tools/test-resolve-ts.mjs tools/探-检索页面不空页.mjs
 */
import { Machine, sleep } from "./browser-harness.mjs";

const BASE = (process.env.MUMAI_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");
const m = new Machine({ name: "probe-kb2", port: 9625, base: BASE, account: "shi" });

try {
  await m.start();
  if (!(await m.login())) throw new Error("登录失败");
  /* 先把查询页打开（不带 q），再手动敲问句并提交 —— 这样能第一时间抓"检索中"那一帧 */
  await m.evaluate(`location.hash = '#/knowledge?tab=search'`);
  await sleep(2500);
  const fired = await m.evaluate(`(() => {
    const input = document.querySelector('.kb-input--search');
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '风险点处置记录');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const form = input.closest('.kb-search-bar');
    const button = form ? [...form.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '检索') : null;
    if (button) { button.click(); return true; }
    return 'no-button';
  })()`);
  let sawLoading = false;
  let loadingText = "";
  for (let i = 0; i < 120; i += 1) {
    const probe = await m.evaluate(`(() => {
      const text = (document.body.innerText || '').replace(/\\s+/g, ' ');
      const at = text.indexOf('正在检索');
      return { loading: at >= 0, snippet: at >= 0 ? text.slice(at, at + 70) : '', done: /条证据/.test(text) };
    })()`);
    if (probe.loading) {
      sawLoading = true;
      loadingText = probe.snippet;
    }
    if (probe.done) break;
    await sleep(60);
  }
  const final = await m.evaluate(`(() => {
    const text = (document.body.innerText || '').replace(/\\s+/g, ' ');
    const at = text.indexOf('检索结果');
    return { hasResult: at >= 0, snippet: at >= 0 ? text.slice(at, at + 60) : text.slice(0, 120) };
  })()`);
  console.log(JSON.stringify({ fired, sawLoading, loadingText, final }, null, 1));
} catch (error) {
  console.error(String(error?.stack ?? error));
} finally {
  m.kill();
}
