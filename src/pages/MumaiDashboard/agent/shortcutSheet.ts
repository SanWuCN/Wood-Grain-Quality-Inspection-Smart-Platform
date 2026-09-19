/**
 * 小木气泡里的**对话一览**（按顺序列出 25 轮：第几轮、这一轮怎么说、小木念什么）
 *
 * ── 这张表为什么在气泡里（用户口径 2026-09-17）────────────────────────
 * 用户原话：「小木呢，别人内网登上去也得能用快捷键呼唤出来相应对话」。
 * 快捷键本身在**任何机器**上都是好的（纯前端：按键 → 脚本化识别 → 剧本直答，
 * 录音走同源的 `/voice/*.mp3`，见 `tools/验收-快捷键气泡.mjs`）。
 * 缺的是"别人怎么知道按哪个键"，于是把表搬进气泡，数据源只有剧本与条目表两处，
 * 页面不手抄一行字。
 *
 * ── 2026-10-01 起：**键位不再显示**（用户口径：「小木气泡快捷键显示删了」）──
 * 键位表出现在投影给观众看的气泡上，等于把"整场演示是按组合键驱动的"写在屏幕上。
 * 所以这一览现在只列**轮次与台词**，`.keys` 字段与「一条龙」那一行一并去掉；
 * 键位仍然好使（`useScriptShortcut` 那一套没动），只是不再画在屏幕上：
 *   · 讲解人自己看键位 → `docs/史-台词与提词背诵方案-v1.0.md`；
 *   · 想核对"第 N 个键 = 第 N 轮"→ `scriptShortcutSequence.test.ts` 与
 *     `scriptShortcutCoverage.test.ts`（键位表的唯一事实源在 `scriptShortcutEntries.ts`）。
 * `shortcutSheet.test.ts` 里钉了一条：这一览的数据里**不许再出现 `Ctrl` 字样**。
 *
 * ⚠ 麦克风那条路在内网机器上是**不可用**的：浏览器只在 https 或 localhost 下
 *   暴露 `navigator.mediaDevices`，同事用 `http://192.168.x.x:8000` 打开时
 *   唤醒与语音输入都会被挡。这一点必须在界面上说清楚（气泡里就有一行），
 *   否则用户会以为"小木坏了"，而其实是浏览器的安全限制。
 */
import { SCRIPT_ROUNDS, mainLineOf } from "./script";
import { SCRIPT_SHORTCUT_ENTRIES } from "./scriptShortcutEntries";

/** 一条要显示的行（纯数据，便于单测；不依赖 DOM） */
export type ShortcutSheetRow = {
  /** 序号，1 起 */
  index: number;
  /** 圈号与轮次标题，如 `① 三个月巡检与风险统计` */
  round: string;
  /** 这一轮怎么触发：照着说这句话，或"按钮触发，不用说话" */
  how: string;
  /** 小木会念的话（逐字） */
  reply: string;
};

/**
 * 组装一览表。
 *
 * 两条来源拼起来，任何一条对不上就抛错（宁可红，也不要一张错位的表）：
 *   1. 条目表给的"照着说什么"；
 *   2. 剧本给的轮次标题与主台词；
 * 并且条目数必须等于轮数（第 N 条 = 第 N 轮，顺序不能错）。
 */
export function shortcutSheetRows(): ShortcutSheetRow[] {
  if (SCRIPT_SHORTCUT_ENTRIES.length !== SCRIPT_ROUNDS.length) {
    throw new Error(
      `快捷键条目 ${SCRIPT_SHORTCUT_ENTRIES.length} 条 ≠ 剧本 ${SCRIPT_ROUNDS.length} 轮 —— 一览表会错位`,
    );
  }
  return SCRIPT_SHORTCUT_ENTRIES.map((entry, index) => {
    const round = SCRIPT_ROUNDS.find((item) => item.roundNo === entry.roundNo);
    if (!round) throw new Error(`第 ${index + 1} 条指向的轮次 ${entry.roundNo} 不存在`);
    return {
      index: index + 1,
      round: `${round.roundNo} ${round.title}`,
      /* 主动发起的条目 text 就是小木自己的台词 —— 那种情况没人说话 */
      how: entry.proactive ? "按钮触发，不用说话" : entry.text,
      reply: mainLineOf(round),
    };
  });
}
