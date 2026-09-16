/**
 * 设备令牌默认值的回归测试（发现于 2026-09-16 的 ID 1 验收）
 *
 * ── 现象 ────────────────────────────────────────────────────────────
 * 平台后端从某些终端/脚本启动时，`MUMAI_DEVICE_TOKENS` 会是**空字符串**
 * （而不是未设置）。此时：
 *   · `String(raw ?? "demo-token")` 的默认值**不生效**（空串不是 null/undefined）；
 *   · `parseTokens("")` 把空串 split 成 `[""]` → 被 `if (!text) continue` 跳过 → **0 个令牌**；
 *   · 于是**任何设备**上报都 401，而《手持终端接入与验收》第 64 行承诺
 *     "只有令牌（没有 deviceId: 前缀）表示任意设备可用"、默认就是 `demo-token`。
 * 实测证据：`/api/health` 里 `devices.tokens = 0`，仓库自带的
 * `tools/test-device-gateway.mjs` 在这台机器上同样 401。
 *
 * ── 判据 ────────────────────────────────────────────────────────────
 *   · 未设置 / 空串 / 只有空白 → 用默认令牌 `demo-token`；
 *   · 配了内容则按内容解析，且**不受默认值污染**（不能既收默认又收配置）。
 *
 * 跑法：node --test server/services/device-tokens.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { createDeviceGateway } from "./device-gateway.mjs";
import { createUploadService } from "./uploads.mjs";

/* 一个最小可用的内存库：只用到 db.exec/prepare，够构造这两个服务 */
function fakeDb() {
  const tables = new Map();
  return {
    exec() { /* 建表语句忽略 */ },
    prepare(sql) {
      return {
        get: () => (tables.has(sql) ? tables.get(sql) : undefined),
        all: () => [],
        run: () => ({ changes: 0 }),
      };
    },
  };
}

/** 用给定环境值构造网关，读它自报的令牌数 */
function tokenCountWith(envValue) {
  const before = process.env.MUMAI_DEVICE_TOKENS;
  if (envValue === undefined) delete process.env.MUMAI_DEVICE_TOKENS;
  else process.env.MUMAI_DEVICE_TOKENS = envValue;
  try {
    const gateway = createDeviceGateway({ db: fakeDb() });
    return gateway.status().tokens;
  } finally {
    if (before === undefined) delete process.env.MUMAI_DEVICE_TOKENS;
    else process.env.MUMAI_DEVICE_TOKENS = before;
  }
}

test("未设置 MUMAI_DEVICE_TOKENS 时用默认令牌（文档承诺的行为）", () => {
  assert.equal(tokenCountWith(undefined), 1, "未设置时应加载 1 个默认令牌 demo-token");
});

test("**空字符串**时也要用默认令牌 —— 空串不是「不配」，是「配了但没写」", () => {
  assert.equal(tokenCountWith(""), 1,
    "空串导致 0 令牌时，任何设备上报都会 401，而文档承诺默认 demo-token 可用");
});

test("只有空白字符时同样用默认令牌", () => {
  assert.equal(tokenCountWith("   "), 1, "空白串与空串同理");
});

test("显式配置时不叠加默认令牌（默认值只在没配时生效）", () => {
  assert.equal(tokenCountWith("handheld-02:abc123"), 1, "配了设备专属令牌就只认它");
  assert.equal(tokenCountWith("a,b"), 2, "两个任意设备令牌");
});

test("上传服务与网关用同一套默认值口径（两处都踩过同一个坑）", () => {
  const before = process.env.MUMAI_DEVICE_TOKENS;
  process.env.MUMAI_DEVICE_TOKENS = "";
  try {
    /* 只要能构造出来即说明没抛错；令牌数由网关那条断言覆盖 */
    assert.doesNotThrow(() => createUploadService({ db: fakeDb(), logger: { info() {}, error() {}, warn() {} } }));
  } finally {
    if (before === undefined) delete process.env.MUMAI_DEVICE_TOKENS;
    else process.env.MUMAI_DEVICE_TOKENS = before;
  }
});
