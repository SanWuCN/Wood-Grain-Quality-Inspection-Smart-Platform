/**
 * 设备轮询退避的判据测试
 *
 * 每条都能证伪：退避算错会让页面要么继续刷红字、要么长期不刷新。
 * 跑法：node --test src/pages/MumaiDashboard/device/pollBackoff.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isTransientPollFailure,
  nextPollDelayMs,
  POLL_BACKOFF_MAX_MS,
} from "./pollBackoff.ts";

const BASE = 5000;

test("没失败时保持正常节奏", () => {
  assert.equal(nextPollDelayMs(BASE, 0), BASE);
});

test("连续失败按倍数退避", () => {
  assert.equal(nextPollDelayMs(BASE, 1), BASE * 1);
  assert.equal(nextPollDelayMs(BASE, 2), BASE * 2);
  assert.equal(nextPollDelayMs(BASE, 3), BASE * 4);
  assert.equal(nextPollDelayMs(BASE, 4), BASE * 8);
});

test("退避有上限，且上限仍小于「数据过期」容忍度", () => {
  /* 退到上限之后不再增长 —— 否则连续失败久了会再也不刷新 */
  assert.equal(nextPollDelayMs(BASE, 20), POLL_BACKOFF_MAX_MS);
  assert.ok(POLL_BACKOFF_MAX_MS <= 60000,
    "退避上限超过 1 分钟就会让页面长期显示旧设备数据");
});

test("退避后的间隔不会小于正常节奏（不能因为失败反而更频繁）", () => {
  for (const failures of [0, 1, 2, 5, 50]) {
    assert.ok(nextPollDelayMs(BASE, failures) >= BASE,
      `连续失败 ${failures} 次时反而打得更勤，等于加重红字`);
  }
});

test("成功一次立刻回到正常节奏（不留退避后遗症）", () => {
  /* 失败若干次后再传 0：必须回到 base，而不是记住历史 */
  assert.equal(nextPollDelayMs(BASE, 0), BASE);
});

test("异常入参不炸：负数/小数都按 0 处理", () => {
  assert.equal(nextPollDelayMs(BASE, -3), BASE);
  assert.equal(nextPollDelayMs(BASE, 2.7), BASE * 2);
  assert.equal(nextPollDelayMs(0, 5), 0, "base 为 0 表示不轮询");
});

test("只有「等一下会好」的失败才退避", () => {
  assert.equal(isTransientPollFailure(401), true, "令牌没到位/失效：等一下就好");
  assert.equal(isTransientPollFailure(503), true, "后端重启中：等一下就好");
  assert.equal(isTransientPollFailure(undefined), true, "网络层失败（连接被拒）");
  assert.equal(isTransientPollFailure(403), false, "权限不足：等多久都不会好，要照常报错");
  assert.equal(isTransientPollFailure(404), false, "设备不存在：不该退避掩盖");
});
