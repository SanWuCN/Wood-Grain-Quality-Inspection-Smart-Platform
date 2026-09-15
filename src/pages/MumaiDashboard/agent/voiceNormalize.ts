/**
 * 语音归一化与阶段提示（工作清单 v1.0 §9）
 *
 * ── 两层归一化，分工不同 ────────────────────────────────────────────
 *   ① **字符级**（`scriptMatch.ts` 的拼音解码）：同音字自动等价，
 *      解决「清洗/清晰」「古建/古剑」这类**逐字**误听。无需枚举。
 *   ② **实体级**（本文件的 `normalizeEntitySpelling`）：把"同一个东西的不同叫法"
 *      统一成一个码，如 `Z零四` / `四号柱` / `四号木柱` 都是 `Z04`。
 *      这类不是同音问题（"四号柱"和"Z04"一点都不同音），必须显式建表。
 *
 * §9.2 把这两层的要求并列写在一张表里，所以实现上也要分开管，
 * 否则会出现"以为拼音能覆盖，结果实体别名没人管"的漏洞。
 */

/** §9.2 明列的实体别名 → 统一码  */
const ENTITY_ALIASES: Record<string, string> = {
  /* Z04 的四种说法（§9.2 逐字给定） */
  z04: "Z04",
  z零四: "Z04",
  四号柱: "Z04",
  四号木柱: "Z04",
  /* 同族的其余编号（同一条规则的自然外推，演示里都可能被说到） */
  z01: "Z01",
  z零一: "Z01",
  一号柱: "Z01",
  一号木柱: "Z01",
  z02: "Z02",
  z零二: "Z02",
  二号柱: "Z02",
  二号木柱: "Z02",
  z03: "Z03",
  z零三: "Z03",
  三号柱: "Z03",
  三号木柱: "Z03",
};

/**
 * 把"同一个东西的不同叫法"归一成一个码（§9.2 的实体别名表）。
 *
 * 找不到别名时**原样返回**：不做模糊猜测 —— 猜错会把用户指的那个构件换成另一个，
 * 而构件编号是后续所有结论的挂载点，指错等于结论挂错。
 */
export function normalizeEntitySpelling(text: string): string {
  const trimmed = String(text).trim();
  if (!trimmed) return trimmed;
  return ENTITY_ALIASES[trimmed.toLowerCase()] ?? trimmed;
}

/** §9.2 末：单条阶段提示不超过 40 个汉字 */
export const PHASE_HINT_MAX_CHARS = 40;

/**
 * 按当前阶段给出**短**引导语（§9.2 末）。
 *
 * 为什么必须短、且必须分阶段：
 *   · 识别提示（prompt）越长，热词表越容易被稀释，短句反而更准；
 *   · 把 22 轮长文本一次性塞进去，等于让识别器在几十个候选里选，
 *     实测更容易把不相干的说法匹配成某个轮次。
 * 所以这里只给"当前阶段该说什么"的一句话，不给整套剧本。
 */
export function phaseHintFor(state: string): string {
  switch (state) {
    case "listening":
      return "请说「小木小木」，停顿一下，再说完整指令。";
    case "thinking":
      return "正在整理，请稍候。";
    case "speaking":
      return "正在播报，可等播完再说下一句。";
    case "confirming":
      return "需要你确认，请说「确认」或「取消」。";
    case "error":
      return "刚才没听清，请再说一遍。";
    case "idle":
    default:
      return "说「小木小木」可以唤醒；也可以直接说关键词。";
  }
}
