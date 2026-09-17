/**
 * 小木快捷键一览（气泡里那张「按哪个键出哪一段」）
 *
 * ── 为什么气泡里要自带这张表（用户口径 2026-09-17）────────────────────
 * 用户原话：「小木呢，别人内网登上去也得能用快捷键呼唤出来相应对话」。
 *
 * 快捷键本身在**任何机器**上都是好的（纯前端：按键 → 脚本化识别 → 剧本直答，
 * 录音走同源的 `/voice/*.mp3`，见 `tools/验收-快捷键气泡.mjs` 的 LAN 验收）。
 * 真正缺的是"别人怎么知道按哪个键"：键位表原来只存在于代码与主机上的一份 md，
 * 内网另一台机器登进来的人看不到 —— 于是"能用"变成了"不会用"。
 *
 * 所以把表搬进气泡：数据源只有两处，页面不手抄一行字，
 * 剧本改了台词、条目表换了键位，这里跟着变（`shortcutSheet.test.ts` 会核对）。
 *
 * ⚠ 麦克风那条路在内网机器上是**不可用**的：浏览器只在 https 或 localhost 下
 *   暴露 `navigator.mediaDevices`，同事用 `http://192.168.x.x:8000` 打开时
 *   唤醒与语音输入都会被挡。这一点必须在界面上说清楚（下面就有一行），
 *   否则用户会以为"小木坏了"，而其实是浏览器的安全限制。
 */
import { SCRIPT_ROUNDS, mainLineOf } from "./script";
import { SCRIPT_SHORTCUT_ENTRIES } from "./scriptShortcutEntries";
import { shortcutLabel } from "./scriptShortcutSequence";

/** 一条要显示的行（纯数据，便于单测；不依赖 DOM） */
export type ShortcutSheetRow = {
  /** 序号，1 起 */
  index: number;
  /** 显示用的键位，如 `Ctrl+B+1` / `Ctrl+Y+0` / `Ctrl+M+5` */
  keys: string;
  /** 圈号与轮次标题，如 `① 三个月巡检与风险统计` */
  round: string;
  /** 这一轮怎么触发：照着说这句话，或"按钮触发，不用说话" */
  how: string;
  /** 小木会念的话（逐字） */
  reply: string;
};

/**
 * 键位文本的**唯一实现**在 `scriptShortcutSequence.shortcutLabel`：
 * 2026-09-17 起三段前缀各不同（B/Y/M），前缀不能再当成一个常量导出。
 * 这里保留一个同名转发，方便页面侧少 import 一个模块。
 */
export function keyLabel(id: string): string {
  return shortcutLabel(id);
}

/**
 * 组装一览表。
 *
 * 三条来源拼起来，任何一条对不上就抛错（宁可红，也不要一张错位的表）：
 *   1. 条目表给的键位与"照着说什么"；
 *   2. 剧本给的轮次标题与主台词；
 *   3. 条目数必须等于轮数（第 N 个键 = 第 N 轮）。
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
      /* 键位文本由复合 id 直接渲染：三段前缀各不同，这里不能再拼一个常量前缀 */
      keys: keyLabel(entry.key),
      round: `${round.roundNo} ${round.title}`,
      /* 主动发起的条目 text 就是小木自己的台词 —— 那种情况没人说话 */
      how: entry.proactive ? "按钮触发，不用说话" : entry.text,
      reply: mainLineOf(round),
    };
  });
}
