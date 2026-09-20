/**
 * 语音包匹配 · 单测（纯函数，不起 DOM）
 *
 * ── 这一组防的是什么（用户口径 2026-10-01「播放的都是音频而非合成音」）──
 * 录音是按**当时的演示取值**录的，而句子里的取值会变：
 *   录音：「…（电池 91%），到位后任务状态为 执行中。」
 *   现在：「…（电池 86%），到位后任务状态为 idle。」
 * 逐字匹配必然落空 → 语音包里有这条录音却用不上 → 现场要么没声音、要么（以前）
 * 冒出浏览器合成音。所以要在"逐字"之外补一条**受约束**的前缀容忍，
 * 而这条容忍绝不能在"不是同一句"的时候乱认 —— 下面每条边界都钉住。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AUDIO_LENGTH_SLACK,
  AUDIO_MATCH_RATIO,
  commonPrefixLength,
  commonSuffixLength,
  lcsLength,
  looksLikeSameSentence,
  resolveAudio,
} from "./voicePack.ts";

const pack = {
  "好的，正在让小车返回 起点 / 殿门（电池 91%），到位后任务状态为 执行中。": "/voice/robot_return_home.mp3",
  "已下发返航指令，目标 起点 / 殿门，电池 91%。": "/voice/robot_return_home-2.mp3",
  "已读取历史巡检报告，风险 6 处。": "/voice/history_summary.mp3",
  "已开始执行巡检任务 MSN-2026-0911-02（演示车 DEMO-CART-01，SP-02 低速巡检）。":
    "/voice/start_patrol-2.mp3",
};

test("逐字命中优先（这是常态）", () => {
  assert.equal(
    resolveAudio(pack, "已下发返航指令，目标 起点 / 殿门，电池 91%。"),
    "/voice/robot_return_home-2.mp3",
  );
});

test("取值漂移的同一句：两头结构一致就认这条录音", () => {
  /* 只有电池与任务状态两个取值不同（91%→86%、执行中→idle） */
  const drifted = "好的，正在让小车返回 起点 / 殿门（电池 86%），到位后任务状态为 idle。";
  assert.equal(resolveAudio(pack, drifted), "/voice/robot_return_home.mp3");
});

test("取值在中间漂移（多了一段）也认", () => {
  /* 「任务已下发：<目标>。小车从…」——目标由 planner 现算，录音里是空位 */
  const withGoal = resolveAudio(
    { "任务已下发：。小车从 起点 / 殿门 出发，依次经过 P1 → P6。": "/voice/robot_patrol_route.mp3" },
    "任务已下发：去建图并巡检四根木柱。小车从 起点 / 殿门 出发，依次经过 P1 → P6。",
  );
  assert.equal(withGoal, "/voice/robot_patrol_route.mp3");
});

test("不是同一句就不认（两头都对不上）", () => {
  /* 「已打开 金柱 Z04…」与「已读取历史巡检报告…」只共享「已」一个字 */
  assert.equal(resolveAudio(pack, "已打开 金柱 Z04（Z04-lower）：图像 img-Z04-lower-f08。"), null);
});

test("只说了半句，不许去认领一条长录音", () => {
  /* 「已开始执行巡检任务」（8 字）远短于那条录音 —— 念出来会跑题 */
  assert.equal(resolveAudio(pack, "已开始执行巡检任务"), null);
});

test("两条录音并列最长（分不出是哪句）→ 不猜，返回 null", () => {
  const ambiguous = {
    "ABCDEFGHIJ-第一版": "/voice/a.mp3",
    "ABCDEFGHIJ-第二版": "/voice/b.mp3",
  };
  assert.equal(resolveAudio(ambiguous, "ABCDEFGHIJ-第三版"), null);
});

test("阈值常量本身有判据：不能松到随便认、也不能紧到等于逐字", () => {
  assert.ok(AUDIO_MATCH_RATIO >= 0.5 && AUDIO_MATCH_RATIO < 1, `当前 ${AUDIO_MATCH_RATIO}`);
  assert.ok(AUDIO_LENGTH_SLACK >= 1 && AUDIO_LENGTH_SLACK <= 2, `当前 ${AUDIO_LENGTH_SLACK}`);
});

test("LCS 判据量出来的分界线：同句漂移 ≥60%，异句 ≤33%（实测七组）", () => {
  /* 同一句、只有取值不同 —— 必须认 */
  assert.equal(
    looksLikeSameSentence(
      "好的，正在让小车返回 起点 / 殿门（电池 86%），到位后任务状态为 idle。",
      "好的，正在让小车返回 起点 / 殿门（电池 91%），到位后任务状态为 执行中。",
    ),
    true,
  );
  /* 只说了半句（分母是那条长录音）—— 必须不认 */
  assert.equal(
    looksLikeSameSentence(
      "已开始执行巡检任务",
      "已开始执行巡检任务 MSN-2026-0911-02（演示车 DEMO-CART-01，SP-02 低速巡检（0.25 m/s，转弯 0.12 m/s））。",
    ),
    false,
  );
  /* 六字短句：LCS 33%，低于阈值 */
  assert.equal(looksLikeSameSentence("打开任务总览", "打开设备清单"), false);
});

test("lcsLength：与手算一致，空串给 0", () => {
  assert.equal(lcsLength("", "abc"), 0);
  assert.equal(lcsLength("abc", ""), 0);
  assert.equal(lcsLength("abcd", "acbd"), 3);
});

test("commonPrefixLength / commonSuffixLength：空串与完全不同都给 0", () => {
  assert.equal(commonPrefixLength("", "abc"), 0);
  assert.equal(commonPrefixLength("abc", "xyz"), 0);
  assert.equal(commonPrefixLength("abc", "abd"), 2);
  assert.equal(commonSuffixLength("abc", "xbc"), 2);
  assert.equal(commonSuffixLength("abc", "xyz"), 0);
});
