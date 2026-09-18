/**
 * 气泡「关键词提示」开关 · 单测（纯逻辑，不起 DOM）
 *
 * 这一组防的是两件事：
 *   ① **默认必须是关的**。用户口径是"原来在气泡里的太明显了"——
 *      哪天有人把默认改成显示，现场就会把整本剧本的关键词铺在屏幕上，
 *      而这种事不会报错、只会"看起来更全"，所以要拿测试钉住默认值。
 *   ② 开关的两条边界：读不到（从没设置过 / localStorage 被禁 / 隐私模式）
 *      按"关"处理；写不进去时返回真实状态，界面据此回退。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  KEYWORD_HINT_KEY,
  keywordHintVisible,
  setKeywordHintVisible,
  type KeyValueStore,
} from "./keywordHint.ts";

/** 内存版存储：与 localStorage 同形状，够用且不依赖浏览器 */
function memoryStore(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  const store: KeyValueStore = {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
  };
  return { store, map };
}

test("从没设置过时默认是关（不许默认把关键词铺出来）", () => {
  const { store } = memoryStore();
  assert.equal(keywordHintVisible(store), false);
});

test("只有显式写过 \"on\" 才算开（坏值 / 别的取值一律当关）", () => {
  for (const bad of ["", "true", "1", "ON", "on ", "off", "yes"]) {
    const { store } = memoryStore({ [KEYWORD_HINT_KEY]: bad });
    assert.equal(keywordHintVisible(store), false, `「${bad}」不该被当成打开`);
  }
  const on = memoryStore({ [KEYWORD_HINT_KEY]: "on" });
  assert.equal(keywordHintVisible(on.store), true);
});

test("开关写进去之后读得回来，关掉也读得回来", () => {
  const { store, map } = memoryStore();
  assert.equal(setKeywordHintVisible(true, store), true);
  assert.equal(map.get(KEYWORD_HINT_KEY), "on");
  assert.equal(keywordHintVisible(store), true);
  assert.equal(setKeywordHintVisible(false, store), false);
  assert.equal(map.get(KEYWORD_HINT_KEY), "off");
  assert.equal(keywordHintVisible(store), false);
});

test("没有存储（SSR / localStorage 被禁）时读是关、写返回 false（不假装写成功）", () => {
  assert.equal(keywordHintVisible(null), false);
  assert.equal(keywordHintVisible(undefined), false);
  assert.equal(setKeywordHintVisible(true, null), false);
  assert.equal(setKeywordHintVisible(true, undefined), false);
});

test("存储抛错时不崩：读当关、写返回失败", () => {
  const hostile: KeyValueStore = {
    getItem: () => {
      throw new Error("SecurityError: localStorage 被禁用");
    },
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
  };
  assert.equal(keywordHintVisible(hostile), false);
  assert.equal(setKeywordHintVisible(true, hostile), false);
});
