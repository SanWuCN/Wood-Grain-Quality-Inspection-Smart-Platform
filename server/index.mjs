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
import { createDeviceGateway } from "./services/device-gateway.mjs";
import { createWorkOrderService } from "./services/work-orders.mjs";
import { createUploadService } from "./services/uploads.mjs";
import { createBleBridge } from "./services/ble-bridge.mjs";
import { DEFAULT_SESSION_ID, createSession, getSession, listSessions, snapshot } from "./services/session.mjs";
import { ASSETS_ROOT, ensureAssetsRoot } from "./services/assets.mjs";
import { ensureDemoPackage } from "./fixtures/preflight.mjs";
import { ensureArchive } from "./fixtures/archive.mjs";
import { installKnowledgeFixture } from "./services/knowledge-store.mjs";
import { ensureSampleFiles } from "./fixtures/knowledge-samples.mjs";
import { createJobRunner } from "./services/knowledge-jobs.mjs";
import { appendEvent } from "./services/session.mjs";

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
  /*
    数据与知识中心：安装 knowledge-demo-v1 夹具，并给可深入展示样本补上真实文件。
    只在没有种子记录时安装 —— 演示中被改过的数据不会被启动流程覆盖（PRD §11.2）。
  */
  const knowledgeReport = installKnowledgeFixture(db, { sessionId });
  const knowledgeSamples = ensureSampleFiles(db, sessionId);

  const server = createServer();
  /*
    upgrade 由这里统一分发：浏览器事件通道 `/ws` 与设备通道 `/ws/devices/{id}`
    共用同一个端口（终端只能配一个 platform_url，不能为它单开端口）。
    顺序敏感 —— 设备通道先试，命中就结束；两个通道都不认才断开。
  */
  const hub = createHub({ server, db, noServer: true });
  const devices = createDeviceGateway({ db, sessionId });
  server.on("upgrade", (request, socket, head) => {
    if (devices.handleUpgrade(request, socket, head)) return;
    if (hub.handleUpgrade(request, socket, head)) return;
    socket.destroy();
  });
  const bridge = createBleBridge(db);
  const log = quiet ? () => {} : (...args) => console.log(...args);
  /*
    工单域（PRD-工单指派与扫描仪下发-v1.0）：快捷键触发建单、指派、按单环境版本与整包下发。
    它要借设备网关把命令推给扫描仪，所以放在 devices 之后创建；没有网关时读取与建单照样可用。
  */
  const workOrders = createWorkOrderService({ db, hub, devices, sessionId });
  /* 交付平台批次 B：文件分片上传与批次清单（终端侧契约） */
  const uploads = createUploadService({ db });
  /*
    知识索引任务调度器：命令总线只负责建立任务与广播 started 事件，
    真正的阶段推进在 runner 里按 tick 进行。这样「启动更新」是一个幂等的写命令，
    而进度是服务端按完成记录数算出来的，不由前端计时器伪造（PRD §9.3）。
  */
  const knowledgeRunner = createJobRunner({ db, sessionId, hub, logger: { log, error: console.error } });
  const handle = createApi({
    db,
    hub,
    bridge,
    devices,
    workOrders,
    uploads,
    staticRoot: staticDir ? resolve(staticDir) : null,
    knowledgeRunner,
  });
  server.on("request", handle);

  return new Promise((resolvePromise) => {
    server.listen(port, host, () => {
      const actualPort = server.address().port;
      bridge.ready(`http://127.0.0.1:${actualPort}`);
      log(`木脉智检 · 共享服务已启动`);
      log(`  HTTP      http://${host === "0.0.0.0" ? "localhost" : host}:${actualPort}/api`);
      log(`  WebSocket ws://${host === "0.0.0.0" ? "localhost" : host}:${actualPort}/ws`);
      log(`  设备通道  ws://${host === "0.0.0.0" ? "localhost" : host}:${actualPort}/ws/devices/{deviceId}`);
      log(`  设备网关  令牌 ${devices.status().tokens} 组 · 已登记 ${devices.status().devices} 台 · 在线 ${devices.status().online} 台`);
      log(`  会话      ${sessionId}（共 ${listSessions(db).length} 场）`);
      log(`  数据库    ${dbFile}`);
      log(`  资产目录  ${ASSETS_ROOT}${packReport.created ? "（本次补齐了演示更新包）" : ""}`);
      log(`  归档清单  ${archiveReport.count} 项${archiveReport.created ? "（本次补齐了真实文件）" : ""}`);
      log(
        `  知识中心  ${knowledgeReport.created ? "已安装 " : "沿用 "}${knowledgeReport.scenarioId}`
          + `（资产 ${knowledgeReport.report?.assets ?? 0} · 分块 ${knowledgeReport.report?.chunks ?? 0}`
          + ` · 可打开样本 ${knowledgeSamples.created} 项）`,
      );
      if (staticDir) log(`  静态托管  ${resolve(staticDir)}`);
      resolvePromise({
        server,
        db,
        hub,
        devices,
        sessionId,
        port: actualPort,
        url: `http://localhost:${actualPort}`,
        close: () =>
          new Promise((done) => {
            knowledgeRunner.stopAll();
            bridge.close();
            devices.close();
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
