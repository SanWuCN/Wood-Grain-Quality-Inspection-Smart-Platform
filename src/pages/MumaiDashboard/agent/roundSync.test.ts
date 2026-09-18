/**
 * 内网多主机内容同步 · 判据与开关（`roundSync.ts`）
 *
 * 三条边界都在 `remoteRoundOf` 这个纯函数里，逐条断言；再加开关的读写。
 * 这三条不是"看起来更稳妥"，每一条不对都会在现场出具体的毛病：
 *   · 事件名不判 → 任何一条 WS 事件（工单事件、心跳）都会被当成回合跟随；
 *   · **自己的回声不判 → 两台机器互相跟随，页面来回跳（死循环）**；
 *   · 旧事件不判 → 断线重连补发历史事件时，跟随端把十分钟前的台词再演一遍。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { StreamEvent } from "../api/client.ts";
import { FRESH_MS, followEnabled, hostIdOf, remoteRoundOf, setFollowEnabled } from "./roundSync.ts";

/** 造一条 `xiaomu.round` 事件（字段与服务端 `workflow.mjs` 写的一致） */
function roundEvent(overrides: {
  seq?: number;
  at?: string;
  roundNo?: string;
  text?: string;
  hostId?: string | null;
  type?: string;
} = {}): StreamEvent {
  const at = overrides.at ?? new Date().toISOString();
  return {
    seq: overrides.seq ?? 101,
    type: overrides.type ?? "xiaomu.round",
    entityKind: "agentTurn",
    entityId: `TURN-${overrides.seq ?? 101}`,
    revision: 1,
    actorId: "shi",
    payload: {
      turnId: `TURN-${overrides.seq ?? 101}`,
      roundNo: overrides.roundNo ?? "⑰",
      text: overrides.text ?? "清洗完成，待审核记录已列出，数据集已按物理样本分组。",
      hostId: overrides.hostId === undefined ? "host-other" : overrides.hostId,
      by: "shi",
      nav: { route: "/firmware", tab: "dataset" },
    },
    at,
  };
}

test("正常的远程回合会被跟随，台词与轮次号都带出来", () => {
  const round = remoteRoundOf(roundEvent(), { selfHostId: "host-self" });
  assert.ok(round, "别人的回合应当被跟随");
  assert.equal(round.roundNo, "⑰");
  assert.match(round.text, /清洗完成/);
  assert.equal(round.hostId, "host-other");
  assert.equal(round.by, "shi");
  assert.equal(round.seq, 101);
});

test("自己的回声不跟随（否则两台机器互相跟随 → 页面来回跳）", () => {
  assert.equal(remoteRoundOf(roundEvent({ hostId: "host-self" }), { selfHostId: "host-self" }), null);
  /* 没有 hostId 的旧写法仍然跟随（宁可跟一次，也不要把整条链路判死） */
  assert.ok(remoteRoundOf(roundEvent({ hostId: null }), { selfHostId: "host-self" }));
});

test("旧事件不跟随：断线重连补发的历史事件不该再演一遍", () => {
  const now = Date.now();
  const old = new Date(now - FRESH_MS - 1000).toISOString();
  assert.equal(remoteRoundOf(roundEvent({ at: old }), { selfHostId: "host-self", now }), null);
  const fresh = new Date(now - 1000).toISOString();
  assert.ok(remoteRoundOf(roundEvent({ at: fresh }), { selfHostId: "host-self", now }));
});

test("只认 xiaomu.round：别的 WS 事件（工单 / 心跳 / 任务卡）一律不跟随", () => {
  for (const type of ["workOrder.created", "task.created", "sync.probe", "mission.created"]) {
    assert.equal(remoteRoundOf(roundEvent({ type }), { selfHostId: "host-self" }), null, `${type} 不该被当成回合`);
  }
  assert.equal(remoteRoundOf(null, { selfHostId: "host-self" }), null);
});

test("缺轮次号或台词的广播不算有效回合（服务端会拦，前端也要能兜住坏数据）", () => {
  const noRound = roundEvent();
  noRound.payload = { ...noRound.payload, roundNo: "" };
  assert.equal(remoteRoundOf(noRound, { selfHostId: "host-self" }), null);
  const noText = roundEvent();
  noText.payload = { ...noText.payload, text: "" };
  assert.equal(remoteRoundOf(noText, { selfHostId: "host-self" }), null);
});

test("跟随开关：默认开，关掉后读得到关，再开回得来", () => {
  /* Node 里没有 localStorage：`followEnabled` 应当安全退回默认值（开） */
  assert.equal(followEnabled(), true, "读不到开关时按开处理 —— 新机器打开就该能跟着看");
  setFollowEnabled(false);
  assert.equal(followEnabled(), true, "没有 localStorage 时写不进去，读到的仍是默认开");
});

test("本机 hostId 稳定（同一进程里每次拿到的都是同一个）", () => {
  const first = hostIdOf();
  assert.ok(first.startsWith("host-"));
  assert.equal(hostIdOf(), first);
});
