/**
 * 环境读数录入预设 —— **现场演练用的提词器**（隐藏机制：弹窗里按 Enter 依次填入）
 *
 * ── 这是什么、不是什么 ────────────────────────────────────────────────
 * 在「录入环境读数」弹窗里，焦点落在任一输入框上时，每按一次 Enter 就按固定顺序
 * 把**下一个还没填的**一项填上；六项填满后 Enter 不再动任何数据。
 *
 * 它**不是新单默认值**：弹窗打开时六项仍然是空的（PRD §4.1 L68「环境读数、测量时间、
 * 测量位置全部为空」，A09「空值显示 — + 待录入，不显示 0、26.4、78、1.2 这类默认值」
 * 原样不动）。只有人手按键才会出现数字 —— 这条边界是这只提词器唯一的合法性来源。
 *
 * ── 数值来源（PRD-工单指派与扫描仪下发-v1.0 §9.2 的示例包字段）──────────
 * 原文：「示例包字段（数值仅为已录入示例，绝不是新单默认值）」
 *   airTempC 26.4 ℃ ／ relativeHumidityPct 78 %RH ／ windSpeedMs 1.2 m/s ／
 *   atmosphericPressureHpa 1008.6 hPa ／ position「示例寺院内四根木柱检测区域」
 * 直接沿用文档里已录入示例的那组数，不另编一套"看着差不多"的读数：
 * 现场任何人拿文档对屏都能逐字对上，改一个数就是口径漂移（评审时说不清数字哪来的）。
 *
 * ── 三条不能让步的口径 ──────────────────────────────────────────────
 *   · **不填 1013.25**（§7.1 L218 / O3 / AC-15）：恒压标准大气压不是现场实测值。
 *     这里给 1008.6 hPa，并且**压力那一步同时把单位拨回 hPa** —— 否则用户在 kPa
 *     下按 Enter 会得到 1008.6 kPa（= 10086 hPa），量程 300–1100 必然判红，
 *     演示当场穿帮。
 *   · **测量时间不写死日期**：服务端要求测量时间不得晚于当前时间 60 秒以上（§7.1），
 *     写死的日期迟早把演示卡在「测量时间不晚于服务端时间」这条校验上（§4.2 同一条
 *     口径：样例时间按触发日生成，不能永远使用固定日期）。这里在**按下 Enter 的那一刻**
 *     取现场墙钟的当前分钟，与本组件读 `datetime-local` 的口径一致（不做时区换算）。
 *   · **只填空的，不覆盖人打的字**：任一项已经有输入（哪怕是人刚手打完）就跳过。
 *     预置值永远不冲掉人工录入 —— 否则"提词器"就变成了"改数据的"。
 *
 * 测量位置沿用文档 §9.2 的写法，只说到「院内四根木柱检测区域」：委托原文里四根木柱的
 * 方位与柱型属于「待现场确认 · 附件未明确」（`taskScope.ts`），预设不得借机把"东侧"
 * "金柱"这类未核对的事实写进测量位置。
 */

import type { EnvironmentFieldKey } from "../../api/client";

/** 预设覆盖的六项：四项读数 + 测量位置 + 测量时间（= 弹窗里可填的全部字段） */
export type EnvPresetKey = EnvironmentFieldKey | "position" | "measuredAt";

/**
 * 填入结果。气压多带一个 `unit`：值是 hPa 口径的，必须连单位一起给，
 * 否则同一串数字在 kPa 下会被服务端按 10 倍换算（见文件头第三条）。
 */
export type EnvPresetStep =
  | { key: EnvironmentFieldKey; value: string; unit?: string }
  | { key: "position"; value: string }
  | { key: "measuredAt"; value: string };

/**
 * 填入顺序 = 弹窗里的字段顺序（四项读数 → 测量位置 → 测量时间）。
 *
 * 顺序即演示口径：屏幕上的数字自上而下逐个出现，不会跳着填。
 */
export const ENV_PRESET_ORDER: readonly EnvPresetKey[] = Object.freeze([
  "airTempC",
  "relativeHumidityPct",
  "windSpeedMs",
  "atmosphericPressureHpa",
  "position",
  "measuredAt",
] as const);

/**
 * 四项读数的**录入文本**（不是 number）：写进输入框的就是这几个字。
 *
 * 存文本而不是数字，是为了绕开 `String(26.4)` 这类浮点格式化的不确定性 ——
 * 逐字核对是这组值的唯一验收方式。
 */
export const ENV_PRESET_READINGS: Readonly<Record<EnvironmentFieldKey, string>> = Object.freeze({
  airTempC: "26.4",
  relativeHumidityPct: "78",
  windSpeedMs: "1.2",
  atmosphericPressureHpa: "1008.6",
});

/** 测量位置：PRD §9.2 示例包里的原文，不猜方位、不猜柱型 */
export const ENV_PRESET_POSITION = "示例寺院内四根木柱检测区域";

/** 气压预设值的单位：与 1008.6 这个数绑定，换单位必须换值 */
export const ENV_PRESET_PRESSURE_UNIT = "hPa";

/** 两位数补零，`datetime-local` 要的就是这种定长文本 */
function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * 测量时间 → `YYYY-MM-DDTHH:mm`（现场墙钟，分钟精度）。
 *
 * 与 `EnvironmentPanel.toLocalInput()` 同一口径：取浏览器本地时间字段，不做时区换算；
 * 截到分钟会让它比"现在"早 0–59 秒，所以永远满足"不晚于服务端时间 60 秒"这条判据。
 */
export function envPresetMeasuredAt(now: Date = new Date()): string {
  return (
    `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}` +
    `T${pad2(now.getHours())}:${pad2(now.getMinutes())}`
  );
}

/** 某一项的预设值：位置与时间另有来源，其余取 `ENV_PRESET_READINGS` */
function stepFor(key: EnvPresetKey, now: Date): EnvPresetStep {
  if (key === "position") return { key, value: ENV_PRESET_POSITION };
  if (key === "measuredAt") return { key, value: envPresetMeasuredAt(now) };
  if (key === "atmosphericPressureHpa") {
    return { key, value: ENV_PRESET_READINGS[key], unit: ENV_PRESET_PRESSURE_UNIT };
  }
  return { key, value: ENV_PRESET_READINGS[key] };
}

/** 已填判定与组件内一致：空串与纯空白都算没填（不拿 `Number("")` 当 0） */
function isBlank(text: string | undefined): boolean {
  return typeof text !== "string" || text.trim() === "";
}

/**
 * 取**下一个待填项**：按 `ENV_PRESET_ORDER` 找到第一个还空着的字段。
 *
 * 六项都填满时返回 `null` —— 组件据此不再拦 Enter，页面上也不会出现"按了没反应"
 * 之外的任何副作用（不自动保存、不自动校验）。
 *
 * @param current 弹窗里当前的六项文本（打字中的也算，非空即跳过）
 * @param now     取测量时间的基准时刻；只有轮到 `measuredAt` 时才会用到
 */
export function nextEnvPresetFill(
  current: Partial<Record<EnvPresetKey, string>>,
  now: Date = new Date(),
): EnvPresetStep | null {
  for (const key of ENV_PRESET_ORDER) {
    if (!isBlank(current[key])) continue;
    return stepFor(key, now);
  }
  return null;
}
