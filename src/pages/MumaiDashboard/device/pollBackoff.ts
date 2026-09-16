/**
 * 设备数据轮询的**退避节奏**（纯逻辑，与 React 分开以便单测）
 *
 * ── 解决什么问题（实测现象）──────────────────────────────────────────
 * 硬件页的轮询在两种情况下会**连续失败**，而原来的实现每次都照常打请求：
 *   · 页面刚加载、登录令牌还没写进 localStorage（`useDeviceLink` 里已有一道
 *     `if (!readToken()) return` 的拦截，但竞态下仍可能漏过一次）；
 *   · 后端重启换了签名密钥，页面还开着、手里令牌已失效。
 * 两种都不影响功能（下一轮就会自愈），但会在控制台**刷红字**——
 * 而 `tools/accept.mjs` 的验收判据里有"console error = 0"，
 * 于是整轮验收时红时绿（实测同一份代码连跑三遍：一遍 /mapping 假红、
 * 一遍 /firmware 报 4 条 401、一遍全绿）。
 *
 * ── 判据 ────────────────────────────────────────────────────────────
 *   · 成功一次就立刻回到正常节奏（不留"退避后遗症"）；
 *   · 连续失败按倍数退避，但**有上限**，不能退到再也不刷新；
 *   · 上限必须仍小于"数据过期"的容忍度，否则页面会长期显示旧值。
 */

/** 连续失败时，第 n 次失败之后应等待的毫秒数（n 从 1 开始） */
export const POLL_BACKOFF_BASE_MS = 5000;
export const POLL_BACKOFF_FACTOR = 2;
/** 退避上限：1 分钟。再长就不合适了 —— 设备本来每 2 秒上报一份 */
export const POLL_BACKOFF_MAX_MS = 60000;

/**
 * 计算下一次轮询的间隔。
 *
 * @param baseMs 正常节奏（毫秒）
 * @param consecutiveFailures 连续失败次数（0 = 上次成功）
 */
export function nextPollDelayMs(baseMs: number, consecutiveFailures: number): number {
  if (baseMs <= 0) return 0;
  const failures = Math.max(0, Math.floor(consecutiveFailures));
  if (failures === 0) return baseMs;
  const grown = baseMs * POLL_BACKOFF_FACTOR ** (failures - 1);
  /* 退避后的间隔至少是正常节奏，且不超过上限 */
  return Math.max(baseMs, Math.min(POLL_BACKOFF_MAX_MS, grown));
}

/**
 * 这次失败是否属于"等一下就会好"的（值得退避而不是报错给用户）。
 *
 * 401（令牌没到位/失效）与网络层失败（后端重启中）都算；
 * 其它（例如 403 权限不足、404 设备不存在）不该退避 —— 那等到天亮也不会好，
 * 应当照常把错误显示出来。
 */
export function isTransientPollFailure(status: number | null | undefined): boolean {
  if (status === 401 || status === 408 || status === 429) return true;
  if (typeof status === "number" && status >= 500) return true;
  /* 没有状态码 = 网络层失败（连接被拒、超时） */
  return status === undefined || status === null;
}
