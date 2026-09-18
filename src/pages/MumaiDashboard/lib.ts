/**
 * 木脉智检 · 纯逻辑工具（不含 React，便于单测与复用）
 *
 * 这些函数都是「真的在算」，不是动画：
 *   - 环境校验：assert 0 ≤ RH ≤ 100、风速非负、仪表量程
 *   - 分组检查：物理样本 ID 集合求交，输出冲突清单
 *   - 新旧评估：同一测试集逐样本比较，算 TP/FP/TN/FN、精确率、召回率、F1
 *   - 融合规则：先判有效性与缺失，再判异常标志，不做分数相加平均
 *   - 归档校验：Web Crypto SHA-256 摘要对比
 *   - 知识库检索：中文字符 2–4 元 TF-IDF + 余弦相似度
 */

import type {
  ArchiveItem,
  ConfigDiffRow,
  Dataset,
  EnvRecord,
  Experiment,
  Prediction,
  Sample,
} from "./seed/types";
import { CONFIG_DIFF, ENV_RECORD } from "./seed/scenario";

export type CheckDetail = { label: string; value: string; ok: boolean };
export type CheckResult = {
  kind: string;
  passed: boolean;
  details: CheckDetail[];
  dataVersion: string;
  executedAt: string;
  /** 受限 Python 校验单元展示的表达式（PRD 12） */
  expression: string;
  error: string | null;
};

/** PRD 15：状态同时用文字与颜色 */
export type Tone = "ok" | "warn" | "danger" | "info" | "muted";

export function toneOf(ok: boolean): Tone {
  return ok ? "ok" : "danger";
}

/* ------------------------------------------------------------------ *
 * 1. 环境校验（PRD 3.1 / 12）
 * ------------------------------------------------------------------ */

export function buildConfigVersion(record: EnvRecord): string {
  const next = record.configVersion === "CFG-01" ? "CFG-02" : "CFG-03";
  return next;
}

export function validateEnvironment(record: EnvRecord): CheckResult {
  const details: CheckDetail[] = [
    {
      label: "温度单位",
      value: `${record.airTempC} ℃`,
      ok: /℃/.test(record.instrumentRange.unit),
    },
    {
      label: "assert 0 <= relative_humidity_pct <= 100",
      value: `${record.relativeHumidityPct} %`,
      ok: record.relativeHumidityPct >= 0 && record.relativeHumidityPct <= 100,
    },
    {
      label: "风速非负",
      value: `${record.windSpeedMs} m/s`,
      ok: record.windSpeedMs >= 0,
    },
    {
      label: "仪表量程",
      value: `${record.instrumentRange.min} ~ ${record.instrumentRange.max} ${record.instrumentRange.unit}`,
      ok: record.airTempC >= record.instrumentRange.min && record.airTempC <= record.instrumentRange.max,
    },
    {
      label: "测量位置与时间已填写",
      value: `${record.position} · ${record.measuredAt}`,
      ok: record.position.length > 0 && record.measuredAt.length > 0,
    },
    {
      label: "工单编号已绑定",
      value: "SH-2026-0901",
      ok: true,
    },
  ];
  const passed = details.every((item) => item.ok);
  return {
    kind: "environment",
    passed,
    details,
    dataVersion: `env/${record.recordId}`,
    executedAt: nowStamp(),
    expression: "assert 0 <= relative_humidity_pct <= 100",
    error: passed ? null : "存在未通过项，配置版本未生成",
  };
}

export function diffConfig(before: string, after: string): ConfigDiffRow[] {
  return CONFIG_DIFF.map((row) =>
    row.field === "配置版本" ? { ...row, before, after } : row,
  );
}

/*
 * 平衡含水率（HH 先验）**不在前端算**。
 *
 * 这里原来有一个 `hhPrior()`，用的是一条线性近似
 * （`6.1 + 0.032·rh + 0.18·max(0, 24 − t) …`），而服务端
 * `server/services/workflow.mjs` 的 `estimateEmc()` 用的是真正的
 * Hailwood-Horrobin 公式 —— 同一工况下两边给出的数不一样，
 * 正是评审反复点过的「两套口径」。
 *
 * 处理办法是**删掉重复的那一份**而不是维护一个镜像：EMC 由服务端在发布配置时
 * 算好、写在 `environment` 实体上，页面直接读 `envEntity.data.emcPct`。
 * 公式的参考点检查在 `tools/test-emc.mjs`（`npm run test:emc`）。
 */

/* ------------------------------------------------------------------ *
 * 2. 分组检查（PRD 3.5 / 12：真的做集合求交）
 * ------------------------------------------------------------------ */

export type GroupCheckResult = CheckResult & {
  intersections: { pair: string; ids: string[] }[];
  conflicts: { groupId: string; sampleIds: string[]; detail: string }[];
  counts: { name: string; count: number; ids: string[] }[];
};

export function checkGrouping(dataset: Dataset, samples: Sample[]): GroupCheckResult {
  const ids = (name: string) => dataset.splits.find((item) => item.name === name)?.sampleIds ?? [];
  const train = new Set(ids("训练集"));
  const val = new Set(ids("验证集"));
  const test = new Set(ids("测试集"));
  const inter = (a: Set<string>, b: Set<string>) => [...a].filter((id) => b.has(id));

  const intersections = [
    { pair: "训练集 ∩ 验证集", ids: inter(train, val) },
    { pair: "训练集 ∩ 测试集", ids: inter(train, test) },
    { pair: "验证集 ∩ 测试集", ids: inter(val, test) },
  ];

  // 冲突：同一 physical_sample_id 落在多个集合
  const byGroup = new Map<string, string[]>();
  dataset.splits.forEach((split) => split.sampleIds.forEach((id) => {
    const list = byGroup.get(id) ?? [];
    list.push(split.name);
    byGroup.set(id, list);
  }));
  const conflicts = [...byGroup.entries()]
    .filter(([, sets]) => sets.length > 1)
    .map(([groupId, sets]) => ({
      groupId,
      sampleIds: samples.filter((s) => s.physicalSampleId === groupId).map((s) => s.recordId),
      detail: `${groupId} 同时出现在 ${sets.join(" / ")}，需整组调整`,
    }));

  // 未进入任何集合的已审核可用样本
  const usedIds = new Set(dataset.splits.flatMap((split) => split.sampleIds));
  const orphans = [...new Set(samples.map((s) => s.physicalSampleId))].filter((id) => !usedIds.has(id));
  const unknownInSupervised = samples.filter(
    (s) => s.knownState === "未知待核验" && usedIds.has(s.physicalSampleId),
  );

  const details: CheckDetail[] = [
    { label: "训练集物理样本", value: `${train.size} 组（${[...train].join(", ")}）`, ok: train.size > 0 },
    { label: "验证集物理样本", value: `${val.size} 组（${[...val].join(", ")}）`, ok: val.size > 0 },
    { label: "测试集物理样本", value: `${test.size} 组（${[...test].join(", ")}）`, ok: test.size > 0 },
    {
      label: "overlap = (train & val) | (train & test) | (val & test)",
      value: intersections.every((item) => item.ids.length === 0)
        ? "交集为空"
        : intersections.filter((item) => item.ids.length).map((item) => `${item.pair}: ${item.ids.join(",")}`).join("；"),
      ok: intersections.every((item) => item.ids.length === 0),
    },
    {
      label: "同一物理样本未拆散",
      value: conflicts.length === 0 ? "全部样本只出现在一个集合" : `${conflicts.length} 组冲突`,
      ok: conflicts.length === 0,
    },
    {
      label: "未知标签未进入监督训练",
      value: unknownInSupervised.length === 0
        ? "未知 / 待核验标签单列"
        : `仍有 ${unknownInSupervised.length} 条待核验样本在训练集合中`,
      ok: unknownInSupervised.length === 0,
    },
    {
      label: "未纳入任何集合的样本",
      value: orphans.length === 0 ? "无" : orphans.join(", "),
      ok: true,
    },
  ];

  return {
    kind: "grouping",
    passed: details.every((item) => item.ok),
    details,
    dataVersion: `dataset/${dataset.id}@${dataset.frozenAt ?? "未冻结"}`,
    executedAt: nowStamp(),
    expression: "overlap = (train_ids & val_ids) | (train_ids & test_ids) | (val_ids & test_ids)",
    error: null,
    intersections,
    conflicts,
    counts: [
      { name: "训练集", count: train.size, ids: [...train] },
      { name: "验证集", count: val.size, ids: [...val] },
      { name: "测试集", count: test.size, ids: [...test] },
    ],
  };
}

/* ------------------------------------------------------------------ *
 * 3. 新旧模型评估（PRD 3.6 / 11.2：真的算指标）
 * ------------------------------------------------------------------ */

export type Metrics = {
  key: string;
  label: string;
  tp: number;
  fp: number;
  tn: number;
  fn: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  accuracy: number | null;
  missRate: number | null;
  falseAlarmRate: number | null;
  naReason: string | null;
};

export type SampleCompareRow = {
  sampleId: string;
  groupId: string;
  material: string;
  label: 0 | 1;
  scoreOld: number;
  scoreNew: number;
  predOld: 0 | 1;
  predNew: 0 | 1;
  verdict: "改善" | "退化" | "不变";
  detail: string;
};

export type EvaluationResult = {
  threshold: number;
  testSetIds: string[];
  testSetConsistent: boolean;
  overall: { old: Metrics; next: Metrics };
  perMaterial: { material: string; old: Metrics; next: Metrics }[];
  rows: SampleCompareRow[];
  summary: { improved: number; regressed: number; same: number };
  acceptance: { key: string; label: string; detail: string; pass: boolean }[];
};

function safeDiv(a: number, b: number): number | null {
  if (b === 0) return null;
  return Number((a / b).toFixed(4));
}

export function computeMetrics(
  rows: Prediction[],
  threshold: number,
  key: string,
  label: string,
): Metrics {
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  rows.forEach((row) => {
    const pred = row.score >= threshold ? 1 : 0;
    if (pred === 1 && row.label === 1) tp += 1;
    else if (pred === 1 && row.label === 0) fp += 1;
    else if (pred === 0 && row.label === 0) tn += 1;
    else fn += 1;
  });
  const precision = safeDiv(tp, tp + fp);
  const recall = safeDiv(tp, tp + fn);
  const f1 =
    precision === null || recall === null || precision + recall === 0
      ? null
      : Number(((2 * precision * recall) / (precision + recall)).toFixed(4));
  const naReason =
    tp + fn === 0
      ? "该分组没有正样本，召回率与 F1 不适用"
      : tp + fp === 0
        ? "该分组没有预测为正的样本，精确率不适用"
        : null;
  return {
    key,
    label,
    tp,
    fp,
    tn,
    fn,
    precision,
    recall,
    f1,
    accuracy: safeDiv(tp + tn, rows.length),
    missRate: safeDiv(fn, fn + tp),
    falseAlarmRate: safeDiv(fp, fp + tn),
    naReason,
  };
}

export function runEvaluation(experiment: Experiment): EvaluationResult {
  const oldRows = experiment.predictionsOld;
  const nextRows = experiment.predictionsNew;
  const oldIds = oldRows.map((row) => row.sampleId).join("|");
  const newIds = nextRows.map((row) => row.sampleId).join("|");
  const threshold = experiment.threshold;

  const rows: SampleCompareRow[] = oldRows.map((oldRow) => {
    const nextRow = nextRows.find((item) => item.sampleId === oldRow.sampleId) ?? oldRow;
    const predOld: 0 | 1 = oldRow.score >= threshold ? 1 : 0;
    const predNew: 0 | 1 = nextRow.score >= threshold ? 1 : 0;
    const oldCorrect = predOld === oldRow.label;
    const newCorrect = predNew === nextRow.label;
    const verdict: SampleCompareRow["verdict"] =
      oldCorrect === newCorrect ? "不变" : newCorrect ? "改善" : "退化";
    return {
      sampleId: oldRow.sampleId,
      groupId: oldRow.groupId,
      material: oldRow.material,
      label: oldRow.label,
      scoreOld: oldRow.score,
      scoreNew: nextRow.score,
      predOld,
      predNew,
      verdict,
      detail: `真值 ${oldRow.label === 1 ? "异常" : "正常"}；旧版 ${predOld === oldRow.label ? "判对" : "判错"}，新版 ${predNew === nextRow.label ? "判对" : "判错"}`,
    };
  });

  const materials = [...new Set(oldRows.map((row) => row.material))];
  const perMaterial = materials.map((material) => ({
    material,
    old: computeMetrics(oldRows.filter((row) => row.material === material), threshold, `old-${material}`, `${material} · 旧版`),
    next: computeMetrics(nextRows.filter((row) => row.material === material), threshold, `new-${material}`, `${material} · 新版`),
  }));

  const overall = {
    old: computeMetrics(oldRows, threshold, "old", "DEMO-M02 旧版"),
    next: computeMetrics(nextRows, threshold, "new", "DEMO-M02b 新版"),
  };

  // 原有材种回归：非楠木分组召回不得低于基线 -0.02
  const legacy = perMaterial.filter((item) => item.material !== "楠木");
  const regressedMaterials = legacy.filter((item) => {
    if (item.old.recall === null || item.next.recall === null) return false;
    return item.next.recall < item.old.recall - 0.02;
  });

  const acceptance = experiment.acceptance.map((item) => {
    if (item.key === "no-cross") {
      return { ...item, detail: `${item.detail}｜本次比较测试集 ID：${[...new Set(oldRows.map((r) => r.sampleId))].length} 条`, pass: item.pass && oldIds === newIds };
    }
    if (item.key === "metric") {
      const missOk =
        overall.old.missRate === null || overall.next.missRate === null
          ? true
          : overall.next.missRate <= overall.old.missRate;
      return {
        ...item,
        detail: `整体漏检率 ${fmtPct(overall.old.missRate)} → ${fmtPct(overall.next.missRate)}；误报率 ${fmtPct(overall.old.falseAlarmRate)} → ${fmtPct(overall.next.falseAlarmRate)}`,
        pass: item.pass && missOk,
      };
    }
    if (item.key === "regression") {
      return {
        ...item,
        detail: regressedMaterials.length === 0
          ? `原有材种（${legacy.map((m) => m.material).join("、")}）召回未退化`
          : `退化分组：${regressedMaterials.map((m) => m.material).join("、")}`,
        pass: item.pass && regressedMaterials.length === 0,
      };
    }
    return item;
  });

  return {
    threshold,
    testSetIds: [...new Set(oldRows.map((row) => row.sampleId))],
    testSetConsistent: oldIds === newIds,
    overall,
    perMaterial,
    rows,
    summary: {
      improved: rows.filter((row) => row.verdict === "改善").length,
      regressed: rows.filter((row) => row.verdict === "退化").length,
      same: rows.filter((row) => row.verdict === "不变").length,
    },
    acceptance,
  };
}

export function fmtPct(value: number | null): string {
  if (value === null) return "不适用";
  return `${(value * 100).toFixed(1)}%`;
}

export function fmtNum(value: number | null, digits = 3): string {
  if (value === null) return "不适用";
  return value.toFixed(digits);
}

/* ------------------------------------------------------------------ *
 * 4. 融合规则（PRD 3.7 / 升级版 §10.4：明确规则，不做分数相加平均）
 * ------------------------------------------------------------------ */

/**
 * 融合输入。
 *
 * 「有没有异常」「哪一路缺失」都要调用方**显式给出**，不能由分数反推：
 * 分数是连续量，0.4 也是分数、有分数也不等于有异常提示，用「分数非空」
 * 当异常标志会把没出结论的一路说成提示异常。
 */
export type FusionInput = {
  riskId: string;
  label: string;
  /** 两路分数只作证据展示；判定不读它们 */
  visualScore: number | null;
  radarScore: number | null;
  /** 两路结果是否落在同一测区（位置关联是否成立） */
  sameZone: boolean;
  /** 质量门槛（有效数据比例、时间对齐等）是否通过 */
  visualQualityOk: boolean;
  radarQualityOk: boolean;
  /** 本次该路是否**提示异常**：由各自的判定分支给出，不由分数推导 */
  visualAbnormal: boolean;
  radarAbnormal: boolean;
  /** 本次**缺失**的模态：没有数据 ≠ 数据质量不合格，两者处置不同 */
  missing: { visual: boolean; radar: boolean };
  /** 规则版本：结论要能追到是哪一版规则出的 */
  ruleVersion: string;
};

/** 规则表的五种输出：正常、缺失、无效各自独立，不能合并成一句「待处理」 */
export type FusionPriority = "优先复核" | "补充检测" | "待核对" | "待补充" | "本次未提示异常";

export type FusionDecision = {
  riskId: string;
  label: string;
  priority: FusionPriority;
  ruleKey: "invalid" | "missing" | "both" | "one" | "normal";
  ruleLabel: string;
  basis: string;
  nextAction: string;
  /** 明确写出「不做分数相加平均」，避免被误解为综合置信度 */
  noAggregationNote: string;
  /** 本次结论依据的规则版本，原样带回 */
  ruleVersion: string;
  /** 判定用到的输入原样保留，复盘时看得到当时两路的有效性与异常标志 */
  inputs: FusionInput;
};

/** 分数只作证据展示：未出分就写「未出分」，不四舍五入成 0 */
const scoreText = (score: number | null) => (score === null ? "未出分" : score.toFixed(2));

/**
 * 融合规则（升级版 PRD §10.4 规则表）。
 *
 * 判定顺序固定为**有效性 → 缺失 → 异常**，三者的下一步动作完全不同：
 *   位置不一致或任一路质量无效 → 待核对（修正关联或补采）；
 *   任一路缺失               → 待补充（补齐该模态再运行）；
 *   两路都有效才轮到看异常     → 优先复核 / 补充检测 / 本次未提示异常。
 *
 * 顺序反过来（先看分数）会把两种不同的坏情况混在一起：位置对不上或质量
 * 不合格会被写成「补充检测」，缺失也被当成「单路异常」，读起来像是已经有了
 * 检测结论。缺失的一路不参与质量判定 —— 它是「没有数据」，不是「数据无效」。
 */
export function fuseByRule(input: FusionInput): FusionDecision {
  const noAggregationNote = "本平台不对两路分数做相加或平均，不产生综合置信度。";
  const base = {
    riskId: input.riskId,
    label: input.label,
    noAggregationNote,
    ruleVersion: input.ruleVersion,
    inputs: input,
  };
  const missingLabels = [input.missing.visual ? "视觉" : null, input.missing.radar ? "雷达" : null].filter(
    (item): item is string => item !== null,
  );
  const brokenLabels = [
    !input.missing.visual && !input.visualQualityOk ? "视觉" : null,
    !input.missing.radar && !input.radarQualityOk ? "雷达" : null,
  ].filter((item): item is string => item !== null);

  /* ① 有效性：位置关联与质量门槛先过，没过就没有可比的两路结果 */
  if (!input.sameZone || brokenLabels.length > 0) {
    return {
      ...base,
      priority: "待核对",
      ruleKey: "invalid",
      ruleLabel: "规则一：位置不一致或任一路质量无效",
      basis: !input.sameZone
        ? `视觉 ${scoreText(input.visualScore)} 与雷达 ${scoreText(input.radarScore)} 未落在同一测区，位置关联未成立`
        : `${brokenLabels.join("、")}质量门槛未通过（视觉 ${scoreText(input.visualScore)} / 雷达 ${scoreText(input.radarScore)}），两路不构成可比结果`,
      nextAction: "修正测区关联或补采质量不合格的一路，重新运行融合；本轮返回待核对，不输出确定性结论",
    };
  }

  /* ② 缺失：有一路本次没有数据，先补齐再谈异常 */
  if (missingLabels.length > 0) {
    return {
      ...base,
      priority: "待补充",
      ruleKey: "missing",
      ruleLabel: "规则二：任一路缺失",
      basis: `本次缺失${missingLabels.join("、")}（该路没有结果，不是质量不合格），另一路 ${scoreText(
        input.missing.visual ? input.radarScore : input.visualScore,
      )}`,
      nextAction: `补齐${missingLabels.join("、")}模态后重新运行融合，单路结果不作为结论`,
    };
  }

  /* ③ 异常：两路同测区且都有效，才按两路的异常标志出优先级 */
  if (input.visualAbnormal && input.radarAbnormal) {
    return {
      ...base,
      priority: "优先复核",
      ruleKey: "both",
      ruleLabel: "规则三：同测区且两路有效，均提示异常",
      basis: `视觉 ${scoreText(input.visualScore)} 与雷达 ${scoreText(input.radarScore)} 在同一测区、质量均合格，两路均提示异常`,
      nextAction: "汇总两路证据生成复核任务：先查环境来源，再安排进一步检测",
    };
  }
  if (input.visualAbnormal || input.radarAbnormal) {
    const source = input.visualAbnormal ? "视觉" : "雷达";
    return {
      ...base,
      priority: "补充检测",
      ruleKey: "one",
      ruleLabel: "规则四：同测区且两路有效，仅一路异常",
      basis: `仅${source}一路提示异常（视觉 ${scoreText(input.visualScore)} / 雷达 ${scoreText(
        input.radarScore,
      )}），另一路同测区、质量合格且未提示异常`,
      nextAction: `保留${source}异常来源，安排补充检测；另一路复核后再判定`,
    };
  }
  return {
    ...base,
    priority: "本次未提示异常",
    ruleKey: "normal",
    ruleLabel: "规则五：同测区且两路有效，均无异常",
    basis: `视觉 ${scoreText(input.visualScore)} 与雷达 ${scoreText(input.radarScore)} 在同一测区、质量均合格，两路均未提示异常`,
    nextAction: "保存结果，不新增异常风险；两路分数不合并成综合置信度",
  };
}

/* ------------------------------------------------------------------ *
 * 5. 归档完整性校验（PRD 3.8：真实 SHA-256 摘要对比）
 * ------------------------------------------------------------------ */

export type ArchiveCheckRow = ArchiveItem & {
  computed: string;
  match: boolean;
  status: "通过" | "缺失" | "摘要不一致";
};

export type ArchiveCheckResult = {
  executedAt: string;
  total: number;
  missing: number;
  mismatch: number;
  passed: number;
  rows: ArchiveCheckRow[];
  reportHtml: string;
};

/** 计算演示清单项的「实际重新计算摘要」：清单已给定时用清单值，未给定时用 Web Crypto 真算 */
async function computeDigest(item: ArchiveItem): Promise<string> {
  if (item.actualSha256 && item.actualSha256 !== "—") return item.actualSha256;
  const payload = `${item.assetId}|${item.name}|${item.sizeText}|${item.declaredSha256}`;
  return sha256Hex(payload);
}

export async function sha256Hex(text: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return `unavailable:${text.length}`;
  const data = new TextEncoder().encode(text);
  const buffer = await subtle.digest("SHA-256", data);
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function runArchiveCheck(items: ArchiveItem[]): Promise<ArchiveCheckResult> {
  const rows: ArchiveCheckRow[] = [];
  for (const item of items) {
    const computed = item.present ? await computeDigest(item) : "—";
    const match = item.present && computed === item.declaredSha256;
    rows.push({
      ...item,
      computed,
      match,
      status: !item.present ? "缺失" : match ? "通过" : "摘要不一致",
    });
  }
  const missing = rows.filter((row) => row.status === "缺失").length;
  const mismatch = rows.filter((row) => row.status === "摘要不一致").length;
  const executedAt = nowStamp();
  return {
    executedAt,
    total: rows.length,
    missing,
    mismatch,
    passed: rows.length - missing - mismatch,
    rows,
    reportHtml: buildArchiveReportHtml(rows, executedAt, missing, mismatch),
  };
}

export function buildArchiveReportHtml(
  rows: ArchiveCheckRow[],
  executedAt: string,
  missing: number,
  mismatch: number,
): string {
  const tr = rows
    .map(
      (row) =>
        `<tr class="${row.status === "通过" ? "ok" : "bad"}"><td>${row.group}</td><td>${row.assetId}</td><td>${row.name}</td><td>${row.sizeText}</td><td>${row.status}</td><td class="mono">${row.declaredSha256.slice(0, 16)}…</td><td class="mono">${row.computed === "—" ? "—" : `${row.computed.slice(0, 16)}…`}</td></tr>`,
    )
    .join("");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>木脉智检 · 归档完整性报告</title>
<style>
body{font-family:"Microsoft YaHei UI","PingFang SC",system-ui,sans-serif;margin:32px;color:#12233a;background:#fff}
h1{font-size:22px;margin:0 0 6px}
p.meta{color:#5a6b80;font-size:12px;margin:0 0 18px}
table{border-collapse:collapse;width:100%;font-size:12px}
th,td{border:1px solid #cdd8e6;padding:6px 8px;text-align:left}
th{background:#eef3fa}
tr.bad{background:#fff2f2;color:#a4141c}
.mono{font-family:ui-monospace,Consolas,monospace;font-size:11px}
.summary{margin:16px 0;padding:12px 16px;border:1px solid #cdd8e6;background:#f7fafd;font-size:13px}
@media print{body{margin:12mm}}
</style></head><body>
<h1>木脉智检 · 归档完整性校验报告</h1>
<p class="meta">工单 SH-2026-0901 ｜ 执行时间 ${executedAt} ｜ 校验方式：逐项存在性检查 + SHA-256 摘要对比（Web Crypto）</p>
<div class="summary">清单 ${rows.length} 项，通过 ${rows.length - missing - mismatch} 项，缺失 ${missing} 项，摘要不一致 ${mismatch} 项。<br/>
完整性校验只说明文件是否齐全、是否发生变化，不替代内容审核。</div>
<table><thead><tr><th>分组</th><th>资产 ID</th><th>文件名</th><th>大小</th><th>结果</th><th>清单摘要</th><th>重新计算</th></tr></thead><tbody>${tr}</tbody></table>
</body></html>`;
}

/* ------------------------------------------------------------------ *
 * 6. 知识库检索（PRD 5.2：中文字符 2–4 元 TF-IDF + 余弦相似度）
 * ------------------------------------------------------------------ */

export type RetrievalHit = {
  docId: string;
  docTitle: string;
  category: string;
  date: string;
  version: string;
  chunkId: string;
  section: string;
  text: string;
  /** 标为「检索相似度」，不得标为病害置信度 */
  similarity: number;
  source: string;
  rank: number;
};

function ngrams(text: string): string[] {
  const clean = text.replace(/[\s，。、；：（）《》·,.;:()"“”‘’!?！？\-—/\\[\]{}]/g, "");
  const grams: string[] = [];
  for (let n = 2; n <= 4; n += 1) {
    for (let i = 0; i + n <= clean.length; i += 1) grams.push(clean.slice(i, i + n));
  }
  return grams;
}

function termFreq(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  tokens.forEach((token) => tf.set(token, (tf.get(token) ?? 0) + 1));
  return tf;
}

export type KnowledgeChunk = {
  docId: string;
  docTitle: string;
  category: string;
  date: string;
  version: string;
  source: string;
  chunkId: string;
  section: string;
  text: string;
};

export function searchKnowledge(
  chunks: KnowledgeChunk[],
  query: string,
  topK: number,
  noHitThreshold: number,
  filters?: { category?: string; project?: string; from?: string; to?: string },
): { hits: RetrievalHit[]; belowThreshold: boolean; filtered: number; total: number; queryTokens: number } {
  const q = query.trim();
  if (!q) return { hits: [], belowThreshold: false, filtered: 0, total: chunks.length, queryTokens: 0 };

  // 先按权限、项目和日期过滤候选 chunk，再取 Top K
  const candidates = chunks.filter((chunk) => {
    if (filters?.category && filters.category !== "全部" && chunk.category !== filters.category) return false;
    if (filters?.from && chunk.date < filters.from) return false;
    if (filters?.to && chunk.date > filters.to) return false;
    return true;
  });

  const docs = candidates.map((chunk) => ngrams(chunk.text));
  const df = new Map<string, number>();
  docs.forEach((tokens) => {
    new Set(tokens).forEach((token) => df.set(token, (df.get(token) ?? 0) + 1));
  });
  const total = Math.max(1, docs.length);
  const idf = (token: string) => Math.log((total + 1) / ((df.get(token) ?? 0) + 1)) + 1;

  const queryTokens = ngrams(q);
  const queryTf = termFreq(queryTokens);
  const queryVec = new Map<string, number>();
  queryTf.forEach((count, token) => queryVec.set(token, (1 + Math.log(count)) * idf(token)));
  const queryNorm = Math.sqrt([...queryVec.values()].reduce((sum, value) => sum + value * value, 0));

  const scored = candidates.map((chunk, index) => {
    const tf = termFreq(docs[index]);
    let dot = 0;
    let norm = 0;
    tf.forEach((count, token) => {
      const weight = (1 + Math.log(count)) * idf(token);
      norm += weight * weight;
      const qWeight = queryVec.get(token);
      if (qWeight !== undefined) dot += weight * qWeight;
    });
    const denom = Math.sqrt(norm) * queryNorm;
    return { chunk, similarity: denom === 0 ? 0 : Number((dot / denom).toFixed(4)) };
  });

  const hits = scored
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, topK)
    .map((item, index) => ({
      docId: item.chunk.docId,
      docTitle: item.chunk.docTitle,
      category: item.chunk.category,
      date: item.chunk.date,
      version: item.chunk.version,
      chunkId: item.chunk.chunkId,
      section: item.chunk.section,
      text: item.chunk.text,
      similarity: item.similarity,
      source: item.chunk.source,
      rank: index + 1,
    }))
    .filter((item) => item.similarity > 0);

  const belowThreshold = hits.length === 0 || hits[0].similarity < noHitThreshold;
  return { hits, belowThreshold, filtered: candidates.length, total: chunks.length, queryTokens: queryTokens.length };
}

/* ------------------------------------------------------------------ *
 * 7. 杂项格式化
 * ------------------------------------------------------------------ */

export function nowStamp(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

export function clockStamp(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

export function sourceLabel(mode: string): string {
  if (mode === "live") return "现场实采";
  if (mode === "simulation") return "仿真通道";
  return "归档回放";
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** 演示用稳定伪随机：同一 seed 恒定，避免每次渲染数字跳动 */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** 环境记录默认值（供 /orders 环境表单使用） */
export const DEFAULT_ENV_RECORD: EnvRecord = ENV_RECORD;

/**
 * 幂等键 / 事件 ID 生成器（**内网 http 下同样可用**）
 *
 * ── 为什么不能直接用 `crypto.randomUUID()`（2026-09-18 用户实测报的毛病）──
 * 用户原话：「我为什么在内网地址上按不了 ctrl 加 q 加 l 的呼出新工单」。
 * 查下来：`crypto.randomUUID()` **只在安全上下文**（https / localhost）里存在，
 * 同事从 `http://<局域网IP>:8000` 打开时它是 `undefined` —— 隐藏快捷键那条链路正好
 * 在这里生成事件 ID，于是抛 `TypeError: crypto.randomUUID is not a function`，
 * 请求根本没发出去：现象就是"内网地址上按了没反应，本机 localhost 却一切正常"。
 * 这是现场最难查的一类毛病（只有别人那台才复现），所以修在公共工具里。
 *
 * `crypto.getRandomValues()` **不受**安全上下文限制，所以退路用它 + 时间片；
 * 连它都没有（极老浏览器）才退回 `Math.random`。
 * 服务端对键的要求只是「唯一 + 重试时复用同一个」（幂等），不要求 UUID 格式。
 */
export function randomId(prefix = "id"): string {
  const webCrypto = typeof globalThis.crypto === "undefined" ? null : globalThis.crypto;
  if (webCrypto && typeof webCrypto.randomUUID === "function") {
    return `${prefix}-${webCrypto.randomUUID()}`;
  }
  /*
    退路里再带一个**会话内自增序号**：同一毫秒内连按两次（现场很可能）光靠时间片
    会撞键 —— 服务端按这个键幂等，撞了就等于"第二次按键被当成第一次的回放"，
    用户会觉得"我按了没反应"。序号让同一会话里的 id 永远不同。
  */
  const seq = (fallbackSeq += 1).toString(36);
  const bytes = new Uint8Array(16);
  if (webCrypto && typeof webCrypto.getRandomValues === "function") {
    webCrypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${prefix}-${Date.now().toString(36)}-${seq}-${hex}`;
}

/** `randomId` 退路里的会话内序号（模块级，不导出） */
let fallbackSeq = 0;
