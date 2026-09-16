import type { DataPackage, ScanBatch } from "../seed/types";

export type CaptureBatchInput = Pick<ScanBatch, "batchId" | "startedAt" | "receive">;
export type CapturePackageInput = Pick<
  DataPackage,
  "id" | "name" | "kind" | "source" | "batchId" | "capturedAt" | "state" | "checks"
>;

const CHANNELS = [
  ["radar", "雷达原始数据"],
  ["image", "表面图像"],
  ["result", "结果文件"],
] as const;

export function buildCaptureInsights(batch: CaptureBatchInput, packages: CapturePackageInput[]) {
  const channels = CHANNELS.map(([key, label]) => {
    const record = batch.receive[key];
    const missing = Math.max(0, record.expected - record.received);
    const progress = record.expected
      ? Math.min(100, Math.round((record.received / record.expected) * 100))
      : record.state === "完成"
        ? 100
        : 0;
    return { key, label, ...record, missing, progress };
  });
  const expected = channels.reduce((sum, item) => sum + item.expected, 0);
  const received = channels.reduce((sum, item) => sum + item.received, 0);
  const linked = packages.filter((item) => item.batchId === batch.batchId);
  const checks = linked.flatMap((item) => item.checks);
  const integrity = {
    passed: checks.filter((item) => item.pass).length,
    total: checks.length,
  };
  const channelIssues = channels
    .filter((item) => item.missing > 0)
    .map((item) => ({
      key: `receive-${item.key}`,
      source: item.label,
      detail: `缺少 ${item.missing} 条，已接收 ${item.received}/${item.expected}`,
    }));
  const integrityIssues = linked.flatMap((item) =>
    item.checks
      .filter((check) => !check.pass)
      .map((check) => ({
        key: `${item.id}-${check.key}`,
        source: `${item.name} · ${check.label}`,
        detail: check.detail,
      })),
  );

  return {
    expected,
    received,
    missing: Math.max(0, expected - received),
    progress: expected ? Math.min(100, Math.round((received / expected) * 100)) : 0,
    channels,
    integrity,
    issues: [...channelIssues, ...integrityIssues],
    artifacts: linked.map((item) => ({
      id: item.id,
      name: item.name,
      kind: item.kind,
      source: item.source,
      capturedAt: item.capturedAt,
      state: item.state,
      passedChecks: item.checks.filter((check) => check.pass).length,
      totalChecks: item.checks.length,
    })),
  };
}

export type CleanStage = "pick" | "configure" | "precheck" | "cleaned" | "reviewed" | "versioned";

const CLEAN_STAGES: CleanStage[] = ["pick", "configure", "precheck", "cleaned", "reviewed", "versioned"];

export function buildCleanProgress({
  stage,
  totalRecords,
  outcome,
  acceptedAnomalies = 0,
  excludedFalsePositives = 0,
}: {
  stage: string;
  totalRecords: number;
  outcome?: { kept: number; flagged: number };
  acceptedAnomalies?: number;
  excludedFalsePositives?: number;
}) {
  const stageIndex = Math.max(0, CLEAN_STAGES.indexOf(stage as CleanStage));
  const flagged = outcome?.flagged ?? 0;
  const accepted = Math.min(flagged, Math.max(0, acceptedAnomalies));
  const falsePositives = Math.min(flagged - accepted, Math.max(0, excludedFalsePositives));
  const pendingReview = Math.max(0, flagged - accepted - falsePositives);
  const processed = outcome ? totalRecords : 0;
  const reviewState = !outcome
    ? "等待执行清洗"
    : flagged === 0
      ? "无需人工核验"
      : pendingReview > 0
        ? `${pendingReview} 条待核验`
        : "人工核验完成";

  return {
    percent: Math.round((stageIndex / (CLEAN_STAGES.length - 1)) * 100),
    processed,
    flagged,
    pendingReview,
    outputRecords: outcome ? outcome.kept + falsePositives : 0,
    removedRecords: outcome ? accepted : 0,
    reviewState,
  };
}
