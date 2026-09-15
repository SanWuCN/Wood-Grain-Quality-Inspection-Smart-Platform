/**
 * 唤醒门控：TTS 播报期间与尾音期**不接受唤醒**（工作清单 v1.0 §9）
 *
 * ── 为什么需要一层逻辑门控，而不是只靠回声消除 ──────────────────────
 * 唤醒通道已经开了 `echoCancellation`，麦克风节点也不接扬声器
 * （见 `wakeChannel.ts`）。但**回声消除不保证消除自身 TTS**：
 * 浏览器只对"它判定来自扬声器的信号"做消除，实际效果取决于音量、设备
 * （外放/耳机）、以及音频管线延迟。把"不会自唤醒"押在浏览器实现上不稳。
 *
 * 所以这里再加一层**显式**门控：
 *   · 播报中 —— 一律拒绝；
 *   · 播报刚结束的 `WAKEREJECT_TAIL_MS` 内 —— 也拒绝（尾音与房间混响）；
 *   · 其余情况 —— 接受。
 *
 * ── 为什么不做成"播报中降低灵敏度" ──────────────────────────────────
 * 演示时用户不会在小木说话的同时下指令（说了也会被播报盖住），
 * 所以"播报中一律不接受"既最简单也最不容易出错；
 * 引入"降低灵敏度"反而要再调一个阈值，而那个阈值无法从数据推出。
 */

/** 播报结束后的静默期：这段窗口内的拾音不当作新指令 */
export const WAKEREJECT_TAIL_MS = 600;

export type WakeGateInput = {
  /** TTS 是否正在播报（取自 `VoiceOutput` 的 `speaking`） */
  speaking: boolean;
  /**
   * 距上一次播报结束的毫秒数。
   * 从未播报过时传一个大于静默期的值（调用方负责）。
   */
  sinceSpeechEndMs: number;
};

export type WakeGateDecision = {
  /** true = 这一帧的拾音不参与唤醒判定 */
  reject: boolean;
  /** 拒绝的理由（接受时为空串）；用于日志与验收核对 */
  reason: string;
};

/**
 * 判定当前是否应拒绝唤醒。
 *
 * 纯函数：不碰 DOM、不读时间 —— 时间由调用方传入。
 * 这样"播报中/尾音期/正常"三种情形都能在 Node 里逐条断言，
 * 不必起浏览器（本仓库的唤醒相关测试全都跑在 Node 下）。
 */
export function shouldRejectWake(input: WakeGateInput): WakeGateDecision {
  if (input.speaking) {
    return { reject: true, reason: "小木正在播报，暂时不接受唤醒（防自唤醒）" };
  }
  if (input.sinceSpeechEndMs < WAKEREJECT_TAIL_MS) {
    return {
      reject: true,
      reason: `距上次播报结束仅 ${Math.max(0, Math.round(input.sinceSpeechEndMs))}ms，处于尾音静默期（${WAKEREJECT_TAIL_MS}ms）`,
    };
  }
  return { reject: false, reason: "" };
}
