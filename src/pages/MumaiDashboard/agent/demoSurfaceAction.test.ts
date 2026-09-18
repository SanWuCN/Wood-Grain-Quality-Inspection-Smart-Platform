/**
 * 演示表面的跨树开关（`agent/demoSurfaceAction.ts`）
 *
 * ── 这一组在防什么 ──────────────────────────────────────────────────
 * 表面是左下角那块浮层，页面、`executor`、人手上的按钮三方都能开它。
 * 两件事写错了都不会报错，只会在现场弹错窗口或干脆不弹：
 *   1. **事件名**：`Shell` 监听的就是这一个字符串，改了名两边必须一起改
 *      （所以两边都从常量取，不再各写一份字面量）；
 *   2. **轮次号**：弹的是"哪一轮的表面"，由 `DEMO_ACTIONS` 决定 ——
 *      通道巡查那个窗口必须仍挂在 `CHANNEL_PATROL_ROUND_NO` 上，
 *      否则建图页上那个手动按钮会弹出一个别的浮层。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { CHANNEL_PATROL_ROUND_NO, actionFor } from "./demoActions.ts";
import { DEMO_SURFACE_EVENT, openDemoSurface } from "./demoSurfaceAction.ts";

test("事件名固定为 mumai:demo-surface（Shell 与 executor 共用这一个常量）", () => {
  assert.equal(DEMO_SURFACE_EVENT, "mumai:demo-surface");
});

test("通道巡查窗口挂在 ⑨ 上：手动按钮与那一轮弹的是同一个窗口", () => {
  const action = actionFor(CHANNEL_PATROL_ROUND_NO);
  assert.ok(action, `演示动作表里必须有 ${CHANNEL_PATROL_ROUND_NO} 这一轮`);
  assert.equal(action.surface, "channels", "通道巡查窗口用的就是通道状态那个表面");
  assert.match(action.title, /监听窗口/, "标题要写明这是监听窗口（剧本 §104 的说法）");
});

test("openDemoSurface：按轮次号派发事件；拿不到轮次号或不在浏览器里就不派发", () => {
  const sent: { type: string; detail: unknown }[] = [];
  const host = globalThis as unknown as { window?: unknown };
  const before = host.window;
  host.window = {
    dispatchEvent(event: { type: string; detail?: unknown }) {
      sent.push({ type: event.type, detail: event.detail });
      return true;
    },
  };
  try {
    assert.equal(openDemoSurface(CHANNEL_PATROL_ROUND_NO), true);
    assert.equal(sent.length, 1, "一次调用只派发一个事件");
    assert.equal(sent[0].type, DEMO_SURFACE_EVENT);
    assert.deepEqual(sent[0].detail, { roundNo: CHANNEL_PATROL_ROUND_NO });
    /* 空轮次号不许派发：`Shell` 收到空值会关掉浮层（那是"收起来"的语义） */
    assert.equal(openDemoSurface(""), false);
    assert.deepEqual(sent.length, 1);
  } finally {
    host.window = before;
  }
});
