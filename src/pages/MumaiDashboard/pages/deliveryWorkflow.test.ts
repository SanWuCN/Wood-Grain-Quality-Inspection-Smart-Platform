import assert from "node:assert/strict";
import { test } from "node:test";

import type { ArtifactEntity, SharedEntity } from "../api/client.ts";
import type { TerminalScript } from "./terminalScripts.ts";
import { buildDeliveryWorkflow, buildReceiveFileRows } from "./deliveryWorkflow.ts";

const distillScript: TerminalScript = {
  key: "distill",
  label: "蒸馏与量化",
  command: "distill_int8_quant.py",
  runId: "run-20260911-0244",
  owner: "shi",
  submittedAt: "2026-09-11 10:12",
  summary: "KD 20 epoch",
  totalMs: 100,
  steps: [
    { text: "quant: Sensitivity scan complete INT8=45/47 layers FP16=2/47 layers", level: "OK", dwellMs: 10 },
    { text: "verify: PASSED edge deployment requirements satisfied", level: "OK", dwellMs: 10 },
    { text: "pack: Output fw_mumai_v3.6.0.bin 4.08 MB", level: "INFO", dwellMs: 10 },
    { text: "archive: Complete session_id=MML-2026-0413", level: "OK", dwellMs: 10 },
  ],
};

function artifact(overrides: Partial<ArtifactEntity> = {}): SharedEntity<ArtifactEntity> {
  return {
    id: "artifact-01",
    revision: 3,
    updatedAt: "2026-09-11T10:42:00.000Z",
    data: {
      id: "artifact-01",
      name: "fw_mumai_v3.6.0.bin",
      kind: "firmware",
      target: "硬件侧端模型",
      modelVersion: "v3.6.0",
      demoOnly: false,
      fromJob: "run-20260911-0244",
      files: [
        { fileId: "file-package", role: "整包" },
        { fileId: "file-manifest", role: "清单" },
      ],
      state: "已发布",
      sha256: "abcdef1234567890",
      sizeText: "4.08 MB",
      publishedBy: "shi",
      publishedAt: "2026-09-11T10:42:00.000Z",
      downloadCount: 0,
      receipts: [],
      ...overrides,
    },
  };
}

test("交付阶段复用量化脚本记录，并按服务端产物状态推进发布与接收", () => {
  const workflow = buildDeliveryWorkflow(distillScript, artifact());
  assert.deepEqual(
    workflow.steps.map((step) => [step.key, step.state]),
    [
      ["quantize", "已完成"],
      ["verify", "已完成"],
      ["package", "已完成"],
      ["publish", "已完成"],
      ["receive", "等待"],
    ],
  );
  assert.equal(workflow.runId, "run-20260911-0244");
  assert.match(workflow.steps[0]?.detail ?? "", /INT8/);
  assert.match(workflow.steps[1]?.detail ?? "", /PASSED/);
  assert.match(workflow.steps[2]?.detail ?? "", /fw_mumai/);
});

test("下载后接收阶段进行中，摘要回验通过后才完成", () => {
  const script = distillScript;
  const downloaded = buildDeliveryWorkflow(script, artifact({ state: "已下载", downloadCount: 1 }));
  assert.equal(downloaded.steps.at(-1)?.state, "进行中");

  const verified = buildDeliveryWorkflow(
    script,
    artifact({
      state: "已回验",
      downloadCount: 1,
      receipts: [
        {
          at: "2026-09-11T10:50:00.000Z",
          actor: "rao",
          reportedVersion: "v3.6.0",
          verifiedHash: "abcdef1234567890",
          pass: true,
          note: "摘要一致",
          deviceMode: "hardware",
        },
      ],
    }),
  );
  assert.equal(verified.steps.at(-1)?.state, "已完成");
  assert.equal(verified.receiptSummary, "1/1 次回验通过");
});

test("服务端仅完成构建校验时，发布阶段仍然等待", () => {
  const checked = buildDeliveryWorkflow(
    distillScript,
    artifact({ state: "checked", publishedAt: null }),
  );

  assert.equal(checked.steps.find((step) => step.key === "publish")?.state, "等待");
});

test("产物未登记同一作业号时，不借用其它脚本的量化与复测结论", () => {
  const workflow = buildDeliveryWorkflow(
    distillScript,
    artifact({ fromJob: "EXP-2026-0911" }),
  );

  assert.deepEqual(
    workflow.steps.slice(0, 3).map((step) => step.state),
    ["等待", "等待", "等待"],
  );
  assert.match(workflow.steps[0]?.detail ?? "", /未关联/);
});

test("接收文件列表只使用服务端登记文件和本次会话下载结果", () => {
  const rows = buildReceiveFileRows(artifact(), {
    "file-package": { state: "已接收", size: 4177920, sha256: "abcdef1234567890" },
    "file-manifest": { state: "失败", message: "连接中断" },
  });

  assert.deepEqual(rows.map((row) => row.fileId), ["file-package", "file-manifest"]);
  assert.equal(rows[0]?.state, "已接收");
  assert.equal(rows[0]?.sha256, "abcdef1234567890");
  assert.equal(rows[1]?.state, "失败");
  assert.equal(rows[1]?.message, "连接中断");
});

test("已持久化的服务端下载记录在重新打开接收页后仍显示为已接收", () => {
  const rows = buildReceiveFileRows(
    artifact({
      downloadCount: 1,
      receivedFiles: [
        {
          fileId: "file-package",
          at: "2026-09-11T10:55:00.000Z",
          actor: "rao",
          size: 4177920,
          sha256: "abcdef1234567890",
        },
      ],
    }),
    {},
  );

  assert.equal(rows[0]?.state, "已接收");
  assert.equal(rows[0]?.sha256, "abcdef1234567890");
  assert.equal(rows[1]?.state, "待接收");
});
