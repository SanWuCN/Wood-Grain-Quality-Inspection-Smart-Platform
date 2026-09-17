/**
 * 剧本轮次的预录音频覆盖：把「哪些轮次真的录了」钉住
 * ── 这一组在防什么 ──────────────────────────────────────────────
 * 审计发现过的真实缺口：`public/voice/manifest.json` 里的键**全是意图模板**，
 * 而 22 轮剧本播的是 `script.ts` 的台词 —— 两条文本不同源，于是
 * **剧本轮次从来没有命中过预录音频**，现场全在放浏览器合成音（而且悄无声息）。
 *
 * 所以每交付一轮录音，就在 `script.ts` 的 `voicePack` 上标出来（该字段本来就是
 * "对接语音资源以它为准"），并由本测试核对：
 *   · 标注了 `voicePack` 的轮次，其**主台词**必须在语音包里逐字命中；
 *   · 命中的音频文件必须真实存在；
 *   · 没标的轮次不参与断言（避免把"还没录"误判成失败）。
 *
 * ⚠ 实测现状（2026-09-16，交付第一轮录音时量到的）：22 轮里只有 **①** 的主台词
 * 在语音包里命中。稿子上带编号的 ⑧⑫⑮⑯⑱⑳（AI语音3–8）**都没有对应的 manifest 键** ——
 * 也就是说那 6 轮现场一直在放浏览器合成音。它们尚未被标成本测试的断言对象（标了就会红），
 * 交付录音后逐轮标上即可；这条注释就是"还欠哪几轮"的账本，别删。
 *
 * 反向作用同样重要：以后有人改台词却没改语音包键，这一组会立刻报红，
 * 而不是等到台上才发现"声音还是机器的"。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { SCRIPT_ROUNDS } from "./script.ts";

const MANIFEST = fileURLToPath(new URL("../../../../public/voice/manifest.json", import.meta.url));
const VOICE_DIR = fileURLToPath(new URL("../../../../public/voice", import.meta.url));

/** 磁盘上已交付的轮次录音（命名约定 `round-NN.mp3`；01 = ① … 22 = ㉒） */
function deliveredRoundFiles(): { roundNo: string; file: string }[] {
  const numbers = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳㉑㉒".split("");
  return readdirSync(VOICE_DIR)
    .map((name) => /^round-(\d{2})\.mp3$/.exec(name))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({ roundNo: numbers[Number(match[1]) - 1] ?? match[1], file: match[0] }));
}

test("已交付录音的轮次（磁盘上存在 round-NN.mp3）必须在语音包里逐字命中", () => {
  assert.ok(existsSync(MANIFEST), `找不到语音包清单：${MANIFEST}`);
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as Record<string, string>;

  const delivered = deliveredRoundFiles();
  assert.ok(delivered.length > 0, "磁盘上还没有任何 round-NN.mp3，这条测试等于没测");

  for (const { roundNo, file } of delivered) {
    const round = SCRIPT_ROUNDS.find((item) => item.roundNo === roundNo);
    assert.ok(round, `有录音 ${file} 但剧本里找不到第 ${roundNo} 轮`);
    const main = round.lines.find((line) => line.role === "main");
    assert.ok(main, `第 ${roundNo} 轮没有主台词，无法与语音包核对`);
    assert.ok(
      manifest[main.text],
      `第 ${roundNo} 轮的录音 ${file} 已在盘上，但语音包里没有它的主台词键：` +
        `「${main.text.slice(0, 24)}…」—— 现场会静默回退浏览器合成音`,
    );
  }
});

test("剧本 voicePack 标注与磁盘录音一致（标了的要能核对，没标的不许悄悄有录音）", () => {
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as Record<string, string>;
  const deliveredRounds = deliveredRoundFiles().map((item) => item.roundNo);
  for (const roundNo of deliveredRounds) {
    const round = SCRIPT_ROUNDS.find((item) => item.roundNo === roundNo);
    assert.ok(round);
    assert.notEqual(round.voicePack, null, `第 ${roundNo} 轮已有录音文件，voicePack 不该还是 null`);
    const main = round.lines.find((line) => line.role === "main");
    assert.ok(main);
    assert.ok(manifest[main.text], `第 ${roundNo} 轮的主台词在语音包里没有键`);
  }
  /* 编号不许重复（重复会让对接音频时张冠李戴） */
  const numbers = SCRIPT_ROUNDS.map((r) => r.voicePack).filter((v): v is string => v !== null);
  const duplicated = numbers.filter((item, index) => numbers.indexOf(item) !== index);
  assert.deepEqual(duplicated, [], `语音编号重复：${duplicated.join("、")}`);
});

test("第一轮「接单整理」已录音：键与文件对得上", () => {
  const round = SCRIPT_ROUNDS.find((item) => item.roundNo === "①");
  assert.ok(round);
  assert.equal(round.voicePack, "AI语音1", "第一轮已交付录音，voicePack 不该还是 null");
  const main = round.lines.find((line) => line.role === "main");
  assert.ok(main);
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as Record<string, string>;
  assert.equal(manifest[main.text], "/voice/round-01.mp3");
});
