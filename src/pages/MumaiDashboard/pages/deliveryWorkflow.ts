import type { ArtifactEntity, SharedEntity } from "../api/client";
import type { TerminalScript } from "./terminalScripts";

export type DeliveryStepState = "等待" | "进行中" | "已完成";

export type DeliveryWorkflowStep = {
  key: "quantize" | "verify" | "package" | "publish" | "receive";
  label: string;
  state: DeliveryStepState;
  detail: string;
};

export type DeliveryWorkflow = {
  runId: string;
  command: string;
  submittedAt: string;
  summary: string;
  steps: DeliveryWorkflowStep[];
  receiptSummary: string;
};

export type ReceiveResult = {
  state: "已接收" | "失败";
  size?: number;
  sha256?: string | null;
  message?: string;
};

export type ReceiveFileRow = {
  fileId: string;
  role: string;
  state: "待接收" | "已接收" | "失败";
  size: number | null;
  sha256: string | null;
  message: string | null;
};

function lastMatching(script: TerminalScript, pattern: RegExp): string | null {
  for (let index = script.steps.length - 1; index >= 0; index -= 1) {
    const text = script.steps[index]?.text;
    if (text && pattern.test(text)) return text;
  }
  return null;
}

/** 从既有终端脚本的输出中提取交付页需要的四类记录，不重新生成数字。 */
export function buildDeliveryWorkflow(
  script: TerminalScript,
  artifact: SharedEntity<ArtifactEntity>,
): DeliveryWorkflow {
  const linkedToScript = artifact.data.fromJob === script.runId;
  const quantize = linkedToScript
    ? lastMatching(script, /quant: (?:Engine export complete|Sensitivity scan complete)/i)
    : null;
  const verify = linkedToScript
    ? lastMatching(script, /verify: (?:PASSED|WARN|Accuracy drop)/i)
    : null;
  const packageLine = linkedToScript
    ? lastMatching(script, /pack: (?:Output|Manifest written)/i)
    : null;
  const receipts = artifact.data.receipts ?? [];
  const passedReceipts = receipts.filter((receipt) => receipt.pass).length;
  const downloaded = (artifact.data.downloadCount ?? 0) > 0;
  const verified = receipts.some((receipt) => receipt.pass);

  return {
    runId: script.runId,
    command: script.command,
    submittedAt: script.submittedAt,
    summary: script.summary,
    steps: [
      {
        key: "quantize",
        label: "INT8 量化",
        state: quantize ? "已完成" : "等待",
        detail: quantize ?? (linkedToScript ? "脚本尚未写入量化结果" : "产物未关联本量化作业"),
      },
      {
        key: "verify",
        label: "端侧复测",
        state: verify?.includes("PASSED") ? "已完成" : verify ? "进行中" : "等待",
        detail: verify ?? (linkedToScript ? "脚本尚未写入复测结果" : "产物未关联本复测作业"),
      },
      {
        key: "package",
        label: "封装清单",
        state: packageLine ? "已完成" : "等待",
        detail: packageLine
          ? `${packageLine}${lastMatching(script, /archive: (?:Complete|Version tag)/i) ? " · 已写入归档记录" : ""}`
          : linkedToScript
            ? "脚本尚未写入封装文件"
            : "产物未关联本封装作业",
      },
      {
        key: "publish",
        label: "平台发布",
        state: ["已发布", "已下载", "已回验"].includes(artifact.data.state) ? "已完成" : "等待",
        detail:
          artifact.data.publishedAt
            ? `发布于 ${artifact.data.publishedAt.slice(0, 19).replace("T", " ")}`
            : "等待提交到平台",
      },
      {
        key: "receive",
        label: "接收回验",
        state: verified ? "已完成" : downloaded ? "进行中" : "等待",
        detail: verified
          ? `摘要回验通过 ${passedReceipts}/${receipts.length}`
          : downloaded
            ? "已下载，等待接收方提交摘要"
            : "等待接收方取用",
      },
    ],
    receiptSummary: `${passedReceipts}/${receipts.length} 次回验通过`,
  };
}

/** 文件行只由服务端登记的 fileId / role 和当前会话的实际结果组成。 */
export function buildReceiveFileRows(
  artifact: SharedEntity<ArtifactEntity>,
  results: Record<string, ReceiveResult>,
): ReceiveFileRow[] {
  return artifact.data.files.map((file) => {
    const persisted = [...(artifact.data.receivedFiles ?? [])]
      .reverse()
      .find((entry) => entry.fileId === file.fileId);
    const result = results[file.fileId] ?? (persisted
      ? { state: "已接收" as const, size: persisted.size ?? undefined, sha256: persisted.sha256 }
      : undefined);
    return {
      fileId: file.fileId,
      role: file.role,
      state: result?.state ?? "待接收",
      size: result?.size ?? null,
      sha256: result?.sha256 ?? null,
      message: result?.message ?? null,
    };
  });
}
