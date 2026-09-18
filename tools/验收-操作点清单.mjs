/**
 * 验收：剧本所需的**平台操作点清单**（在不在、点不点得动）
 *
 * ── 这条工装回答的问题 ──────────────────────────────────────────────
 * 用户口径：「检测是不是剧本所需所有平台可操作点都在」。
 * 于是把《木脉智检.docx》里点名的每一次"人在平台上动手"列成一张表，
 * 逐条到页面上找那个控件，并读它的 `disabled` 与 `title`：
 *
 *   ✓ 存在且可点        —— 现在就能按下去
 *   ⚠ 存在·当前禁用      —— 控件在，但前置条件没满足；括号里给的是页面自己写的**原因**
 *                          （这条不算失败：例如"发布场景"必须先跑完检查、
 *                            "下发到设备"要先有产物 —— 剧本本来就按这个顺序走）
 *   … 依赖数据            —— 只有数据到位才渲染（例如任务卡），由别的工装单独证
 *   ✗ 未找到              —— 剧本要求、但页面上找不到（这才是不通过）
 *
 * ⚠ 这条工装**只读不点**：会改数据的动作（读单 / 下发 / 校验 / 发布 / 清洗 / 回执）
 *   由各自的工装真点一遍（见文件末尾那张对照表），避免"验收自己把演示库改了"。
 *
 * 用法（仓库根目录）：
 *   node --import ./tools/test-resolve-ts.mjs tools/验收-操作点清单.mjs
 *   … --url http://192.168.1.5:8000    在内网地址上跑一遍
 *   … --account shen                   换个人看（默认 shi；shi 现在是全量权限）
 */

import { Machine, sleep } from "./browser-harness.mjs";

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const BASE = argOf("url", process.env.MUMAI_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");
const ACCOUNT = argOf("account", "shi");
/** 只跑某几个操作点（排查用，按 id 里的关键词匹配，逗号分隔） */
const ONLY = argOf("only", "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

/**
 * 剧本点名的操作点。
 *
 * `where` = 剧本里的位置（行号来自 docx 抽文 `剧本-docx/剧本.txt`）。
 * `find`  = 页面上怎么认出这个控件：按可见文案（textAny）或按 title（titleHas）。
 * ⚠ 用 title 认的那些，是因为按钮文案是动态的（例如打帧按钮在加载中会显示别的字），
 *   而 title 里始终写着"这个按钮是干什么的"。
 * `provedBy` = 会真点它的工装（这条工装只读，所以要点名的动作必须在这里留出处）。
 */
const POINTS = [
  { where: "§9（第 9 行）", id: "工单识别（读这份工单）", route: "/orders?order={order}", find: { textAny: ["工单识别"] }, provedBy: "验收-工单识别.mjs" },
  { where: "§12（第 12 行）", id: "指派 / 调整指派人员", route: "/orders?order={order}", find: { textAny: ["指派人员", "调整指派"] } },
  { where: "§72（第 72 行）", id: "录入环境读数", route: "/orders?order={order}", find: { textAny: ["录入读数"] }, provedBy: "验收-环境读数预设.mjs" },
  { where: "§72（第 72 行）", id: "运行环境校验（生成配置版本）", route: "/orders?order={order}", find: { textAny: ["运行校验"] }, provedBy: "验收-环境读数预设.mjs" },
  { where: "§72（第 72 行）", id: "保存环境草稿（在「录入读数」弹窗内）", route: "/orders?order={order}", find: { textAny: ["录入读数"] }, provedBy: "验收-环境读数预设.mjs" },
  { where: "§76（第 76 行）", id: "下发到扫描仪", route: "/orders?order={order}", find: { textAny: ["下发扫描仪"] } },
  {
    where: "§302（第 302 行）",
    id: "下发自主巡航任务",
    route: "/orders?order={order}",
    /* ⚠ 按**可见文案**认：那个按钮的 title 是动态的 —— 没被挡住时写「按上面的预览
       下发一条自主巡航任务…」，被挡住时 title 变成挡住的原因，只按 title 认会漏。 */
    find: { textAny: ["下发自主巡航任务", "下发中…"], titleHas: ["下发一条自主巡航任务"] },
    provedBy: "验收-多机同步.mjs（跨机派发→接受）",
  },
  { where: "§102（第 102 行）", id: "通道巡查（监听窗口）", route: "/mapping", find: { textAny: ["通道巡查"] }, provedBy: "验收-小木带路.mjs ⑨ 段" },
  { where: "§111（第 111 行）", id: "上传 / 替换模型文件", route: "/twin", find: { textAny: ["上传模型文件", "上传模型", "替换模型"] } },
  { where: "§111（第 111 行）", id: "运行场景检查", route: "/twin", find: { textAny: ["运行检查"] } },
  { where: "§111（第 111 行）", id: "发布场景", route: "/twin", find: { textAny: ["发布场景"] } },
  { where: "§123（第 123 行）", id: "打关键帧（记录当前机位）", route: "/twin", find: { titleHas: ["打帧"] }, provedBy: "验收-场景关键帧（scene-keyframes 服务端测试 + 多机同步打帧一节）" },
  { where: "§163（第 163 行）", id: "巡检任务预览与下发", route: "/mapping", find: { textAny: ["任务预览", "下发任务", "开始"] } },
  {
    where: "§163（第 163 行）",
    id: "清洗流水线：预检查 / 执行清洗 / 重跑",
    route: "/firmware?tab=dataset",
    /* 流程停在哪一步按钮就长什么样：没跑过是「预检查 / 执行清洗」，跑过之后是
       「重跑」与「下一步：人工核验」—— 三种都算"这一步能操作"，不能只认一种写法 */
    find: { textAny: ["执行清洗", "预检查", "重跑", "下一步："] },
    provedBy: "验收-小木带路.mjs ⑰ 段（揭示逐拍推到执行清洗）",
  },
  { where: "§230（第 230 行）", id: "受限校验单元：整组调整后重跑", route: "/firmware?tab=dataset", find: { textAny: ["整组调整后重跑", "编入所选集合"] }, provedBy: "验收-小木带路.mjs 数据集页检查" },
  { where: "§260（第 260 行）", id: "下发到设备（更新包）", route: "/firmware?tab=delivery", find: { textAny: ["下发到设备"] }, provedBy: "验收-更新包下发（device-update-dispatch）" },
  { where: "§331（第 331 行）", id: "运行交付文件校验（SHA-256）", route: "/archive", find: { textAny: ["运行交付文件校验"] } },
  { where: "⑥⑮（第 30 / 198 行）", id: "任务卡的「核对后保存」/「执行人回执」", route: "/workbench", find: { textAny: ["核对后保存", "执行人回执", "回执"] }, optional: true, provedBy: "验收-执行工作台.mjs（13/13）" },
];

let failed = 0;
const rows = [];

const machine = new Machine({ name: "opcheck", port: 9567, base: BASE, account: ACCOUNT });

/** 在页面上找控件：返回 { text, disabled, title } 或 null */
const FINDER = (find) => `(() => {
  const texts = ${JSON.stringify(find.textAny ?? [])};
  const titles = ${JSON.stringify(find.titleHas ?? [])};
  const buttons = [...document.querySelectorAll('button')];
  for (const node of buttons) {
    const text = (node.textContent || '').trim();
    const title = node.getAttribute('title') || '';
    const byText = texts.some((needle) => text.includes(needle));
    const byTitle = titles.some((needle) => title.includes(needle));
    if (!byText && !byTitle) continue;
    /* 认到的若是"容器里的登录按钮"这类噪声，跳过（文案必须短于 24 字） */
    if (text.length > 24) continue;
    return { text: text || title, disabled: Boolean(node.disabled), title };
  }
  return null;
})()`;

/**
 * 路由 → 该页根元素的 class（用来等"这一页真的挂上了"）。
 *
 * ⚠ 为什么需要它：只设 `location.hash` 之后立刻找按钮，会**在上一个页面**上找 ——
 *   实测有一次在 `/orders` 上找巡航按钮，正文却还是融合分析页的内容
 *   （`{order}` 那次是参数没带上，这次是页面还没切过去），报出来的"未找到"全是假的。
 */
const PAGE_CLASS = {
  "/orders": ".page--orders",
  "/mapping": ".page--mapping",
  "/twin": ".page--twin",
  "/firmware": ".page--adapt",
  "/archive": ".page--archive",
  "/workbench": ".page.wb",
};

try {
  console.log(`平台操作点验收 · ${BASE} · 账号 ${ACCOUNT}`);
  await machine.start();
  if (!(await machine.login())) throw new Error(`登录失败（${ACCOUNT}）—— 页面在 ${BASE} 上吗？`);
  console.log(`  已登录\n`);

  /*
    ⚠ 工单页上的控件（工单识别 / 指派 / 环境 / 下发 / 巡航）都挂在**详情**上，
    只开 `#/orders` 是列表页，找不到它们 —— 先取最新那张单的 id 再带上 `?order=`。
    （第一版没带参数，5 个操作点全报"未找到"，是工装取数错，不是功能缺。）
  */
  const newest = (await machine.call("GET", "/api/work-orders"))?.json?.orders?.[0]?.id ?? "";
  console.log(`  当前工单：${newest || "（列表为空）"}\n`);

  for (const point of POINTS) {
    if (ONLY.length && !ONLY.some((needle) => point.id.includes(needle) || point.where.includes(needle))) continue;
    const route = point.route.replace("{order}", newest);
    const path = route.split("?")[0];
    const marker = PAGE_CLASS[path];
    await machine.evaluate(`location.hash = '#${route}'`);
    /* 先等这一页挂上，再找控件（否则会在上一页上找） */
    if (marker) {
      const landed = await machine.waitFor(
        `(() => (document.querySelector(${JSON.stringify(marker)}) ? location.hash : null))()`,
        { timeoutMs: 8000 },
      );
      if (!landed) console.log(`  ⚠ ${point.id}：8 秒内没等到页面 ${marker}，仍按当前页找（结果会记成未找到）`);
    }
    await sleep(400);
    const hit = await machine.waitFor(FINDER(point.find), { timeoutMs: 6000 });
    if (hit) {
      const state = hit.disabled ? `⚠ 存在·当前禁用（${hit.title || "页面未写明原因"}）` : "✓ 存在且可点";
      rows.push({ point, state, hit });
    } else if (point.optional) {
      rows.push({ point, state: "… 依赖数据（当前没有可操作对象）", hit: null });
    } else {
      /*
       报"未找到"时把正文里的按钮文案一起打出来 —— 排查时不必再开一次浏览器。
       ⚠ 必须**排除外壳导航**：页面顶部那十几个导航按钮会占满 `slice`，
        第一版就是这么拿到一串"排练控制台 / 任务总览…"，看不出正文到底渲染了没有。
      */
      const labels = await machine.evaluate(`(() => {
        const NAV = new Set(['排练控制台', '投到展示窗口', '任务总览', '工单档案', '建图巡航', '数字孪生', '硬件详情', '固件及模型', '知识库', '报告归档']);
        const nodes = [...document.querySelectorAll('button')].filter((node) => {
          const text = (node.textContent || '').trim();
          if (!text || text.length > 30) return false;
          if (NAV.has(text) || text.includes('退出') || text.includes('平台正常')) return false;
          return true;
        });
        return {
          body: (document.querySelector('.page')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 80),
          labels: nodes.map((node) => (node.textContent || '').trim() + (node.disabled ? '（禁用）' : '')).slice(0, 14),
        };
      })()`);
      rows.push({ point, state: "✗ 未找到", hit: null, labels });
      failed += 1;
    }
  }

  console.log("剧本位置                | 操作点                          | 结果");
  console.log("------------------------|--------------------------------|------------------------------------------");
  for (const row of rows) {
    const where = row.point.where.padEnd(22, " ");
    const id = row.point.id.padEnd(30, " ");
    console.log(`${where} | ${id} | ${row.state}`);
  }
  const misses = rows.filter((row) => row.labels);
  if (misses.length) {
    console.log("\n未找到的那几页上实际有哪些按钮（排查用）：");
    for (const row of misses) {
      console.log(`  · ${row.point.id}（${row.point.route}）`);
      console.log(`      正文开头：${row.labels?.body || "（.page 没有内容）"}`);
      console.log(`      正文按钮：${(row.labels?.labels ?? []).join(" / ") || "（无）"}`);
    }
  }
  const clickable = rows.filter((r) => r.state.startsWith("✓")).length;
  const disabled = rows.filter((r) => r.state.startsWith("⚠")).length;
  const optional = rows.filter((r) => r.state.startsWith("…")).length;
  console.log(
    `\n合计 ${rows.length} 个操作点：可点 ${clickable} · 存在但当前禁用 ${disabled} · 依赖数据 ${optional} · 未找到 ${failed}`,
  );
  console.log("会改数据的那些动作由各自工装真点一遍：" +
    [...new Set(POINTS.map((p) => p.provedBy).filter(Boolean))].map((name) => `\n  · ${name}`).join(""));
  console.log(failed === 0 ? "\n✓ 操作点清单：全部在（禁用项都写明了原因）" : `\n✗ 有 ${failed} 个操作点没找到`);
  process.exitCode = failed === 0 ? 0 : 1;
} catch (error) {
  console.error(`工装异常：${error?.stack ?? error}`);
  process.exitCode = 1;
} finally {
  machine.kill();
}
