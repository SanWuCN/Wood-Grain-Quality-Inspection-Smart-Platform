/**
 * 账号显示名（前端侧）
 *
 * 服务端返回的 actor 只有 id（`shen` / `shi` / `rao` / `ma`），界面上要写姓名。
 * 这张表与 server/services/permissions.mjs 的 ACCOUNT_NAME 同源，
 * 但前端不能 import 服务端文件（构建产物里不该出现服务端代码），所以各存一份 ——
 * 两处都只有四个键，改一处时另一处必须同步，这一点写在两边的注释里。
 */

export const ACCOUNT_NAME: Record<string, string> = {
  shen: "沈 · 项目经理",
  shi: "史 · 人工智能架构师",
  rao: "饶 · 全栈开发工程师",
  ma: "马昱天 · 具身智能工程师",
};

/** 取显示名；未知账号名原样返回，不编造 */
export function actorName(accountId: string | null | undefined): string {
  if (!accountId) return "—";
  return ACCOUNT_NAME[accountId] ?? accountId;
}

/**
 * 只要姓名，不带岗位（`史` 而不是 `史 · 人工智能架构师`）。
 *
 * 给"一行里还要塞帧号、构件、时间"的列表用（数字孪生的机位关键帧列表就是）；
 * 正文与播报仍走 `actorName()`，岗位信息在那里有用。
 */
export function actorShortName(accountId: string | null | undefined): string {
  return actorName(accountId).split(" · ")[0];
}
