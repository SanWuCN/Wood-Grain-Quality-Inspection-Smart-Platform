/**
 * 数据集清洗 · 纯逻辑（无 React，不进 fast-refresh 组件文件）
 *
 * 用户的要求是「通过算法清洗数据集，展示流程，不是拿文字在那里糊弄」，
 * 所以清洗的每一步都作用在**当前样本集合**上真算，而不是从种子里抄一张
 * 「五步全部完成」的表。规则与阈值都可配置，改完重跑，结果随之变化。
 *
 * ── 2026-09-18：从 4 步扩到 8 步（用户口径「更详细和真实，步骤稍微复杂些」）──
 * 同时**删掉了种子里手写的那张漏斗**（`CLEAN_STEPS`）。原因是一处真问题：
 * 手写表写的是 `12 → 9 → 8 → 7 → 6`、3 条待审核（r-0003 / r-0007 / r-0008「距组中心 3.4σ」），
 * 而实际跑出来的是 `12 → 10 → 9 → 8 → 8`、4 条命中（r-0005 / r-0010 / r-0003 / r-0007），
 * r-0008 那条**任何规则都挑不出来**（同组两条都是 28 mm，σ=0）——
 * 页面上的数字和核验弹窗里的记录对不上，现场一问就穿帮。
 * 现在漏斗、待审核、事实表、台词全部读这里的实算结果，从根上不可能再漂。
 */

import type { Sample } from "./seed/types";

/** 一条被规则命中的记录 */
export type CleanFlag = {
  recordId: string;
  physicalSampleId: string;
  /** 被哪条规则挑出来的（与 `CleanStepStat.label` 一致） */
  step: string;
  /** 归到哪一类人工判断（⑰ 的备用播报念的正是这三类） */
  category: CleanCategory;
  reason: string;
  /** 命中值：让人能核验，而不只是看到一个「不合格」 */
  value: string;
};

/** 人工核验的三类（与 ⑰ 备用播报逐字对齐，改名会与台词对不上） */
export const CLEAN_CATEGORIES = ["重复疑点", "采集异常", "标签待核验"] as const;
export type CleanCategory = (typeof CLEAN_CATEGORIES)[number];

export type CleanStepStat = {
  key: string;
  label: string;
  input: number;
  kept: number;
  review: number;
  detail: string;
  /** 这一步实际挑出来的记录号（页面上逐条对得上，不是只给一个数字） */
  hits: string[];
  /** 这一步的性质：自动剔除（确定不可用）/ 交人工核验 / 只做校验 */
  kind: "removed" | "review" | "check";
};

export type CleanOutcome = {
  kept: number;
  /** 确定不可用、直接剔除的条数（不进人工核验队列） */
  unusable: number;
  /** 被直接剔除的记录（空文件 / 格式损坏这类：读都读不了，不该占用人工核验的时间） */
  dropped: { recordId: string; reason: string; value: string }[];
  flagged: CleanFlag[];
  steps: CleanStepStat[];
  /** 参考件标定出的标称距离（mm）——「特征幅度与参考分布比对」那一步的基准，实算 */
  nominalMm: number;
};

export type CleanDecision = "accept" | "exclude";

/** 阈值：配置阶段可改 */
export type CleanThresholds = {
  /** 饱和比例上限（%）：超过则待审核 */
  saturationMax: number;
  /** 与参考件标称距离的允许偏差（mm）：超过则记为采集异常 */
  referenceToleranceMm: number;
  /** 是否合并同物理样本的重复帧 */
  dedupe: boolean;
};

export const DEFAULT_THRESHOLDS: CleanThresholds = {
  saturationMax: 10,
  referenceToleranceMm: 8,
  dedupe: true,
};

/**
 * 执行清洗（8 步流水线）。
 *
 * 每一步都作用在**当前仍然有效的记录**上：被前面某条规则挑走的记录不再进入后面的步骤
 * —— 真实流水线就是这么串的，也保证了同一条记录**不会被两步重复计入**待审核。
 * 每步都留下：输入 / 保留 / 待审核 / 判据说明 / **实际命中的记录号**（页面逐条对得上）。
 *
 * 三类人工判断（`CLEAN_CATEGORIES`）与 ⑰ 的备用播报逐字对齐：
 * 重复疑点 = ④重复摘要；采集异常 = ⑤饱和 / ⑦参考分布偏离；标签待核验 = ⑥标签依据。
 */
export function runClean(samples: Sample[], thresholds: CleanThresholds): CleanOutcome {
  const flagged: CleanFlag[] = [];
  const dropped: { recordId: string; reason: string; value: string }[] = [];
  const alive = new Set(samples.map((sample) => sample.recordId));
  const sampleOf = (recordId: string) => samples.find((item) => item.recordId === recordId);
  /** ③记录号唯一性用：第一次见到的记录号 */
  const firstSeen = new Map<string, string>();

  const take = (
    recordId: string,
    step: string,
    category: CleanCategory,
    reason: string,
    value: string,
  ): boolean => {
    if (!alive.has(recordId)) return false;
    alive.delete(recordId);
    flagged.push({
      recordId,
      physicalSampleId: sampleOf(recordId)?.physicalSampleId ?? recordId,
      step,
      category,
      reason,
      value,
    });
    return true;
  };

  /**
   * 直接剔除（不进人工核验队列）。
   *
   * 只用于**读都读不了**的记录（空文件 / 格式损坏）：这类不是"疑似"，让人一条条点
   * 「排除」是浪费核验时间；但它必须**明确记账**（`dropped`），否则会从
   * `selectCleanVersionRecords` 的缝里漏进新数据集版本 —— 老代码就有这个洞。
   */
  const drop = (recordId: string, reason: string, value: string): boolean => {
    if (!alive.has(recordId)) return false;
    alive.delete(recordId);
    dropped.push({ recordId, reason, value });
    return true;
  };

  const steps: CleanStepStat[] = [];
  const stage = (
    key: string,
    label: string,
    kind: CleanStepStat["kind"],
    detail: string,
    work: () => string[],
  ) => {
    const input = alive.size;
    const hits = work();
    /* 待审核数只数**真进了核验队列**的那些：命中但被直接剔除的不算 */
    const review = flagged.filter((item) => item.step === label).length;
    steps.push({ key, label, kind, detail, hits, input, kept: alive.size, review });
  };

  /* 参考件标定：标称距离取**参考批次**（sourceBatch 以 ref 开头）距离读数的中位数。
     这是"特征幅度"那一步的比对基准 —— 与参考件比，而不是组内互相比：
     同组只有两条记录时，互相比的"偏离"在数学上没有意义（一半的组 σ=0）。 */
  const referenceDistances = samples
    .filter((sample) => /^ref/i.test(sample.sourceBatch))
    .map((sample) => sample.distanceMm)
    .sort((a, b) => a - b);
  const nominalMm = referenceDistances.length
    ? referenceDistances[Math.floor(referenceDistances.length / 2)]
    : 25;

  // ① 字段与空值：必填字段缺失 → 待审核；已有「不可用」质量结论 → 确定剔除，不进审核队列
  stage("schema", "字段与空值检查", "removed", "必填字段缺失进入核验；已有不可用质量结论的直接剔除", () => {
    const hits: string[] = [];
    for (const sample of samples) {
      if (!alive.has(sample.recordId)) continue;
      const missing = (["path", "materialSource", "knownState", "groupId", "sourceBatch"] as const).filter(
        (field) => !String((sample as unknown as Record<string, unknown>)[field] ?? "").trim(),
      );
      if (sample.quality === "不可用") {
        /* 不可用 = 明确读不了（空文件 / 格式损坏）：直接剔除并记账，不进核验队列 */
        if (drop(sample.recordId, sample.qualityReason || "质量结论不可用", `quality=${sample.quality}`)) {
          hits.push(sample.recordId);
        }
        continue;
      }
      if (missing.length) {
        if (take(sample.recordId, "字段与空值检查", "采集异常", `必填字段缺失：${missing.join(" / ")}`, missing.join("/"))) {
          hits.push(sample.recordId);
        }
      }
    }
    return hits;
  });

  // ② 路径与来源校验：目录要属于本批次、后缀与命名要符合规范（查文件系统之前先看元数据）
  stage("path", "路径与来源校验", "check", "目录归属、后缀与命名规范（scan_### / frame_### / *_scan.csv）", () => {
    const hits: string[] = [];
    for (const sample of samples) {
      if (!alive.has(sample.recordId)) continue;
      const path = sample.path;
      const problems: string[] = [];
      if (!path.startsWith(`${sample.sourceBatch.split("/")[0]}/`) && !path.includes(sample.sourceBatch)) {
        problems.push(`目录不属于来源批次 ${sample.sourceBatch}`);
      }
      if (!/\.csv$/i.test(path)) problems.push("后缀不是 .csv");
      if (!/(scan|frame)_?\d+|_scan\.csv$/i.test(path)) problems.push("命名不符规范");
      if (problems.length) {
        if (take(sample.recordId, "路径与来源校验", "采集异常", problems.join("；"), path)) hits.push(sample.recordId);
      }
    }
    return hits;
  });

  // ③ 记录号唯一性：同一记录号出现两次以上，后来的进核验（先到的不动）
  stage("unique", "记录号唯一性", "check", "同一记录号只允许出现一次；重复出现的后来者进入核验", () => {
    const hits: string[] = [];
    for (const sample of samples) {
      if (!alive.has(sample.recordId)) continue;
      const first = firstSeen.get(sample.recordId);
      if (first === undefined) {
        firstSeen.set(sample.recordId, sample.path);
        continue;
      }
      if (take(sample.recordId, "记录号唯一性", "采集异常", `记录号重复（已出现在 ${first}）`, sample.recordId)) {
        hits.push(sample.recordId);
      }
    }
    return hits;
  });

  // ④ 重复摘要筛查：只处理数据清单里**明确登记**了 duplicateOf 的记录，不把同木样多方向采样误判成重复
  stage(
    "dedupe",
    "重复摘要筛查",
    "review",
    thresholds.dedupe ? "仅核验已登记 duplicateOf 的记录（合并前不删除原文件）" : "本次关闭（按用户配置）",
    () => {
      if (!thresholds.dedupe) return [];
      const hits: string[] = [];
      for (const sample of samples) {
        if (!alive.has(sample.recordId)) continue;
        if (sample.duplicateOf !== null) {
          if (
            take(sample.recordId, "重复摘要筛查", "重复疑点", `与 ${sample.duplicateOf} 摘要重复`, `dup=${sample.duplicateOf}`)
          ) {
            hits.push(sample.recordId);
          }
        }
      }
      return hits;
    },
  );

  // ⑤ 数值范围与饱和：采集异常里最典型的一类
  stage("range", "数值范围与饱和检查", "review", `饱和比例 > ${thresholds.saturationMax}% 记为采集异常`, () => {
    const hits: string[] = [];
    for (const sample of samples) {
      if (!alive.has(sample.recordId)) continue;
      if (sample.saturationPct > thresholds.saturationMax) {
        if (
          take(
            sample.recordId,
            "数值范围与饱和检查",
            "采集异常",
            `饱和比例 ${sample.saturationPct}% 超上限 ${thresholds.saturationMax}%`,
            `${sample.saturationPct}%`,
          )
        ) {
          hits.push(sample.recordId);
        }
      }
    }
    return hits;
  });

  // ⑥ 标签依据核验：没有可追溯依据的标签等于没有标签，不能进监督训练
  stage("label", "标签依据核验", "review", "未知待核验、已知结论但依据不可追溯的记录进入核验", () => {
    const hits: string[] = [];
    for (const sample of samples) {
      if (!alive.has(sample.recordId)) continue;
      const basis = String(sample.labelBasis ?? "").trim();
      const traceable = /^(来源卡|人工标记|融合规则|历史报告)/.test(basis);
      if (sample.knownState === "未知待核验" && !traceable) {
        if (
          take(sample.recordId, "标签依据核验", "标签待核验", "未知待核验且没有可追溯的标签依据", basis || "label_basis=—")
        ) {
          hits.push(sample.recordId);
        }
        continue;
      }
      if (!traceable) {
        if (take(sample.recordId, "标签依据核验", "标签待核验", "标签依据不可追溯", basis || "label_basis=—")) {
          hits.push(sample.recordId);
        }
      }
    }
    return hits;
  });

  // ⑦ 特征幅度与参考分布比对：与参考件标定比，超带记为采集异常（作为审核建议，不自动删除）
  stage(
    "reference",
    "特征幅度与参考分布比对",
    "review",
    `参考件标定中位 ${nominalMm} mm，允许偏差 ±${thresholds.referenceToleranceMm} mm`,
    () => {
      const hits: string[] = [];
      for (const sample of samples) {
        if (!alive.has(sample.recordId)) continue;
        const deviation = Math.abs(sample.distanceMm - nominalMm);
        if (deviation > thresholds.referenceToleranceMm) {
          if (
            take(
              sample.recordId,
              "特征幅度与参考分布比对",
              "采集异常",
              `距离读数 ${sample.distanceMm} mm，偏离参考标定 ${deviation.toFixed(1)} mm`,
              `${sample.distanceMm} mm`,
            )
          ) {
            hits.push(sample.recordId);
          }
        }
      }
      return hits;
    },
  );

  // ⑧ 物理样本分组：同一样本必须编在同一组（分组的正确性决定划分能不能按组切）
  stage("group", "物理样本分组校验", "check", "同一 physical_sample_id 必须落在同一个分组，否则划分会跨组泄漏", () => {
    const hits: string[] = [];
    const groupOf = new Map<string, string>();
    for (const sample of samples) {
      const known = groupOf.get(sample.physicalSampleId);
      if (known === undefined) {
        groupOf.set(sample.physicalSampleId, sample.groupId);
        continue;
      }
      if (known !== sample.groupId) {
        if (
          take(
            sample.recordId,
            "物理样本分组校验",
            "采集异常",
            `同一物理样本 ${sample.physicalSampleId} 落在两个分组（${known} / ${sample.groupId}）`,
            sample.groupId,
          )
        ) {
          hits.push(sample.recordId);
        }
      }
    }
    return hits;
  });

  const unusable = dropped.length;
  return { kept: alive.size, unusable, dropped, flagged, steps, nominalMm };
}

/**
 * 划分泄漏检查：同一个物理样本的记录不能同时出现在两个划分里。
 *
 * 为什么单独一步（而不是塞进 `runClean`）：划分来自 `DATASET.splits`，而清洗只认样本清单；
 * 两者合在一起会让"改划分"变成"重跑清洗"。返回**冲突**列表，空 = 无泄漏。
 */
export function checkSplitLeakage(
  splits: readonly { name: string; sampleIds: readonly string[] }[],
): { physicalSampleId: string; splits: string[] }[] {
  const seen = new Map<string, string[]>();
  for (const split of splits) {
    for (const sampleId of split.sampleIds) {
      const list = seen.get(sampleId) ?? [];
      if (!list.includes(split.name)) list.push(split.name);
      seen.set(sampleId, list);
    }
  }
  return [...seen.entries()]
    .filter(([, names]) => names.length > 1)
    .map(([physicalSampleId, names]) => ({ physicalSampleId, splits: names }));
}

/** 根据逐条人工结论生成版本成员，未决记录不会被悄悄纳入或删除。 */
export function selectCleanVersionRecords(
  samples: Sample[],
  outcome: CleanOutcome,
  decisions: Record<string, CleanDecision>,
) {
  const flagged = new Set(outcome.flagged.map((item) => item.recordId));
  /* 确定不可用的记录**一律剔除**：它们不在核验队列里，老代码按"没被 flag 就是保留"
     处理，于是空文件 / 格式损坏的记录会悄悄进到新数据集版本里 —— 这里显式挡住。 */
  const dropped = new Set(outcome.dropped.map((item) => item.recordId));
  const includedRecordIds: string[] = [];
  const removedRecordIds: string[] = [];
  const undecidedRecordIds: string[] = [];

  for (const sample of samples) {
    if (dropped.has(sample.recordId)) {
      removedRecordIds.push(sample.recordId);
    } else if (!flagged.has(sample.recordId) || decisions[sample.recordId] === "exclude") {
      includedRecordIds.push(sample.recordId);
    } else if (decisions[sample.recordId] === "accept") {
      removedRecordIds.push(sample.recordId);
    } else {
      undecidedRecordIds.push(sample.recordId);
    }
  }

  return { includedRecordIds, removedRecordIds, undecidedRecordIds };
}
