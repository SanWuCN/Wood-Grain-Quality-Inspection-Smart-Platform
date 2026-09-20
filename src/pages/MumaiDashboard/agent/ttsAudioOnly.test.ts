/**
 * 语音输出 · 「只播音频、不出合成音」的回归测试（用户口径 2026-10-01）
 *
 * ── 用户口径 ────────────────────────────────────────────────────────
 * 「确保小木播放的都是音频而非合成音」。
 *
 * 这一条钉住的是**默认行为**：语音包里没有这一句时，宁可没声音（只显示字幕）
 * 也不要机器音 —— 合成音与录音是两个人的音色，冒一次就露。
 * 回退路径整段保留在 `tts.ts`，由 `SYNTHESIS_FALLBACK_ENABLED` 控制；
 * 下面第三条用例核对"常量与行为一致"，防哪天常量被改回 true 而没人发现。
 *
 * 浏览器环境的桩与 `ttsOverlap.test.ts` 同一套写法（那边验的是叠音竞态）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

type Act = { kind: "audio" | "synth"; url?: string; text?: string };

function installBrowserStub() {
  const acts: Act[] = [];
  const timers = new Set<number>();
  let uid = 0;

  const setTimeoutStub = (fn: () => void, ms = 0) => {
    const id = ++uid;
    const handle = globalThis.setTimeout(() => {
      timers.delete(id);
      fn();
    }, ms);
    timers.add(id);
    return handle as unknown as number;
  };

  const windowStub = {
    setTimeout: setTimeoutStub,
    clearTimeout: (handle: number) => {
      timers.delete(handle as unknown as number);
      globalThis.clearTimeout(handle as unknown as ReturnType<typeof globalThis.setTimeout>);
    },
    location: { protocol: "http:", host: "127.0.0.1:8000", hash: "#/" },
  };

  class FakeAudio {
    src: string;
    duration = 2;
    preload = "";
    oncanplaythrough: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onended: (() => void) | null = null;
    onloadedmetadata: (() => void) | null = null;
    constructor(src: string) {
      this.src = src;
      windowStub.setTimeout(() => this.oncanplaythrough?.(), 0);
      windowStub.setTimeout(() => this.onloadedmetadata?.(), 0);
    }
    play() {
      acts.push({ kind: "audio", url: this.src });
      return Promise.resolve();
    }
    pause() {}
  }

  const speechSynthesisStub = {
    speak: (utterance: { text: string }) => {
      acts.push({ kind: "synth", text: utterance.text });
    },
    cancel: () => undefined,
    pause: () => undefined,
    resume: () => undefined,
    speaking: false,
    pending: false,
    getVoices: () => [],
  };

  class FakeUtterance {
    text: string;
    lang = "";
    rate = 1;
    pitch = 1;
    voice: unknown = null;
    onend: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(text: string) {
      this.text = text;
    }
  }

  const scope = globalThis as unknown as Record<string, unknown>;
  const saved = {
    window: scope.window,
    Audio: scope.Audio,
    speechSynthesis: scope.speechSynthesis,
    SpeechSynthesisUtterance: scope.SpeechSynthesisUtterance,
  };
  scope.window = windowStub;
  scope.Audio = FakeAudio;
  scope.speechSynthesis = speechSynthesisStub;
  scope.SpeechSynthesisUtterance = FakeUtterance;

  return {
    acts,
    restore() {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete scope[key];
        else scope[key] = value;
      }
    },
  };
}

/** 语音包清单（`fetch` 一并桩掉） */
function stubManifest(entries: Record<string, string>) {
  const scope = globalThis as unknown as Record<string, unknown>;
  const savedFetch = scope.fetch;
  scope.fetch = async () => ({ ok: true, json: async () => entries });
  return () => {
    scope.fetch = savedFetch;
  };
}

/** `tts.ts` 的探测缓存是模块级的：每条用例都要拿到干净模块 */
async function freshVoiceOutput() {
  const mod = (await import(`./tts.ts?gate=${Math.random()}`)) as {
    VoiceOutput: new () => { speak: (text: string, audioUrl?: string) => Promise<void> };
  };
  return mod.VoiceOutput;
}

test("没录音的句子不出合成音：只显示字幕", async () => {
  const browser = installBrowserStub();
  /* 清单里只有别的一句：本次要播的这句必然"没命中" */
  const restoreFetch = stubManifest({ 录过的那一句: "/voice/round-01.mp3" });
  try {
    const VoiceOutput = await freshVoiceOutput();
    const output = new VoiceOutput();

    await output.speak("这一句没有录音");
    await new Promise((resolve) => globalThis.setTimeout(resolve, 40));

    assert.equal(
      browser.acts.filter((act) => act.kind === "synth").length,
      0,
      "没命中语音包时不许回退浏览器合成音 —— 平台只播音频",
    );
    assert.equal(
      browser.acts.filter((act) => act.kind === "audio").length,
      0,
      "没有音频可播时也不该凭空播别的文件",
    );
  } finally {
    restoreFetch();
    browser.restore();
  }
});

test("有录音就播录音（这条路径不受开关影响）", async () => {
  const browser = installBrowserStub();
  const restoreFetch = stubManifest({ 录过的那一句: "/voice/round-01.mp3" });
  try {
    const VoiceOutput = await freshVoiceOutput();
    const output = new VoiceOutput();
    await output.speak("录过的那一句");
    assert.deepEqual(
      browser.acts.filter((act) => act.kind === "audio").map((act) => act.url),
      ["/voice/round-01.mp3"],
    );
    assert.equal(browser.acts.filter((act) => act.kind === "synth").length, 0);
  } finally {
    restoreFetch();
    browser.restore();
  }
});

test("回退开关与行为同源：默认必须是关", async () => {
  const mod = (await import("./tts.ts")) as { SYNTHESIS_FALLBACK_ENABLED: boolean };
  assert.equal(
    mod.SYNTHESIS_FALLBACK_ENABLED,
    false,
    "默认必须是关：用户口径是「播放的都是音频而非合成音」",
  );
});
