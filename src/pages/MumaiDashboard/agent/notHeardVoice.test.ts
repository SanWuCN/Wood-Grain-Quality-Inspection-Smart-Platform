/**
 * 「未听清 / 没听懂」那句兜底话术的**录音**回归测试（用户 2026-10-01 补录）
 * ── 这一组在防什么 ──────────────────────────────────────────────
 *   1. **文案与语音包不能失配**：`VoiceOutput.speak()` 按文本**逐字**去
 *      `public/voice/manifest.json` 找音频；话术改一个字、键没跟着改，就会
 *      **静默回退浏览器合成音** —— 现场听起来只是"音色变了"，最容易漏掉。
 *      用户就是在外场听到那句机器人音，才补录了这一条。
 *   2. **两个变体都要有键**：同一句话在两条路径上出现，标点不同 ——
 *      · 没听清（麦克风没拿到文本）走 `replyNotHeard()`，文本是「…请再说一遍**。**」；
 *      · 没命中意图走 `FALLBACK_TEXT`，文本**不带句号**。
 *      只录一个键，另一条路径照样回退合成音（这条测试就是为此写的）。
 *   3. 录音文件必须真实存在（清单里写了键、盘上没有文件同样是静默回退）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { NOT_HEARD_TEXT } from "./degrade.ts";
import { FALLBACK_TEXT } from "./intents.ts";

const MANIFEST = fileURLToPath(new URL("../../../../public/voice/manifest.json", import.meta.url));
/** 没听清那一轮的**实际播报文本**：`degrade.ts` 的 `replyNotHeard()` 拼了一个句号 */
const NOT_HEARD_SPOKEN = `${NOT_HEARD_TEXT}。`;

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as Record<string, string>;

test("未听清与兜底是同一句话，但两个变体都在语音包里有键", () => {
  assert.equal(NOT_HEARD_TEXT, FALLBACK_TEXT, "两条路径共用一句话（改文案时两处一起改，见 intents.ts 的注释）");
  for (const text of [NOT_HEARD_TEXT, NOT_HEARD_SPOKEN]) {
    const url = manifest[text];
    assert.ok(
      url,
      `语音包里没有「${text}」这条键 —— 走到这条路径时会静默回退浏览器合成音（用户补录的正是这一句）`,
    );
    assert.match(url, /^\/voice\//, `值必须是 /voice/ 下的路径（public 不写进 URL）：${url}`);
    const file = fileURLToPath(new URL(`../../../../public${url}`, import.meta.url));
    assert.ok(existsSync(file), `清单里有键但文件不存在：${file}`);
  }
});

test("两个变体指向同一个录音文件（同一句话不重复存两份字节）", () => {
  assert.equal(
    manifest[NOT_HEARD_TEXT],
    manifest[NOT_HEARD_SPOKEN],
    "带句号与不带句号是同一句话，应指向同一份录音",
  );
});

test("语音包里没有第三个「不好意思…」变体（防旧措辞留在库里）", () => {
  const variants = Object.keys(manifest).filter((key) => key.includes("不好意思"));
  assert.deepEqual(
    variants.sort(),
    [NOT_HEARD_TEXT, NOT_HEARD_SPOKEN].sort(),
    `库里出现了意料之外的说法：${variants.join(" / ")}（旧措辞会让人听到不一致的话术）`,
  );
});
