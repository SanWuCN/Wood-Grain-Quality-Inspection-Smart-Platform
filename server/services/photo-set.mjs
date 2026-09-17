/**
 * 照片处理批次 · 素材挂载（用户 2026-09-22 给的「处理」包）
 *
 * ── 为什么走服务端挂载，而不是塞进 public/ ─────────────────────────
 * 用户给的是**真素材**：1,312 张处理后影像（1512×2016，共 ~370 MB）+ 27 张已标注原片
 * （3024×4032，共 ~56 MB）。放进 `public/` 会同时进 git 与每次构建的 dist 拷贝，
 * 仓库和构建都受不了；所以素材留在**工作区磁盘**上，由平台服务按 URL 前缀映射出去：
 *
 *   /photos/processed/<新文件名>         → <root>/处理完毕/<新文件名>
 *   /photos/annotated/<IMG_xxxx.jpg>     → <root>/已标注照片/<IMG_xxxx.jpg>
 *   /photos/thumb/processed/<新文件名>   → <root>/缩略图/处理完毕/<新文件名>
 *   /photos/thumb/annotated/<IMG_xxxx>   → <root>/缩略图/已标注照片/<IMG_xxxx>
 *
 * URL 段全用 ASCII（目录名是中文，只在磁盘上），因此不存在百分号编码的坑；
 * 文件名本身也是 ASCII（`sxs2026092200001.jpg` / `IMG_0421.jpg`）。
 *
 * ── 与 staticRoot 的关系 ──────────────────────────────────────────
 * 前端构建产物仍在 `dist`（`serveStatic`）；这里是**另一份**只读素材，
 * 两者都在 8000 这一个服务上，所以内网别的机器打开页面照样能看图（不走本机文件系统）。
 */

import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve, extname, basename } from "node:path";

/** 素材根目录可用环境变量换（换机器 / 换批次时不用改代码） */
export const PHOTO_DIR_ENV = "MUMAI_PHOTO_DIR";
export const DEFAULT_PHOTO_ROOT = "D:\\平台\\数据集-照片处理-20260922";

/** URL 段 → 磁盘子目录（顺序敏感：thumb 要在前面判） */
const MOUNTS = [
  { prefix: "/photos/thumb/processed/", dir: ["缩略图", "处理完毕"] },
  { prefix: "/photos/thumb/annotated/", dir: ["缩略图", "已标注照片"] },
  { prefix: "/photos/processed/", dir: ["处理完毕"] },
  { prefix: "/photos/annotated/", dir: ["已标注照片"] },
];

const IMAGE_TYPES = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png" };

/** 只允许 ASCII 文件名 + 已知图片后缀（挡目录穿越与奇怪后缀） */
function safeName(name) {
  if (!name || name.length > 120) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return null;
  if (name.startsWith(".") || name.includes("..")) return null;
  if (!IMAGE_TYPES[extname(name).toLowerCase()]) return null;
  return name;
}

function countImages(dir) {
  try {
    return readdirSync(dir).filter((name) => IMAGE_TYPES[extname(name).toLowerCase()]).length;
  } catch {
    return 0;
  }
}

function listImages(dir) {
  try {
    return readdirSync(dir)
      .filter((name) => IMAGE_TYPES[extname(name).toLowerCase()])
      .sort();
  } catch {
    return [];
  }
}

export function createPhotoSet({ root = process.env[PHOTO_DIR_ENV] ?? DEFAULT_PHOTO_ROOT } = {}) {
  const base = resolve(root);
  const dirOf = (...parts) => join(base, ...parts);

  return {
    root: base,

    /**
     * 处理一个 /photos/* 请求。返回 true 表示这条请求已经由本模块回应。
     *
     * 素材不存在时如实回 404（而不是 SPA 兜底回一张 HTML）—— 页面靠
     * `/api/photo-set` 的 `available` 决定要不要贴图，真缺文件就是缺，别糊。
     */
    serve(req, res, pathname) {
      if (!pathname.startsWith("/photos/")) return false;
      if (req.method !== "GET" && req.method !== "HEAD") return false;

      const mount = MOUNTS.find((item) => pathname.startsWith(item.prefix));
      const raw = mount ? pathname.slice(mount.prefix.length) : "";
      const name = safeName(decodeURIComponent(raw));
      const file = name && mount ? dirOf(...mount.dir, name) : null;
      if (!file || !file.startsWith(base) || !existsSync(file) || !statSync(file).isFile()) {
        res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ code: "PHOTO_NOT_FOUND", message: "素材文件不存在", path: pathname }));
        return true;
      }

      const stat = statSync(file);
      res.writeHead(200, {
        "content-type": IMAGE_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
        "content-length": stat.size,
        /* 素材是"一批到底"的，可以长缓存；改批次就换目录 */
        "cache-control": "public, max-age=86400",
      });
      if (req.method === "HEAD") res.end();
      else createReadStream(file).pipe(res);
      return true;
    },

    /**
     * 素材可用性与计数（页面据此决定"贴图 / 提示未挂载"）。
     * 一律**现读磁盘**：素材是外面放进去的，缓存一份计数只会在换批次后骗人。
     */
    status() {
      const processedDir = dirOf("处理完毕");
      const annotatedDir = dirOf("已标注照片");
      const processed = countImages(processedDir);
      const annotated = listImages(annotatedDir);
      const thumbs =
        countImages(dirOf("缩略图", "处理完毕")) > 0 || countImages(dirOf("缩略图", "已标注照片")) > 0;
      return {
        available: processed > 0,
        root: base,
        csv: existsSync(dirOf("原文件名对照表.csv")),
        processed,
        annotatedCount: annotated.length,
        annotated,
        thumbs,
        /** 页面把这几条原样念给现场人听（缺素材时知道去哪儿放） */
        expect: {
          processedDir,
          annotatedDir: basename(annotatedDir),
          env: PHOTO_DIR_ENV,
        },
      };
    },
  };
}
