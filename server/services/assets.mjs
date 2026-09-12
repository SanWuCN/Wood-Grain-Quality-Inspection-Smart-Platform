/**
 * 共享服务 · 文件资产（真实字节 + 流式摘要）
 *
 * 评审 F02 / F11 的根子在这里：原来「下载」只写一条取用记录，不产生文件；
 * 「归档校验」用的是种子里编好的摘要，不是逐文件读字节算的。
 * 这一层保证三件事：
 *   1. 上传的字节真的落到 server/assets/，库里只存路径、大小和摘要
 *   2. 摘要是**边写边算**的（crypto.createHash 流式喂），不把大文件读进内存
 *   3. 下载返回真实字节 + Content-Disposition，不是一段 JSON
 *
 * 传输编码用裸 body（`POST /api/files?name=...`）而不是 multipart：
 * 两端都是我们自己写的，裸 body 可以直接 pipe 到磁盘、边写边算摘要，
 * 不必先把手写的 multipart 解析器写对（那是另一类容易出错的东西）。
 */

import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { extname, join, resolve } from "node:path";
import { nowIso } from "../storage/db.mjs";

/** 资产根目录：默认 server/assets，可用 MUMAI_ASSETS 覆盖（预检脚本会检查它） */
export const ASSETS_ROOT = resolve(process.env.MUMAI_ASSETS ?? "server/assets");

export function ensureAssetsRoot() {
  mkdirSync(ASSETS_ROOT, { recursive: true });
  return ASSETS_ROOT;
}

const MEDIA_BY_EXT = {
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".zip": "application/zip",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".bin": "application/octet-stream",
  ".sog": "application/octet-stream",
  ".pth": "application/octet-stream",
  ".onnx": "application/octet-stream",
};

export function mediaTypeFor(name, fallback = "application/octet-stream") {
  return MEDIA_BY_EXT[extname(name).toLowerCase()] ?? fallback;
}

function sha256OfFile(path) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolvePromise(hash.digest("hex")));
  });
}

/** 把一个可读流存成资产：边写盘边算摘要，返回 files 表要的那几个字段 */
export async function saveStream(readable, { name, mediaType, sessionId = null, uploadedBy = null, dir = null }) {
  ensureAssetsRoot();
  const id = `file-${randomUUID()}`;
  const subdir = dir ? join(ASSETS_ROOT, dir) : ASSETS_ROOT;
  mkdirSync(subdir, { recursive: true });
  const storedPath = join(subdir, `${id}${extname(name) || ""}`);

  const hash = createHash("sha256");
  let size = 0;
  readable.on("data", (chunk) => {
    hash.update(chunk);
    size += chunk.length;
  });
  await pipeline(readable, createWriteStream(storedPath));

  return {
    id,
    session_id: sessionId,
    name,
    media_type: mediaType ?? mediaTypeFor(name),
    size,
    sha256: hash.digest("hex"),
    stored_path: storedPath,
    uploaded_by: uploadedBy,
    uploaded_at: nowIso(),
  };
}

/** 由服务端自己生成的文件（演示更新包、报告、清单）走这个：内容已在内存里 */
export function saveBuffer(buffer, { name, mediaType, sessionId = null, uploadedBy = null, dir = null }) {
  ensureAssetsRoot();
  const id = `file-${randomUUID()}`;
  const subdir = dir ? join(ASSETS_ROOT, dir) : ASSETS_ROOT;
  mkdirSync(subdir, { recursive: true });
  const storedPath = join(subdir, `${id}${extname(name) || ""}`);
  writeFileSync(storedPath, buffer);
  return {
    id,
    session_id: sessionId,
    name,
    media_type: mediaType ?? mediaTypeFor(name),
    size: buffer.length,
    sha256: createHash("sha256").update(buffer).digest("hex"),
    stored_path: storedPath,
    uploaded_by: uploadedBy,
    uploaded_at: nowIso(),
  };
}

/** 登记到 files 表（保存与登记分开：生成一批文件时可以先全部落盘再一次性入库） */
export function registerFile(db, record) {
  db.prepare(
    `INSERT INTO files (id, session_id, name, media_type, size, sha256, stored_path, uploaded_by, uploaded_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(
    record.id,
    record.session_id,
    record.name,
    record.media_type,
    record.size,
    record.sha256,
    record.stored_path,
    record.uploaded_by,
    record.uploaded_at,
  );
  return record;
}

export function getFile(db, id) {
  return db.prepare("SELECT * FROM files WHERE id=?").get(id) ?? null;
}

export function listFiles(db, ids) {
  if (!ids?.length) return [];
  const placeholders = ids.map(() => "?").join(",");
  return db.prepare(`SELECT * FROM files WHERE id IN (${placeholders})`).all(...ids);
}

/** 校验磁盘上的字节与库里登记的摘要是否一致 —— 归档检查（F11）就是靠它 */
export async function verifyFile(file) {
  if (!file || !existsSync(file.stored_path)) {
    return { fileId: file?.id ?? null, name: file?.name ?? null, present: false, match: false, actualSha256: null };
  }
  const actualSha256 = await sha256OfFile(file.stored_path);
  return {
    fileId: file.id,
    name: file.name,
    present: true,
    size: statSync(file.stored_path).size,
    declaredSha256: file.sha256,
    actualSha256,
    match: actualSha256 === file.sha256,
  };
}

/** 读取一个已登记文件的内容（小文件：清单、报告、JSON） */
export function readFileText(file) {
  return readFileSync(file.stored_path, "utf8");
}

export { sha256OfFile };
