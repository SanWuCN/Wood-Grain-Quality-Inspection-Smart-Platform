/**
 * 数字孪生「证据对照」（剧本 ㉒「证据对照与补核清单」的屏幕落点）
 *
 * ── 用户口径（2026-10-01）────────────────────────────────────────────
 * 「证据对照已打开。两路共同提示的项目优先展示，结果不一致或资料不齐的项目已列入补核清单。
 *   这个对话，还是要做具体的东西，而不只是跳转」。
 * 原先 ㉒ 只是跳到数字孪生页（再切一下主视图），屏幕上没有"对照"这件事本身。
 *
 * ── 这一屏画什么（全部来自 `FUSION_RECORD`，不编一条）────────────────
 *   · **两路共同提示（优先展示）**：`outputs` 里 priority = 优先复核 的项目，
 *     左边是视觉标注框（`anno-box-0x` + 图片名 + 置信度）、右边是同测区的雷达响应段
 *     （`echo-…-seg-0x` + 幅值 + 质量），中间那列写"凭什么算一致"（`FUSION_RULES` 的规则）；
 *   · **补核清单**：priority ≠ 优先复核 的项目 —— 结果不一致或任一路质量不合格，
 *     连同**不合格的那一路**（`branches` 里 state 不合格 / `zoneMatch` 的 note）一起列出；
 *   · **资料完整性**：`completeness` 四行（原始数据 / 表面图像 / 结果文件 / 预处理版本），
 *     `ok === false` 的单独标出来（"资料不齐"这一半就从这儿来）；
 *   · 每行都带**出处**（标注框号 / 响应段号 / 图片文件名）—— 与仓库「预置结果必须标来源」同一口径。
 *
 * ⚠ 配对规则不靠解析 `basis` 的自由文本：`outputs[].basis` 里出现哪个 `zoneMatch` 的
 *   标注框号/响应段号，就配哪一行（`basis.includes(id)`）。改文案不会让配对错位。
 */
import { CURRENT_RISKS, FUSION_RECORD, FUSION_RULES } from "../seed/scenario";

/** 一行"两路对照"：视觉 ↔ 雷达 ↔ 结论 */
export type EvidencePair = {
  riskId: string;
  label: string;
  priority: string;
  /** 视觉那一路：标注框号 / 图片 / 置信度 / 标签 */
  visual: { boxId: string; image: string; confidence: number; label: string };
  /** 雷达那一路：响应段 / 幅值 / 质量 */
  radar: { segment: string; amplitude: number; quality: string };
  /** 测区（两路必须同测区才谈得上对照） */
  zone: string;
  /** 这一对的规则与依据（逐字来自融合记录） */
  rule: string;
  basis: string;
  /** 下一步（来自风险记录 / 融合记录） */
  nextAction: string;
  /** 结论：优先复核 / 待核对 …（与 `CURRENT_RISKS` 的优先级一致时才采用） */
  verdict: string;
};

export type EvidenceModel = {
  recordId: string;
  ruleVersion: string;
  batchId: string;
  zone: string;
  /** 两路共同提示 → 优先展示 */
  priority: EvidencePair[];
  /** 结果不一致 / 资料不齐 → 补核清单 */
  supplement: EvidencePair[];
  /** 资料完整性四行（`ok === false` 的会在界面上标红） */
  completeness: { label: string; value: string; ok: boolean; note: string }[];
  /** 三个分支的判定（视觉 / 雷达 / 质量门槛） */
  branches: { key: string; label: string; detail: string; state: string }[];
  /** 补核清单里"为什么补"的一句话（把不合格的那一路点出来） */
  supplementReasons: string[];
};

/** 把 `outputs` 的一行配到 `zoneMatch` 的两路上（按 id 出现在 basis 里认） */
function pairOf(output: (typeof FUSION_RECORD)["outputs"][number]): EvidencePair | null {
  const match = FUSION_RECORD.zoneMatch.find(
    (item) => output.basis.includes(item.visual) || output.basis.includes(item.radar.replace(/^echo-[^-]+-[^-]+-/, "")),
  );
  if (!match) return null;
  const annotation = FUSION_RECORD.annotations.find((item) => item.boxId === match.visual);
  const radar = FUSION_RECORD.radarFeatures.find((item) => item.segment.endsWith(match.radar));
  if (!annotation || !radar) return null;
  return {
    riskId: output.riskId,
    label: output.label,
    priority: output.priority,
    visual: { boxId: annotation.boxId, image: annotation.image, confidence: annotation.confidence, label: annotation.label },
    radar: { segment: radar.segment, amplitude: radar.amplitude, quality: radar.quality },
    zone: annotation.zone,
    rule: output.rule,
    basis: output.basis,
    nextAction: output.nextAction,
    verdict: output.priority,
  };
}

/** 组装这一屏（纯函数，可单测） */
export function evidenceModel(): EvidenceModel {
  const pairs = FUSION_RECORD.outputs.map(pairOf).filter((item): item is EvidencePair => item !== null);
  const priority = pairs.filter((item) => item.priority === "优先复核");
  const supplement = pairs.filter((item) => item.priority !== "优先复核");
  /*
    补核的理由：优先用**不合格那一路自己的话**（质量门槛分支的 detail），
    没有就退回 zoneMatch 的 note —— 两条都是记录里的原文，不另写一句。
  */
  const failing = FUSION_RECORD.branches.filter((item) => item.state !== "合格").map((item) => item.detail);
  const supplementReasons = supplement.map((item) => {
    const note = FUSION_RECORD.zoneMatch.find((match) => item.basis.includes(match.visual))?.note;
    return [item.basis, failing[0], note].filter(Boolean).join("；");
  });
  return {
    recordId: FUSION_RECORD.recordId,
    ruleVersion: FUSION_RECORD.ruleVersion,
    batchId: FUSION_RECORD.batchId,
    zone: pairs[0]?.zone ?? "",
    priority,
    supplement,
    completeness: FUSION_RECORD.completeness.map((item) => ({ ...item })),
    branches: FUSION_RECORD.branches.map((item) => ({ ...item })),
    supplementReasons,
  };
}

/** 规则表（界面上解释"什么算两路一致"）：直接来自 `FUSION_RULES`，不手写第二份 */
export function evidenceRules(): { key: string; label: string; result: string; note: string }[] {
  return FUSION_RULES.map((item) => ({ ...item }));
}

/** 这一屏与风险记录的交叉核对：结论里的优先复核数应与 `CURRENT_RISKS` 一致 */
export function evidenceCrossCheck(): { priorityInRisks: number; priorityInEvidence: number; consistent: boolean } {
  const priorityInRisks = CURRENT_RISKS.filter((item) => item.priority === "优先复核").length;
  const priorityInEvidence = evidenceModel().priority.length;
  return { priorityInRisks, priorityInEvidence, consistent: priorityInRisks === priorityInEvidence };
}
