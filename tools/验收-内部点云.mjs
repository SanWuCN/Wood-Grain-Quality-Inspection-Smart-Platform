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

  /*
    ⚠ 这条判据 2026-10-01 从"渲染器自报点数"改成"进 GPU 的高斯颗数"：
    这一屏现在画的是高斯泼溅基元（`SplatMesh`），不再走 `gl.POINTS`，
    所以 `gl.info.render.points` 恒为 0 —— 旧判据会永远红，而且红得没道理。
    `data-splats` 由几何层算出（壳 + 木料 + 缺陷三层求和），是屏幕上真画的东西。
  */
  const drawn = await machine.waitFor(
    `(() => {
      const stage = document.querySelector('.ipc__stage');
      if (!stage) return null;
      const splats = Number(stage.getAttribute('data-splats') || 0);
      const canvas = stage.querySelector('canvas');
      return splats > 0 && canvas && canvas.width > 100 ? { splats, width: canvas.width, height: canvas.height } : null;
    })()`,
    { timeoutMs: 25_000 },
  );
  check(
    `画布真的画出了高斯泼溅（几何层报的颗数）`,
    Boolean(drawn && drawn.splats > 100_000),
    drawn ? `${drawn.splats} 颗高斯 · 画布 ${drawn.width}×${drawn.height}` : "25 秒内没等到颗数（泼溅没建起来？）",
  );

  /* ---------- ②b 精度读数（用户 2026-10：「3d 点云做得更精细一些」）----------
     判据取自阶段节点上的 `data-arc-mm` / `data-level-mm` / `data-budget`，
     它们由生成器的 `cloudRefinement()` 算出（页面不另算一套）。
     环向 ≤ 7 mm 是"轮廓能对上单根那根"的门槛：单根取景距离 6.54 m 时，
     再粗就看成多边形；轴向 ≤ 13 mm 是为了柱身不出现横向条纹。
  */
  const precision = await machine.evaluate(`(() => {
    const stage = document.querySelector('.ipc__stage');
    if (!stage) return null;
    return {
      arcMm: Number(stage.getAttribute('data-arc-mm') || 0),
      levelMm: Number(stage.getAttribute('data-level-mm') || 0),
      budget: Number(stage.getAttribute('data-budget') || 0),
      text: (stage.closest('.ipc')?.innerText || '').replace(/\\s+/g, ' '),
    };
  })()`);
  check(
    `柱面环向点距够细（≤ 7 mm，实得 ${precision ? precision.arcMm.toFixed(2) : "—"} mm）`,
    Boolean(precision && precision.arcMm > 0 && precision.arcMm <= 7),
    precision ? `四根里最粗的那根 ${precision.arcMm.toFixed(2)} mm` : "读不到精度读数",
  );
  check(
    `柱身轴向点距够细（≤ 13 mm，实得 ${precision ? precision.levelMm.toFixed(2) : "—"} mm）`,
    Boolean(precision && precision.levelMm > 0 && precision.levelMm <= 13),
  );
  /*
    ⚠ 上界 2026-10-01 从 70 万提到 120 万：为了"看得出是一颗颗点"
    （单颗点缩到间距以下、点之间露空隙），点距必须更密，否则柱子会发虚。
    修法是加密而不是把点调回大尺寸 —— 后者就是用户否掉的"纯棕色木柱"。
  */
  check(
    `点数预算在合理量级（实得 ${precision ? precision.budget : "—"} 颗高斯）`,
    Boolean(precision && precision.budget > 300_000 && precision.budget < 1_600_000),
  );
  check(
    "精度那一栏在屏上（讲解时能指着说这是多细）",
    Boolean(precision && /柱面环向点距/.test(precision.text) && /点\/m³/.test(precision.text)),
  );

  /*
    ---------- ②c 外壳必须是**真高斯泼溅**（用户口径 2026-10-01）----------
    「外壳像高斯泼溅的，内部缺陷也得真实点」。

    ⚠ 这条判据在 2026-10-01 改过口径，旧版是错的：
    旧版断言"外壳用的是从 gs.sog 切出来的真实柱面"（`data-shell-points`）。
    那一份 4.2 万点的资产后来经复核是**均匀噪声区**（那份泼溅里根本没有一根
    能单独取出的木柱，证据与脚本见 `internalPointCloud.ts` 里 `shellGrainColor` 的注释），
    所以它已经被撤掉；现在外壳是**程序化柱面 + 真高斯泼溅渲染**（Spark）。
    判据换成"进 GPU 的高斯颗数"（`data-splats`）：点渲染时代那个数是 0。
  */
  let shell = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    shell = await machine.evaluate(`(() => {
      const stage = document.querySelector('.ipc__stage');
      if (!stage) return null;
      return {
        mode: stage.getAttribute('data-shell'),
        splats: Number(stage.getAttribute('data-splats') || 0),
        budget: Number(stage.getAttribute('data-budget') || 0),
      };
    })()`);
    if (shell && shell.splats > 0) break;
    await sleep(500);
  }
  check(
    `外壳是**真高斯泼溅**（实得 ${shell ? shell.mode : "读不到"} · ${shell ? shell.splats : 0} 颗高斯）`,
    Boolean(shell && shell.mode === "splat" && shell.splats > 100_000),
    shell ? `${shell.splats} 颗（壳 + 木料 + 缺陷三层一起）` : "读不到 stage",
  );
  check(
    "高斯颗数与几何层的点数预算一致（屏幕上的读数不是另算一份）",
    Boolean(shell && shell.budget === shell.splats),
    shell ? `data-budget ${shell.budget} vs data-splats ${shell.splats}` : "读不到 stage",
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
    这一条判的是**屏幕上这一刻真在画的高斯颗数**（`data-splats`），
    不是按钮上那行字：木料整层收掉之后，颗数应当掉到原来的一成上下；
    再切回「木料全显」又要涨回来。

    ⚠ 判据 2026-10-01 改过：旧版读 `data-points`（渲染器自报的 `gl.POINTS` 数），
    这一屏改成泼溅之后那个数恒为 0，而且 `data-splats` 必须**跟着开关变**
    （写成一个与开关无关的常量，这两条就永远看不出变化 —— 等于没测）。
    这里只比**方向**：切过去要明显变小、切回来要明显回升。
  */
  const splatsNow = () =>
    machine.evaluate(`Number(document.querySelector('.ipc__stage')?.getAttribute('data-splats') || 0)`);

  const woodSplats = await splatsNow();
  check(
    `只看一根时画的明显少于四根`,
    Boolean(soloState) && woodSplats > 0 && Boolean(drawn) && woodSplats < drawn.splats * 0.9,
    `四根 ${drawn?.splats ?? "?"} → 只看 Z04 ${woodSplats} 颗`,
  );

  const onlyDefect = await machine.evaluate(`(() => {
    const button = [...document.querySelectorAll('.ipc__toggle')].find((node) => (node.textContent || '').trim() === '只看破损');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  const defectSplats = await machine.waitFor(
    `(() => {
      const splats = Number(document.querySelector('.ipc__stage')?.getAttribute('data-splats') || 0);
      return splats > 0 && splats < ${Math.round(woodSplats * 0.5)} ? splats : null;
    })()`,
    { timeoutMs: 10_000 },
  );
  check(
    `「只看破损」把木料收掉（屏幕上只剩缺陷）`,
    onlyDefect === true && defectSplats !== null,
    defectSplats !== null ? `木料 ${woodSplats} → 破损 ${defectSplats} 颗` : `10 秒内颗数没掉下来（还是 ${woodSplats}？）`,
  );
  await machine.evaluate(`(() => {
    const button = [...document.querySelectorAll('.ipc__toggle')].find((node) => (node.textContent || '').trim() === '木料全显');
    button?.click();
    return Boolean(button);
  })()`);
  const backSplats = await machine.waitFor(
    `(() => {
      const splats = Number(document.querySelector('.ipc__stage')?.getAttribute('data-splats') || 0);
      return splats > ${Math.round(woodSplats * 0.9)} ? splats : null;
    })()`,
    { timeoutMs: 10_000 },
  );
  check(
    `切回「木料全显」颗数涨回来（这个开关是双向的，不是一次性的）`,
    backSplats !== null,
    `${backSplats ?? "?"} 颗（收回前 ${woodSplats}）`,
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
  const autoSplats = await machine.waitFor(
    `(() => {
      const stage = document.querySelector('.ipc__stage');
      const splats = Number(stage?.getAttribute('data-splats') || 0);
      return splats > 10_000 ? splats : null;
    })()`,
    { timeoutMs: 15_000 },
  );
  check(
    `㉒ 的事件能把主视图切到内部点云（并画出高斯泼溅）`,
    opened === true && Boolean(autoView) && autoSplats !== null,
    autoView ? `${autoView.tab} · ${autoSplats ?? 0} 颗` : "20 秒内没切过去",
  );

  /* ---------- ⑩ 剖开看内部（用户口径 2026-10-02：「根本看不出内部问题」）----------
     默认机位是斜前方，柱子朝相机那一面全是外皮 —— 内部有没有虫蛀、空到什么程度，
     从外面读不出来。这一条要证三件事：
       · 开关在、点得动；
       · 点下去**屏幕上的颗数明显变少**（壳与木料被剖掉一层）；
       · 剖掉的是木料，**腔壁/虫道那一层还在**（否则就是把要给人看的东西也收掉了）。
  */
  const cutBefore = Number(await machine.evaluate(`document.querySelector('.ipc__stage')?.getAttribute('data-splats') || 0`));
  const cutClicked = await machine.evaluate(`(() => {
    const chip = [...document.querySelectorAll('button')].find((el) => (el.textContent || '').trim() === '剖开看内部');
    if (!chip) return 'no-chip';
    if (!chip.className.includes('is-on')) chip.click();
    return 'clicked';
  })()`);
  const cutAfter = await machine.waitFor(
    `(() => {
      const stage = document.querySelector('.ipc__stage');
      const chip = [...document.querySelectorAll('button')].find((el) => (el.textContent || '').includes('剖开看内部'));
      const splats = Number(stage?.getAttribute('data-splats') || 0);
      return chip && chip.className.includes('is-on') && splats > 0 && splats < ${cutBefore} ? splats : null;
    })()`,
    { timeoutMs: 20_000 },
  );
  check(
    "有「剖开看内部」开关，点下去屏幕上的木料明显变少（真的剖开了）",
    cutClicked === "clicked" && cutAfter !== null,
    cutClicked === "no-chip" ? "没找到开关" : `${cutBefore} → ${cutAfter ?? "没变少"}`,
  );
  const cutShot = await machine.shot("内部点云-剖开看内部");
  if (cutShot) console.log(`  剖切截图：${cutShot}`);
  /* 收工复位：这个开关留在页面上的话，后面再跑这一屏的人会以为默认就是剖开的 */
  await machine.evaluate(`(() => {
    const chip = [...document.querySelectorAll('button')].find((el) => (el.textContent || '').includes('剖开看内部'));
    if (chip && chip.className.includes('is-on')) chip.click();
    return true;
  })()`);

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
