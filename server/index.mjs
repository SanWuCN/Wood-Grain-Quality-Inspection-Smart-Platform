/**
 * 木脉智检 · 共享服务（单进程：HTTP + WebSocket + 可选静态托管）
 *
 * 启动：
 *   node server/index.mjs                     # 只提供 /api 与 /ws（开发用，页面走 Vite）
 *   node server/index.mjs --static dist       # 连前端构建一起提供（内网演示用）
 *   node server/index.mjs --db :memory:       # 内存库，用于预检与自测
 *
 * 环境变量：
 *   MUMAI_PORT    默认 8000（PRD §5.3 的示例端口）
 *   MUMAI_HOST    默认 0.0.0.0，让四台电脑都能连
 *   MUMAI_DB      默认 server/data/mumai.db
 *   MUMAI_ASSETS  默认 server/assets
 *   MUMAI_SECRET  令牌签名密钥；不设则每次启动随机（重启后需重新登录）
 *   MUMAI_SESSION 默认演示会话 id，默认 demo-01
 */

import { createServer } from "node:http";
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "./storage/db.mjs";
import { createApi } from "./api/http.mjs";
import { createHub } from "./services/hub.mjs";
import { createBleBridge } from "./services/ble-bridge.mjs";
import { DEFAULT_SESSION_ID, createSession, getSession, listSessions, snapshot } from "./services/session.mjs";
import { ASSETS_ROOT, ensureAssetsRoot } from "./services/assets.mjs";
import { ensureDemoPackage } from "./fixtures/preflight.mjs";
import { ensureArchive } from "./fixtures/archive.mjs";

export function startService({
  port = Number(process.env.MUMAI_PORT ?? 8000),
  host = process.env.MUMAI_HOST ?? "0.0.0.0",
  dbFile = process.env.MUMAI_DB ?? resolve("server/data/mumai.db"),
  staticDir = null,
  sessionId = DEFAULT_SESSION_ID,
  quiet = false,
} = {}) {
  const db = openDatabase(dbFile);
  ensureAssetsRoot();

  // 开场会话：没有就建一个，保证四端一连上就有同一份状态
  if (!getSession(db, sessionId)) createSession(db, "chapter2", sessionId);
  const packReport = ensureDemoPackage(db, sessionId);
  // 归档清单的真实文件（评审 F11）：缺了就补齐，已有的一律不动
  const archiveReport = ensureArchive(db, sessionId);

  const server = createServer();
  const hub = createHub({ server, db });
  const bridge = createBleBridge(db);
  const handle = createApi({ db, hub, bridge, staticRoot: staticDir ? resolve(staticDir) : null });
  server.on("request", handle);

  const log = quiet ? () => {} : (...args) => console.log(...args);

  return new Promise((resolvePromise) => {
    server.listen(port, host, () => {
      const actualPort = server.address().port;
      bridge.ready(`http://127.0.0.1:${actualPort}`);
      log(`木脉智检 · 共享服务已启动`);
      log(`  HTTP      http://${host === "0.0.0.0" ? "localhost" : host}:${actualPort}/api`);
      log(`  WebSocket ws://${host === "0.0.0.0" ? "localhost" : host}:${actualPort}/ws`);
      log(`  会话      ${sessionId}（共 ${listSessions(db).length} 场）`);
      log(`  数据库    ${dbFile}`);
      log(`  资产目录  ${ASSETS_ROOT}${packReport.created ? "（本次补齐了演示更新包）" : ""}`);
      log(`  归档清单  ${archiveReport.count} 项${archiveReport.created ? "（本次补齐了真实文件）" : ""}`);
      if (staticDir) log(`  静态托管  ${resolve(staticDir)}`);
      resolvePromise({
        server,
        db,
        hub,
        sessionId,
        port: actualPort,
        url: `http://localhost:${actualPort}`,
        close: () =>
          new Promise((done) => {
            bridge.close();
            hub.close();
            server.close(() => {
              db.close();
              done();
            });
            // Long-lived desktop streams must not keep a shutdown waiting indefinitely.
            server.closeAllConnections();
          }),
      });
    });
  });
}

/** 预检：启动脚本与 /api/health 共用（PRD §11「启动脚本检查端口、数据库、素材、索引」） */
export function runPreflight({ dbFile = process.env.MUMAI_DB ?? resolve("server/data/mumai.db") } = {}) {
  const checks = [];
  const push = (key, label, pass, detail) => checks.push({ key, label, pass, detail });

  push("node", "Node 运行时", Number(process.versions.node.split(".")[0]) >= 22, `v${process.versions.node}`);
  push("db-dir", "数据库目录可写", (() => {
    try {
      openDatabase(dbFile).close();
      return true;
    } catch (error) {
      return false;
    }
  })(), dbFile);
  push("assets", "资产目录已就绪", existsSync(ASSETS_ROOT), ASSETS_ROOT);
  push("static", "前端构建产物存在", existsSync(resolve("dist/index.html")), "dist/index.html");
  push("sog", "高斯场景资源存在", existsSync(resolve("public/model/sog/gs.sog")), "public/model/sog/gs.sog");
  push("fonts", "本地字体已打包", existsSync(resolve("public/fonts")), "public/fonts");
  return { checks, ok: checks.every((item) => item.pass) };
}

/* 直接运行：node server/index.mjs（被 import 时不要自动起服务） */
const isMain = (() => {
  if (typeof process.argv[1] !== "string") return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isMain) {
  const staticArgIndex = process.argv.indexOf("--static");
  const dbArgIndex = process.argv.indexOf("--db");
  startService({
    staticDir: staticArgIndex >= 0 ? process.argv[staticArgIndex + 1] : null,
    dbFile: dbArgIndex >= 0 ? process.argv[dbArgIndex + 1] : undefined,
  }).then((service) => {
    let stopping = false;
    const shutdown = async () => {
      if (stopping) return;
      stopping = true;
      const deadline = setTimeout(() => process.exit(1), 4000);
      deadline.unref();
      await service.close();
      clearTimeout(deadline);
      process.exit(0);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    const snap = snapshot(service.db, service.sessionId);
    console.log(`  实体      ${Object.entries(snap.entities).map(([kind, list]) => `${kind}:${list.length}`).join(" ")}`);
  });
}
