/**
 * 令牌保鲜闸门：**能确定会 401 的请求，干脆不打**。
 *
 * ── 解决什么问题 ────────────────────────────────────────────────────
 * 设备轮询（`useDeviceLink`）本来已经拦掉"完全没有令牌"的情况（注释里写着
 * "先打一轮必然是 401，控制台里全是红字"）。但**手里有令牌、令牌却已失效**时漏了：
 * 服务端 `auth.mjs` 没设 `MUMAI_SECRET` 时每次启动随机生成签名密钥，
 * 于是"浏览器还开着（或 localStorage 里留着上一个服务实例的令牌）+ 后端重启过"
 * 这种最常见的情形下，页面发出的第一批设备请求必然 401。
 *
 * `apiRequest` 虽然会自动补登录并重放成功，但**那一次 401 响应已经被浏览器
 * 记进控制台**，事后无法撤销 —— 而 `tools/accept.mjs` 的验收判据里有
 * "console error = 0"，于是同一份代码连跑三遍会出现：一遍红、一遍绿。
 *
 * 这里在轮询之前先问一次 `/api/auth/me`：
 *   · 该接口对"没有令牌/令牌过期"回的是 `actor: null`（**正常答案，不是 401**，
 *     见 `client.ts` 的说明），所以这次探测本身不会产生任何红字；
 *   · `actor` 为空 → 用本地会话重新登录，把令牌换成有效的；
 *   · 拿不到答案（服务没起）→ 返回 false，让调用方照常按原节奏重试。
 *
 * 探测**带缓存**：同一个页面生命周期里只探一次，避免每次轮询都多打一个请求。
 */

/** 探测结果：true = 令牌可用（或已换成可用的）；false = 这次别打业务请求 */
export type TokenFreshness = () => Promise<boolean>;

export function createTokenGate(deps: {
  /** 读取当前令牌（null 表示没有） */
  readToken: () => string | null;
  /** 问一次"我是谁"：令牌无效时要回 `actor: null` 而不是抛 401 */
  probeActor: () => Promise<unknown | null>;
  /** 用本地会话重新登录；成功返回 true */
  relogin: () => Promise<boolean>;
}): TokenFreshness {
  /** 已经确认过可用的令牌值 —— 同一个令牌不再重复探测 */
  let verifiedToken: string | null = null;
  let inFlight: Promise<boolean> | null = null;

  return async () => {
    const token = deps.readToken();
    if (!token) return false;
    if (token === verifiedToken) return true;
    if (inFlight) return inFlight;

    inFlight = (async () => {
      try {
        const actor = await deps.probeActor();
        if (actor) {
          verifiedToken = token;
          return true;
        }
        /*
          令牌无效（actor 为 null）：换一个新的再放行。
          换不到也返回 false —— 让调用方跳过这一轮，而不是打一个注定 401 的请求。
        */
        const ok = await deps.relogin();
        if (!ok) return false;
        verifiedToken = deps.readToken();
        return verifiedToken !== null;
      } catch {
        /* 探测本身失败（服务没起）：不算"令牌无效"，也不放行打业务请求 */
        return false;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };
}
