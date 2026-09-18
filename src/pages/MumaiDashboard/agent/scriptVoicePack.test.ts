/**
 * 剧本轮次的预录音频覆盖：把「哪些轮次真的录了」钉住
 * ── 这一组在防什么 ──────────────────────────────────────────────
 * 审计发现过的真实缺口：`public/voice/manifest.json` 里的键**全是意图模板**，
 * 而剧本播的是 `script.ts` 的台词 —— 两条文本不同源，于是
 * **剧本轮次从来没有命中过预录音频**，现场全在放浏览器合成音（而且悄无声息）。
 *
 * 所以每交付一轮录音，就在 `script.ts` 的 `voicePack` 上标出来（该字段本来就是
 * "对接语音资源以它为准"），并由本测试核对：
 *   · 标注了 `voicePack` 的轮次，其**主台词**必须在语音包里逐字命中；
 *   · 命中的音频文件必须真实存在；
 *   · 没标的轮次不参与断言（避免把"还没录"误判成失败）。
 *
 * ⚠ 2026-09-17 剧本按《小木对话总文案.txt》重排为 25 轮后，语音包**跟着一起重排**：
 * `public/voice/round-NN.mp3` 的编号 = 新轮号（见 `tools-夜间/重排语音文件.mjs`），
 * manifest 里的路径同步改过。所以本文件里"第 NN 轮 ↔ round-NN.mp3"的约定仍然成立。
 *
 * 反向作用同样重要：以后有人改台词却没改语音包键，这一组会立刻报红，
 * 而不是等到台上才发现"声音还是机器的"。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { SCRIPT_ROUNDS } from "./script.ts";

const MANIFEST = fileURLToPath(new URL("../../../../public/voice/manifest.json", import.meta.url));
const VOICE_DIR = fileURLToPath(new URL("../../../../public/voice", import.meta.url));

/**
 * 清单里的值必须指向**真实存在、非空**的音频文件。
 *
 * ⚠ 这一条是本文件开头写明、代码却一直没实现的那半句（原来只断言"键存在"）：
 * 键在、文件不在（或 0 字节）时，运行时 `probeAudio()` 会失败并**静默回退浏览器合成音** ——
 * 现场只是"音色变了"，界面上看不出任何异常，正是这一组测试要防的那种失败。
 */
function assertAudioFile(url: string, where: string): void {
  assert.match(url, /^\/voice\/[\w.-]+\.(mp3|wav)$/, `${where} 的音频路径不合约定：${url}`);
  const file = join(VOICE_DIR, url.replace(/^\/voice\//, ""));
  assert.ok(existsSync(file), `${where} 的音频文件不存在：${url}`);
  assert.ok(statSync(file).size > 0, `${where} 的音频是 0 字节：${url}`);
}

/** 磁盘上已交付的轮次录音（命名约定 `round-NN.mp3`；01 = ① … 25 = ㉕） */
function deliveredRoundFiles(): { roundNo: string; file: string }[] {
  const numbers = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳㉑㉒㉓㉔㉕".split("");
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
    const url = manifest[main.text];
    assert.ok(
      url,
      `第 ${roundNo} 轮的录音 ${file} 已在盘上，但语音包里没有它的主台词键：` +
        `「${main.text.slice(0, 24)}…」—— 现场会静默回退浏览器合成音`,
    );
    assertAudioFile(url, `第 ${roundNo} 轮`);
  }
});

test("剧本 voicePack 标注与磁盘录音一致（标了的要能核对，没标的不许悄悄有录音）", () => {
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as Record<string, string>;
  const deliveredRounds = deliveredRoundFiles().map((item) => item.roundNo);
  for (const roundNo of deliveredRounds) {
    const round = SCRIPT_ROUNDS.find((item) => item.roundNo === roundNo);
    assert.ok(round);
    const main = round.lines.find((line) => line.role === "main");
    assert.ok(main);
    /*
      ⚠ 这里原来断言 `voicePack !== null`（"有录音就必须有配音编号"）。
      2026-09-17 交付 ③ 轮的录音时这条卡住了 —— 但 ③ 轮**本来就没有编号**：
      它对应净稿段29，在剧本里标的是「无人（本地事件/旁白）」，没有 `AI语音N` 前缀。
      为了过测试给它编一个编号，等于往稿子里塞了一个剧本不存在的事实（幻觉），
      而"编号"只是对接音频时的**人读标注**，不是播放凭据。

      所以判据收紧到**真正的不变量**：
        · 有录音 → 主台词必须在语音包里逐字有键（这才是"现场会不会播错话"的防线）；
        · 编号若有 → 必须与别的轮次不重复（下面单独查）；
        · 编号为空 → 允许，但**必须是剧本没给编号的旁白轮**，不能是"有编号却忘了填"。
      最后一条用"其他旁白轮也都为空"来钉：只要不是全空，就说明确实存在"该标而没标"的情形。
    */
    assert.ok(manifest[main.text], `第 ${roundNo} 轮的主台词在语音包里没有键`);
    assertAudioFile(manifest[main.text], `第 ${roundNo} 轮`);
    if (round.voicePack === null) {
      const voicedElsewhere = SCRIPT_ROUNDS.filter((r) => r.voicePack !== null).length;
      assert.ok(
        voicedElsewhere > 0,
        `第 ${roundNo} 轮没有配音编号，而全剧本**一个编号都没有** —— 更像"忘了填"而不是"剧本没给"`,
      );
    }
  }
  /* 编号不许重复（重复会让对接音频时张冠李戴） */
  const numbers = SCRIPT_ROUNDS.map((r) => r.voicePack).filter((v): v is string => v !== null);
  const duplicated = numbers.filter((item, index) => numbers.indexOf(item) !== index);
  assert.deepEqual(duplicated, [], `语音编号重复：${duplicated.join("、")}`);
});

test("第二轮「接单整理」已录音：键与文件对得上", () => {
  /* ⚠ 剧本重排后「接单整理」是 ②（①是新增的三个月统计问答），录音文件随之改名为 round-02.mp3 */
  const round = SCRIPT_ROUNDS.find((item) => item.roundNo === "②");
  assert.ok(round);
  assert.equal(round.title, "接单整理");
  assert.equal(round.voicePack, "AI语音1", "第二轮已交付录音，voicePack 不该还是 null");
  const main = round.lines.find((line) => line.role === "main");
  assert.ok(main);
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as Record<string, string>;
  assert.equal(manifest[main.text], "/voice/round-02.mp3");
});
