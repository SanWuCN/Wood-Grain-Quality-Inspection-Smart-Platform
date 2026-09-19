/**
 * 验收：数字孪生的**内部点云**（用户 2026-09-30 追加的一项）
 *
 * ── 这条工装回答的问题 ──────────────────────────────────────────────
 *   ① 数字孪生页上**有没有这一项**（主视图切换里那个「内部点云」页签），
 *      且它**没被画布盖住**、用真鼠标点得动（`element.click()` 不算数，见下）；
 *   ② 点进去**真的画出了点**（不是一块黑画布）—— 判据是渲染器自己报的
 *      `gl.info.render.points`（写在同一块 DOM 的 `data-points` 上），
 *      随便写个数字骗不过去：它是 WebGL 这一帧真正提交的点数；
 *   ③ 三类缺陷与**来源**都在屏上（虫蛀 / 内部裂痕 / 缺损，每条带编号或档案出处）；
 *   ④ 口径那行字在（"按外形与档案记录生成、不是实测点云"）；
 *   ⑤ 健康构件**没有被编缺陷**（Z01/Z02 显示"无内部缺陷记录"）；
 *   ⑥ 「只看某一根」点得动，且**真的少画了三根**（点数跟着掉）；
 *   ⑦ 「只看破损」把木料整层收掉（点数掉到一成上下），切回「木料全显」又涨回来。
 *
 * 用法（仓库根目录）：
 *   node --import ./tools/test-resolve-ts.mjs tools/验收-内部点云.mjs
 *   … --url http://127.0.0.1:5173      在内网 / dev 入口上再跑一遍
 */

import { Machine, sleep } from "./browser-harness.mjs";

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const BASE = argOf("url", process.env.MUMAI_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? `　（${detail}）` : ""}`);
  if (!ok) failed += 1;
};

const machine = new Machine({ name: "ipc", port: 9577, base: BASE, account: "shi" });

try {
  console.log(`内部点云验收 · ${BASE}`);
  await machine.start();
  if (!(await machine.login())) throw new Error(`登录失败（shi）—— 页面在 ${BASE} 上吗？`);
  await machine.evaluate(`location.hash = '#/twin'`);
  await machine.waitFor(`Boolean(document.querySelector('.page--twin'))`, { timeoutMs: 12_000 });
  await sleep(800);

  /* ---------- ① 主视图里有没有这一项 ---------- */
  const tabs = await machine.waitFor(
    `(() => {
      const list = [...document.querySelectorAll('.twin-view__tab')].map((node) => (node.textContent || '').trim());
      return list.length ? list : null;
    })()`,
    { timeoutMs: 8000 },
  );
  check(
    `主视图切换里有「内部点云」这一项`,
    Array.isArray(tabs) && tabs.some((text) => text.includes("内部点云")),
    (tabs ?? []).join(" / "),
  );

  /* ---------- ② 点进去，等渲染器报点数 ---------- */
  /*
    ⚠ 用**命中测试点法**（`machine.clickHitTest`），不是页面里的 `tab.click()`：
      `element.click()` 不看层级 —— 页签被画布盖住时它照样"点得动"，人却点不着。
      这个坑真发生过（用户 2026-10-01 问"3D 点云图去哪儿查看"）：页签原本在 `.twin-stage`
      里，被 `position:absolute; inset:0` 的 `.twin-view` 整个压住，脚本全绿、人找不到入口。
      所以先查"页签中心点上最顶层的是不是它自己"，再在那个**命中到的元素**上点一下。
  */
  const tab = await machine.evaluate(`(() => {
    const node = [...document.querySelectorAll('.twin-view__tab')].find((item) => (item.textContent || '').includes('内部点云'));
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    const top = document.elementFromPoint(cx, cy);
    return { width: rect.width, height: rect.height, covered: !(top && node.contains(top)), topClass: top ? String(top.className || top.tagName) : null };
  })()`);
  check(
    `「内部点云」页签在画布之上（人点得着，不是被盖住）`,
    Boolean(tab) && tab.covered === false,
    tab ? `中心点上最顶层=${tab.topClass}${tab.covered ? "（被盖住了！）" : ""}` : "没找到页签",
  );
  const hit = await machine.clickHitTest(".twin-view__tab", { contains: "内部点云" });
  check(
    `点下去命中的就是这个页签（不是画布）`,
    Boolean(hit?.ok) && hit.hitSelf === true,
    hit?.ok ? `命中=${hit.topClass}${hit.hitSelf ? "" : "（点到的是别的东西）"}` : (hit?.reason ?? "点击失败"),
  );
  const tabOpened = await machine.waitFor(
    `(() => { const stage = document.querySelector('.ipc__stage'); return stage ? true : null; })()`,
    { timeoutMs: 10_000 },
  );
  check("点完真的切到内部点云", tabOpened === true, tabOpened === true ? "" : "10 秒内没切过去");

  const drawn = await machine.waitFor(
    `(() => {
      const stage = document.querySelector('.ipc__stage');
      if (!stage) return null;
      const points = Number(stage.getAttribute('data-points') || 0);
      const canvas = stage.querySelector('canvas');
      return points > 0 && canvas && canvas.width > 100 ? { points, width: canvas.width, height: canvas.height } : null;
    })()`,
    { timeoutMs: 25_000 },
  );
  check(
    `画布真的画出了点（渲染器自报点数）`,
    Boolean(drawn && drawn.points > 10_000),
    drawn ? `${drawn.points} 个点 · 画布 ${drawn.width}×${drawn.height}` : "25 秒内没等到点数（WebGL 没画出来？）",
  );

  /* ---------- ③ 三类缺陷与来源 ---------- */
  const text = await machine.evaluate(`document.body.innerText || ''`);
  check("三类缺陷的名字都在（虫蛀 / 内部裂痕 / 缺损）", ["虫蛀空洞", "内部裂痕", "缺损"].every((key) => text.includes(key)));
  check(
    "每一处缺陷都带着出处（风险记录编号或档案原话）",
    /CUR-Z04-0\d/.test(text) && /档案[：:]/.test(text),
    /CUR-Z04-0\d/.test(text) ? "含风险记录编号" : "没看到风险记录编号",
  );
  check("四根柱子的外形（柱径/材种）在屏上", /直径\s*\d{3}\s*mm/.test(text) && /(楠木|杉木)/.test(text));

  /* ---------- ④ 口径那行字 ---------- */
  check(
    `写明「按外形与档案记录生成、不是实测点云」`,
    /按构件外形与档案记录生成/.test(text) && /不是实测点云/.test(text) && /预置结果/.test(text),
  );

  /* ---------- ⑤ 健康构件没有被编缺陷 ---------- */
  const healthy = await machine.evaluate(`(() => {
    const list = [...document.querySelectorAll('.ipc__specs li')].map((node) => (node.textContent || '').replace(/\\s+/g, ' ').trim());
    return list;
  })()`);
  const z01 = (healthy ?? []).find((row) => row.startsWith("Z01")) ?? "";
  const z02 = (healthy ?? []).find((row) => row.startsWith("Z02")) ?? "";
  check(`Z01（档案：外观连续）显示「无内部缺陷记录」`, z01.includes("无内部缺陷记录"), z01 || "没找到 Z01 那行");
  check(`Z02（档案：轻微褪色）显示「无内部缺陷记录」`, z02.includes("无内部缺陷记录"), z02 || "没找到 Z02 那行");

  /* ---------- ⑥ 「只看选中构件」与 ㉒ 的自动切换 ---------- */
  const solo = await machine.evaluate(`(() => {
    const button = [...document.querySelectorAll('.ipc__toggle')].find((node) => (node.textContent || '').includes('只看 Z04'));
    if (!button) return null;
    button.click();
    return (button.textContent || '').trim();
  })()`);
  check(`有「只看 Z04」这一项且点得动`, Boolean(solo), solo ?? "没找到那个开关");
  const soloState = await machine.waitFor(
    `(() => {
      const specs = [...document.querySelectorAll('.ipc__specs li')].map((node) => node.textContent || '');
      return specs.length === 1 && specs[0].includes('Z04') ? { count: specs.length } : null;
    })()`,
    { timeoutMs: 8000 },
  );
  check(`勾上之后只剩选中的那一根`, Boolean(soloState), soloState ? `剩 ${soloState.count} 根` : "还是四根都在");

  /*
    ---------- ⑦ 「只看破损」真的把木料收掉了 ----------
    这一条判的是**屏幕上的点**（渲染器自报），不是按钮上那行字：木料整层收掉之后，
    点数应当掉到原来的一成上下；再切回「木料全显」又要涨回来。

    ⚠ 取数必须等它**稳下来**：点数按 0.5 s 一帧上报，点完按钮立刻读会读到上一个状态的
      值（第一版就这么假红了一次 —— "只看 Z04"读到的是四根的 238515，于是"涨回来"永远不成立）。
  */
  const pointsNow = () =>
    machine.evaluate(`Number(document.querySelector('.ipc__stage')?.getAttribute('data-points') || 0)`);
  const stablePoints = async () => {
    let previous = await pointsNow();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await sleep(900);
      const current = await pointsNow();
      if (current === previous) return current;
      previous = current;
    }
    return previous;
  };

  const woodPoints = await stablePoints();
  check(
    `只看一根时画的点明显少于四根`,
    Boolean(soloState) && woodPoints > 0 && Boolean(drawn) && woodPoints < drawn.points * 0.9,
    `四根 ${drawn?.points ?? "?"} → 只看 Z04 ${woodPoints} 个点`,
  );

  const onlyDefect = await machine.evaluate(`(() => {
    const button = [...document.querySelectorAll('.ipc__toggle')].find((node) => (node.textContent || '').trim() === '只看破损');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  const defectPoints = await machine.waitFor(
    `(() => {
      const points = Number(document.querySelector('.ipc__stage')?.getAttribute('data-points') || 0);
      return points > 0 && points < ${Math.round(woodPoints * 0.5)} ? points : null;
    })()`,
    { timeoutMs: 10_000 },
  );
  check(
    `「只看破损」把木料收掉（屏幕上只剩缺陷点）`,
    onlyDefect === true && defectPoints !== null,
    defectPoints !== null ? `木料 ${woodPoints} → 破损 ${defectPoints} 个点` : `10 秒内点数没掉下来（还是 ${woodPoints}？）`,
  );
  await machine.evaluate(`(() => {
    const button = [...document.querySelectorAll('.ipc__toggle')].find((node) => (node.textContent || '').trim() === '木料全显');
    button?.click();
    return Boolean(button);
  })()`);
  const backPoints = await stablePoints();
  check(
    `切回「木料全显」点数涨回来（这个开关是双向的，不是一次性的）`,
    backPoints > woodPoints * 0.9,
    `${backPoints} 个点（收回前 ${woodPoints}）`,
  );

  /*
    ㉒「证据对照」播完时 `executor` 派发的事件 —— 这里**直接派发同一条事件**验证接线，
    不重跑那一轮的播报（省时间，且这一条要证的正是"事件到页面的那段线"）。
  */
  await machine.evaluate(`location.hash = '#/twin?component=Z04'`);
  await machine.waitFor(`Boolean(document.querySelector('.page--twin'))`, { timeoutMs: 10_000 });
  await sleep(600);
  const opened = await machine.evaluate(`(() => {
    window.dispatchEvent(new CustomEvent('mumai:twin-internal-cloud', { detail: { componentId: 'Z04' } }));
    return true;
  })()`);
  const autoView = await machine.waitFor(
    `(() => {
      const active = document.querySelector('.twin-view__tab.is-active');
      const stage = document.querySelector('.ipc__stage');
      return active && stage && (active.textContent || '').includes('内部点云')
        ? { tab: (active.textContent || '').trim() }
        : null;
    })()`,
    { timeoutMs: 20_000 },
  );
  /* 同上：切过来之后等点数稳下来再读，免得把这之前的数当成"切过来画出的点" */
  const autoPoints = await stablePoints();
  check(
    `㉒ 的事件能把主视图切到内部点云（并画出点）`,
    opened === true && Boolean(autoView && autoPoints > 10_000),
    autoView ? `${autoView.tab} · ${autoPoints} 个点` : "20 秒内没切过去",
  );

  const shot = await machine.shot("内部点云");
  if (shot) console.log(`  截图：${shot}`);
  console.log(failed === 0 ? "\n✓ 内部点云：全部通过" : `\n✗ 有 ${failed} 项未通过`);
  process.exitCode = failed === 0 ? 0 : 1;
} catch (error) {
  console.error(`工装异常：${error?.stack ?? error}`);
  process.exitCode = 1;
} finally {
  machine.kill();
}
