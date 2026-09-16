import type { Experiment } from "../seed/types";

export type TrainingRuntime = {
  started: boolean;
  running: boolean;
  visibleLogCount: number;
  updatedAt: string | null;
};

export type TrackingStep = {
  key: string;
  label: string;
  state: "等待" | "进行中" | "已完成";
  at: string | null;
};

export type TrainingTracking = {
  current: {
    state: "待提交" | "运行中" | "已完成";
    stageKey: string | null;
    stageLabel: string;
    updatedAt: string | null;
    steps: TrackingStep[];
    alerts: string[];
  };
  archive: {
    experimentId: string;
    versionText: string;
    steps: TrackingStep[];
    updatedAt: string | null;
    passed: number;
    total: number;
    alerts: string[];
  };
};

const stageRank = (experiment: Experiment, key: string | null) =>
  key === null ? -1 : experiment.jobSteps.findIndex((step) => step.key === key);

/**
 * 把当前回放任务与归档实验包整理成两份互不共享引用的状态视图。
 * 当前任务只读 visibleLogCount，归档任务始终读取实验包原始阶段和验收项。
 */
export function buildTrainingTracking(experiment: Experiment, runtime: TrainingRuntime): TrainingTracking {
  const visible = Math.max(0, Math.min(runtime.visibleLogCount, experiment.log.length));
  const visibleLogs = experiment.log.slice(0, visible);
  const latestLog = visibleLogs.at(-1) ?? null;
  const currentStageKey = runtime.started ? (latestLog?.step ?? experiment.jobSteps[0]?.key ?? null) : null;
  const currentRank = stageRank(experiment, currentStageKey);
  const isFinished = runtime.started && !runtime.running && visible >= experiment.log.length;

  const currentSteps: TrackingStep[] = experiment.jobSteps.map((step, index) => ({
    key: step.key,
    label: step.label,
    state: !runtime.started
      ? "等待"
      : isFinished || index < currentRank
        ? "已完成"
        : index === currentRank
          ? runtime.running
            ? "进行中"
            : "已完成"
          : "等待",
    at: visibleLogs.find((line) => line.step === step.key)?.at ?? null,
  }));

  const currentAlerts = visibleLogs
    .filter((line) => line.level === "WARN" || line.level === "ERROR")
    .map((line) => line.text);

  const archiveSteps: TrackingStep[] = experiment.jobSteps.map((step) => ({ ...step }));
  const archiveAlerts = experiment.acceptance
    .filter((item) => !item.pass)
    .map((item) => `${item.label}：${item.detail}`);

  return {
    current: {
      state: !runtime.started ? "待提交" : isFinished ? "已完成" : "运行中",
      stageKey: currentStageKey,
      stageLabel: currentStageKey
        ? experiment.jobSteps.find((step) => step.key === currentStageKey)?.label ?? "未知阶段"
        : "等待提交",
      updatedAt: runtime.updatedAt,
      steps: currentSteps,
      alerts: currentAlerts,
    },
    archive: {
      experimentId: experiment.id,
      versionText: `${experiment.baselineVersion} -> ${experiment.candidateVersion}`,
      steps: archiveSteps,
      updatedAt: experiment.jobSteps.at(-1)?.at ?? null,
      passed: experiment.acceptance.filter((item) => item.pass).length,
      total: experiment.acceptance.length,
      alerts: archiveAlerts,
    },
  };
}
