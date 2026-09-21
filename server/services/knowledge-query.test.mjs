/**
 * 语料装载（检索的入口）回归
 *
 * 背景（2026-10-01 现场）：小木第①轮把评委带到「检索验证」页后，页面一直显示
 * 「正在检索 · 索引可能正在更新」。实测是新服务版本发布后的**第一次检索要 22–24 秒** ——
 * 时间全在 `loadCorpus` 那条 `final JOIN knowledge_chunks JOIN knowledge_assets` 上：
 * 执行计划里两个 join 都只用到 `session_id`，等于**每个成员行扫一遍全表**（18,048²）。
 * 拆成「资产白名单 / 快照成员 / 按主键分批取正文」三步后，同一份数据 24 秒 → 约 240 ms。
 *
 * 这一组盯三件事，每一条都是改写时最容易丢的语义：
 *   ① 装载出来的分块**就是**当前服务版本里那几条（数量与 `servingChunkCounts` 对得上，
 *      两份实现交叉验证 —— 我改的正是其中一份）；
 *   ② 语料里能搜到刚归档的那张工单，且命中的资产就是它（链路端到端还通）；
 *   ③ 资产被软删之后，重装语料**不再**包含它（原来那条 JOIN 的 `a.deleted_at IS NULL`
 *      就是这个作用，拆三步时最容易漏）。
 * 另加一条静态守卫：`knowledge-query.mjs` 里不许再出现那条病态 join。
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { openDatabase } from "../storage/db.mjs";
import { ingestArchivedWorkOrder } from "./knowledge-ingest.mjs";
import { advanceJob } from "./knowledge-jobs.mjs";
import { loadCorpus, searchKnowledge } from "./knowledge-query.mjs";
import { currentServingVersion, servingChunkCounts } from "./knowledge-store.mjs";
import { invalidateCorpus } from "./knowledge-index-demo.mjs";

const SESSION = "demo-01";
const PROJECT = "project-example-temple";

/** 一张最小但完整的工单详情（字段名与 `workOrders.detailFor()` 一致） */
const detail = () => ({
  order: {
    id: "wo-corpus-0001",
    orderNo: "WO-20260921-0001",
    title: "示例寺古建筑检测 · 四根木柱检测",
    status: "已归档",
    location: "上海市松江区示例寺院内",
    plannedStart: "2026-09-21",
    plannedEnd: "2026-09-23",
    createdAt: "2026-09-21T00:02:00.000Z",
    deliveryText: "检测记录及成果报告，2026-09-28 前提交",
    source: "shortcut",
    requirementsText: "为掌握示例寺现场木柱保存状况，现委托贵方开展现场检测。",
  },
  commission: { unit: "示例古建筑保护管理单位", date: "2026-09-21", contact: { role: "现场管理岗位", channel: "现场值班渠道" } },
  subjects: [{ code: "Z04", name: "木柱", subjectId: "sub-4", position: null }],
  environment: { inputs: { airTempC: 22, relativeHumidityPct: 58, windSpeedM3: 0.6 }, position: "示例寺院内", measuredAt: "2026-09-21T08:17" },
  devices: [],
  logs: [{ at: "2026-09-21T12:30:00.000Z", actorLabel: "人工智能架构师", text: "归档工单", type: "status" }],
});

function withDb(work) {
  const dir = mkdtempSync(join(tmpdir(), "mumai-corpus-"));
  const db = openDatabase(join(dir, "test.db"));
  try {
    return work(db);
  } finally {
    db.close?.();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 归档登记 → 推进索引任务到终态（发布新服务版本） */
function ingestAndIndex(db, workDetail = detail()) {
  const registered = ingestArchivedWorkOrder(db, SESSION, {
    detail: workDetail,
    actorId: "shi",
    actorLabel: "人工智能架构师",
  });
  const jobId = registered.jobId;
  assert.ok(jobId, "归档之后应当建出索引任务");
  let job = null;
  for (let step = 0; step < 40; step += 1) {
    advanceJob(db, SESSION, jobId);
    job = db.prepare("SELECT status, target_version AS targetVersion FROM knowledge_jobs WHERE session_id=? AND id=?").get(SESSION, jobId);
    if (["成功", "部分成功", "失败", "已取消"].includes(job?.status)) break;
  }
  assert.equal(job?.status, "成功", `索引任务没跑成功：${job?.status}`);
  invalidateCorpus(SESSION);
  return registered;
}

test("语料里的分块数与该服务版本的有效分块数一致（两份实现交叉验证）", () => {
  withDb((db) => {
    ingestAndIndex(db);
    const serving = currentServingVersion(db, SESSION);
    const corpus = loadCorpus(db, SESSION, { projectId: PROJECT });
    const counts = servingChunkCounts(db, SESSION, serving, PROJECT);

    assert.ok(corpus.chunks.length > 0, "装出来的语料不能是空的（否则检索永远无命中）");
    assert.equal(
      corpus.chunks.length,
      counts.total,
      `语料分块数 ${corpus.chunks.length} 与有效分块数 ${counts.total} 对不上 —— 两份实现的语义漂了`,
    );
    for (const chunk of corpus.chunks) {
      assert.ok(chunk.text && chunk.text.length > 0, "分块正文不能是空的");
      assert.ok(chunk.assetId, "每个分块都要带来源资产（检索结果要能点开）");
      assert.equal(typeof chunk.locator, "object", "locator 要解析成对象（原文定位用）");
    }
  });
});

test("刚归档的工单能被检索到，命中的就是它（端到端还通）", () => {
  withDb((db) => {
    const { assetId } = ingestAndIndex(db);
    const result = searchKnowledge(db, SESSION, { query: "工单归档 检测主体 Z04", projectId: PROJECT, topK: 5 });
    assert.ok(result.hits.length > 0, "刚归档的工单检索不到 —— 语料装载这一步断了");
    assert.ok(
      result.hits.some((hit) => hit.assetId === assetId),
      `命中的资产里没有刚归档的那一张（命中：${result.hits.map((hit) => hit.assetId).join("、")}）`,
    );
  });
});

test("资产被软删之后重装语料不再包含它（原来那条 JOIN 的 deleted_at 条件）", () => {
  withDb((db) => {
    const { assetId } = ingestAndIndex(db);
    const before = loadCorpus(db, SESSION, { projectId: PROJECT });
    assert.ok(before.chunks.some((chunk) => chunk.assetId === assetId), "软删之前应当在语料里");

    db.prepare("UPDATE knowledge_assets SET deleted_at=? WHERE session_id=? AND id=?").run("2026-09-21T13:00:00.000Z", SESSION, assetId);
    invalidateCorpus(SESSION);
    const after = loadCorpus(db, SESSION, { projectId: PROJECT });
    assert.ok(
      !after.chunks.some((chunk) => chunk.assetId === assetId),
      "软删之后语料里不该再有它的分块",
    );
  });
});

test("静态守卫：不许再写成那条病态 join（final 直接 JOIN knowledge_chunks）", () => {
  /*
    这条不是"防手滑"，是防**性能回归**：那条 join 在 18k 成员上会被规划成
    "每个成员行扫一遍分块表"，而且是**静默**的（结果完全正确，只是 24 秒）。
    正确的做法是先把快照成员取出来、再按主键分批取正文（见 loadCorpus 里的注释）。
  */
  const source = readFileSync(new URL("./knowledge-query.mjs", import.meta.url), "utf8");
  /* 先剥掉注释再判：`loadCorpus` 的说明里就要拿那条 join 当反面例子写出来 */
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  assert.ok(
    !/JOIN\s+knowledge_chunks/i.test(code),
    "knowledge-query.mjs 里又出现了「JOIN knowledge_chunks」—— 请改回按主键分批取（loadCorpus 的注释里有实测数据）",
  );
});
