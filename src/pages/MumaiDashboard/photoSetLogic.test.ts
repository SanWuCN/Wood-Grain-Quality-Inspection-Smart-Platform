import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MAPPING_CSV_URL,
  POSITION_LABEL,
  annotatedOverlap,
  annotatedUrl,
  filterMapping,
  groupBySource,
  pageSlice,
  parsePhotoMapping,
  processedUrl,
  sourceRange,
  summarizePhotoSet,
} from "./photoSetLogic.ts";

/** 用户给的对照表原件（按字节原样放进 public；用 sha256 钉住，改一个字节就红） */
const CSV_FILE = new URL("../../../public/photo-batch-20260922/mapping.csv", import.meta.url);
const CSV_SHA256 = "ce882778788ec0ee113afc862035234d9f50efdcd3e2eef34e89ad0955a11498";
const csvText = readFileSync(CSV_FILE, "utf8");

test("对照表是用户原件：sha256 未改，1,312 行 = 328 张源照片 × 4 个位号", () => {
  assert.equal(createHash("sha256").update(readFileSync(CSV_FILE)).digest("hex"), CSV_SHA256);

  const { rows, errors } = parsePhotoMapping(csvText);
  assert.deepEqual(errors, [], "原件不该有解析不了的行");
  assert.equal(rows.length, 1312);

  const summary = summarizePhotoSet(rows);
  assert.equal(summary.sourceCount, 328);
  assert.deepEqual(summary.byPosition.map((item) => item.count), [328, 328, 328, 328]);
  assert.deepEqual(summary.byPosition.map((item) => item.label), ["左上", "右上", "左下", "右下"]);
  assert.deepEqual(summary.incomplete, [], "每张源照片都应切出四块");
  assert.equal(sourceRange(rows), "IMG_0467–IMG_0794");
});

test("处理后影像与对照表一一对应：编号连续、文件名唯一", () => {
  const { rows } = parsePhotoMapping(csvText);
  const names = rows.map((row) => row.newName);

  assert.equal(new Set(names).size, names.length, "新文件名不能重复");
  /* 编号从 00001 起连号到 01312（sxs20260922 + 5 位序号） */
  assert.deepEqual(
    [...names].sort(),
    Array.from({ length: 1312 }, (_, i) => `sxs20260922${String(i + 1).padStart(5, "0")}.jpg`),
  );
  assert.ok(rows.every((row) => /^IMG_\d+_\d\.jpg$/.test(row.oldName)), "原文件名形如 IMG_0481_4.jpg");
  assert.ok(rows.every((row) => /^IMG_\d+\.HEIC$/.test(row.source)), "源照片形如 IMG_0481.HEIC");
  assert.ok(
    rows.every((row) => row.oldName === `${row.source.replace(/\.HEIC$/, "")}_${row.pos}.jpg`),
    "原文件名 = 源照片编号 + 位号",
  );
});

test("四宫格：按位号排序、每张源照片刚好四块，位号与方位标注固定", () => {
  const { rows } = parsePhotoMapping(csvText);
  const groups = groupBySource(rows);

  assert.equal(groups.length, 328);
  for (const group of groups.slice(0, 25)) {
    assert.deepEqual(group.crops.map((crop) => crop.pos), [1, 2, 3, 4], `${group.source} 位号不齐`);
  }
  assert.deepEqual(POSITION_LABEL, { 1: "左上", 2: "右上", 3: "左下", 4: "右下" });
  /* 位号不按编号相邻：拼回原构图必须照位号摆，不能照编号顺序摆 */
  const first = groups.find((group) => group.source === "IMG_0766.HEIC");
  assert.deepEqual(first?.crops.map((crop) => crop.newName), [
    "sxs2026092200001.jpg",
    "sxs2026092200251.jpg",
    "sxs2026092201084.jpg",
    "sxs2026092201098.jpg",
  ]);
});

test("搜索与分页：新编号 / 原文件名 / 源照片都能搜，页码越界夹回有效页", () => {
  const { rows } = parsePhotoMapping(csvText);

  /* IMG_0766 的四块：源照片字段是 IMG_0766.HEIC、原文件名是 IMG_0766_N.jpg，两边都能搜到 */
  assert.deepEqual(filterMapping(rows, "IMG_0766").map((row) => row.pos), [1, 2, 3, 4]);
  assert.equal(filterMapping(rows, "img_0766_2").length, 1, "大小写不敏感");
  assert.equal(filterMapping(rows, "sxs2026092200001.jpg").length, 1);
  assert.equal(filterMapping(rows, "  ").length, rows.length, "空关键词不过滤");

  const page = pageSlice(rows, 1, 40);
  assert.equal(page.total, 1312);
  assert.equal(page.pages, 33);
  assert.equal(page.items.length, 40);
  assert.deepEqual(pageSlice(rows, 33, 40).items.length, 32);
  assert.equal(pageSlice(rows, 999, 40).page, 33, "越界夹到最后一页");
  assert.equal(pageSlice(rows, -5, 40).page, 1);
});

test("素材地址走服务端挂载前缀；已标注原片与对照表无交集（不硬配对）", () => {
  assert.equal(processedUrl("sxs2026092200001.jpg"), "/photos/processed/sxs2026092200001.jpg");
  assert.equal(processedUrl("sxs2026092200001.jpg", { thumb: true }), "/photos/thumb/processed/sxs2026092200001.jpg");
  assert.equal(annotatedUrl("IMG_0421.jpg"), "/photos/annotated/IMG_0421.jpg");
  assert.equal(annotatedUrl("IMG_0421.jpg", { thumb: true }), "/photos/thumb/annotated/IMG_0421.jpg");
  assert.equal(MAPPING_CSV_URL, "/photo-batch-20260922/mapping.csv");

  const { rows } = parsePhotoMapping(csvText);
  /* 真实素材目录里的 27 张已标注原片（编号区间 IMG_0421–IMG_0447） */
  const annotated = readdirSync(new URL("../../../public/photo-batch-20260922", import.meta.url))
    .filter((name) => name.endsWith(".csv"));
  assert.deepEqual(annotated, ["mapping.csv"], "public 里只放对照表那一份数据");

  const imgs = Array.from({ length: 27 }, (_, i) => `IMG_0${421 + i}.jpg`);
  assert.deepEqual(annotatedOverlap(rows, imgs), [], "IMB_0421–0447 不在对照表的源照片区间内");
  assert.deepEqual(annotatedOverlap(rows, ["IMG_0766.jpg"]), ["IMG_0766.jpg"], "真在同一批时要能认出来");
});

test("解析容错：坏行进 errors 而不是被静默丢掉", () => {
  const text = [
    "新文件名,原文件名,源照片,位置(1左上 2右上 3左下 4右下)",
    "sxs2026092200001.jpg,IMG_0766_1.jpg,IMG_0766.HEIC,1",
    "sxs2026092200002.jpg,IMG_0782_2.jpg,IMG_0782.HEIC,9",
    "缺字段的一行",
    "sxs2026092200001.jpg,IMG_0766_1.jpg,IMG_0766.HEIC,1",
    "sxs2026092200003.jpg,IMG_0481_4.jpg,IMG_0481.HEIC,4",
  ].join("\n");

  const { rows, errors } = parsePhotoMapping(text);
  assert.deepEqual(rows.map((row) => row.newName), ["sxs2026092200001.jpg", "sxs2026092200003.jpg"]);
  assert.equal(errors.length, 3);
  assert.match(errors[0], /位号|不合法/);
  assert.match(errors[1], /字段数/);
  assert.match(errors[2], /重复/);
});
