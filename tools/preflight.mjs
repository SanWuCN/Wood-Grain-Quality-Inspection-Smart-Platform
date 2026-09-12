/**
 * 启动预检（PRD §11）
 *
 * 演示前跑一次，把「素材在不在、服务连不连得上、数据库能不能写」一次说清，
 * 而不是等台上点按钮才发现缺文件。
 *
 * 用法：
 *   node tools/preflight.mjs            # 只检查本机文件与服务
 *   node tools/preflight.mjs --json     # 机器可读输出
 *
 * 退出码：全部通过 0，有未通过项 1（可以直接接进启动脚本）。
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { openDatabase } from "../server/storage/db.mjs";
import { ASSETS_ROOT, ensureAssetsRoot } from "../server/services/assets.mjs";
import { DEFAULT_SESSION_ID, createSession, getSession, snapshot } from "../server/services/session.mjs";
import { ensureDemoPackage, preflightDetail } from "../server/fixtures/preflight.mjs";

const asJson = process.argv.includes("--json");
const checks = [];
const add = (key, label, pass, detail) => checks.push({ key, label, pass, detail });

/* ---- 运行时 ---- */
const major = Number(process.versions.node.split(".")[0]);
add("node", "Node 运行时 ≥ 22（需要内置 node:sqlite）", major >= 22, `v${process.versions.node}`);

/* ---- 数据库与共享服务 ---- */
let db = null;
let sessionOk = false;
let packageOk = false;
let entitySummary = "—";
try {
  // 预检用临时库，绝不碰演示数据
  db = openDatabase(":memory:");
  add("sqlite", "SQLite 可读写（node:sqlite）", true, "内存库建表通过");
  if (!getSession(db, DEFAULT_SESSION_ID)) createSession(db, "chapter2", DEFAULT_SESSION_ID);
  const snap = snapshot(db, DEFAULT_SESSION_ID);
  sessionOk = Boolean(snap);
  ensureDemoPackage(db, DEFAULT_SESSION_ID);
  packageOk = true;
  entitySummary = Object.entries(snap.entities)
    .map(([kind, list]) => `${kind}:${list.length}`)
    .join(" ");
} catch (error) {
  add("sqlite", "SQLite 可读写（node:sqlite）", false, String(error?.message ?? error));
}
add("session", "演示会话可初始化", sessionOk, DEFAULT_SESSION_ID);
add("demo-package", "演示更新包可生成", packageOk, "ART-01");
if (entitySummary !== "—") add("entities", "共享实体齐备", true, entitySummary);
if (db) {
  try {
    const detail = preflightDetail(db, DEFAULT_SESSION_ID);
    for (const item of detail.items) add(item.key, item.label, item.pass, item.detail);
  } finally {
    db.close();
  }
}

/* ---- 素材 ---- */
ensureAssetsRoot();
add("assets-dir", "资产目录存在", existsSync(ASSETS_ROOT), ASSETS_ROOT);
add("scene-asset", "高斯场景资源（gs.sog）", existsSync(resolve("public/model/sog/gs.sog")), "public/model/sog/gs.sog");
add("fonts", "本地字体（断网不影响排版）", existsSync(resolve("public/fonts")), "public/fonts");
add("dist", "前端构建产物（内网演示需要）", existsSync(resolve("dist/index.html")), "dist/index.html");

/* ---- 正在跑的服务 ---- */
let serviceOk = false;
let serviceDetail = "未启动（开发时页面走 Vite 代理，也需要它）";
try {
  const response = await fetch("http://localhost:8000/api/health", { signal: AbortSignal.timeout(1500) });
  const body = await response.json();
  serviceOk = response.ok && body.ok === true;
  serviceDetail = `已连接 · 会话 ${body.sessions} 场 · 客户端 ${body.clients} 个`;
} catch {
  /* 没起就是没起，不算异常 */
}
add("service", "共享服务已在 8000 端口运行", serviceOk, serviceDetail);

/* ---- 输出 ---- */
const ok = checks.every((item) => item.pass);
if (asJson) {
  console.log(JSON.stringify({ ok, checks }, null, 2));
} else {
  console.log("木脉智检 · 启动预检\n");
  for (const item of checks) {
    console.log(`  ${item.pass ? "✓" : "✗"} ${item.label.padEnd(30, " ")} ${item.detail}`);
  }
  console.log(`\n${ok ? "全部通过，可以开始演示。" : "有未通过项 —— 逐条处理后再开始。"}`);
}
process.exit(ok ? 0 : 1);
