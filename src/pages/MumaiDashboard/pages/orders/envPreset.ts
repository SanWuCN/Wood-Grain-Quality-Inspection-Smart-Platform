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
 * ── 数值来源（用户 2026-09-23 口径变更：跟剧本走）────────────────────
 * 剧本《木脉智检.docx》第 71 行沈的口播是：
 *   「当前温度22摄氏度，相对湿度58%，风速0.6米每秒，大气压强101千帕。
 *     测量位置为四柱区域入口，时间按平台记录。请完成登记。」
 * 用户 2026-09-23 明确要求「把录入读数预备数据改成」这一组，所以这里以剧本为准。
 *
 * ⚠ 与 PRD-工单指派与扫描仪下发-v1.0 §9.2 的示例包字段（26.4 ℃ / 78 %RH / 1.2 m/s /
 *   1008.6 hPa）**故意不一致**：那是文档里的历史示例值，而这四个数是本次的**口播稿**。
 *   两者并存会当场对不上 —— 沈念的是 22/58/0.6，屏幕上却填进 26.4/78/1.2。
 *   要回退就改回下面四个值（连 `ENV_PRESET_PRESSURE_UNIT` 一起），并在提交信息里写明原因。
 *
 * ⚠ `seed/scenario.ts` 的 `ENV_RECORD` / `CONFIG_DIFF`（26.4 ℃ / 78 %RH / CFG-02）
 *   是**归档单**的工况，与本次新单的录入值不是同一条记录，**未跟着改**。
 *
 * ── 三条不能让步的口径 ──────────────────────────────────────────────
 *   · **不填 1013.25**（§7.1 L218 / O3 / AC-15）：恒压标准大气压不是现场实测值。
 *     这里给 101 kPa（剧本原话「大气压强101千帕」），并且**压力那一步同时把单位拨成 kPa** ——
 *     否则用户在 hPa 下按 Enter 会得到 `101 hPa`（= 10.1 kPa），
 *     量程 300–1100 hPa 必然判红，演示当场穿帮。
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
 * 存文本而不是数字，是为了绕开 `String(22)` 这类浮点格式化的不确定性 ——
 * 逐字核对是这组值的唯一验收方式。
 *
 * 取值 = 剧本第 71 行沈的口播：22 ℃ / 58 %RH / 0.6 m/s / 101 kPa（见文件头的来源说明）。
 */
export const ENV_PRESET_READINGS: Readonly<Record<EnvironmentFieldKey, string>> = Object.freeze({
  airTempC: "22",
  relativeHumidityPct: "58",
  windSpeedMs: "0.6",
  atmosphericPressureHpa: "101",
});

/** 测量位置：PRD §9.2 示例包里的原文，不猜方位、不猜柱型 */
export const ENV_PRESET_POSITION = "示例寺院内四根木柱检测区域";

/**
 * 气压预设值的单位：与 `101` 这个数绑定，换单位必须换值。
 *
 * 剧本念的是「大气压强101千帕」，所以这里是 **kPa** —— 服务端按 §7.1 换算成 hPa 存
 * （101 kPa = 1010 hPa，落在 300–1100 的量程内）。写成 hPa 会让 101 变成 10.1 kPa，
 * 校验当场判红。
 */
export const ENV_PRESET_PRESSURE_UNIT = "kPa";

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
