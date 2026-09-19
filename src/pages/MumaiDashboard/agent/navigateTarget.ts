/**
 * 「这一步要不要真的跳转」——给 `navigate_page` 用的纯函数
 *
 * ── 为什么需要它（用户 2026-10-01）──────────────────────────────────
 * 「期中有个对话我记得是正常已经到数字孪生页面展示了，触发对话原地跳转一下
 *   反而导致数字孪生重新加载」。
 *
 * 症状：小木带路的某些轮次落点与**当前所在的页面**是同一个地方（例如已经在 `/twin`
 * 了，⑫/㉒ 的落点又是 `/twin`；或者 ⑪ 已经把 `?component=Z04` 带上，下一轮又跳 `/twin`）。
 * 这时 `navigate()` 仍然会推一条历史、改一次 query —— 数字孪生那种重资源页面
 * （6.7 MB 高斯模型 + Spark 画布）会因此重新初始化，看起来就是"整屏重新加载"。
 *
 * 判据（**当前地址已经满足目标**就不跳）：
 *   · 路径相同；且
 *   · 目标里带的每一个查询参数，在当前地址里都存在且值相同。
 *
 * 注意这是"满足"而不是"相等"：`/twin?component=Z04` **满足** `/twin`
 * （目标要的信息已经在地址里了，再跳一次只会摘掉参数、把 `selected` 重新算一遍），
 * 但 `/twin` **不满足** `/twin?component=Z04`（少了参数，必须跳过去把它选上）。
 */
export type ParsedRoute = { path: string; params: Map<string, string> };

/** 解析 `#/twin?component=Z04` / `/twin?component=Z04` 这种地址 */
export function parseRoute(value: string): ParsedRoute {
  const raw = String(value ?? "").trim().replace(/^#/, "");
  const [path, query = ""] = raw.split("?");
  const params = new Map<string, string>();
  for (const pair of query.split("&")) {
    if (!pair) continue;
    const index = pair.indexOf("=");
    const key = index >= 0 ? pair.slice(0, index) : pair;
    const param = index >= 0 ? pair.slice(index + 1) : "";
    if (key) params.set(decodeURIComponent(key), decodeURIComponent(param));
  }
  return { path: path || "/", params };
}

/** 当前地址（`currentHash`）是不是已经满足目标地址（`target`）——满足就不必再跳 */
export function routeSatisfied(currentHash: string, target: string): boolean {
  const current = parseRoute(currentHash);
  const want = parseRoute(target);
  if (current.path !== want.path) return false;
  for (const [key, value] of want.params) {
    if (!current.params.has(key) || current.params.get(key) !== value) return false;
  }
  return true;
}
