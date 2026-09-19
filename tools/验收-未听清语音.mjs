/**
 * 验收：「没听清 / 没听懂」那句兜底话术**播的是录音，不是浏览器合成音**
 *
 * ── 这条工装回答的问题 ──────────────────────────────────────────────
 * 用户 2026-10-01 补录了 `not_heard.mp3`（原话就一句：「不好意思，请再说一遍」）。
 * 它有两个入口、**标点不同**，只接一个键的话另一条路照样回退机器人音：
 *   · 未听清（唤醒成功但没拿到文本）→ `replyNotHeard()`：文本带句号；
 *   · 未命中意图（说了句不在目录里的话）→ `FALLBACK_TEXT`：文本不带句号。
 * 所以两条路径都要真跑一遍，判据是**页面真的 new Audio('/voice/not_heard.mp3') 并 play()**，
 * 同时 `speechSynthesis.speak` 一次都没被调用（与 `验收-快捷键气泡` 同一条判据）。
 *
 * 用法（仓库根目录）：
 *   node --import ./tools/test-resolve-ts.mjs tools/验收-未听清语音.mjs
 *   … --url http://192.168.31.202:8000     在内网地址上再跑一遍
 */

import { Machine, sleep } from "./browser-harness.mjs";

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const BASE = argOf("url", process.env.MUMAI_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");
const FILE = "/voice/not_heard.mp3";

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? `　（${detail}）` : ""}`);
  if (!ok) failed += 1;
};

const machine = new Machine({ name: "notheard", port: 9591, base: BASE, account: "shi" });

/** 装音频探针：必须在触发之前装好，否则抓不到这一轮的播放 */
const ARM_PROBE = `(() => {
  window.__nh = { played: [], synth: 0 };
  const origPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    try { window.__nh.played.push(this.currentSrc || this.src || ''); } catch (error) {}
    return origPlay.apply(this, arguments);
  };
  const synth = window.speechSynthesis;
  if (synth && synth.speak) {
    const origSpeak = synth.speak.bind(synth);
    synth.speak = function () { window.__nh.synth += 1; return origSpeak.apply(null, arguments); };
  }
  return true;
})()`;

/** 派发一次提问（空串 = 未听清那条路） */
const ask = (question, id) =>
  machine.evaluate(
    `window.dispatchEvent(new CustomEvent('mumai:xiaomu-ask', { detail: { question: ${JSON.stringify(question)}, interactionId: ${JSON.stringify(id)} } })); 1`,
  );

try {
  console.log(`未听清语音验收 · ${BASE}`);
  await machine.start();
  if (!(await machine.login())) throw new Error(`登录失败（shi）—— 页面在 ${BASE} 上吗？`);
  await machine.evaluate(`location.hash = '#/console'`);
  await machine.waitFor(`Boolean(document.querySelector('.xd__panel') || document.querySelector('.console'))`, { timeoutMs: 12_000 });
  await sleep(1200);

  /* ---------- ① 录音文件本身可访问、且真的能解码出时长 ---------- */
  const served = await machine.evaluate(`(async () => {
    const response = await fetch(${JSON.stringify(FILE)}, { method: 'HEAD' });
    return { status: response.status, type: response.headers.get('content-type'), length: Number(response.headers.get('content-length') || 0) };
  })()`);
  check(
    `录音文件在服务端拿得到（${FILE}）`,
    served?.status === 200 && served.length > 10_000,
    `HTTP ${served?.status ?? "?"} · ${served?.length ?? 0} 字节 · ${served?.type ?? "?"}`,
  );
  const decoded = await machine.evaluate(`(async () => {
    const audio = new Audio(${JSON.stringify(FILE)});
    return await new Promise((resolve) => {
      audio.onloadedmetadata = () => resolve(Math.round(audio.duration * 100) / 100);
      audio.onerror = () => resolve(null);
      setTimeout(() => resolve(null), 4000);
    });
  })()`);
  check(
    `这一条真的是那段录音（解码出真实时长）`,
    typeof decoded === "number" && decoded > 1.5 && decoded < 6,
    decoded === null ? "4 秒内没解码出时长（文件坏了？）" : `${decoded} 秒`,
  );

  /*
    ⚠ 验录音**必须先造一次用户手势**：headless 页面没有任何交互时，autoplay 策略会把
      `play()` 拒掉（NotAllowedError），平台随即按设计回退合成音 —— 那是环境造成的假故障，
      真人演示时点一下页面就不会出现。见 `browser-harness.mjs` 的 `activate()`。
  */
  const activated = await machine.activate();
  check("已造出用户手势（否则 autoplay 会拒掉录音，验的是环境不是功能）", activated === true, `hasBeenActive=${activated}`);

  const setProbe = await machine.evaluate(ARM_PROBE);
  check("音频探针已装上（play / speechSynthesis 都被记账）", setProbe === true);

  /* ---------- ② 未命中意图那条路（文本不带句号） ---------- */
  await ask("今天晚饭吃什么", `nh-fallback-${Date.now()}`);
  const bubble = await machine.waitFor(
    `(() => {
      const text = (document.querySelector('.xd__answer')?.textContent || '').trim();
      return text.includes('不好意思') ? text : null;
    })()`,
    { timeoutMs: 15_000 },
  );
  check(
    `说的那句与屏上写的一致（不好意思，请再说一遍）`,
    Boolean(bubble && bubble.includes("不好意思，请再说一遍")),
    bubble ? bubble.slice(0, 60) : "15 秒内没等到这句回复",
  );
  const fallbackAudio = await machine.waitFor(
    `(() => {
      const played = (window.__nh && window.__nh.played) || [];
      return played.some((url) => String(url).includes(${JSON.stringify(FILE)}))
        ? { played: played.map((url) => String(url).split('/').pop()), synth: window.__nh.synth }
        : null;
    })()`,
    { timeoutMs: 15_000 },
  );
  check(
    `未命中意图时播的是录音（${FILE}）`,
    Boolean(fallbackAudio),
    fallbackAudio ? `播放：${fallbackAudio.played.join(" / ")}` : "没听到这一段录音",
  );
  check(
    `这条路没有回退浏览器合成音`,
    (fallbackAudio?.synth ?? 1) === 0,
    `speechSynthesis.speak 调用 ${fallbackAudio?.synth ?? "?"} 次`,
  );

  /* ---------- ③ 未听清那条路（同一个 question 字段，空串；文本带句号） ---------- */
  await machine.evaluate(`window.__nh.played = []; window.__nh.synth = 0; 1`);
  await ask("", `nh-unheard-${Date.now()}`);
  const unheardBubble = await machine.waitFor(
    `(() => {
      const text = (document.querySelector('.xd__answer')?.textContent || '').trim();
      return text.includes('不好意思，请再说一遍。') ? text : null;
    })()`,
    { timeoutMs: 12_000 },
  );
  check(
    `未听清时屏上写的是带句号那一版（不好意思，请再说一遍。）`,
    Boolean(unheardBubble),
    unheardBubble ?? "12 秒内没等到这句回复",
  );
  const unheardAudio = await machine.waitFor(
    `(() => {
      const played = (window.__nh && window.__nh.played) || [];
      return played.some((url) => String(url).includes(${JSON.stringify(FILE)}))
        ? { played: played.map((url) => String(url).split('/').pop()), synth: window.__nh.synth }
        : null;
    })()`,
    { timeoutMs: 15_000 },
  );
  check(
    `未听清（空文本）时播的也是同一段录音`,
    Boolean(unheardAudio),
    unheardAudio ? `播放：${unheardAudio.played.join(" / ")}` : "没听到这一段录音",
  );
  check(
    `这条路也没有回退浏览器合成音`,
    (unheardAudio?.synth ?? 1) === 0,
    `speechSynthesis.speak 调用 ${unheardAudio?.synth ?? "?"} 次`,
  );

  const shot = await machine.shot("未听清语音");
  if (shot) console.log(`  截图：${shot}`);
  console.log(failed === 0 ? "\n✓ 未听清语音：全部通过" : `\n✗ 有 ${failed} 项未通过`);
  process.exitCode = failed === 0 ? 0 : 1;
} catch (error) {
  console.error(`工装异常：${error?.stack ?? error}`);
  process.exitCode = 1;
} finally {
  machine.kill();
}
