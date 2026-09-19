/**
 * 「本轮同步」读数 —— 讲解机按下某一轮之后，**各端有没有跟到这一轮的页面上**
 *
 * ── 为什么要有它（用户 2026-10-01 长期口径；本轮新增）──────────────────
 * 内网协同面板原来能看"谁连着、每台端停在哪一页"，但讲解人按下快捷键之后，
 * 屏幕上**没有一句当场可用的话**能说明"这一轮广播到哪几台机器、它们跟上了没有"。
 * 现场被问「两台机器是同一屏吗」时，只能挨个念端明细自己比对。
 *
 * ── 判据（复用已经测过的 `routeSatisfied`，不另写一套地址比较）──────────
 *   · 这一轮的落点 = `agentTurn.nav` 按 `withQuery` 拼出来的地址
 *     （与 `navigate_page` 同一套规则，否则会把跟上的端误判成没跟上）；
 *   · 某台端"跟上了" = 它当前页**已经满足**这一轮的落点（路径相同 + 目标参数都在）；
 *   · 本轮不跳页（`nav` 为空）→ 不做同页判断，只说"这一轮不换页"。
 *
 * 只读、只算，不发任何请求（数据由页面传入：`agentTurns` + `peers.ends`）。
 */
import type { AgentTurnEntity, CollabEnd } from "../api/client";
import { routeSatisfied } from "../agent/navigateTarget";
import { withQuery } from "../agent/tools";

/** `navigate_page` 会带上的查询键（与工具那边保持一致） */
const NAV_QUERY_KEYS = ["tab", "batch", "component", "view", "q", "order"];

export type RoundSyncEnd = {
  /** 「史 @ 192.168.101.8」这种可念的描述 */
  label: string;
  page: string;
  account: string;
};

export type RoundSyncView = {
  roundNo: string;
  text: string;
  at: string;
  by: string;
  /** 这一轮的落点（如 `/knowledge?tab=search`）；空串 = 本轮不换页 */
  target: string;
  /** 跟上的端（不含讲解机自己） */
  followed: RoundSyncEnd[];
  /** 没跟上的端，带它现在停在哪一页 */
  lagging: RoundSyncEnd[];
  /** 掉队那一列的抬头：刚讲完时是「还没上报」（端每 15 秒上报一次），否则是「没跟上」 */
  laggingLabel: string;
  /** 一句话结论，可以直接念 */
  verdict: string;
  tone: "ok" | "warn" | "info";
};

/** 把一轮的 `nav` 拼成地址（与 `navigate_page` 同规则） */
export function navTarget(nav: Record<string, unknown> | null | undefined): string {
  if (!nav) return "";
  const route = String(nav.route ?? "");
  if (!route || route === "order") return route === "order" ? "/orders" : "";
  const args: Record<string, string> = {};
  for (const key of NAV_QUERY_KEYS) {
    const value = nav[key];
    if (value !== undefined && value !== null && value !== "") args[key] = String(value);
  }
  return withQuery(route, args, NAV_QUERY_KEYS);
}

/** 某一轮的落点能不能被这台端的当前页"满足" */
export function endFollowed(page: string | null | undefined, target: string): boolean {
  if (!target) return false;
  if (!page) return false;
  /* 端的 page 可能是 `#/orders?order=x` 或 `/orders?order=x`，`routeSatisfied` 两种都认 */
  return routeSatisfied(page, target);
}

const endLabel = (end: CollabEnd): string =>
  `${end.accountName || end.accountId || "未登录"} @ ${end.address}${end.page ? ` · ${end.page}` : ""}`;
const endAccount = (end: CollabEnd): string => end.accountName || end.accountId || "未登录";

/**
 * 某一台端**跟到了第几轮**（端明细上那一小段后缀）。
 *
 * 把小木回合留痕按时间从新到旧扫一遍，第一条"落点 = 端当前页"的就是它跟到的那一轮。
 * 用在「现在连着的端」那一列上，把"谁 · 在哪一页"升级成"谁 · 已在第 ⑰ 轮"——
 * 讲解人扫一眼就知道哪台掉队、掉在哪一轮。
 *
 * @returns 轮次号（如 `⑰`）；这台端的当前页不满足任何一轮时返回 `null`（例如刚打开还在首页）
 */
export function endRoundNo(turns: AgentTurnEntity[], page: string | null | undefined): string | null {
  if (!page) return null;
  const ordered = [...turns].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  for (const turn of ordered) {
    const target = navTarget(turn.nav);
    if (target && endFollowed(page, target)) return turn.roundNo;
  }
  return null;
}

/** 端明细那一列的后缀：「· 已在第 ⑰ 轮」/「· 还没跟到任何一轮」 */
export function endRoundSuffix(turns: AgentTurnEntity[], page: string | null | undefined): string {
  const roundNo = endRoundNo(turns, page);
  return roundNo ? ` · 已在第 ${roundNo} 轮` : " · 还没跟到任何一轮";
}

/** 本机那一端的判定：地址是回环（`127.` / `::1` / `localhost`）就是这台服务器上的浏览器 */
export function loopbackEndIds(ends: CollabEnd[]): string[] {
  return ends
    .filter((end) => /^(::1|::ffff:127\.|127\.|localhost)/i.test(String(end.address ?? "")))
    .map((end) => end.id);
}

/**
 * 该把哪些端排除在"跟上的端"之外。
 *
 * ⚠ 不能无脑排除回环端：**同一台机器上开两个标签页**做双机演示时，两端都是回环，
 * 那样面板会说"只有本机一台端"，而屏幕上明明有两端（实测：`验收-多机同步` 就是两台
 * 真浏览器跑在同一台机器上，被这条判据挡成了假红）。
 * 所以只有**存在非回环端**（= 局域网里的同事）时才排除回环端（= 服务器本机那台浏览器）。
 */
export function selfEndIds(ends: CollabEnd[]): string[] {
  const loop = loopbackEndIds(ends);
  if (!loop.length || loop.length === ends.length) return [];
  return loop;
}

/**
 * 端明细里的「在哪一页」是**每 15 秒上报一次**的（客户端 `PING_EVERY_MS`，
 * 见 `api/client.ts` 的 ping）。所以刚讲完一轮、端还没上报时，读到的可能仍是上一页 ——
 * 这时说人家"掉队"就是**假警报**。20 秒以内按"还没上报"讲。
 */
export const PAGE_REPORT_LAG_MS = 20_000;

/** 这一轮是不是刚讲完（端可能还没上报当前页面） */
export function roundIsFresh(at: string, nowMs = Date.now()): boolean {
  const time = Date.parse(at);
  if (Number.isNaN(time)) return false;
  return nowMs - time < PAGE_REPORT_LAG_MS;
}

/**
 * 算这一轮的同步读数。
 *
 * @param turns 小木回合留痕（store 里的 `agentTurn`，顺序不限）
 * @param ends  当前会话连着的端（`peers.ends`）
 * @param excludeIds 要排除的端（**讲解机自己不算"跟上的端"**；用 `selfEndIds` 取）
 * @param nowMs 当前时刻（可注入，便于单测"刚讲完"这一档）
 * @returns 没有回合留痕时返回 null（还没讲过任何一轮）
 */
export function roundSyncView(
  turns: AgentTurnEntity[],
  ends: CollabEnd[],
  excludeIds: string[] = [],
  nowMs = Date.now(),
): RoundSyncView | null {
  if (!turns.length) return null;
  /* 最近一轮：按 at 取最新（同一毫秒时按数组顺序取靠后的那条） */
  const turn = turns.reduce((latest, item) => (item.at >= latest.at ? item : latest), turns[0]);
  const target = navTarget(turn.nav);
  const others = ends.filter((end) => !excludeIds.includes(end.id));
  const followed: RoundSyncEnd[] = [];
  const lagging: RoundSyncEnd[] = [];
  /*
    ⚠ 本轮不换页（`target` 为空）时**不分类**：`endFollowed(page, "")` 恒为 false，
    照常分类会把每一台端都塞进"掉队"，屏幕上就成了"N 台还在别的页面"——
    明明这一轮根本没要求换页（单测把这个反例钉住了）。
  */
  if (target) {
    for (const end of others) {
      const row = { label: endLabel(end), page: end.page ?? "", account: endAccount(end) };
      if (endFollowed(end.page, target)) followed.push(row);
      else lagging.push(row);
    }
  }

  let verdict: string;
  let tone: RoundSyncView["tone"];
  if (!target) {
    verdict = `第 ${turn.roundNo} 轮不换页，各端保持自己当前页面`;
    tone = "info";
  } else if (!others.length) {
    verdict = "本会话目前只有本机一台端（同事连上来后这里会显示他们跟没跟上）";
    tone = "warn";
  } else if (!lagging.length) {
    verdict = `${others.length} 台端都在第 ${turn.roundNo} 轮的页面上（${target}）`;
    tone = "ok";
  } else if (roundIsFresh(turn.at, nowMs)) {
    /* 刚讲完：端每 15 秒才上报一次，这时说"掉队"是假警报 —— 如实说"还没上报" */
    verdict = `${followed.length} 台端已同页 · ${lagging.length} 台还没上报当前页面（端每 15 秒上报一次，稍等再看）`;
    tone = "info";
  } else {
    verdict = `${followed.length} 台端已同页 · ${lagging.length} 台还在别的页面：${lagging
      .map((row) => `${row.account}（${row.page || "未上报页面"}）`)
      .join("、")}`;
    tone = "warn";
  }
  return {
    laggingLabel: target && lagging.length && roundIsFresh(turn.at, nowMs) ? "还没上报" : "没跟上",
    roundNo: turn.roundNo,
    text: turn.text,
    at: turn.at,
    by: turn.by || "（未记名）",
    target,
    followed,
    lagging,
    verdict,
    tone,
  };
}
