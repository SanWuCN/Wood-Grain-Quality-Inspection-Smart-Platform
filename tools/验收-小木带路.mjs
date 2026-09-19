/**
 * 验收：**小木带路**（25 轮小木互动 → 平台自动切到剧本对应的页面）
 *
 * ── 这条工装回答的问题 ──────────────────────────────────────────────
 * 用户口径（2026-09-23）：「对平台进行页面添加及和小木互动时触发的自动操作，贴合剧本……
 * 操作或展示页面少就添加」。验收要证伪的正是"念完停在原地"：
 *   ① 每一轮的 `nav` 声明是否**真的把页面带走了**（对 URL 断言，不看截图）；
 *   ② 页内定位（页签）是否真的生效 —— 页签写错时页面不报错，只是**内容区空白**，
 *      所以这一条按内容断言（例如环境记录页必须出现四类天气与来源标注）；
 *   ③ 环境记录页的数值是否真的来自数据包（不许出现「标签缺失」或"实时"这类穿帮字样）。
 *
 * ── 为什么不逐个硬编码说法 ──────────────────────────────────────────
 * 触发词是剧本自己的数据（`SCRIPT_ROUNDS[i].triggers`）。工装用 `routeUtterance()`
 * **先从该轮自己的触发词里挑一条真能命中本轮的说法**，再把它发进页面 ——
 * 于是"说法改了"不需要改工装，"说法命中了别的轮"会当场暴露成一条失败。
 *
 * 用法（仓库根目录）：
 *   node --import ./tools/test-resolve-ts.mjs tools/验收-小木带路.mjs
 *   node --import ./tools/test-resolve-ts.mjs tools/验收-小木带路.mjs --url http://192.168.1.5:8000
 *   … --only ⑤,⑰,⑲     只跑指定轮次（排查时用）
 *   … --keep-cards       保留 ⑥⑮ 生成的任务卡（默认收工会清掉，见下面的说明）
 *
 * ── 为什么默认要清任务卡（收工那一段）──────────────────────────────
 * ⑥⑮ 两轮的自动操作会在服务端生成任务卡（`taskCard` 实体，幂等）。走一遍 25 轮
 * 就会把演示库里的那两批卡生成出来 —— 而演示现场恰恰要看到"卡片跟着台词一张张出现"。
 * 所以默认收工把它清掉；要看卡片就加 `--keep-cards`。
 */

import { DatabaseSync } from "node:sqlite";
import { Machine, sleep } from "./browser-harness.mjs";

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const BASE = argOf("url", process.env.MUMAI_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");
const only = argOf("only", "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const ACCOUNT = argOf("account", "shi");
/** 演示库：工装收尾清任务卡用（卡片没有删除接口，随工单级联清理） */
const DB_FILE = "server/data/mumai.db";

const { SCRIPT_ROUNDS } = await import("../src/pages/MumaiDashboard/agent/script.ts");
const { routeUtterance } = await import("../src/pages/MumaiDashboard/agent/scriptMatch.ts");
const { SCRIPT_SHORTCUT_ENTRIES } = await import("../src/pages/MumaiDashboard/agent/scriptShortcutEntries.ts");

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? `　（${detail}）` : ""}`);
  if (!ok) failed += 1;
};

/** 该轮要说哪句话：从它自己的触发词里挑第一条**真能命中本轮**的 */
function phraseFor(round) {
  for (const trigger of round.triggers) {
    for (const sentence of [trigger, `小木，${trigger}`, `小木小木，${trigger}`]) {
      const route = routeUtterance(sentence);
      if (route.kind === "script" && route.round.roundNo === round.roundNo) return sentence;
    }
  }
  return null;
}

/** 期望的 URL 片段：路由 + 页内定位（顺序无关，逐个包含即可） */
function expectHash(nav) {
  if (nav.route === "order") return ["/orders"];
  const parts = [nav.route];
  if (nav.tab) parts.push(`tab=${nav.tab}`);
  if (nav.view) parts.push(`view=${nav.view}`);
  if (nav.component) parts.push(`component=${nav.component}`);
  return parts;
}

const machine = new Machine({ name: "nav", port: 9531, base: BASE, account: ACCOUNT });

try {
  console.log(`小木带路验收 · ${BASE} · 账号 ${ACCOUNT}`);
  await machine.start();
  const ok = await machine.login();
  if (!ok) throw new Error(`登录失败（${ACCOUNT}）—— 页面在 ${BASE} 上吗？`);
  console.log("  已登录\n");

  /* 等共享服务就绪：这一条决定了工单页能不能真的打开（列表为空时导航会被跳过） */
  const orders = await machine.call("GET", "/api/work-orders");
  const orderCount = Array.isArray(orders?.json?.orders) ? orders.json.orders.length : 0;
  console.log(`  服务端工单数 = ${orderCount}${orderCount === 0 ? "（工单页的轮次会跳过选单，只断言路由）" : ""}\n`);

  const rounds = SCRIPT_ROUNDS.filter((round) => (only.length ? only.includes(round.roundNo) : true));
  const skipped = [];

  for (const round of rounds) {
    const nav = round.nav;
    if (!nav) {
      check(`${round.roundNo} ${round.title}`, false, "这一轮没有页面落点");
      continue;
    }
    if (round.triggerSource !== "voice") {
      skipped.push(`${round.roundNo}（${round.triggerSource}）`);
      continue;
    }
    const phrase = phraseFor(round);
    if (!phrase) {
      check(`${round.roundNo} ${round.title}`, false, "它自己的触发词一条都命不中本轮");
      continue;
    }

    /* 先离开目标页，才能证明"是这一轮把页面带过去的"，而不是上一轮停在那儿 */
    const parts = expectHash(nav);
    /* 工单页的轮次要选中某一张：列表为空时不硬要求路由（工装控制不了"没有工单"这件事） */
    const orderRound = nav.route === "order";
    if (orderRound && orderCount === 0) {
      skipped.push(`${round.roundNo}（服务端没有工单）`);
      continue;
    }
    await machine.evaluate(`location.hash = '#/console'`);
    await sleep(220);

    const interactionId = `nav-${round.roundNo}-${Date.now()}`;
    await machine.evaluate(
      `window.dispatchEvent(new CustomEvent('mumai:xiaomu-ask', { detail: { question: ${JSON.stringify(phrase)}, interactionId: ${JSON.stringify(interactionId)} } })); 1`,
    );

    let hash = "";
    const deadline = Date.now() + 9000;
    while (Date.now() < deadline) {
      await sleep(250);
      hash = await machine.evaluate(`location.hash`);
      if (parts.every((part) => String(hash).includes(part))) break;
    }
    const hit = parts.every((part) => String(hash).includes(part));
    check(`${round.roundNo} ${round.title}`, hit, hit ? `「${phrase}」→ ${hash}` : `期望 ${parts.join(" & ")}，实际 ${hash}`);
    if (!hit) continue;

    /* 页内定位生效了吗：目标页签的内容必须真的渲染出来（写错页签时内容区是空的） */
    if (nav.route === "/hardware" && nav.tab === "env") {
      const content = await machine.waitFor(
        `(() => {
          const text = document.body.innerText || '';
          const kinds = ['降水', '湿度', '风', '温度'].filter((k) => text.includes(k));
          return kinds.length === 4 ? { kinds: kinds.length, source: /未启用联网查询/.test(text), missingLabel: /标签缺失/.test(text), live: /实时/.test(text) } : null;
        })()`,
        { timeoutMs: 6000 },
      );
      check(`  ↳ 环境记录页内容`, Boolean(content), content ? `四类天气齐全` : "四类天气没渲染出来");
      if (content) {
        check(`  ↳ 来源标注是归档口径`, content.source && !content.live, `未启用联网查询=${content.source} · 出现"实时"=${content.live}`);
        check(`  ↳ 没有「标签缺失」`, !content.missingLabel);
      }
    }

    /* 数据接收页：三路通道 + 接收清单 + 按样本编号核对，三块都要真的渲染出来 */
    if (nav.route === "/hardware" && nav.tab === "receive") {
      const content = await machine.waitFor(
        `(() => {
          const text = document.body.innerText || '';
          const channels = ['小车数据通道', '手持设备通道', '场景文件网络通道'].filter((k) => text.includes(k));
          return channels.length === 3
            ? {
                channels: channels.length,
                manifest: /本单接收清单/.test(text),
                samples: /按样本编号核对/.test(text),
                independent: /采集时间各自独立记录/.test(text),
                notLinked: /设备编号/.test(text),
              }
            : null;
        })()`,
        { timeoutMs: 6000 },
      );
      check(`  ↳ 数据接收页内容`, Boolean(content), content ? "三路通道齐全" : "三路通道没渲染出来");
      if (content) {
        check(`  ↳ 接收清单与样本编号核对两块都在`, content.manifest && content.samples);
        check(`  ↳ 写明「采集时间各自独立记录」`, content.independent);
      }
    }

    /* 建图巡航（⑨）：剧本 §104 要求「弹出个监听窗口」，窗口里要有建图效果与视频流 */
    if (nav.route === "/mapping") {
      const panel = await machine.waitFor(
        `(() => {
          const node = document.querySelector('.dsf');
          if (!node) return null;
          const text = node.innerText || '';
          return {
            text,
            title: /监听窗口/.test(text),
            video: /视频通道/.test(text),
            delay: /延迟/.test(text) && /9 s/.test(text),
            map: /建图版本/.test(text) && /地图覆盖率/.test(text),
          };
        })()`,
        { timeoutMs: 8000 },
      );
      check(`  ↳ 弹出监听窗口`, Boolean(panel?.title), panel ? "窗口标题写着监听窗口" : "⑨ 的小窗没弹出来");
      if (panel) {
        check(`  ↳ 窗口里有建图效果那一组`, panel.map);
        check(`  ↳ 窗口里有视频通道那一路（状态与延迟）`, panel.video && panel.delay);
      }
      /*
        ── 剧本 §102：人自己也要点得开 ─────────────────────────────────
        「等待时选用：小车继续建图，**史在平台开启数据通道巡查**」。
        所以建图页上要有一个真的按钮，点下去弹的是同一个窗口。

        ⚠ 必须 `waitFor` 等它渲染出来再点（2026-09-30 修）：建图页在 5173（dev）上
        模块按需加载，比 dist 慢；第一版是一次 `evaluate` 直接找 —— 找不到就报假红
        （8000 上"碰巧"已就绪，所以只在 5173 上暴露）。
      */
      const manual = await machine.waitFor(
        `(() => {
          const button = [...document.querySelectorAll('button')].find((node) => (node.textContent || '').trim() === '通道巡查');
          if (!button || button.disabled) return null;
          button.click();
          return 'clicked';
        })()`,
        { timeoutMs: 12_000 },
      );
      check(`  ↳ 建图页上有「通道巡查」按钮且点得动（§102 史自己开启）`, manual === "clicked");
      const reopened = await machine.waitFor(`Boolean(document.querySelector('.dsf'))`, { timeoutMs: 6000 });
      check(`  ↳ 点它弹出同一个监听窗口`, Boolean(reopened));
    }

    /* 数据集页（⑰）：沈那一步的「受限校验单元 + 集合求交语句 + 冲突清单」要真的在屏上 */
    if (nav.route === "/firmware" && nav.tab === "dataset") {
      const unit = await machine.waitFor(
        `(() => {
          const text = document.body.innerText || '';
          const code = [...document.querySelectorAll('.code-block')].map((n) => n.textContent || '').join('');
          const expr = /overlap = \\(train_ids & val_ids\\) \\| \\(train_ids & test_ids\\) \\| \\(val_ids & test_ids\\)/.test(code);
          const list = /交集/.test(text) && /三类问题明细/.test(text);
          const rerun = /整组调整后重跑/.test(text);
          /* 三样齐了才返回 —— 只返回一部分会让 waitFor 立刻收工（见下面的说明） */
          return expr && list && rerun ? { expr, list, rerun } : null;
        })()`,
        /*
          ⚠ 这个等待函数**必须返回 null 才会继续等**（2026-09-30 修）。
          旧写法无条件返回对象，`waitFor` 第一拍（250ms）就拿到结果 —— 等于没等：
          8000（dist，渲染快）碰巧已就绪，5173（dev，模块按需加载）还没挂上分组检查面板，
          于是这两条在 5173 上稳定报假红。
          现在三样都齐了才返回；超时 8 秒放宽到 15 秒（分得清"慢"与"没有"）。
        */
        { timeoutMs: 15_000 },
      );
      check(
        `  ↳ 受限校验单元里的集合求交语句逐字在屏上（沈那一步）`,
        Boolean(unit?.expr),
        unit?.expr ? "语句与剧本一致" : "没找到那句 overlap = (train_ids & val_ids) | …",
      );
      check(
        `  ↳ 冲突清单与「整组调整后重跑」都在（有冲突则调整分组后重跑）`,
        Boolean(unit?.list && unit?.rerun),
        `清单=${unit?.list} 重跑=${unit?.rerun}`,
      );
    }

    /* 三维场景：四柱构件条要真的渲染出来，且重点构件带「建议优先复核」 */
    if (nav.route === "/twin") {
      /*
        ── 先看「预采场景」角标（剧本 §134）────────────────────────────
        原文：「场景标题持续显示"预采场景"」。这一版场景用的是出发前预采的全景
        视频，标题上不写这一笔就会被当成"现场刚拍回来的画面"。判据只看素材名，
        所以这里查的是屏上真的有这个标记（服务端实体没有素材名，靠 id 回查本地）。
      */
      const sceneTag = await machine.waitFor(
        `(() => {
          const node = document.querySelector('.scene-list .scene-list__tag');
          if (!node || !(node.textContent || '').includes('预采场景')) return null;
          /* 工具条那一行要单独取（整页 innerText 里也有角标本身，那样判等于没判） */
          const note = document.querySelector('.toolbar__note');
          return { tag: (node.textContent || '').trim(), toolbar: /预采场景/.test(note ? note.innerText : '') };
        })()`,
        { timeoutMs: 8000 },
      );
      check(`  ↳ 场景标题带「预采场景」角标（§134）`, Boolean(sceneTag), sceneTag ? sceneTag.tag : "标题上没看到角标");
      check(`  ↳ 顶部工具条也写明这是预采场景（持续显示）`, Boolean(sceneTag?.toolbar), sceneTag ? `工具条带标记=${sceneTag.toolbar}` : "无角标可比对");
      /*
        ── ⑫「打开你标记的原图」的可见结果（剧本 §140–142）──────────────
        小木：「对应原图已打开，标注与构件编号一起显示。请核对这处表面缺损。」
        屏上要同时有：图片编号、标注框（编号 + 类别 + 置信度）、
        以及 §141 那句"没有标注坐标时只打开原图、不虚构放大定位"的交代。
      */
      const evidence = await machine.waitFor(
        `(() => {
          const text = document.body.innerText || '';
          return {
            image: /img-Z04-lower-f11\\.jpg|IMG_\\d{4}\\.jpg/.test(text),
            box: /anno-box-11/.test(text),
            preset: /预置标注记录/.test(text),
          };
        })()`,
        { timeoutMs: 8000 },
      );
      check(
        `  ↳ 屏上给出原图编号与标注框（标注与构件编号一起显示）`,
        Boolean(evidence?.image && evidence?.box),
        `原图编号=${evidence?.image} 标注框=${evidence?.box}`,
      );
      check(
        `  ↳ 写明标注是预置记录（§141 口径）`,
        Boolean(evidence?.preset),
        `预置标注记录=${evidence?.preset}`,
      );
      /*
        ── ⑫ 的原图窗口（用户 2026-09-30：「应该打开个窗口，放出木材表面图片」）──
        要看到的是**真图**，不是一段文字。所以这里断言三件事：
          · 窗口在（`.opw`）；
          · 里面那张 `<img>` **真的解码出了像素**（`naturalWidth > 200`）——
            这正是"图裂了"的判据：`/photos/*` 没被代理时 src 返回的是一页 HTML，
            浏览器解不出图，`naturalWidth` 会是 0，而页面本身不报错；
          · 平台叠的框在（`.opw__box`），且默认是"以框为中心"的 transform 放大。

        ⚠ **只有 ⑫ 会开这个窗**（⑪㉒ 也落在 /twin，但它们的台词不要求打开原图）。
          第一版把这段挂在所有 /twin 轮次上，于是 ⑪㉒ 两轮报了"没等到原图窗口"的假红 ——
          判据要跟着"这一轮该不该开窗"走。
      */
      if (round.roundNo === "⑫") {
        const photoWin = await machine.waitFor(
          `(() => {
            const win = document.querySelector('.opw');
            if (!win) return null;
            const img = win.querySelector('.opw__img');
            const box = win.querySelector('.opw__box');
            const panes = win.querySelectorAll('.opw__pane').length;
            const zoomPane = win.querySelector('.opw__pane.is-zoom .opw__inner');
            return {
              natural: img ? img.naturalWidth : 0,
              box: Boolean(box),
              panes,
              zoomed: (zoomPane?.getAttribute('style') || '').includes('scale('),
              src: img ? img.getAttribute('src') : '',
            };
          })()`,
          { timeoutMs: 12_000 },
        );
        check(
          `  ↳ ⑫ 弹出原图窗口，且图片**真的解码出来**（不是裂图）`,
          Boolean(photoWin && photoWin.natural > 200),
          photoWin ? `naturalWidth=${photoWin.natural} · src=${photoWin.src}` : "没等到原图窗口",
        );
        check(
          `  ↳ 窗口里有平台的标注框，且默认按框放大`,
          Boolean(photoWin?.box && photoWin?.zoomed),
          `框=${photoWin?.box} 放大=${photoWin?.zoomed}`,
        );
        /* 用户 2026-09-30：「进行缺失标注对比啥的」→ 默认并排：左边整张、右边放大 */
        check(
          `  ↳ 并排对照（原图 · 整张 / 疑点区域 · 放大）`,
          photoWin?.panes === 2,
          `画面块数=${photoWin?.panes}（期望 2）`,
        );
      }
      /*
        ── ㉒「证据对照」播完应自动切到**内部点云**（用户 2026-09-30 追加的那一项）──
        这一轮落在数字孪生页、台词说的是"两路共同提示的项目优先展示"，
        内部响应区（虫蛀/裂痕）就是两路汇到的那一层。
        ⚠ **⑪ 不许切**：那一轮讲外观，台词里还写着「不能确认内部是否存在空洞」——
          提前把内部结论摆出来就是剧情矛盾（`twinViewAction.test.ts` 钉住这条）。
      */
      if (round.roundNo === "㉒") {
        const internal = await machine.waitFor(
          `(() => {
            const active = document.querySelector('.twin-view__tab.is-active');
            const stage = document.querySelector('.ipc__stage');
            if (!active || !stage || !(active.textContent || '').includes('内部点云')) return null;
            const points = Number(stage.getAttribute('data-points') || 0);
            return points > 10_000 ? { tab: (active.textContent || '').trim(), points } : null;
          })()`,
          { timeoutMs: 25_000 },
        );
        check(
          `  ↳ ㉒ 播完自动切到「内部点云」并画出点`,
          Boolean(internal),
          internal ? `${internal.tab} · ${internal.points} 个点` : "25 秒内没切过去",
        );
      }
      /*
        ⚠ 分两步等：先等构件条出现（证明页内定位到了三维场景），
        再等**最终态**（四根都在 + 重点构件高亮 + 选中 Z04）。
        为什么不等"中间态"：⑪ 那一轮是**跟着播报逐柱点亮**的，最后一根要等台词念完
        （88 字约 16 秒）由收尾补拍点亮；6 秒的窗口只能看到前三根。
      */
      const first = await machine.waitFor(
        `(() => { const n = document.querySelectorAll('.twin-col').length; return n > 0 ? n : null; })()`,
        { timeoutMs: 8000 },
      );
      check(`  ↳ 四柱构件条渲染出来`, Boolean(first), first ? `出现 ${first} 根` : "构件条没渲染出来");
      const content = await machine.waitFor(
        `(() => {
          const cols = [...document.querySelectorAll('.twin-col')];
          const text = document.body.innerText || '';
          const current = (document.querySelector('.twin-col.is-current .twin-col__id')?.textContent || '').trim();
          return cols.length === 4 && /建议优先复核/.test(text) && /Z04 下部区域/.test(text) && current === 'Z04'
            ? { count: cols.length, ids: cols.map((n) => (n.querySelector('.twin-col__id')?.textContent || '').trim()) }
            : null;
        })()`,
        { timeoutMs: 25_000 },
      );
      check(
        `  ↳ 最终四根都在、重点构件带「建议优先复核」、且选中 Z04`,
        Boolean(content),
        content ? `${content.count} 根：${content.ids.join(" ")}` : "25 秒内没等到最终态（逐柱点亮的收尾没发生？）",
      );
    }

    /* 更新交付页：交付包 / 目标版本 / 回验与取用记录（版本回执 + 自检）都要在 */
    if (nav.route === "/firmware" && nav.tab === "delivery") {
      const content = await machine.waitFor(
        `(() => {
          const text = document.body.innerText || '';
          const need = ['已发布产物', '回验与取用记录'];
          const hit = need.filter((k) => text.includes(k));
          return hit.length === need.length
            ? { hits: hit.length, pkg: /DEMO-PKG-02/.test(text), target: /DEMO-M02b/.test(text), selfCheck: /自检/.test(text) }
            : null;
        })()`,
        { timeoutMs: 8000 },
      );
      check(`  ↳ 更新交付页内容`, Boolean(content), content ? "已发布产物与回验记录两屏都在" : "交付页没渲染出来");
      if (content) {
        check(
          `  ↳ 交付包、目标版本与自检结论都在屏上`,
          content.pkg && content.target && content.selfCheck,
          `包=${content.pkg} 目标版本=${content.target} 自检=${content.selfCheck}`,
        );
      }
    }

    /* 素材质检页：素材清单 + 两处低清晰度标记 + 切片检查，三块都要真的渲染出来 */
    if (nav.route === "/materials") {
      /*
        ⚠ 等待条件必须把**下面每一条检查要看的字**都写进去（2026-09-30 修）。
        旧写法只等那 5 个素材数字，拿到就快照；而这页的板块是先后挂上的 ——
        在 5173（dev，模块按需加载更慢）上快照取早了，后两块还没渲染，
        于是"需重看的画面 / 切片检查 / 预置结果"三条**稳定报假红**，8000 上却全绿。
        现在：等到全部条件齐了再快照；超过 15 秒才判失败（分得清"慢"与"没渲染"）。
      */
      const content = await machine.waitFor(
        `(() => {
          const text = document.body.innerText || '';
          const need = ['3840×1920', '214', '00:43', '02:17', '缺失文件'];
          const marks = /需要重看的画面/.test(text);
          const checks = /切片与重建前检查/.test(text);
          const origin = /预置结果/.test(text);
          const hit = need.filter((k) => text.includes(k));
          if (hit.length !== need.length || !marks || !checks || !origin) return null;
          return { hits: hit.length, marks, checks, origin };
        })()`,
        { timeoutMs: 15_000 },
      );
      check(`  ↳ 素材质检页内容`, Boolean(content), content ? "分辨率 / 关键帧 / 两处标记 / 缺失文件都在" : "素材清单没渲染出来（15 秒）");
      if (content) {
        check(`  ↳ 需重看的画面与切片检查两块都在`, content.marks && content.checks);
        check(`  ↳ 标明检查结论来自「预置结果」`, content.origin);
      }
    }
  }

  if (skipped.length) console.log(`\n  非语音触发的轮次（下面用快捷键真按一遍）：${skipped.join("、")}`);

  /*
    ── 本地事件触发的那几轮（⑬ 小木主动预警）──────────────
    它们**不收语音**（`triggerSource: "local-event"`，剧本里是小木自己起头），
    现场靠快捷键触发（`scriptShortcutEntries.ts` 里 `proactive: true` 的条目）。
    这里就用那条快捷键真按一遍：Ctrl+<字母> 再按数字，然后断言
    ① 页面被带到剧本对应的页签；② 预警小窗出现（用户口径：「⑬ 这个触发时，
    会弹出预警窗口，然后带个确认按钮」）。
  */
  for (const round of rounds.filter((item) => item.triggerSource !== "voice")) {
    const entry = SCRIPT_SHORTCUT_ENTRIES.find((item) => item.roundNo === round.roundNo);
    if (!entry) {
      check(`${round.roundNo} ${round.title}`, false, "没有对应的快捷键条目，现场无法主动发起");
      continue;
    }
    await machine.evaluate(`location.hash = '#/console'`);
    await sleep(250);
    const [letter, digit] = String(entry.key).split(":");
    await machine.evaluate(`(() => {
      const fire = (key) => window.dispatchEvent(new KeyboardEvent('keydown', {
        key, code: 'Key' + key.toUpperCase(), ctrlKey: true, bubbles: true, cancelable: true }));
      fire(${JSON.stringify(letter)});
      fire(${JSON.stringify(digit)});
      return true;
    })()`);
    const parts = expectHash(round.nav ?? { route: "/" });
    let hash = "";
    for (let i = 0; i < 40; i += 1) {
      await sleep(250);
      hash = await machine.evaluate(`location.hash`);
      if (parts.every((part) => String(hash).includes(part))) break;
    }
    const hit = parts.every((part) => String(hash).includes(part));
    check(
      `${round.roundNo} ${round.title}（主动发起 · Ctrl+${letter.toUpperCase()}+${digit}）`,
      hit,
      hit ? `→ ${hash}` : `期望 ${parts.join(" & ")}，实际 ${hash}`,
    );
    if (!hit) continue;
    /* 预警小窗：警示描边 + 「预警」角标 + 一个确认按钮（这是用户点名要的形态） */
    const alert = await machine.waitFor(
      `(() => {
        const box = document.querySelector('.dsf--alert');
        if (!box) return null;
        const button = [...box.querySelectorAll('button')].find((node) => !node.className.includes('dsf__close'));
        return { alert: true, badge: /预警/.test(box.textContent || ''), button: Boolean(button), label: (button?.textContent || '').trim() };
      })()`,
      { timeoutMs: 6000 },
    );
    check(
      `  ↳ 弹出预警小窗且带确认按钮`,
      Boolean(alert?.alert && alert?.badge && alert?.button),
      alert ? `角标=${alert.badge} 按钮=${alert.button}（${alert.label}）` : "预警小窗没出现",
    );
  }

  /*
    收工：清掉 ⑥⑮ 这一轮在服务端生成的任务卡。
    卡片是幂等生成的（同一批只生成一次），留在库里会让演示现场看不到"卡片一张张出现"，
    而且上一轮验收留下的"已保存 / 已回执"状态会与新台词矛盾。默认清掉，`--keep-cards` 保留。
    只删 kind='taskCard' 的行 —— 服务端没有删除动作（卡片随工单级联清理），
    这里直接动库是验收工装的收尾，不是产品路径。
  */
  if (!args.includes("--keep-cards")) {
    try {
      const db = new DatabaseSync(DB_FILE);
      const removed = db.prepare("DELETE FROM entities WHERE kind='taskCard'").run();
      db.close();
      console.log(`\n  收工：清掉本轮生成的任务卡 ${removed.changes} 张（--keep-cards 可保留）`);
    } catch (error) {
      console.log(`\n  收工：任务卡清理失败（${String(error?.message ?? error)}）—— 演示前请手动清一次`);
    }
  }

  /* 留一张新页面的截图存档（内容判据在上面，截图只给评审看排版） */
  await machine.evaluate(`location.hash = '#/hardware?tab=env'`);
  await sleep(1200);
  const shot = await machine.shot("小木带路-环境记录页");
  if (shot) console.log(`  截图：${shot}`);
  console.log(failed === 0 ? "\n✓ 小木带路：全部通过" : `\n✗ 有 ${failed} 项未通过`);
  process.exitCode = failed === 0 ? 0 : 1;
} catch (error) {
  console.error(`工装异常：${error?.stack ?? error}`);
  process.exitCode = 1;
} finally {
  machine.kill();
}
