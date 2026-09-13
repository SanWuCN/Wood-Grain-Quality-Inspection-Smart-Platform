/**
 * 一次性工具：把 knowledge-demo-v1 夹具按当前生成器重装一遍。
 *
 * 用途：夹具生成器改了（时间分布、版本规范化等）之后，让已有的演示库
 * 与生成器口径重新一致，而不必删掉整个 mumai.db。
 *
 * 它只清空并重建**知识域**的表（knowledge_*），不碰平台原有工单、设备、
 * 归档文件或其它会话 —— 这一条与 PRD §15 的迁移要求一致。
 *
 * 用法：node tools/reset-knowledge-fixture.mjs [sessionId]
 */

import { resolve } from "node:path";
import { openDatabase } from "../server/storage/db.mjs";
import { installKnowledgeFixture } from "../server/services/knowledge-store.mjs";
import { ensureSampleFiles, fixtureDigest, fixtureReport } from "../server/fixtures/knowledge-samples.mjs";

const sessionId = process.argv[2] ?? "demo-01";
const dbFile = process.env.MUMAI_DB ?? resolve("server/data/mumai.db");
const db = openDatabase(dbFile);

const installed = installKnowledgeFixture(db, { sessionId, force: true });
const samples = ensureSampleFiles(db, sessionId);
const report = fixtureReport(db, sessionId);
const digest = fixtureDigest(db, sessionId);

console.log(`已重装 ${installed.scenarioId}（session=${sessionId}）`);
console.log(`  资产 ${report.counts.assets} · 分块 ${report.counts.chunks} · 向量 ${report.counts.vectors} · 关系 ${report.counts.relations}`);
console.log(`  可打开样本 ${samples.created} 项 · 未随包提供附件 ${report.missingAttachment} 项`);
console.log(`  夹具指纹 ${digest.sha256.slice(0, 16)}`);
if (report.errors.length) {
  console.error(`  自检错误：${report.errors.join("；")}`);
  process.exitCode = 1;
}
db.close();
