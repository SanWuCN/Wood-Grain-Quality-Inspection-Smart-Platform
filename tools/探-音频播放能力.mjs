/**
 * 探针：`new Audio(url).play()` 在这套 headless 环境里到底成不成（对比两个文件）
 *
 * 起因：兜底那一轮"录音 play 了、紧接着又合成了" —— 1ms 的间隔指向
 * `playAudio()` 的 `finish(false)`（音频报错或被拒），于是回退合成音。
 * 要分清是**这个新文件的问题**还是**环境里 autoplay 被拒**，直接对比一个老文件。
 *
 * 用法：node --import ./tools/test-resolve-ts.mjs tools/探-音频播放能力.mjs
 */
import { Machine, sleep } from "./browser-harness.mjs";

const BASE = (process.argv.includes("--url") ? process.argv[process.argv.indexOf("--url") + 1] : "http://127.0.0.1:8000").replace(/\/$/, "");
const machine = new Machine({ name: "audioplay", port: 9595, base: BASE, account: "shi" });

try {
  await machine.start();
  if (!(await machine.login())) throw new Error("登录失败");
  await machine.evaluate(`location.hash = '#/console'`);
  await sleep(1200);

  const before = await machine.evaluate(`({ active: navigator.userActivation?.isActive, sticky: navigator.userActivation?.hasBeenActive })`);
  console.log("激活状态（点击前）：", JSON.stringify(before));

  /* 用 CDP 的 userGesture 造一次"用户手势"：sticky activation 一旦为 true，
     之后页面里的 play() 就都放行了 —— 与真人先点一下页面等价 */
  await machine.send("Runtime.evaluate", { expression: `navigator.userActivation?.hasBeenActive`, userGesture: true, returnByValue: true });
  const after = await machine.evaluate(`({ active: navigator.userActivation?.isActive, sticky: navigator.userActivation?.hasBeenActive })`);
  console.log("激活状态（userGesture 之后）：", JSON.stringify(after));

  const result = await machine.evaluate(`(async () => {
    const one = async (url) => {
      const audio = new Audio(url);
      const record = { url, events: [] };
      audio.onerror = () => record.events.push('error:' + (audio.error && audio.error.code));
      audio.onloadedmetadata = () => record.events.push('metadata:' + Math.round(audio.duration * 100) / 100);
      audio.oncanplaythrough = () => record.events.push('canplaythrough');
      try {
        await audio.play();
        record.play = 'ok';
      } catch (error) {
        record.play = 'rejected:' + (error && error.name) + ':' + (error && error.message);
      }
      await new Promise((r) => setTimeout(r, 1500));
      record.paused = audio.paused;
      record.currentTime = Math.round(audio.currentTime * 100) / 100;
      audio.pause();
      return record;
    };
    return {
      notHeard: await one('/voice/not_heard.mp3'),
      round04: await one('/voice/round-04.mp3'),
    };
  })()`);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(`探针异常：${error?.stack ?? error}`);
  process.exitCode = 1;
} finally {
  machine.kill();
}
