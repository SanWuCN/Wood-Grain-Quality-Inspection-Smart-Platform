/**
 * 令牌保鲜闸门的判据测试
 *
 * 每条都能证伪：放行了失效令牌 → 控制台继续刷 401；
 * 拦得太狠 → 设备面板再也不刷新（比红字更糟）。
 * 跑法：node --test src/pages/MumaiDashboard/device/tokenGate.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { createTokenGate } from "./tokenGate.ts";

/** 造一个可控的依赖集合，记录调用次数 */
function deps({
  token = "t1",
  actor = { id: "shi" },
  reloginOk = true,
  reloginToken = "t2",
  probeThrows = false,
}: {
  token?: string | null;
  actor?: { id: string } | null;
  reloginOk?: boolean;
  reloginToken?: string;
  probeThrows?: boolean;
} = {}) {
  const calls = { probe: 0, relogin: 0 };
  let current: string | null = token;
  return {
    calls,
    setToken: (next: string | null) => { current = next; },
    gate: createTokenGate({
      readToken: () => current,
      probeActor: async () => { calls.probe += 1; if (probeThrows) throw new Error("服务没起"); return actor; },
      relogin: async () => { calls.relogin += 1; if (reloginOk) current = reloginToken; return reloginOk; },
    }),
  };
}

test("没有令牌时直接拦下（不打注定 401 的请求）", async () => {
  const d = deps({ token: null });
  assert.equal(await d.gate(), false);
  assert.equal(d.calls.probe, 0, "连令牌都没有就不该去问我是谁");
});

test("令牌有效时放行，且同一个令牌只探一次", async () => {
  const d = deps();
  assert.equal(await d.gate(), true);
  assert.equal(await d.gate(), true);
  assert.equal(await d.gate(), true);
  assert.equal(d.calls.probe, 1, "同一个令牌重复探测就是白白多打请求");
});

test("令牌失效（actor 为 null）时重新登录，并用新令牌放行", async () => {
  const d = deps({ actor: null, reloginToken: "t2" });
  assert.equal(await d.gate(), true, "换到新令牌后应当放行");
  assert.equal(d.calls.relogin, 1);
  /* 新令牌已确认，再调不该重复探测 */
  await d.gate();
  assert.equal(d.calls.probe, 1);
});

test("令牌失效且换不到新令牌时拦下（宁可不刷新，也不刷红字）", async () => {
  const d = deps({ actor: null, reloginOk: false });
  assert.equal(await d.gate(), false);
});

test("探测失败（服务没起）时不放行，也不当成令牌无效", async () => {
  const d = deps({ probeThrows: true });
  assert.equal(await d.gate(), false);
  assert.equal(d.calls.relogin, 0, "服务不可达时重登录也没意义，不该白试");
});

test("并发调用共用同一次探测（轮询与事件轮询会同时问）", async () => {
  const d = deps();
  const [a, b, c] = await Promise.all([d.gate(), d.gate(), d.gate()]);
  assert.deepEqual([a, b, c], [true, true, true]);
  assert.equal(d.calls.probe, 1, "两个轮询同时到点时只应探测一次");
});

test("令牌变了要重新探测（换账号/换会话后不能沿用旧结论）", async () => {
  const d = deps();
  await d.gate();
  d.setToken("t9");
  await d.gate();
  assert.equal(d.calls.probe, 2, "令牌变了必须重新确认");
});
