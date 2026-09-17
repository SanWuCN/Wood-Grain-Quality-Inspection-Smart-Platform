/**
 * 唤醒出错提示的单测（用户口径 2026-09-17：「为什么我点击开启常驻唤醒就报错」）
 *
 * 这一组防的是**原因被吞掉**：原来界面上只有一句「音频链路当前不在线」，
 * 真正的原因（权限被拒 / 没麦克风 / 服务没起）只打在控制台里，
 * 用户看不到就只能来问"为什么报错"。
 *
 * 判据：三类原因各自给出**不同的、可操作**的一句话；
 * 且每句话都必须点明"这期间怎么绕过去"（对现场来说这才是最要紧的）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { wakeErrorHint } from "./degrade.ts";

test("麦克风权限被拒：告诉用户去哪改权限，并给出替代路径", () => {
  /* wakeChannel 实际写下的原文（NotAllowedError 分支） */
  const hint = wakeErrorHint("麦克风权限被拒绝，唤醒不可用");
  assert.ok(hint.includes("权限"), `应当点明是权限问题：${hint}`);
  assert.ok(hint.includes("允许"), `应当告诉用户怎么改（地址栏里改成「允许」）：${hint}`);
  assert.ok(hint.includes("快捷键"), `必须给出替代路径：${hint}`);
  /* 浏览器给的是 error.name 时也要认得（wakeChannel 的 `麦克风不可用（NotFoundError）` 分支） */
  assert.ok(wakeErrorHint("麦克风不可用（NotAllowedError）").includes("允许"));
});

test("浏览器不给麦克风（内网 http）：说清是安全上下文限制，并指出本机可用 localhost", () => {
  const hint = wakeErrorHint("浏览器不支持 Web Audio，无法采集音频");
  assert.ok(hint.includes("localhost") || hint.includes("https"), `应当说清只有 localhost/https 才行：${hint}`);
  assert.ok(hint.includes("快捷键"), `必须给出替代路径：${hint}`);
  assert.notEqual(hint, wakeErrorHint("麦克风权限被拒绝，唤醒不可用"), "两类原因不能给同一句话");
});

test("语音服务不可达：指向启动日志里的「语音通道」一行", () => {
  const hint = wakeErrorHint("唤醒通道断开，正在重连…（8000ms 后第 9 次重试）");
  assert.ok(hint.includes("语音通道") || hint.includes("8780"), `应当指向服务侧排查点：${hint}`);
  assert.ok(hint.includes("快捷键"), `必须给出替代路径：${hint}`);
});

test("未知原因：如实带出原文，不编造原因", () => {
  const hint = wakeErrorHint("某种没见过的失败");
  assert.ok(hint.includes("某种没见过的失败"), `原文必须带出来（不许吞掉）：${hint}`);
  assert.ok(hint.includes("快捷键"));
  /* 空原因也不能给出空话 */
  assert.ok(wakeErrorHint("").length > 10, "空原因也要有一句能读的话");
});
