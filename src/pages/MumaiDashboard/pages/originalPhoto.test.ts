/**
 * 「打开你标记的原图」：原片数据与放大倍率（unit test）
 *
 * ── 这一组在防什么 ──────────────────────────────────────────────────
 * 剧本 ⑫ 要"打开原图并放大疑点区域"，而**没有坐标就不许放大**（文档原文）。
 * 于是有两件事会静默写坏、坏在现场：
 *   1. **数据对不上**：`annotatedPhotos.ts` 是按检出结果生成的，改错一个框、
 *      或把 URL 前缀写成 `/photos/…` 以外的东西，页面只会裂图 —— 不会报错；
 *   2. **倍率跑飞**：26 张原片的框大小差三四倍，写死一个倍率就会出现
 *      "有些图放大了还是看不清、有些图放大后整屏都是木纹"。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { ANNOTATED_PHOTOS, EVIDENCE_PHOTO_BY_COMPONENT, annotatedPhotoFor } from "./annotatedPhotos.ts";
import { ZOOM_MAX, ZOOM_MIN, ZOOM_TARGET_SPAN, zoomFactorFor } from "./originalPhotoZoom.ts";

test("原片表：27 张，URL 前缀与批次一致，摘要与尺寸齐全", () => {
  assert.equal(ANNOTATED_PHOTOS.length, 27, "照片批次里是 IMG_0421–IMG_0447 共 27 张");
  for (const photo of ANNOTATED_PHOTOS) {
    assert.match(photo.file, /^IMG_\d{4}\.jpg$/, `文件号形状不对：${photo.file}`);
    assert.equal(photo.url, `/photos/annotated/${photo.file}`, "原图走 /photos/annotated/（服务端只读映射）");
    assert.equal(photo.thumbUrl, `/photos/thumb/annotated/${photo.file}`, "缩略图走 /photos/thumb/annotated/");
    /* 批次事实：IMG_0421–0441 竖幅 3024×4032，IMG_0442–0447 横幅 4032×3024 */
    assert.ok(
      (photo.width === 3024 && photo.height === 4032) || (photo.width === 4032 && photo.height === 3024),
      `尺寸不在批次事实内：${photo.width}×${photo.height}`,
    );
    assert.equal(photo.digest.length, 16, `摘要应当是 sha256 前 16 位：${photo.digest}`);
  }
});

test("框坐标要么没有、要么是 0–1 的合法矩形（合法才允许放大）", () => {
  for (const photo of ANNOTATED_PHOTOS) {
    if (!photo.box) continue;
    const { x, y, w, h } = photo.box;
    assert.ok(x >= 0 && y >= 0 && w > 0 && h > 0, `${photo.file} 框非法：${JSON.stringify(photo.box)}`);
    assert.ok(x + w <= 1.001 && y + h <= 1.001, `${photo.file} 框越界：${JSON.stringify(photo.box)}`);
  }
  /* 批次事实：26 张有红框、1 张没有（IMG_0431）—— 没有的那张按剧本"只打开原图" */
  const without = ANNOTATED_PHOTOS.filter((photo) => !photo.box).map((photo) => photo.file);
  assert.deepEqual(without, ["IMG_0431.jpg"], `没有红框的应当是 IMG_0431：${without.join(",")}`);
});

test("四个构件都配到了原片（⑫ 打开哪一根都要有图）", () => {
  for (const component of ["Z01", "Z02", "Z03", "Z04"]) {
    const photo = annotatedPhotoFor(component);
    assert.ok(photo, `${component} 没配到原片，⑫ 那一轮会开出一个空窗口`);
    assert.ok(photo?.box, `${component} 配到的原片没有标注框，窗口只能"只打开原图"`);
  }
  assert.equal(annotatedPhotoFor("Z99"), null, "没配到的构件返回 null（界面回退成只显示记录）");
  assert.equal(annotatedPhotoFor(null), null);
  assert.equal(Object.keys(EVIDENCE_PHOTO_BY_COMPONENT).length, 4);
});

test("放大倍率：目标是让框占到画面约 42%，并夹在 1.6×–4× 之间", () => {
  assert.equal(zoomFactorFor(null), 1, "没有框就不放大（剧本原文）");
  assert.equal(zoomFactorFor({ w: 0, h: 0 }), 1, "坏数据也不放大");
  /* 小框 → 放大到上限；大框 → 至少 1.6× */
  assert.equal(zoomFactorFor({ w: 0.05, h: 0.05 }), ZOOM_MAX);
  assert.equal(zoomFactorFor({ w: 0.5, h: 0.5 }), ZOOM_MIN);
  /* 中等的框按公式（保留一位小数） */
  const mid = zoomFactorFor({ w: 0.2, h: 0.2 });
  assert.equal(mid, Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, ZOOM_TARGET_SPAN / 0.2)) * 10) / 10);
  assert.ok(mid > ZOOM_MIN && mid < ZOOM_MAX, `中等框应落在上下限之间：${mid}`);
});

test("真实批次里每一张的倍率都在上下限内（不会出现糊成一片或没放大）", () => {
  for (const photo of ANNOTATED_PHOTOS) {
    if (!photo.box) continue;
    const zoom = zoomFactorFor(photo.box);
    assert.ok(zoom >= ZOOM_MIN && zoom <= ZOOM_MAX, `${photo.file} 倍率越界：${zoom}`);
  }
});
