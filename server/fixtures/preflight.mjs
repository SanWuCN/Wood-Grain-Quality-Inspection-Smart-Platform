/**
 * 共享服务 · 启动预检与素材补齐
 *
 * 两件事：
 *   1. 每次启动确认演示更新包在磁盘上真的存在；缺了就重新生成
 *      （评审 F02：产物必须是可下载的真文件，不能只是一条登记）
 *   2. 提供一份可读的预检清单（PRD §11「预检至少包括素材文件、模型演示包、
 *      历史知识、3D资源、音频、服务连接、磁盘空间和展示窗口」）
 */

import { existsSync } from "node:fs";
import { ASSETS_ROOT } from "../services/assets.mjs";
import { buildDemoPackage } from "./demo-package.mjs";

/** 检查某个 fileId 对应的字节是否还在磁盘上 */
export function packageMissing(db, artifactId = "ART-01") {
  const row = db
    .prepare("SELECT data FROM entities WHERE kind='artifact' AND id=?")
    .get(artifactId);
  if (!row) return true;
  let data;
  try {
    data = JSON.parse(row.data);
  } catch {
    return true;
  }
  const files = data.files ?? [];
  if (!files.length) return true;
  return files.some((entry) => {
    const file = db.prepare("SELECT stored_path FROM files WHERE id=?").get(entry.fileId);
    return !file || !existsSync(file.stored_path);
  });
}

/**
 * 保证演示更新包可用。
 *
 * 只在缺文件时重建，不会覆盖已有产物 —— 重建会改变摘要，而回验记录是按摘要存的，
 * 每次启动都换一份新包会让「上一轮的回执」全部对不上。
 */
export function ensureDemoPackage(db, sessionId) {
  if (!packageMissing(db, "ART-01")) return { created: false };
  // 已有 ART-01 但文件丢了：把旧的登记清掉再重建，避免留下指向不存在文件的记录
  db.prepare("DELETE FROM entities WHERE kind='artifact' AND id='ART-01'").run();
  const pack = buildDemoPackage(db, { modelVersion: "DEMO-M02b", builtBy: "shi", sessionId });
  db.prepare(
    `INSERT INTO entities (session_id, kind, id, revision, data, updated_at) VALUES (?,?,?,?,?,?)
     ON CONFLICT (session_id, kind, id) DO UPDATE SET revision=excluded.revision, data=excluded.data, updated_at=excluded.updated_at`,
  ).run(
    sessionId,
    "artifact",
    "ART-01",
    1,
    JSON.stringify({
      id: "ART-01",
      name: pack.packageName,
      kind: "模型包",
      target: "硬件侧端模型",
      modelVersion: "DEMO-M02b",
      demoOnly: true,
      fromJob: "EXP-2026-0911",
      files: [
        { fileId: pack.packageFileId, role: "整包" },
        { fileId: pack.manifestFileId, role: "清单" },
        ...pack.artifactFiles.map((item) => ({ fileId: item.id, role: item.role })),
      ],
      state: "已发布",
      sha256: pack.totalSha256,
      sizeText: `${(pack.totalSize / 1024).toFixed(1)} KB`,
      builtBy: "shi",
      builtAt: new Date().toISOString(),
      publishedBy: "shi",
      publishedAt: new Date().toISOString(),
      receipts: [],
    }),
    new Date().toISOString(),
  );
  return { created: true, packageFileId: pack.packageFileId };
}

/** 预检明细：给 /api/health 与启动脚本共用 */
export function preflightDetail(db, sessionId) {
  const items = [];
  const add = (key, label, pass, detail) => items.push({ key, label, pass, detail });

  const session = db.prepare("SELECT * FROM sessions WHERE id=?").get(sessionId);
  add("session", "演示会话存在", Boolean(session), sessionId);

  const artifact = db.prepare("SELECT id FROM entities WHERE kind='artifact' AND id='ART-01'").get();
  add("demo-package", "演示更新包已登记", Boolean(artifact), artifact ? "ART-01" : "缺失");

  const missing = packageMissing(db, "ART-01");
  add("demo-package-bytes", "演示更新包字节在磁盘上", !missing, missing ? "有文件缺失，启动时会重建" : ASSETS_ROOT);

  const sog = existsSync("public/model/sog/gs.sog");
  add("scene-asset", "高斯场景资源", sog, sog ? "public/model/sog/gs.sog" : "缺失");

  const fonts = existsSync("public/fonts");
  add("fonts", "本地字体", fonts, "public/fonts");

  return { items, ok: items.every((item) => item.pass) };
}
