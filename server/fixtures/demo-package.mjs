/**
 * 演示更新包生成（PRD §10.3）
 *
 * 评审 F02 与 §3.7 的要求是「产物文件实际存在、下载返回正确 Content-Disposition」，
 * 所以这里真的打出字节：
 *   - demo-update.zip 里装 manifest.json / metrics.json / 模型说明 / 演示模型占位资产 / 校验清单
 *   - 每个文件单独登记进 files 表，各自的 sha256 由服务端算
 *   - 包整体摘要**在包生成之后**算，不写回包内（否则就成了把自己摘要写进自己的循环）
 *
 * 包内明确写 demoOnly: true 与「ESP32-S3 端使用演示模型资产」：
 * 评审 §3.7 点名不能把扩展名改成 .bin 就称为可烧录固件。
 */

import { createHash } from "node:crypto";
import { makeZip } from "./zip.mjs";
import { registerFile, saveBuffer } from "../services/assets.mjs";

/** 固定内容的演示模型占位资产：真实字节，但明确不是可烧录固件 */
function demoModelBytes(modelVersion) {
  const lines = [
    "# 木脉智检 · 演示模型资产（demo-only）",
    `model_version: ${modelVersion}`,
    "target: ESP32-S3",
    "note: 这是形状与大小贴近真实的演示占位资产，不是可烧录固件，也不含真实权重。",
    "note: 真实 TinyML 格式与内存适配需按实际运行环境另行联调。",
  ];
  // 让它有一点体积（不是 0 字节），便于演示进度与大小显示
  const filler = Array.from({ length: 512 }, (_, i) => `${String(i).padStart(4, "0")} 0x${((i * 2654435761) >>> 0).toString(16).padStart(8, "0")}`).join("\n");
  return Buffer.from(`${lines.join("\n")}\n\n${filler}\n`, "utf8");
}

/**
 * 生成一个演示更新包并登记全部文件。
 *
 * @returns {{ artifactFiles: object[], manifest: object, totalSha256: string, totalSize: number }}
 */
export function buildDemoPackage(db, { modelVersion = "DEMO-M02b", kind = "模型包", target = "硬件侧端模型", builtBy = "shi", sessionId = null, metrics } = {}) {
  const metricsDoc = metrics ?? {
    testSetId: "DS-06/test",
    sampleCount: 86,
    accuracy: 0.7172,
    precision: 0.7419,
    recall: 0.6884,
    f1: 0.7143,
    note: "与基线同一测试集；措辞为「演示指标」，不是现场实测结论。",
  };

  const manifest = {
    artifactKind: kind,
    target,
    modelVersion,
    demoOnly: true,
    builtAt: new Date().toISOString(),
    builtBy,
    files: [
      { path: "model/demo-model.bin", role: "演示模型占位资产" },
      { path: "metrics.json", role: "同测试集评估指标" },
      { path: "model-card.md", role: "模型说明" },
      { path: "checksums.txt", role: "逐文件摘要" },
    ],
    compatibility: [
      { key: "target", label: "目标运行环境", pass: true, detail: "ESP32-S3 · 演示资产" },
      { key: "flashable", label: "可直接烧录", pass: false, detail: "演示资产不可烧录，真机固件需另行适配" },
    ],
  };

  const modelCard = [
    `# ${modelVersion} 模型说明`,
    "",
    `- 目标设备：${target}`,
    "- 输入：1×420 频谱向量",
    "- 用途：木构件内部响应二分类（演示）",
    "- 演示边界：不包含真实权重，仅用于流程演示。",
  ].join("\n");

  const fileEntries = [
    { path: "model/demo-model.bin", content: demoModelBytes(modelVersion) },
    { path: "metrics.json", content: `${JSON.stringify(metricsDoc, null, 2)}\n` },
    { path: "model-card.md", content: `${modelCard}\n` },
  ];

  // checksums.txt 覆盖前面三份，再连同 manifest 一起打包
  const checksums = fileEntries
    .map((entry) => `${createHash("sha256").update(entry.content).digest("hex")}  ${entry.path}`)
    .join("\n");
  fileEntries.push({ path: "checksums.txt", content: `${checksums}\n` });

  const zipEntries = [
    { name: "manifest.json", content: `${JSON.stringify(manifest, null, 2)}\n` },
    ...fileEntries.map((entry) => ({ name: entry.path, content: entry.content })),
  ];
  const zipBytes = makeZip(zipEntries);
  const totalSha256 = createHash("sha256").update(zipBytes).digest("hex");

  /* ---- 落盘 + 登记：包内每个文件一份，整包一份 ---- */
  const artifactFiles = [];
  for (const entry of fileEntries) {
    const record = saveBuffer(entry.content, {
      name: entry.path.split("/").pop(),
      sessionId,
      uploadedBy: builtBy,
      dir: "demo-package",
    });
    registerFile(db, record);
    artifactFiles.push({ ...record, role: entry.path });
  }

  // manifest 单独也登记一份，便于前端直接读清单而不用解包
  const manifestRecord = saveBuffer(Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"), {
    name: "manifest.json",
    sessionId,
    uploadedBy: builtBy,
    dir: "demo-package",
  });
  registerFile(db, manifestRecord);

  // 整包：摘要来自刚打出来的字节
  const zipRecord = saveBuffer(zipBytes, {
    name: `${modelVersion}-demo-update.zip`,
    mediaType: "application/zip",
    sessionId,
    uploadedBy: builtBy,
    dir: "demo-package",
  });
  registerFile(db, zipRecord);

  return {
    artifactFiles,
    manifest,
    manifestFileId: manifestRecord.id,
    packageFileId: zipRecord.id,
    packageName: zipRecord.name,
    totalSha256,
    totalSize: zipRecord.size,
  };
}
