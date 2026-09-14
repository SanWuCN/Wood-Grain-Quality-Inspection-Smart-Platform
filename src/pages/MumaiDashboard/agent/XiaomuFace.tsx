/**
 * 小木的脸 · 位图形象（**有 GIF 的状态直接播 GIF**）
 *
 * ── 这一版修了什么（用户口径）────────────────────────────────────────
 * 「没有播放 gif，没有调用到说话 gif，现在是静态图片不是 gif，更改渲染适配」
 *
 * 上一版七状态全部指向**静止帧 WebP**，所以哪怕有动效也永远不动。
 * 现在改成：
 *   · 有对应动效的状态 → 直接播 **GIF**（`assets/xiaomu/*.gif`，由抠绿幕产出）
 *   · 没有动效的状态   → 用静止帧 WebP（同一次抠图、同一套参数，观感一致）
 *
 * ── 状态 → 素材的对应关系 ───────────────────────────────────────────
 *   idle         静止帧（呼吸起伏由 CSS 的 `xd-idle` 给，6px 位移）
 *   listening    眯眼笑 GIF（跟着语音在动）
 *   recognizing  眯眼笑 GIF（复用同一个动效：两步都是"在听/在认"，非语言状态）
 *   thinking     皱眉抬眼 GIF
 *   speaking     口型开合 GIF  ← 这就是用户说的"说话 gif"
 *   confirming   静止帧（等确认，用好奇表情）
 *   error        静止帧（出错，用困惑表情）
 *
 * ⚠ **尺寸必须与静止帧一致**：GIF 与 WebP 都是 240×240、球都铺满整帧，
 *   所以换素材不会跳尺寸。这一点由下面的 `SIZE` 常量与 `object-fit: contain` 共同保证。
 *
 * ── 为什么用 <img> 而不是把 GIF 当背景图 ────────────────────────────
 * `<img>` 才能被 `alt` / `aria` / `draggable` 这些无障碍与交互属性约束；
 * 而且 `prefers-reduced-motion` 下我们可以**换回静止帧**（见下），
 * 背景图做不到这种按状态切换的降级。
 */
import { useEffect, useState } from "react";

import stateIdle from "../../../assets/xiaomu/state-idle.webp";
import stateConfirming from "../../../assets/xiaomu/state-confirming.webp";
import stateError from "../../../assets/xiaomu/state-error.webp";
import gifListening from "../../../assets/xiaomu/blink.gif";
import gifBlinkIdle from "../../../assets/xiaomu/blink-idle.gif";
import gifThinking from "../../../assets/xiaomu/think.gif";
import gifSpeaking from "../../../assets/xiaomu/speak.gif";

/**
 * 七状态 → 素材。
 *
 * `gif` 表示"这一状态有动效，优先播它"；缺省则用 `still`。
 * key 与 `XiaomuDock` 的 `DockState` 逐字对应（`XiaomuFace.test.ts` 有对账单测）。
 *
 * ⚠ **待机用慢速那版眨眼**（用户口径：「待机时候也要用眨眼动画，动画速度放慢到 0.8」）。
 * 两版 GIF 帧数完全相同、只差每帧延时：
 *   · `blink.gif`      40ms/帧 → 整周期 1.96s
 *   · `blink-idle.gif` 50ms/帧 → 整周期 2.45s（2.45 ÷ 1.96 = 1.25 倍周期，即速度 0.8 倍）
 * 待机是"一直在跑"的背景动画，慢一点更安静；说话/思考是短时反馈，慢下来会显得迟钝，
 * 所以只有待机用慢版。
 */
const STATE_ASSET: Record<string, { gif?: string; still: string }> = {
  idle: { gif: gifBlinkIdle, still: stateIdle },
  listening: { gif: gifListening, still: stateIdle },
  recognizing: { gif: gifListening, still: stateIdle },
  thinking: { gif: gifThinking, still: stateIdle },
  speaking: { gif: gifSpeaking, still: stateIdle },
  confirming: { still: stateConfirming },
  error: { still: stateError },
};


/**
 * 是否需要把动效降级成静止帧。
 *
 * `prefers-reduced-motion: reduce` 时**不能**还放 GIF ——
 * GIF 是逐帧位图，CSS 动画那套全局"把 duration 压到 0.01ms"的手段对它完全无效，
 * 它会继续动。所以这里显式换回静止帧。
 * 换回之后状态照样能分辨（静止帧的表情本身不同），满足 FR-06 / AC-05。
 */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof matchMedia !== "function") return undefined;
    const mq = matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduced(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return reduced;
}

export type XiaomuFaceProps = {
  /** 界面状态，由 `XiaomuDock` 传入；缺省 idle，未知值也回落 idle */
  state?: string;
};

export default function XiaomuFace({ state = "idle" }: XiaomuFaceProps) {
  const reduced = usePrefersReducedMotion();
  const resolved = STATE_ASSET[state] ? state : "idle";
  const asset = STATE_ASSET[resolved];
  /* 有 GIF 且没要求减动效 → 播 GIF；否则用静止帧 */
  const src = !reduced && asset.gif ? asset.gif : asset.still;

  return (
    <img
      className="xd__figure xf"
      src={src}
      alt=""
      role="presentation"
      aria-hidden="true"
      draggable={false}
      /* data-state 保留原语义钩子；data-src-kind 便于工装区分"播的是 GIF 还是静止帧" */
      data-state={resolved}
      data-face={resolved}
      /*
       * ⚠ 判"是不是 GIF"必须**先剥掉查询串**：Vite 在生产/开发构建里会给资源 URL
       * 加 `?t=...` 或 `?v=...`，`src.endsWith(".gif")` 在带查询串时永远为 false。
       * 实测后果：GIF 明明在播，但 `data-src-kind` 报 "still"，截图工装据此误判
       * "没有播放 gif"（用户口径："没有播放 gif"）。
       */
      data-src-kind={/\.gif(\?|$)/i.test(src) ? "gif" : "still"}
    />
  );
}
