import assert from "node:assert/strict";
import { test } from "node:test";

import type { ArtifactEntity, SharedEntity } from "../api/client.ts";
import type { TerminalScript } from "./terminalScripts.ts";
import { buildDeliveryWorkflow, buildReceiveFileRows, DELIVERY_UNLINKED_NOTE } from "./deliveryWorkflow.ts";

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
  assert.equal(workflow.steps[0]?.detail, DELIVERY_UNLINKED_NOTE);
});

/*
  ── 下面两条锁的是"页面不得凭空给产物安一个作业号"（现场口径缺陷）──────
  原实现里 `DeliveryCenter` **无条件**把固定的蒸馏脚本传进本函数，于是：
    · 「交付作业」一行对**任何**产物都显示蒸馏作业号 run-20260911-0244；
    · 量化/复测/封装三格的明细也永远来自那个脚本。
  产物的真实作业号是 `fromJob`（服务端 artifact.build 写入）：
    · 种子产物是 `EXP-2026-0911`，人工上传的是 `null` —— 两者都**不是**蒸馏作业。
  所以这两条要保证：作业号对不上时，页面不显示作业号、也不借用脚本明细。
*/

test("产物作业号与脚本不一致时，不得把该脚本的作业号挂在产物上", () => {
  const workflow = buildDeliveryWorkflow(null, artifact({ fromJob: "EXP-2026-0911" }));

  assert.equal(workflow.runId, null,
    "作业号对不上却仍显示脚本作业号 —— 等于对观众谎称这个产物出自该作业");
  assert.equal(workflow.command, null);
  assert.deepEqual(
    workflow.steps.slice(0, 3).map((step) => step.state),
    ["等待", "等待", "等待"],
  );
  assert.equal(workflow.steps[0]?.detail, DELIVERY_UNLINKED_NOTE);
});

test("产物作业号与脚本一致时才显示该作业号，且明细仍取自该脚本", () => {
  const workflow = buildDeliveryWorkflow(distillScript, artifact());

  assert.equal(workflow.runId, "run-20260911-0244");
  assert.equal(workflow.command, "distill_int8_quant.py");
  assert.match(workflow.steps[0]?.detail ?? "", /INT8/,
    "作业号一致时明细必须来自脚本，不能变成一句占位说明");
});

test("未关联作业的那句话必须全页统一（标题与三格明细同一字符串）", () => {
  /*
    实测踩过：交付轨道标题换成"非量化作业产物…"之后，
    量化/复测/封装三格仍写着旧的"未关联交付作业" —— 同一件事在屏幕上
    出现两种说法，观众读到的是自相矛盾的两句。所以两处必须共用同一常量。
  */
  const workflow = buildDeliveryWorkflow(null, artifact({ fromJob: "EXP-2026-0911" }));

  for (const step of workflow.steps.slice(0, 3)) {
    assert.equal(step.detail, DELIVERY_UNLINKED_NOTE,
      `「${step.label}」的说明与全页统一说法不一致`);
  }
  assert.ok(DELIVERY_UNLINKED_NOTE.length > 0, "统一说法不能是空串");
  /* 措辞不得承诺做不到的动作：本页没有量化作业的提交入口 */
  assert.ok(!/重新提交作业/.test(DELIVERY_UNLINKED_NOTE),
    "不得写「重新提交作业后回填」——本页没有该入口，属于做不到的承诺");
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
