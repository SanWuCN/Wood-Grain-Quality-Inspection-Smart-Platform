/**
 * 现场环境页的数据装配（纯逻辑，Node 单测可覆盖）
 *
 * ── 这一页为什么存在（贴合剧本）────────────────────────────────────
 * 剧本第一幕史的口播是「平台已关联本次工单。**设备页、环境记录页和数据接收页**准备完成」，
 * 第 5 条沈让小木「查找一下现场情况，提供近三个月的天气数据，评估该地古建可能存在的风险」，
 * 第 8 条小木「调用配置查询和参数推荐工具，显示当前值、建议值与依据」。
 * 三句话都要有页面接得住 —— 本模块给的是「环境记录页」那一张的内容：
 * 现场与工单 → 近三个月天气档案（四分类 + 风险项 + 来源）→ 本次读数与校验结论 →
 * 参数建议对照。
 *
 * ── 数字都从哪儿来（§11.5：同一指标不得在三个文件里手写三个数值）────
 *   · 天气四分类 → `DEMO_SCENARIO_V3.weather`（浮层卡片、播报模板与这一页共用同一批键）；
 *   · 本次读数与校验结论 → 服务端工单实体（`environment`），本页**只读**：
 *     录入与校验的入口仍然只有工单详情页那一个（`EnvironmentPanel`），
 *     两处都能写同一份草稿必然会分叉；
 *   · 参数建议 = 「当前录入（草稿）」与「已校验配置版本」逐项对照，
 *     依据取服务端校验结论的原文 —— 不在这里另编一套建议值。
 * 本文件**不写任何字面量数值**，标签一律复用 `demoSurfaceLabels` 的标签表。
 *
 * ── 两条不能让步的口径（剧本夹注）──────────────────────────────────
 *   · 风速**不代入** HH 模型，只作采集稳定性与环境记录；
 *   · 参数建议**只形成建议**，不自动改写设备参数。
 */

import type { EnvironmentView, WorkOrderDetail } from "../api/client";
import { formatValue, labelOf } from "../agent/demoSurfaceLabels";
import { DEMO_SESSION, HH_PRIOR, scenarioValue } from "../seed/scenario";

/** 一行「标签 + 值」——与演示表面的渲染行同一口径（`labelOf` + `formatValue`） */
export type EnvRow = { key: string; label: string; value: string };

/** 天气四分类（§6.2）：降水 / 湿度 / 风 / 温差，每类带各自的现场风险项 */
export type WeatherCategory = {
  key: "rain" | "humidity" | "wind" | "temperature";
  title: string;
  rows: EnvRow[];
  risks: string[];
};

const WEATHER_TITLES: Record<WeatherCategory["key"], string> = {
  rain: "降水",
  humidity: "湿度",
  wind: "风",
  temperature: "温度",
};

/** 每一类要展示的数据键（顺序即屏幕顺序） */
const WEATHER_KEYS: Record<WeatherCategory["key"], readonly string[]> = {
  rain: [
    "weather.rain.totalMm",
    "weather.rain.rainyDays",
    "weather.rain.stormDays",
    "weather.rain.longestWetSpellDays",
    "weather.rain.peakDailyMm",
  ],
  humidity: ["weather.humidity.avgPct", "weather.humidity.highHumidityDays", "weather.humidity.maxDailyAvgPct"],
  wind: ["weather.wind.maxGustMs", "weather.wind.strongWindDays"],
  temperature: ["weather.temperature.maxDailyDeltaC"],
};

/**
 * 按数据键渲染成行。
 *
 * 取不到值就是「—」并记下缺的是哪个键，**绝不补一个"看起来合理"的数**（§11.1）；
 * 标签缺失时显式写出缺哪个键，而不是把 `weather.rain.totalMm` 抛给观众。
 */
export function rowsOfKeys(keys: readonly string[]): EnvRow[] {
  return keys.map((key) => {
    const raw = scenarioValue(key);
    const meta = labelOf(key);
    if (raw === undefined || meta === null) {
      return { key, label: meta ? meta.label : `〔标签缺失：${key}〕`, value: "—" };
    }
    return { key, label: meta.label, value: formatValue(raw, meta.unit) };
  });
}

/** 天气四分类：数值行 + 该类对应的现场风险项（风险项同样按数据键取，不手写） */
export function weatherCategories(): WeatherCategory[] {
  return (Object.keys(WEATHER_KEYS) as WeatherCategory["key"][]).map((key) => {
    const risks = scenarioValue(`weather.${key}.risks`);
    return {
      key,
      title: WEATHER_TITLES[key],
      rows: rowsOfKeys(WEATHER_KEYS[key]),
      risks: Array.isArray(risks) ? risks.map((item) => String(item)) : [],
    };
  });
}

/**
 * 档案窗口与来源标注。
 *
 * 来源一律写「归档天气档案 · 当前未启用联网查询」——纯内网演示下平台**不发公网请求**
 * （工作清单 §4.1），页面上不能出现"实时""联网获取"这类说法，否则现场断网就对不上。
 */
export function weatherSource(): { range: string; source: string; note: string; title: string } {
  return {
    title: String(scenarioValue("weather.panelTitle") ?? "平台环境档案"),
    range: `${scenarioValue("weather.rangeStart")} 至 ${scenarioValue("weather.rangeEnd")}（近三个月）`,
    source: DEMO_SESSION.weatherArchive.source,
    note: "本页数值取自归档天气档案，未启用联网查询；现场结论以实测为准。",
  };
}

/**
 * 天气四类风险 → 现场优先检查项。
 *
 * 剧本第 5 条要的是「评估该地古建**可能存在的风险**」，所以把四类各自的风险项
 * 合成一张清单（去重、保序），并注明依据来自哪一类 —— 结论只说"优先检查什么"，
 * 不下"哪里有病害"的判断（那是精扫与复核的事）。
 */
export function riskChecklist(): { item: string; from: string }[] {
  const seen = new Set<string>();
  const out: { item: string; from: string }[] = [];
  for (const category of weatherCategories()) {
    for (const risk of category.risks) {
      if (seen.has(risk)) continue;
      seen.add(risk);
      out.push({ item: risk, from: `${category.title}类档案` });
    }
  }
  return out;
}

/** 本次环境读数（服务端工单实体）：四项读数 + 测量信息 + 已校验配置版本 */
export type CurrentEnv = {
  /** recorded = 已录入；pending = 尚未录入（一律显示「—」，不填演示默认值） */
  state: "recorded" | "pending";
  readings: EnvRow[];
  meta: { k: string; v: string }[];
  draftRevision: number;
  configVersion: string | null;
  configValidatedAt: string | null;
  checks: { key: string; label: string; ok: boolean; message: string }[];
};

function numberText(value: number | null | undefined, unit: string): string {
  return typeof value === "number" && Number.isFinite(value) ? `${value} ${unit}` : "—";
}

/**
 * 工单环境读数的展示模型。
 *
 * 空值显示「—」，**不显示 0 / 26.4 / 78 这类默认值**（A09）；仪表与配置版本
 * 一律取服务端返回的实体，不在前端编。
 */
export function currentEnvReadings(env: EnvironmentView | null | undefined): CurrentEnv {
  const empty: CurrentEnv = {
    state: "pending",
    readings: [],
    meta: [],
    draftRevision: 0,
    configVersion: null,
    configValidatedAt: null,
    checks: [],
  };
  if (!env) return empty;
  const readings = env.fields.map((field) => ({
    key: field.key,
    label: field.label,
    value: numberText(env.inputs[field.key], field.unit),
  }));
  return {
    state: readings.some((row) => row.value !== "—") ? "recorded" : "pending",
    readings,
    meta: [
      { k: "测量位置", v: env.position ?? "—" },
      { k: "测量时间", v: env.measuredAt ?? "—" },
      { k: "录入人岗位", v: env.updatedByLabel ?? "—" },
      {
        k: "仪表",
        v: env.instruments.length
          ? env.instruments.map((item) => item.instrumentId).join("、")
          : "按缺省量程校验",
      },
    ],
    draftRevision: env.draftRevision,
    configVersion: env.config?.configVersion ?? null,
    configValidatedAt: env.config?.validatedAt ?? null,
    checks: env.config?.checks ?? [],
  };
}

/**
 * 参数建议对照：**当前录入（草稿）** vs **已校验配置版本**，逐项给依据。
 *
 * 依据取该字段在服务端校验结论里的原文（量程、边界、时钟），不另写一套说法；
 * 没有已校验版本时**不编建议值**，整表进入「待核验」（剧本：「没有对应记录的项目保留待核验」）。
 */
export function compensationCompare(env: EnvironmentView | null | undefined): {
  state: "ready" | "pending";
  rows: string[][];
  methodVersion: string | null;
  note: string;
} {
  const current = currentEnvReadings(env);
  const note = "对照表只形成建议：请全栈工程师用参考件复核后再下发，平台不自动改写设备参数。";
  if (!env || !env.config) {
    return {
      state: "pending",
      rows: current.readings.map((row) => [row.label, row.value, "待核验", "尚未生成配置版本，保留待核验"]),
      methodVersion: null,
      note,
    };
  }
  const reasonOf = (key: string) => {
    const hit = env.config?.checks.find((check) => check.field === key);
    return hit ? hit.message : "服务端校验未涉及该字段";
  };
  return {
    state: "ready",
    rows: env.fields.map((field) => {
      const draft = numberText(env.inputs[field.key], field.unit);
      const published = numberText(env.config?.inputs[field.key], field.unit);
      return [field.label, draft, `${published}（${env.config?.configVersion ?? "—"}）`, reasonOf(field.key)];
    }),
    methodVersion: env.config.methodVersion,
    note,
  };
}

/** HH 平衡含水率先验的口径声明（服务端算值，页面只讲边界） */
export function humidityPrior(): { model: string; note: string; windNote: string } {
  return {
    model: HH_PRIOR.model,
    note: HH_PRIOR.note,
    windNote: HH_PRIOR.windExcluded
      ? "风速仅作采集稳定性与环境记录，不代入 HH 模型。"
      : "风速口径待核。",
  };
}

/**
 * 现场地点的显示串。
 *
 * 服务端的 `location` 常常**已经带着区县**（例如「上海市松江区示例寺院内」），
 * 再拼一次 `district` 就成了「…松江区示例寺院内 · 上海市松江区」——
 * 一眼看得出是机器拼的。包含关系成立时只显示 `location`。
 */
function sitePlace(location: string, district: string): string {
  const place = (location ?? "").trim();
  const area = (district ?? "").trim();
  if (!place) return area || "—";
  if (!area) return place;
  return place.includes(area) || area.includes(place) ? place : `${place} · ${area}`;
}

/** 「现场与工单」一栏：把服务端工单上的现场信息摊平成行（地点 / 委托 / 计划 / 构件） */
export function orderSiteRows(detail: WorkOrderDetail | null | undefined): { k: string; v: string }[] {
  if (!detail || detail.restricted) {
    return [
      { k: "工单", v: "未选中工单" },
      { k: "现场地点", v: "—" },
      { k: "检测主体", v: "—" },
    ];
  }
  const subjects = detail.subjects.map((item) => item.code || item.name).filter(Boolean);
  return [
    { k: "工单号", v: detail.order.orderNo },
    { k: "委托单位", v: detail.commission.unit || "—" },
    { k: "项目名称", v: detail.commission.projectName || "—" },
    { k: "现场地点", v: sitePlace(detail.order.location, detail.order.district) },
    { k: "委托日期", v: detail.commission.date || "—" },
    {
      k: "计划时间",
      v: detail.order.plannedStart
        ? `${detail.order.plannedStart}${detail.order.plannedEnd ? ` 至 ${detail.order.plannedEnd}` : ""}`
        : "—",
    },
    { k: "检测主体", v: subjects.length ? subjects.join("、") : "—" },
  ];
}
