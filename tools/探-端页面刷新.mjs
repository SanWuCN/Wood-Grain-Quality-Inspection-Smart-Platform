/**
 * 探针：**端明细里的「在哪一页」是不是活的**（本轮同步读数的数据前提）
 *
 * 现象（`验收-多机同步` 里发现的）：两台浏览器明明已经跟到 `/firmware?tab=dataset`，
 * 端明细里却都写着 `#/` —— 若真如此，「本轮同步」这句读数就是拿旧数据在下结论。
 *
 * 做法：打开一台浏览器 → 登录 → 跳到 `/orders` → 每 5 秒读一次
 * `/api/sessions/<id>/peers` 里**自己这一端**的 page，最多 40 秒，看它什么时候变。
 *
 * 用法：node --import ./tools/test-resolve-ts.mjs tools/探-端页面刷新.mjs
 */
import { Machine, sleep } from "./browser-harness.mjs";

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const BASE = argOf("url", process.env.MUMAI_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");

const machine = new Machine({ name: "end-page", port: 9615, base: BASE, account: "shi" });

const readEnds = `(async () => {
  const token = localStorage.getItem('mumai.token') || '';
  const response = await fetch('/api/sessions/demo-01/peers', { headers: { authorization: 'Bearer ' + token } });
  const body = await response.json();
  return { hash: location.hash, ends: (body.ends || []).map((end) => ({ addr: end.address, acc: end.accountId, page: end.page, idleMs: end.idleMs })) };
})()`;

try {
  console.log(`端页面刷新探针 · ${BASE}`);
  await machine.start();
  if (!(await machine.login())) throw new Error("登录失败");
  await sleep(2000);

  /* 跳到工单页（带一个查询参数，好区分"只报了路径"与"报了整串 hash"） */
  await machine.evaluate(`location.hash = '#/orders?filter=assign'; 1`);
  const started = Date.now();
  let last = null;
  for (let i = 0; i < 9; i += 1) {
    const view = await machine.evaluate(readEnds);
    last = view;
    const mine = (view.ends || []).find((end) => /127\.|::1|::ffff:127/.test(String(end.addr))) ?? (view.ends || [])[0];
    console.log(`  +${String(Math.round((Date.now() - started) / 1000)).padStart(2)}s  end.page=${JSON.stringify(mine?.page)}  (idleMs=${mine?.idleMs})`);
    if (mine?.page && mine.page.includes("filter=assign")) {
      console.log(`\n✓ 端明细在 ${Math.round((Date.now() - started) / 1000)} 秒内跟上了当前页面（含查询串）`);
      break;
    }
    await sleep(5000);
  }
  if (!(last?.ends || []).some((end) => String(end.page ?? "").includes("filter=assign"))) {
    console.log("\n✗ 40 秒内端明细都没更新到当前页面 —— 「本轮同步」读数的数据前提不成立");
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`探针异常：${error?.stack ?? error}`);
  process.exitCode = 1;
} finally {
  machine.kill();
}
