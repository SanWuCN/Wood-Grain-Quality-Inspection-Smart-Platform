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
  /**
   * 交付作业号。**取不到时为 `null`** —— 不编一个出来。
   *
   * 产物的作业号只有一个权威来源：服务端写入的 `artifact.data.fromJob`。
   * 它与脚本台账里的 `runId` 对不上时（种子产物 `EXP-2026-0911`、人工上传 `null`），
   * 说明这个产物**不是**由该脚本产出的 —— 此时页面必须显示"未关联交付作业"，
   * 而不是把某个脚本的作业号挂在它身上。原实现就是无条件挂蒸馏作业号，
   * 等于对观众谎称"这个包出自那次量化"。
   */
  runId: string | null;
  /** 作业命令；同 `runId`，取不到为 `null` */
  command: string | null;
  submittedAt: string | null;
  summary: string | null;
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

/**
 * 按产物的 `fromJob` 找出**真正**产出它的脚本；找不到就返回 `null`。
 *
 * 为什么必须这样找：脚本台账是前端构造的（`terminalScripts.buildDistillScript` 等），
 * 作业号写在各自的配置里；产物的作业号来自服务端 `artifact.data.fromJob`。
 * 两者是**两个来源**，只有相等才能说"这个产物出自那次作业"。
 * 不相等时（种子产物是 `EXP-2026-0911`，手工上传是 `null`）不能硬凑 ——
 * 硬凑的表现就是页面上那行「交付作业 run-…」，它对每个产物都显示同一个作业号。
 */
export function resolveDeliveryScript<T extends { runId: string }>(
  scripts: readonly T[],
  fromJob: string | null | undefined,
): T | null {
  if (!fromJob) return null;
  return scripts.find((script) => script.runId === fromJob) ?? null;
}

/**
 * 产物没有量化作业记录时，页面对观众的统一说法。
 *
 * ── 为什么是一句常量而不是各处各写 ──────────────────────────────────
 * 同一件事（这个产物没有量化/复测记录）在页面上出现两处：**交付轨道标题**与
 * **量化/复测/封装三格的明细**。两处各写一句就会出现"标题说 A、格子说 B"，
 * 观众读到的是自相矛盾的两句话 —— 实测就发生过（标题写"非量化作业产物"，
 * 格子仍写"未关联交付作业"）。
 *
 * 措辞刻意**不承诺任何动作**：本页的产品形态是"提交 / 取用"，
 * 没有量化作业的提交入口，所以不能写"请重新提交作业后回填"那种做不到的话。
 */
export const DELIVERY_UNLINKED_NOTE =
  "非量化作业产物 —— 本页没有该产物的量化与复测记录，不显示其它作业的结论";

/** 从既有终端脚本的输出中提取交付页需要的四类记录，不重新生成数字。 */
export function buildDeliveryWorkflow(
  script: TerminalScript | null,
  artifact: SharedEntity<ArtifactEntity>,
): DeliveryWorkflow {
  const linkedToScript = Boolean(script) && artifact.data.fromJob === script!.runId;
  const quantize = linkedToScript
    ? lastMatching(script!, /quant: (?:Engine export complete|Sensitivity scan complete)/i)
    : null;
  const verify = linkedToScript
    ? lastMatching(script!, /verify: (?:PASSED|WARN|Accuracy drop)/i)
    : null;
  const packageLine = linkedToScript
    ? lastMatching(script!, /pack: (?:Output|Manifest written)/i)
    : null;
  /* 未关联作业时的说明统一取常量，见上方说明 */
  const unlinked = DELIVERY_UNLINKED_NOTE;
  const receipts = artifact.data.receipts ?? [];
  const passedReceipts = receipts.filter((receipt) => receipt.pass).length;
  const downloaded = (artifact.data.downloadCount ?? 0) > 0;
  const verified = receipts.some((receipt) => receipt.pass);

  return {
    runId: linkedToScript ? script!.runId : null,
    command: linkedToScript ? script!.command : null,
    submittedAt: linkedToScript ? script!.submittedAt : null,
    summary: linkedToScript ? script!.summary : null,
    steps: [
      {
        key: "quantize",
        label: "INT8 量化",
        state: quantize ? "已完成" : "等待",
        detail: quantize ?? (linkedToScript ? "脚本尚未写入量化结果" : unlinked),
      },
      {
        key: "verify",
        label: "端侧复测",
        state: verify?.includes("PASSED") ? "已完成" : verify ? "进行中" : "等待",
        detail: verify ?? (linkedToScript ? "脚本尚未写入复测结果" : unlinked),
      },
      {
        key: "package",
        label: "封装清单",
        state: packageLine ? "已完成" : "等待",
        detail: packageLine
          ? `${packageLine}${lastMatching(script!, /archive: (?:Complete|Version tag)/i) ? " · 已写入归档记录" : ""}`
          : linkedToScript
            ? "脚本尚未写入封装文件"
            : unlinked,
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
