/**
 * 唤醒应答「我在」的回归测试
 * ── 这一组在防什么 ──────────────────────────────────────────────
 *   1. **文案与语音包不能失配**：`VoiceOutput.speak()` 是**按文本逐字**去
 *      `public/voice/manifest.json` 找音频的。文案改一个字、键没跟着改，
 *      就会**静默回退浏览器合成音** —— 现场听起来只是"音色变了"，很容易漏掉。
 *   2. **应答要短**：唤醒应答的意义是在"该我说话了"的空档里立刻出声
 *      （PRD §9：唤醒到可见反馈 ≤800ms），太长就会盖住用户紧接着说的命令。
 *   3. **不能含唤醒词**：句子里若出现「小木」，会被自己的播报反向唤醒
 *      （`wakeGate.ts` 记录了这类自唤醒的坑），应答本身必须干净。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { WAKE_REPLY_TEXT } from "./degrade.ts";

const MANIFEST = fileURLToPath(new URL("../../../../public/voice/manifest.json", import.meta.url));

test("唤醒应答文案非空、够短、且不含唤醒词", () => {
  assert.ok(WAKE_REPLY_TEXT.length > 0, "唤醒应答不能是空串（空串时 speak() 直接返回，等于没有应答）");
  assert.ok(
    WAKE_REPLY_TEXT.length <= 6,
    `唤醒应答应短（当前 ${WAKE_REPLY_TEXT.length} 字）：长了会盖住用户紧接着说的命令`,
  );
  assert.equal(WAKE_REPLY_TEXT.includes("小木"), false, "应答里出现唤醒词会被自己的播报反向唤醒");
});

test("唤醒应答在语音包里有逐字命中的音频，且文件真实存在", () => {
  assert.ok(
    existsSync(MANIFEST),
    `找不到语音包清单：${MANIFEST}（改过目录结构时请同步本测试的路径）`,
  );
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as Record<string, string>;
  const url = manifest[WAKE_REPLY_TEXT];
  assert.ok(
    url,
    `语音包里没有「${WAKE_REPLY_TEXT}」这条键 —— 唤醒应答会静默回退浏览器合成音；` +
      `要么补键，要么改本测试并说明为什么暂时不录`,
  );
  assert.match(url, /^\/voice\//, `值必须是 /voice/ 下的路径（public 不写进 URL）：${url}`);
  const file = fileURLToPath(new URL(`../../../../public${url}`, import.meta.url));
  assert.ok(existsSync(file), `清单里有键但文件不存在：${file}`);
});
