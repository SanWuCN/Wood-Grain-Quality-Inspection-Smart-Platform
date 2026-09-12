/**
 * 归档清单的**真实文件**（评审 F11）
 *
 * 评审原文：「归档摘要使用种子摘要或元信息计算，不是逐文件字节读取；
 * 当前 24 项中有缺失与摘要不符项」，要求「校验实际文件；提供补传或重选副本入口；
 * 完成后能全部通过」。
 *
 * 所以这里为清单里的每一项真的写出一个文件、真的登记进 files 表；
 * 清单登记的摘要就是**这些字节**的摘要。演示保留原设计的三种状态：
 *
 *   通过      21 项 —— 声明摘要 = 实际字节摘要
 *   摘要不一致 2 项（A-09 / A-21）—— 声明摘要故意写错，代表「副本与登记不符」
 *   缺失      1 项（A-07）—— 不登记文件，代表「该项还没归档」
 *
 * 校验一律由服务端流式读字节重算，不看 sizeText 也不看名字。
 *
 * 关于体积：清单里写着 12.1 MB / 184 MB 这些量级，但仓库里不该躺几百 MB 的假数据。
 * 生成的字节按量级缩放并封顶 64 KB，清单上的 sizeText 用**实际字节数**回写 ——
 * 宁可标签小一点，也不能让标签和磁盘上的东西对不上。
 */

import { createHash } from "node:crypto";
import { registerFile, saveBuffer } from "../services/assets.mjs";
import { nowIso } from "../storage/db.mjs";

/** 24 项的身份信息，与 src/pages/MumaiDashboard/seed/scenario.ts 的 ARCHIVE_ITEMS 对齐 */
export const ARCHIVE_MANIFEST = [
  { assetId: "A-01", group: "工单", name: "SH-2026-0901_workorder.json", seedKb: 62 },
  { assetId: "A-02", group: "工单", name: "WO-2026-0912_draft.json", seedKb: 18 },
  { assetId: "A-03", group: "环境", name: "env-2026-0911-01.json", seedKb: 12 },
  { assetId: "A-04", group: "环境", name: "CFG-02_compensation.json", seedKb: 26 },
  { assetId: "A-05", group: "原始数据", name: "scan-Z04-001_radar.csv", seedKb: 12100 },
  { assetId: "A-06", group: "原始数据", name: "scan-Z04-002_radar.csv", seedKb: 12600 },
  // 缺失项：不登记文件
  { assetId: "A-07", group: "原始数据", name: "ref-batch-01_scan_002.csv", seedKb: 0, missing: true },
  { assetId: "A-08", group: "图像", name: "Z04_lower_frames_index.json", seedKb: 41200 },
  // 摘要不一致项
  { assetId: "A-09", group: "图像", name: "Z04_lower_annotations.json", seedKb: 88, mismatch: true },
  { assetId: "A-10", group: "地图", name: "MAP-SH-06.pgm", seedKb: 2600 },
  { assetId: "A-11", group: "地图", name: "MAP-SH-06.yaml", seedKb: 4 },
  { assetId: "A-12", group: "场景", name: "GS-2026.09_manifest.json", seedKb: 184000 },
  { assetId: "A-13", group: "场景", name: "GS-2026.05_manifest.json", seedKb: 168000 },
  { assetId: "A-14", group: "数据集", name: "DS-06_frozen_manifest.json", seedKb: 46 },
  { assetId: "A-15", group: "数据集", name: "DS-06_clean_report.json", seedKb: 72 },
  { assetId: "A-16", group: "模型记录", name: "EXP-2026-0911_epochs.csv", seedKb: 38 },
  { assetId: "A-17", group: "模型记录", name: "EXP-2026-0911_predictions_new.csv", seedKb: 14 },
  { assetId: "A-18", group: "模型记录", name: "model_card_DEMO-M02b.json", seedKb: 9 },
  { assetId: "A-19", group: "模型记录", name: "quantization_report.json", seedKb: 11 },
  { assetId: "A-20", group: "更新日志", name: "DEMO-PKG-02.demo.zip", seedKb: 3200 },
  // 摘要不一致项
  { assetId: "A-21", group: "更新日志", name: "device_update_log.txt", seedKb: 24, mismatch: true },
  { assetId: "A-22", group: "报告", name: "SH-2026-0901_inspection_report.html", seedKb: 1800 },
  { assetId: "A-23", group: "报告", name: "MAY-DEMO-01_report.pdf", seedKb: 4800 },
  { assetId: "A-24", group: "报告", name: "fusion_record_FUSION-03.json", seedKb: 42 },
];

const MAX_BYTES = 64 * 1024;

/**
 * 生成一项的可复现内容。
 *
 * 同一 assetId 每次都产出同样的字节 —— 归档校验要能被反复演示，
 * 不能每启动一次就换一套摘要（那样回执和报告都对不上）。
 */
function contentFor(item) {
  const target = Math.min(Math.max(item.seedKb, 2) * 1024, MAX_BYTES);
  const lines = [];
  const header = `# ${item.assetId} ${item.name}\ngroup: ${item.group}\ngenerated: deterministic\n`;
  lines.push(header);
  let size = Buffer.byteLength(header, "utf8");
  let index = 0;
  while (size < target) {
    // 每行内容由 assetId 与行号推出，不引入随机数
    const line = `${String(index).padStart(5, "0")}  ${createHash("md5").update(`${item.assetId}:${index}`).digest("hex")}  ${item.group}/${item.name}\n`;
    lines.push(line);
    size += Buffer.byteLength(line, "utf8");
    index += 1;
  }
  return Buffer.from(lines.join(""), "utf8");
}

export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * 保证归档清单与真实文件就位。
 *
 * 只在缺失时生成；已存在的项不动 —— 重建会换掉摘要，而校验报告与回执是按摘要存的。
 */
export function ensureArchive(db, sessionId) {
  const existing = db
    .prepare("SELECT COUNT(*) AS n FROM entities WHERE session_id=? AND kind='archiveItem'")
    .get(sessionId);
  if (existing?.n >= ARCHIVE_MANIFEST.length) return { created: false, count: existing.n };

  const at = nowIso();
  for (const item of ARCHIVE_MANIFEST) {
    const already = db
      .prepare("SELECT id FROM entities WHERE session_id=? AND kind='archiveItem' AND id=?")
      .get(sessionId, item.assetId);
    if (already) continue;

    if (item.missing) {
      // 缺失项：清单里有登记，但磁盘上没有对应文件
      putItem(db, sessionId, {
        assetId: item.assetId,
        group: item.group,
        name: item.name,
        sizeText: "—",
        declaredSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        fileId: null,
        present: false,
        repairedBy: null,
        repairedAt: null,
      });
      continue;
    }

    const bytes = contentFor(item);
    const record = saveBuffer(bytes, { name: item.name, sessionId, uploadedBy: "ma", dir: `archive/${item.assetId}` });
    registerFile(db, record);

    /*
     * 摘要不一致的两项：清单上登记一个**别的**摘要，代表「归档副本与登记不符」。
     * 用同一份字节但把首位置换掉，得到的是一个真实存在、只是对不上的摘要。
     */
    const actual = createHash("sha256").update(bytes).digest("hex");
    const declared = item.mismatch ? `f${actual.slice(1)}` : actual;

    putItem(db, sessionId, {
      assetId: item.assetId,
      group: item.group,
      name: item.name,
      sizeText: formatSize(bytes.length),
      declaredSha256: declared,
      fileId: record.id,
      present: true,
      repairedBy: null,
      repairedAt: null,
    });
  }
  return { created: true, count: ARCHIVE_MANIFEST.length, at };
}

function putItem(db, sessionId, data) {
  db.prepare(
    `INSERT INTO entities (session_id, kind, id, revision, data, updated_at) VALUES (?,?,?,?,?,?)
     ON CONFLICT (session_id, kind, id) DO UPDATE SET revision=revision+1, data=excluded.data, updated_at=excluded.updated_at`,
  ).run(sessionId, "archiveItem", data.assetId, 1, JSON.stringify(data), nowIso());
}

export { putItem as putArchiveItem };
