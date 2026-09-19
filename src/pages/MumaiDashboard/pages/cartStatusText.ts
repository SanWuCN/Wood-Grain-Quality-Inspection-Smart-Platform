/**
 * 小车状态里那两句"读数"的口径（纯函数，给 `Mapping.tsx` 用）
 *
 * ── 为什么单独放 `.ts` ────────────────────────────────────────────────
 * 单测只认 `.ts`（`.tsx` 进不了 Node 的测试运行器），而这两句是**现场会被念出来的话**，
 * 必须能断言。口径来自服务端快照（`cart.status`）：
 *   · `ageMs` = 最后一次收到小车状态到现在的时间；`null` = **本轮服务启动后还没收到过**
 *     （与"刚断线"是两回事，见 `server/services/cart.mjs` 的注释）；
 *   · 服务端的设备自检里有一份**同措辞**的实现（`device-readiness.mjs` 的 `lastSeenText`），
 *     改这里要顺手改那边（.mjs 与 .ts 没法共享代码）。
 */

/** 「多久没收到小车状态」 */
export function lastSeenText(ageMs: number | null | undefined): string {
  if (ageMs === null || ageMs === undefined) return "本轮服务启动后还没收到过小车状态";
  const seconds = Math.round(Number(ageMs) / 1000);
  if (seconds < 5) return "刚刚还收到过小车状态";
  if (seconds < 60) return `最后收到小车状态：${seconds} 秒前`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `最后收到小车状态：${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `最后收到小车状态：${hours} 小时前`;
  return `最后收到小车状态：${Math.round(hours / 24)} 天前`;
}

/**
 * 该用哪个"年龄"来讲话。
 *
 * 优先 `ageMs`（**本轮**服务收到的最后一次状态）；本轮还没收到就退回
 * `lastSeenAt`（服务端**落盘**的上一次成功联系时刻，见 `cart.mjs` 的 `rememberLastSeen`）——
 * 现场问的是"上次是什么时候通的"，服务刚重启也要答得上来。
 * 两者都没有才是"从没收到过"（返回 null，由 `lastSeenText` 说那一句）。
 */
export function cartAgeMs(
  status: { ageMs?: number | null; lastSeenAt?: string | null } | null | undefined,
  nowMs = Date.now(),
): number | null {
  if (status?.ageMs !== null && status?.ageMs !== undefined) return status.ageMs;
  const saved = status?.lastSeenAt ? Date.parse(status.lastSeenAt) : Number.NaN;
  if (Number.isNaN(saved)) return null;
  return Math.max(0, nowMs - saved);
}
