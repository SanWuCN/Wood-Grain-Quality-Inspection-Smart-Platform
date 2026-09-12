/**
 * 小木语音智能体 · 实体归一化
 *
 * 技术方案 §17 的槽位抽取：话里说的「一号木柱 / 1号柱 / 第一根 / Z01」必须统一成
 * seed 里的构件编号（Z01–Z04）。这里只做归一化，别名词典在 matcher.ts 里由
 * COMPONENTS 派生，避免同一套别名写两遍。
 */

import { COMPONENTS } from "../../seed/scenario";

/** 中文序数 → 阿拉伯数字（只覆盖前六个，够四柱用；不够时按编号取） */
const CN_DIGITS: Record<string, string> = {
  一: "1",
  二: "2",
  三: "3",
  四: "4",
  五: "5",
  六: "6",
  七: "7",
  八: "8",
  九: "9",
};

/**
 * 把任意柱号说法归一成构件编号。
 *   "一号木柱" / "1号柱" / "第一根" / "z01" / "Z01" → "Z01"
 * 认不出来时返回 null（调用方决定是回退到默认构件还是让用户重说）。
 */
export function normalizePillar(input: string | undefined): string | null {
  if (!input) return null;
  const text = input
    .replace(/[\uff01-\uff5e]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .toLowerCase()
    .replace(/\s/g, "");

  // 直接命中编号：z01 / z1
  const direct = /z0?([1-9])/.exec(text);
  if (direct) {
    const id = `Z0${direct[1]}`;
    if (COMPONENTS.some((item) => item.id === id)) return id;
  }
  // 命中构件全名
  const byName = COMPONENTS.find((item) => text.includes(item.name.toLowerCase()));
  if (byName) return byName.id;

  // 序数说法：一号 / 1号 / 第一根 / 柱子2
  const ordinal = /(?:第|柱子|柱|木柱)?([一二三四五六七八九1-9])\s*(?:号|根|个|支)?/.exec(text);
  if (ordinal) {
    const raw = ordinal[1];
    const digit = CN_DIGITS[raw] ?? raw;
    const index = Number(digit);
    if (Number.isFinite(index) && index >= 1 && index <= COMPONENTS.length) {
      return COMPONENTS[index - 1].id;
    }
  }
  return null;
}

/** 归一化后仍认不出来的柱号，说明用户说的构件不在档案里 —— 用于纠错提示 */
export function pillarOutOfRange(input: string | undefined): boolean {
  return Boolean(input) && normalizePillar(input) === null;
}

/**
 * 归一化 + 查档案：一次拿到构件对象。
 * 认不出来时返回 null（调用方决定是回退默认构件还是直接拒绝下发），
 * 这样「让小车去五号木柱」不会被悄悄当成 Z01 执行。
 */
export function resolvePillar(input: string | undefined) {
  const id = normalizePillar(input);
  if (!id) return null;
  return COMPONENTS.find((item) => item.id === id) ?? null;
}

/** 默认构件：取有雷达响应（即真正测到过）的那根，全部未测时取档案第一根 */
export function defaultPillar() {
  return COMPONENTS.find((item) => item.radarScore !== null) ?? COMPONENTS[0];
}
