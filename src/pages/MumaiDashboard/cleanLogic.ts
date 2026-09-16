/**
 * 数据集清洗 · 纯逻辑（无 React，不进 fast-refresh 组件文件）
 *
 * 用户的要求是「通过算法清洗数据集，展示流程，不是拿文字在那里糊弄」，
 * 所以清洗的每一步都作用在**当前样本集合**上真算，而不是从种子里抄一张
 * 「五步全部完成」的表。规则与阈值都可配置，改完重跑，结果随之变化。
 */

import type { Sample } from "./seed/types";

/** 一条被规则命中的记录 */
export type CleanFlag = {
  recordId: string;
  physicalSampleId: string;
  /** 被哪条规则挑出来的 */
  step: string;
  reason: string;
  /** 命中值：让人能核验，而不只是看到一个「不合格」 */
  value: string;
};

export type CleanStepStat = {
  key: string;
  label: string;
  input: number;
  kept: number;
  review: number;
  detail: string;
};

export type CleanOutcome = {
  kept: number;
  flagged: CleanFlag[];
  steps: CleanStepStat[];
};

export type CleanDecision = "accept" | "exclude";

/** 阈值：配置阶段可改 */
export type CleanThresholds = {
  /** 饱和比例上限（%）：超过则待审核 */
  saturationMax: number;
  /** 距同组中位数的偏离下限（mm）：超过则标记疑似异常 */
  amplitudeMin: number;
  /** 是否合并同物理样本的重复帧 */
  dedupe: boolean;
};

export const DEFAULT_THRESHOLDS: CleanThresholds = {
  saturationMax: 10,
  amplitudeMin: 18,
  dedupe: true,
};

/**
 * 执行清洗。
 *
 * 四条规则依次作用在**当前仍然有效的记录**上，每条都记录输入 / 保留 / 待审核
 * 与命中原因；被前面某条挑走的记录不再进入后面的步骤 —— 真实流水线就是这么串的。
 */
export function runClean(samples: Sample[], thresholds: CleanThresholds): CleanOutcome {
  const flagged: CleanFlag[] = [];
  const alive = new Set(samples.map((sample) => sample.recordId));
  const sampleOf = (recordId: string) => samples.find((item) => item.recordId === recordId);

  const take = (recordId: string, step: string, reason: string, value: string) => {
    if (!alive.has(recordId)) return false;
    alive.delete(recordId);
    flagged.push({
      recordId,
      physicalSampleId: sampleOf(recordId)?.physicalSampleId ?? recordId,
      step,
      reason,
      value,
    });
    return true;
  };

  const steps: CleanStepStat[] = [];
  const stage = (key: string, label: string, detail: string, work: () => number) => {
    const input = alive.size;
    const review = work();
    steps.push({ key, label, input, kept: alive.size, review, detail });
  };

  // ① 字段与空值：路径缺失、记录号重复、已有不可用结论或未知标签无依据
  stage("fields", "字段与空值检查", "缺失字段与已有不可用质量结论进入人工核验", () => {
    let hit = 0;
    const seen = new Set<string>();
    for (const sample of samples) {
      if (!sample.path) {
        if (take(sample.recordId, "字段与空值检查", "路径为空", "path=—")) hit += 1;
        continue;
      }
      if (seen.has(sample.recordId)) {
        if (take(sample.recordId, "字段与空值检查", "记录号重复", sample.recordId)) hit += 1;
        continue;
      }
      seen.add(sample.recordId);
      if (sample.quality === "不可用") {
        if (take(sample.recordId, "字段与空值检查", sample.qualityReason, `quality=${sample.quality}`)) hit += 1;
        continue;
      }
      if (sample.knownState === "未知待核验" && !sample.labelBasis) {
        if (take(sample.recordId, "字段与空值检查", "未知标签且无标签依据", "label_basis=—")) hit += 1;
      }
    }
    return hit;
  });

  // ② 重复帧：只处理数据清单明确记录 duplicateOf 的记录，不把同木样多方向采样误判为重复
  stage("dedupe", "重复帧筛查", thresholds.dedupe ? "仅核验已登记 duplicateOf 的记录" : "本次关闭（按用户配置）", () => {
    if (!thresholds.dedupe) return 0;
    let hit = 0;
    for (const sample of samples) {
      if (!alive.has(sample.recordId)) continue;
      if (sample.duplicateOf !== null) {
        if (take(sample.recordId, "重复帧筛查", `与 ${sample.duplicateOf} 摘要重复`, `dup=${sample.duplicateOf}`)) hit += 1;
      }
    }
    return hit;
  });

  // ③ 数值范围与饱和
  stage("saturation", "数值范围与饱和检查", `饱和比例 > ${thresholds.saturationMax}% 记为待审核`, () => {
    let hit = 0;
    for (const sample of samples) {
      if (!alive.has(sample.recordId)) continue;
      if (sample.saturationPct > thresholds.saturationMax) {
        const ok = take(
          sample.recordId,
          "数值范围与饱和检查",
          `饱和比例 ${sample.saturationPct}% 超上限 ${thresholds.saturationMax}%`,
          `${sample.saturationPct}%`,
        );
        if (ok) hit += 1;
      }
    }
    return hit;
  });

  // ④ 特征幅度与聚类：用距同组中位数的偏离量表达
  stage("amplitude", "特征幅度与聚类", `偏离同组中位数 > ${thresholds.amplitudeMin} mm 记为疑似异常`, () => {
    let hit = 0;
    for (const sample of samples) {
      if (!alive.has(sample.recordId)) continue;
      const peers = samples
        .filter((item) => item.groupId === sample.groupId)
        .map((item) => item.distanceMm)
        .sort((a, b) => a - b);
      const median = peers.length ? peers[Math.floor(peers.length / 2)] : sample.distanceMm;
      const deviation = Math.abs(sample.distanceMm - median);
      if (deviation > thresholds.amplitudeMin) {
        const ok = take(
          sample.recordId,
          "特征幅度与聚类",
          `距同组中位 ${median} mm 偏离 ${deviation.toFixed(1)} mm`,
          `${deviation.toFixed(1)} mm`,
        );
        if (ok) hit += 1;
      }
    }
    return hit;
  });

  return { kept: alive.size, flagged, steps };
}

/** 根据逐条人工结论生成版本成员，未决记录不会被悄悄纳入或删除。 */
export function selectCleanVersionRecords(
  samples: Sample[],
  outcome: CleanOutcome,
  decisions: Record<string, CleanDecision>,
) {
  const flagged = new Set(outcome.flagged.map((item) => item.recordId));
  const includedRecordIds: string[] = [];
  const removedRecordIds: string[] = [];
  const undecidedRecordIds: string[] = [];

  for (const sample of samples) {
    if (!flagged.has(sample.recordId) || decisions[sample.recordId] === "exclude") {
      includedRecordIds.push(sample.recordId);
    } else if (decisions[sample.recordId] === "accept") {
      removedRecordIds.push(sample.recordId);
    } else {
      undecidedRecordIds.push(sample.recordId);
    }
  }

  return { includedRecordIds, removedRecordIds, undecidedRecordIds };
}
