/**
 * 工单归档 → 知识库登记（判据回归：起真库、不起服务）
 *
 * 用户口径（2026-09-19）：「知识库查询的数据要动态拟真，我这边最后工单结束得能归档进去」。
 * 这一组盯四件事，每条都能被写坏：
 *   ① 记录文本**全部来自工单实体**（单号/地点/Z01–Z04/环境读数/配置版本/下发/日志都在），
 *      不是另写一份文案 —— 检索命中的数字必须与工单页上看到的是同一个来源；
 *   ② **空值不编数**：没录入的读数写「—」，不许写成 0；
 *   ③ 登记成知识库资产：类型 workOrder、来源「工单归档」、对象含单号与四根主体、
 *      索引状态「待更新」，并**建出索引任务**（任务只在这一条上跑）；
 *   ④ **幂等**：同一张单再归档一次 → 不新建资产，走内容版本 +1。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { openDatabase } from "../storage/db.mjs";
import { composeWorkOrderRecordText, ingestArchivedWorkOrder, workOrderAssetTitle } from "./knowledge-ingest.mjs";
import { assetContentText, countAssets, getAsset, listJobItems } from "./knowledge-store.mjs";

const SESSION = "demo-01";
const ARCHIVED_AT = "2026-09-19T12:30:00.000Z";

/** 一张走完整条链的工单详情：字段形状与 `workOrders.detailFor()` 一致 */
const detail = (overrides = {}) => ({
  order: {
    id: "wo-test-0001",
    orderNo: "WO-20260919-0001",
    title: "示例寺古建筑检测 · 四根木柱检测",
    status: "已归档",
    location: "上海市松江区示例寺院内",
    plannedStart: "2026-09-21",
    plannedEnd: "2026-09-23",
    createdAt: "2026-09-19T00:02:00.000Z",
    deliveryText: "检测记录及成果报告，2026-09-28 前提交",
    source: "shortcut",
    requirementsText: "为掌握示例寺现场木柱保存状况，现委托贵方开展现场检测。",
  },
  commission: {
    unit: "示例古建筑保护管理单位",
    date: "2026-09-19",
    projectName: "示例寺古建筑检测",
    deliveryText: "检测记录及成果报告，2026-09-28 前提交",
    contact: { role: "现场管理岗位", channel: "进场时间与资料交接由委托单位现场值班渠道联系" },
  },
  subjects: [
    { code: "Z01", name: "木柱", subjectId: "sub-1", position: null },
    { code: "Z02", name: "木柱", subjectId: "sub-2", position: null },
    { code: "Z03", name: "木柱", subjectId: "sub-3", position: null },
    { code: "Z04", name: "木柱", subjectId: "sub-4", position: null },
  ],
  environment: {
    inputs: { airTempC: 22, relativeHumidityPct: 58, windSpeedMs: 0.6, atmosphericPressureHpa: 1010 },
    pressureInput: { value: 101, unit: "kPa", hpa: 1010 },
    position: "示例寺院内四根木柱检测区域",
    measuredAt: "2026-09-19T08:17",
    updatedByLabel: "人工智能架构师",
    draftRevision: 2,
    config: {
      configVersion: "CFG-WO-20260919-0001-001",
      validatedAt: "2026-09-19T08:21:00.000Z",
      validatedByLabel: "人工智能架构师",
      methodVersion: "env-validate/2.0",
      checks: [
        { key: "airTempC", label: "温度是有限数值", ok: true, message: "当前 22 ℃" },
        { key: "airTempC.range", label: "温度在量程 -20–60 ℃ 内", ok: true, message: "当前 22 ℃" },
      ],
    },
  },
  assignment: { leaderLabel: "人工智能架构师" },
  dispatches: [
    {
      deviceId: "handheld-02",
      state: "executed",
      stateText: "扫描仪已应用",
      configVersion: "CFG-WO-20260919-0001-001",
      bundleId: "BND-20260919-0001",
      createdAt: "2026-09-19T08:30:00.000Z",
      acceptedAt: "2026-09-19T08:30:20.000Z",
      executedAt: "2026-09-19T08:30:40.000Z",
    },
  ],
  logs: [
    { at: "2026-09-19T00:02:00.000Z", actorLabel: "系统", text: "接收委托：示例古建筑保护管理单位", type: "commission" },
    { at: "2026-09-19T12:30:00.000Z", actorLabel: "人工智能架构师", text: "归档工单", type: "status" },
  ],
  ...overrides,
});

function withDb(work) {
  const dir = mkdtempSync(join(tmpdir(), "mumai-kb-"));
  const db = openDatabase(join(dir, "test.db"));
  try {
    return work(db);
  } finally {
    db.close?.();
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ *
 * ① 文本全部来自实体
 * ------------------------------------------------------------------ */

test("记录文本带上工单的每一个关键字段（检索任一字段都能定位到这一单）", () => {
  const text = composeWorkOrderRecordText(detail(), { archivedAt: ARCHIVED_AT, actorLabel: "人工智能架构师" });

  for (const needle of [
    "WO-20260919-0001",
    "示例寺古建筑检测 · 四根木柱检测",
    "上海市松江区示例寺院内",
    "2026-09-21 至 2026-09-23",
    "示例古建筑保护管理单位",
    "Z01",
    "Z04",
    "sub-4",
    "22 ℃",
    "58 %RH",
    "0.6 m/s",
    "1010 hPa",
    "原始录入 101 kPa",
    "示例寺院内四根木柱检测区域",
    "CFG-WO-20260919-0001-001",
    "env-validate/2.0",
    "handheld-02",
    "扫描仪已应用",
    "BND-20260919-0001",
    "接收委托：示例古建筑保护管理单位",
    "归档时间 2026-09-19 12:30",
  ]) {
    assert.ok(text.includes(needle), `记录文本里缺「${needle}」—— 检索会搜不到这一单`);
  }
  assert.match(text, /【检测主体】共 4 根/, "四根主体要写成一条可检索的清单");
  assert.match(text, /【校验判据】共 2 项，通过 2 项/, "校验判据要带通过数，别只写标题");
});

test("没有录入的读数写「—」，不编成 0", () => {
  const blank = detail();
  blank.environment = {
    ...blank.environment,
    inputs: { airTempC: null, relativeHumidityPct: null, windSpeedMs: 0, atmosphericPressureHpa: null },
    pressureInput: null,
  };
  const text = composeWorkOrderRecordText(blank, { archivedAt: ARCHIVED_AT, actorLabel: "人工智能架构师" });

  assert.match(text, /温度 —/, "没录入的温度必须写「—」");
  assert.match(text, /大气压 —/, "没录入的气压必须写「—」");
  assert.match(text, /风速 0 m\/s/, "风速 0 是有效读数，要如实写 0");
  assert.ok(!text.includes("null"), "文本里不得出现 null");
  assert.ok(!text.includes("undefined"), "文本里不得出现 undefined");
});

/* ------------------------------------------------------------------ *
 * ③ 登记成资产 + 建索引任务
 * ------------------------------------------------------------------ */

test("归档登记：资产类型/来源/对象/索引状态都对，并建出一条只跑它的索引任务", () => {
  withDb((db) => {
    const result = ingestArchivedWorkOrder(db, SESSION, {
      detail: detail(),
      actorId: "shi",
      actorLabel: "人工智能架构师",
      archivedAt: ARCHIVED_AT,
    });

    assert.equal(result.created, true, "第一次归档应当新建资产");
    assert.equal(result.revision, 1);
    assert.ok(result.assetId.startsWith("KA-W-"), `工单类资产的编号应当是 KA-W-…，实际 ${result.assetId}`);
    assert.ok(result.jobId, "登记后必须建出索引任务（否则新记录检索不到）");

    const asset = getAsset(db, SESSION, result.assetId);
    assert.equal(asset.type, "workOrder");
    assert.equal(asset.title, workOrderAssetTitle(detail().order));
    assert.equal(asset.sourceSystem, "平台工单");
    assert.equal(asset.mainSource, "工单归档");
    assert.equal(asset.sourceEntityId, "wo-test-0001", "source_entity_id 必须是工单内部 id（幂等靠它）");
    assert.equal(asset.indexState, "处理中", "建了索引任务后由任务占用（处理中）—— 任务发布后才会变成已建立索引");
    assert.equal(asset.availability, "可用");
    assert.ok(asset.objectIds.includes("WO-20260919-0001"), "对象编号要含单号");
    for (const code of ["Z01", "Z02", "Z03", "Z04"]) {
      assert.ok(asset.objectIds.includes(code), `对象编号要含 ${code}`);
    }
    assert.deepEqual(asset.businessCategories, ["工单记录", "归档记录"]);

    /* 索引任务只处理这一条 */
    const items = listJobItems(db, SESSION, result.jobId);
    assert.equal(items.length, 1, "归档一张单不该把整个 backlog 卷进同一个任务");
    assert.equal(items[0].assetId, result.assetId);

    /* 落库的正文与现算的一致 */
    assert.equal(assetContentText(db, SESSION, result.assetId), composeWorkOrderRecordText(detail(), {
      archivedAt: ARCHIVED_AT,
      actorLabel: "人工智能架构师",
    }));
  });
});

/* ------------------------------------------------------------------ *
 * ④ 幂等
 * ------------------------------------------------------------------ */

test("同一张单再归档一次：不新建资产，内容版本 +1", () => {
  withDb((db) => {
    const first = ingestArchivedWorkOrder(db, SESSION, { detail: detail(), actorId: "shi", archivedAt: ARCHIVED_AT });
    const before = countAssets(db, SESSION, {});

    const second = ingestArchivedWorkOrder(db, SESSION, {
      detail: detail({ logs: [...detail().logs, { at: "2026-09-19T13:00:00.000Z", actorLabel: "人工智能架构师", text: "补充归档", type: "status" }] }),
      actorId: "shi",
      archivedAt: "2026-09-19T13:00:00.000Z",
    });

    assert.equal(second.assetId, first.assetId, "同一张单必须落到同一个资产上");
    assert.equal(second.created, false, "第二次不该新建资产");
    assert.equal(second.revision, 2, "内容变化应当走版本 +1（老版本继续服务）");
    assert.equal(countAssets(db, SESSION, {}), before, "资产总数不该增加");
    assert.ok(assetContentText(db, SESSION, first.assetId).includes("补充归档"), "正文要换成新的那一版");
    assert.ok(second.jobId, "新版内容同样要建索引任务");
  });
});
