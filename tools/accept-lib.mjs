/**
 * 全平台验收的**判据库**（与 `accept.mjs` 分开，为的是可单测）
 *
 * ── 为什么要分出来 ──────────────────────────────────────────────────
 * `accept.mjs` 里"console error = 0"这条判据原本把所有错误一视同仁，
 * 于是把**诚实的"功能未配置"**也计成缺陷：
 *   · 建图巡航页要读小车链路，未配置车端地址时后端返回 503 `CART_UNCONFIGURED`；
 *   · 页面本身处理得很好（显示"平台侧还没配置这台小车的地址与控制令牌，当前只能查看"），
 *     但浏览器照样记一条 "Failed to load resource: 503"。
 * 实测这一条把 `/mapping` 判成 ✗（6 条错误全是同一个 503 的重复计数）。
 *
 * ── 不能简单地把这类错误过滤掉 ──────────────────────────────────────
 * 过滤掉就变成假绿：真正的 503（服务挂了）会被一起放过。
 * 所以这里做的是**分类**而不是删除：
 *   · 先要求该资源确实是"未配置/未接入"（向接口要 `configured:false` 之类的证据）；
 *   · 分出来的条目单独在报告里列一节，**看得到但不计入失败数**。
 * 拿不到"未配置"证据时，照旧算失败 —— 判据不能靠猜。
 */

/**
 * 判断一个 URL 是否属于"本机未接入"的硬件/外设链路。
 *
 * 这些链路在演示机上本来就不存在（真机接入才有），与"功能坏了"是两件事。
 * 名单刻意写得很窄：只有明确属于外设接入的才进得来。
 */
const UNAVAILABLE_PREFIXES = [
  "/api/cart/",      // 小车链路（需 server/data/cart.json）
  "/api/sensors/",   // SensorTag / 蓝牙工装
  "/api/capture/screen/", // 采集屏投屏（需配置屏幕地址）
];

export function isUnavailableResource(url) {
  try {
    const path = new URL(url, "http://127.0.0.1").pathname;
    return UNAVAILABLE_PREFIXES.some((prefix) => path.startsWith(prefix));
  } catch {
    return false;
  }
}

/** 从一行 console/log 文本里取出资源 URL（取不到返回 null） */
export function resourceUrlOf(line) {
  const m = String(line).match(/https?:\/\/[^\s"']+/);
  return m ? m[0] : null;
}

/**
 * 把一批日志分成 { failures, expected }。
 *
 * @param lines 原始日志行
 * @param opts.probe 异步函数 `(url) => { status, body }`：直接探该资源。
 * @param opts.probeState 异步函数 `(url) => { configured?: boolean, link?: string }`：
 *        探**所属链路的状态端点**。有些资源本身回的是纯文本 503（没有 JSON 体），
 *        直接探它取不到证据；但同一链路的 `/status` 会明确给 `configured:false`。
 *        两条证据任一成立即可（实测 crate：`/api/cart/stream/camera` 是纯文本 503，
 *        而 `/api/cart/status` 明确回 `configured:false`）。
 * @param opts.skipPattern 已知的噪声（框架弃用告警等），直接丢弃
 */
export async function classifyLogLines(lines, { probe, probeState, skipPattern = /THREE\.Clock|deprecated/i } = {}) {
  const failures = [];
  const expected = [];
  const cache = new Map();

  for (const line of lines) {
    if (skipPattern.test(line)) continue;
    const url = resourceUrlOf(line);
    if (!url || !isUnavailableResource(url)) { failures.push(line); continue; }

    if (!cache.has(url)) cache.set(url, await evidenceFor(url, { probe, probeState }));
    const evidence = cache.get(url);
    if (evidence) expected.push({ line, url, evidence });
    else failures.push(line);
  }
  return { failures, expected };
}

/**
 * 取证：这个资源是不是"本机未接入"。
 *
 * 判据刻意严格 —— 只看状态码会把"服务挂了"当成"没配置"，所以要求
 * **业务层自证**：`configured:false` / `link:"unconfigured"`，或错误码里带
 * `*_UNCONFIGURED` / 消息里写"未配置/未接入"。取不到证据就返回 `null`（算失败）。
 */
async function evidenceFor(url, { probe, probeState }) {
  const direct = probe ? await probe(url).catch(() => null) : null;
  const body = direct?.body;
  if (body && typeof body === "object") {
    const code = String(body.code ?? "");
    const message = String(body.message ?? "");
    if (body.configured === false) return `configured=false`;
    if (/UNCONFIGURED|NOT_CONFIGURED|NO_CART|NO_DEVICE|未配置|未接入/.test(code + " " + message)) {
      return code || "错误码自证未配置";
    }
  }
  /* 直接探不到证据时，看所属链路的状态端点 */
  const state = probeState ? await probeState(url).catch(() => null) : null;
  if (state?.configured === false) return `状态端点 configured=false（link=${state.link ?? "?"}）`;
  if (String(state?.link ?? "") === "unconfigured") return "状态端点 link=unconfigured";
  return null;
}
