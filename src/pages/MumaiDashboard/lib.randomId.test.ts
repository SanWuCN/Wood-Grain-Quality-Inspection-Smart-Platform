/**
 * `randomId()` —— 幂等键 / 事件 ID 生成器
 *
 * ── 这一条在防什么（用户 2026-09-18 报的毛病）──────────────────────
 * 「我为什么在内网地址上按不了 ctrl 加 q 加 l 的呼出新工单」。
 * 根因：隐藏快捷键用 `crypto.randomUUID()` 生成事件 ID，而它**只在安全上下文**
 * （https / localhost）里存在 —— 同事从 `http://<局域网IP>:8000` 打开时它是 undefined，
 * 于是抛 `TypeError: crypto.randomUUID is not a function`，请求根本没发出去。
 *
 * 所以这里把"没有 randomUUID 的环境"**真的造出来**再断言（不是只读文档）：
 * 临时把 `globalThis.crypto` 换成一个只有 `getRandomValues` 的替身，
 * 跑完再换回去。测试环境（Node 24）本身是有 randomUUID 的，不这样造就没法覆盖。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { randomId } from "./lib.ts";

/** 临时替换 globalThis.crypto，跑完恢复（Node 24 里它是可写属性） */
function withCrypto<T>(value: unknown, run: () => T): T {
  const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", { value, configurable: true, writable: true });
  try {
    return run();
  } finally {
    if (original) Object.defineProperty(globalThis, "crypto", original);
    else delete (globalThis as { crypto?: unknown }).crypto;
  }
}

/** 只有 getRandomValues 的替身：就是"内网 http"下浏览器给的形状 */
const insecureCrypto = {
  getRandomValues(bytes: Uint8Array) {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 37 + 11) % 256;
    return bytes;
  },
};

test("安全上下文（有 randomUUID）时用 UUID，前缀照传", () => {
  const id = randomId("evt");
  assert.match(id, /^evt-[0-9a-f-]{36}$/, `实得 ${id}`);
  assert.notEqual(randomId("evt"), randomId("evt"), "两次不能相同");
});

test("内网 http（没有 randomUUID）也要能生成，不许抛错", () => {
  const id = withCrypto(insecureCrypto, () => randomId("evt"));
  assert.match(id, /^evt-[0-9a-z]+-[0-9a-z]+-[0-9a-f]{32}$/, `实得 ${id}`);
  /* 生成器本身不依赖 randomUUID 是否存在 —— 这条断言就是当初缺的那一步 */
  assert.ok(!id.includes("undefined"), "不能把 undefined 拼进 id");
});

test("内网 http 下连续生成仍然唯一（16 字节随机 + 时间片 + 会话内序号）", () => {
  /*
    ⚠ 替身故意是**确定性**的（每次都吐同一串字节），时间片也是同一毫秒 ——
    也就是说这一组 50 个 id 的唯一性**只能**来自会话内序号。
    现场"同一毫秒连按两次"正是这个形状：光靠时间片会撞键，
    而撞键 = 服务端把第二次按键当成第一次的回放（用户看着就是"按了没反应"）。
  */
  const ids = withCrypto(insecureCrypto, () => new Set(Array.from({ length: 50 }, () => randomId("k"))));
  assert.equal(ids.size, 50, `50 次生成必须互不相同，实得 ${ids.size} 个不同值`);
});

test("连 getRandomValues 都没有时退回 Math.random，仍然不抛错", () => {
  const id = withCrypto({}, () => randomId("req"));
  assert.match(id, /^req-[0-9a-z]+-[0-9a-z]+-[0-9a-f]{32}$/, `实得 ${id}`);
});

test("crypto 整个不存在（极端环境）也能出 id", () => {
  const id = withCrypto(undefined, () => randomId("evt"));
  assert.match(id, /^evt-[0-9a-z]+-[0-9a-z]+-[0-9a-f]{32}$/, `实得 ${id}`);
});
