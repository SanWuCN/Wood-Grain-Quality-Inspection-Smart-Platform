/**
 * 数据与知识中心 · 可深入展示样本的真实文件
 *
 * 依据：PRD §11.2「可深入展示样本：至少 24 组……包含真实可打开的示例文件」，
 *      以及「若未附原始二进制文件，详情显示『原始附件未随演示包提供』，
 *      仅提供记录 / 文本预览，不能出现可点击却无文件的下载按钮」。
 *
 * 所以这里做的是**真的写盘**：走 assets.mjs 的 saveBuffer（真实字节 + 真实 SHA-256），
 * 再登记到 files 表。文件字节在服务端现算，不随包携带二进制，
 * 避免仓库里躺着一堆几十 KB 的演示附件。
 *
 * 文件形态按类型给：文档给 .md（可直接预览原文），图片给 .svg（浏览器能画，
 * 且能承载标注框），视频给 .txt 转写稿，日志给 .log，工单 / 业务记录给 .json。
 * 页面上仍按**原始格式**显示资产类型，这里只是「随演示包提供的可打开样本」。
 */

import { createHash } from "node:crypto";
import { registerFile, saveBuffer } from "../services/assets.mjs";
import { parseJson } from "../storage/db.mjs";

const EXT_BY_TYPE = {
  document: { ext: ".md", mediaType: "text/markdown; charset=utf-8" },
  image: { ext: ".svg", mediaType: "image/svg+xml" },
  video: { ext: ".txt", mediaType: "text/plain; charset=utf-8" },
  workOrder: { ext: ".json", mediaType: "application/json" },
  logBatch: { ext: ".log", mediaType: "text/plain; charset=utf-8" },
  record: { ext: ".json", mediaType: "application/json" },
};

/** 稳定的 SVG 占位影像：带构件编号、日期与标注框，不是纯色块 */
function imageSvg(asset) {
  const label = String(asset.title).replace(/[<>&]/g, "");
  const objectId = asset.primary_object_id ?? asset.building_id ?? "—";
  const at = String(asset.captured_at ?? "").slice(0, 10);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="640" viewBox="0 0 960 640">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#0c1929"/><stop offset="1" stop-color="#030812"/>
    </linearGradient>
  </defs>
  <rect width="960" height="640" fill="url(#g)"/>
  <g fill="none" stroke="rgba(78,168,255,.28)" stroke-width="1">
    <path d="M0 520 H960 M0 440 H960 M120 0 V640 M840 0 V640"/>
  </g>
  <rect x="352" y="120" width="86" height="400" fill="#22384f" stroke="#4ea8ff" stroke-opacity=".5"/>
  <rect x="352" y="470" width="86" height="50" fill="#2b4257"/>
  <rect x="330" y="500" width="130" height="30" fill="#1a2c3d" stroke="#4ea8ff" stroke-opacity=".35"/>
  <rect x="336" y="452" width="118" height="66" fill="none" stroke="#f2b84b" stroke-dasharray="6 4"/>
  <text x="345" y="486" fill="#f2b84b" font-family="monospace" font-size="13">标注区 1</text>
  <text x="36" y="52" fill="#eaf3ff" font-family="sans-serif" font-size="20">${label}</text>
  <text x="36" y="82" fill="#70849c" font-family="monospace" font-size="14">对象 ${objectId} · 采集 ${at} · 演示占位影像</text>
  <text x="36" y="612" fill="#465a70" font-family="monospace" font-size="12">木脉智检 · 数据与知识中心 · 可深入展示样本</text>
</svg>`;
}

function jsonFile(asset, content, extra) {
  return JSON.stringify(
    {
      资产编号: asset.id,
      标题: asset.title,
      来源系统: asset.source_system,
      原始编号: asset.source_entity_id,
      关联对象: parseJson(asset.object_ids, []),
      版本: `v${asset.content_revision}`,
      采集时间: asset.captured_at,
      ...extra,
      内容: content ? content.text.split("\n") : [],
      说明: "本文件由演示夹具生成，结构与平台业务字段一致，可直接打开核对。",
    },
    null,
    2,
  );
}

/**
 * 给可深入展示样本补齐真实文件。
 *
 * 幂等：已经有 file_id 的资产直接跳过，重复启动不会产生第二份副本。
 */
export function ensureSampleFiles(db, sessionId) {
  const rows = db
    .prepare(
      `SELECT a.*, c.text AS content_text
         FROM knowledge_assets a
         LEFT JOIN knowledge_contents c ON c.session_id=a.session_id AND c.asset_id=a.id
        WHERE a.session_id=? AND a.deleted_at IS NULL
          AND a.index_state IN ('已覆盖','待更新','更新失败')
          AND a.file_id IS NULL
        ORDER BY CASE a.type
                   WHEN 'document' THEN 0 WHEN 'image' THEN 1 WHEN 'video' THEN 2
                   WHEN 'workOrder' THEN 3 WHEN 'logBatch' THEN 4 ELSE 5 END,
                 a.id
        LIMIT 24`,
    )
    .all(sessionId);
  if (!rows.length) return { created: 0, skipped: 0 };

  const updateAsset = db.prepare("UPDATE knowledge_assets SET file_id=?, sha256=? WHERE session_id=? AND id=?");
  const updateRevision = db.prepare(
    "UPDATE knowledge_asset_revisions SET file_id=? WHERE session_id=? AND asset_id=? AND revision=?",
  );
  let created = 0;

  db.exec("BEGIN");
  try {
    for (const row of rows) {
      const spec = EXT_BY_TYPE[row.type] ?? EXT_BY_TYPE.document;
      const baseName = `${row.id}-${row.title}`.replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 60);
      let buffer;
      if (row.type === "image") {
        buffer = Buffer.from(imageSvg(row), "utf8");
      } else if (row.type === "document" || row.type === "video" || row.type === "logBatch") {
        const header = `# ${row.title}\n\n资产编号：${row.id}｜来源：${row.source_system}（${row.source_entity_id}）｜版本：v${row.content_revision}｜采集：${row.captured_at}\n\n`;
        buffer = Buffer.from(header + (row.content_text ?? row.summary ?? ""), "utf8");
      } else {
        const extra = row.type === "workOrder" ? { 工单编号: parseJson(row.extra, {}).orderNo ?? row.source_entity_id } : {};
        buffer = Buffer.from(jsonFile(row, { text: row.content_text ?? "" }, extra), "utf8");
      }
      const record = saveBuffer(buffer, {
        name: `${baseName}${spec.ext}`,
        mediaType: spec.mediaType,
        sessionId,
        uploadedBy: "fixture",
        dir: "knowledge",
      });
      registerFile(db, record);
      updateAsset.run(record.id, record.sha256, sessionId, row.id);
      updateRevision.run(record.id, sessionId, row.id, row.content_revision);
      created += 1;
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { created, skipped: rows.length - created };
}

/** 夹具生成报告（PRD §11.2：列出资产数、各类数量、分块数、关系数、缺失附件数和错误项） */
export function fixtureReport(db, sessionId) {
  const seed = db.prepare("SELECT scenario_id, seed, report, installed_at FROM knowledge_seeds WHERE session_id=?").get(sessionId);
  if (!seed) return null;
  const counts = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM knowledge_assets WHERE session_id=?) AS assets,
         (SELECT COUNT(*) FROM knowledge_assets WHERE session_id=? AND file_id IS NOT NULL) AS withFile,
         (SELECT COUNT(*) FROM knowledge_chunks WHERE session_id=?) AS chunks,
         (SELECT COUNT(*) FROM knowledge_vectors WHERE session_id=?) AS vectors,
         (SELECT COUNT(*) FROM knowledge_relations WHERE session_id=?) AS relations,
         (SELECT COUNT(*) FROM knowledge_contents WHERE session_id=?) AS contents`,
    )
    .get(sessionId, sessionId, sessionId, sessionId, sessionId, sessionId);
  const byType = db
    .prepare("SELECT type, COUNT(*) AS n FROM knowledge_assets WHERE session_id=? GROUP BY type")
    .all(sessionId)
    .map((row) => ({ type: row.type, count: row.n }));
  const stored = parseJson(seed.report, {});
  return {
    scenarioId: seed.scenario_id,
    seed: seed.seed,
    installedAt: seed.installed_at,
    counts: { ...counts, byType },
    /*
      规模样本台账（按主类的「总量 − 可展开明细」）：
      数据说明抽屉要拿它解释「共 N 项里只有 M 项能点开」，
      验收脚本也靠它核对规模合计。存的是安装时的报告，不随页面查询变化。
    */
    scaleRows: stored.scaleRows ?? [],
    scaleTotal: stored.scaleTotal ?? 0,
    deepSampleIds: stored.deepSampleIds ?? [],
    deepSampleCount: stored.deepSampleCount ?? 0,
    missingAttachment: counts.assets - counts.withFile,
    errors: stored.errors ?? [],
  };
}

/**
 * 夹具内容的指纹：验收脚本用它确认「重置后结果一致」（PRD §11.2）。
 *
 * 指纹只取**与时间无关**的部分（分块 ID、序号、字数、摘要），
 * 不取摘要哈希——摘要哈希里含生成时刻，跨天重置必然不同，
 * 那会把「同 seed 结果一致」误判成失败。
 */
export function fixtureDigest(db, sessionId) {
  const rows = db
    .prepare("SELECT id, asset_id, asset_revision, chunk_ordinal, char_count FROM knowledge_chunks WHERE session_id=? ORDER BY id")
    .all(sessionId);
  const hash = createHash("sha256");
  for (const row of rows) {
    hash.update(`${row.id}|${row.asset_id}|${row.asset_revision}|${row.chunk_ordinal}|${row.char_count}\n`);
  }
  const assets = db
    .prepare("SELECT id, type, title, format, content_revision, index_state FROM knowledge_assets WHERE session_id=? ORDER BY id")
    .all(sessionId);
  for (const row of assets) {
    hash.update(`${row.id}|${row.type}|${row.title}|${row.format}|${row.content_revision}|${row.index_state}\n`);
  }
  return { chunks: rows.length, assets: assets.length, sha256: hash.digest("hex") };
}
