/**
 * 共享服务 · 登录令牌
 *
 * PRD §5.3：「登录会话与演示会话分开。每人保存自己的登录token，统一加入同一个
 * demoSessionId」。所以令牌只回答「你是谁」，不回答「你在哪场演示」——
 * 后者由请求里的 sessionId 决定。
 *
 * 令牌是自校验的（HMAC），不落库：演示服务重启后四端不用重新登录，
 * 而签名保证账号名不能自己改。密钥可用 MUMAI_SECRET 固定，
 * 不设就每次启动随机生成（重启后旧的令牌失效，会要求重新登录，这是可接受的）。
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { ACCOUNT_LOGIN, DEMO_PASSWORD, ROLE_PERMISSIONS, permissionsOf } from "./permissions.mjs";

const SECRET = process.env.MUMAI_SECRET ?? randomBytes(32).toString("hex");

function sign(payload) {
  return createHmac("sha256", SECRET).update(payload).digest("base64url");
}

export function issueToken(accountId, issuedAt = Date.now()) {
  const payload = `${accountId}.${issuedAt}`;
  return `${Buffer.from(payload, "utf8").toString("base64url")}.${sign(payload)}`;
}

/** 校验令牌；返回 accountId 或 null。签名比较用 timingSafeEqual，不做字符串相等 */
export function verifyToken(token) {
  if (typeof token !== "string") return null;
  const separator = token.lastIndexOf(".");
  if (separator <= 0) return null;
  let payload;
  try {
    payload = Buffer.from(token.slice(0, separator), "base64url").toString("utf8");
  } catch {
    return null;
  }
  const expected = sign(payload);
  const actual = token.slice(separator + 1);
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const accountId = payload.split(".")[0];
  return accountId in ROLE_PERMISSIONS ? accountId : null;
}

/** 按账号名或拼音登录名找账号 id */
export function resolveAccount(input) {
  const value = String(input ?? "").trim().toLowerCase();
  if (!value) return null;
  if (value in ROLE_PERMISSIONS) return value;
  const byLogin = Object.entries(ACCOUNT_LOGIN).find(([, login]) => login === value);
  if (byLogin) return byLogin[0];
  const byPrefix = Object.entries(ACCOUNT_LOGIN).find(([id, login]) => login.startsWith(value) || id.startsWith(value));
  return byPrefix ? byPrefix[0] : null;
}

/**
 * 账号 id → 下发给客户端的 actor 对象。
 *
 * ⚠ **只有这一个地方拼这个形状**：`/api/auth/login` 与 `/api/auth/me` 必须给同一个
 * 形状的对象（`{id, login, name}`）—— 一个给对象、另一个给裸 id，前端拿到的
 * 就是"有时有 id 有时没有"，表现为端明细里账号变成"未登录"这类怪事（实测踩到过）。
 */
export function actorOf(accountId) {
  return { id: accountId, login: ACCOUNT_LOGIN[accountId], name: accountId };
}

export function login(account, password) {
  const accountId = resolveAccount(account);
  if (!accountId) return { ok: false, status: 401, code: "UNKNOWN_ACCOUNT", message: "账号不存在" };
  if (password !== DEMO_PASSWORD) return { ok: false, status: 401, code: "WRONG_PASSWORD", message: "口令不正确" };
  return {
    ok: true,
    token: issueToken(accountId),
    actor: actorOf(accountId),
    allowedActions: permissionsOf(accountId),
  };
}

/** 从请求头取令牌并解析账号 */
export function actorFromRequest(req) {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  return verifyToken(token);
}
