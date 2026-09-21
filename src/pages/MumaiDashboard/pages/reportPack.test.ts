/**
 * 成果质量报告 · 登记表与实体文件的一致性（纯数据 + 磁盘核对，不起 DOM）
 *
 * 这一组防的是**报告入口指着一个不存在的文件**：
 * 用户口径（2026-10-02）「作为高斯泼溅的报告，是给项目经理看的，放在数字孪生那块」，
 * 入口做在页面上很容易，难的是"点开真的能打开"——
 * · 文件必须真的在 `public/reports/` 里（而且要被 build 拷进 dist）；
 * · `href` 里的百分号编码必须解得回原始文件名（服务端是不是解码我们管不着，
 *   但**地址与文件名必须对得上**，否则 404 现场才发现）；
 * · 展示用的字节数、日期不能与文件本身矛盾。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { DELIVERY_REPORTS, GAUSSIAN_REPORT } from "./reportPack.ts";

/* 从 `src/pages/MumaiDashboard/pages/` 回到仓库根：四级上跳（与 photoSetLogic.test.ts 同一套写法） */
const REPORTS_DIR = fileURLToPath(new URL("../../../../public/reports/", import.meta.url));

test("报告登记表非空，且每一条的原件地址都能解回它自己的文件名", () => {
  assert.ok(DELIVERY_REPORTS.length >= 1, "至少要有一份报告");
  for (const report of DELIVERY_REPORTS) {
    assert.ok(report.title.trim().length > 0, "报告要有给人看的标题");
    assert.ok(report.subtitle.trim().length > 0, "报告要有一句说明");
    assert.match(report.pdfHref, /^\/reports\//, `地址要在静态托管的 /reports 下：${report.pdfHref}`);
    const decoded = decodeURIComponent(report.pdfHref.replace("/reports/", ""));
    assert.equal(decoded, report.fileName, "地址解出来必须等于文件名（否则打开就是 404）");
  }
});

test("报告文件真的在 public/reports 里，且登记的大小与磁盘一致", () => {
  const file = `${REPORTS_DIR}${GAUSSIAN_REPORT.fileName}`;
  assert.ok(existsSync(file), `找不到报告文件：${file}`);
  const bytes = statSync(file).size;
  assert.ok(bytes > 100 * 1024, `报告只有 ${bytes} 字节，多半不是完整文件`);
  /* 展示文案是"1.75 MB"这种，按 MB 反算回来核对（容差 0.05 MB，四舍五入的量级） */
  const declared = Number.parseFloat(GAUSSIAN_REPORT.sizeText);
  const actual = bytes / 1024 / 1024;
  assert.ok(
    Math.abs(declared - actual) < 0.05,
    `大小文案 ${GAUSSIAN_REPORT.sizeText} 与磁盘 ${actual.toFixed(2)} MB 对不上`,
  );
});

test("报告是真 PDF（文件头 %PDF-），不是改了个扩展名的别的东西", () => {
  const file = `${REPORTS_DIR}${GAUSSIAN_REPORT.fileName}`;
  const head = readFileSync(file).subarray(0, 5).toString("latin1");
  assert.equal(head, "%PDF-", `文件头是「${head}」，不是 PDF`);
});

test("逐页页图都在 public/reports 里，张数与 pages 一致，且每页都有标题", () => {
  assert.ok(GAUSSIAN_REPORT.pages.length >= 1, "至少要有一页");
  for (const page of GAUSSIAN_REPORT.pages) {
    assert.ok(page.title.trim().length > 0, `第 ${page.index} 页没有标题（窗口里读的人不知道这页讲什么）`);
    assert.match(page.src, /^\/reports\/report-page-\d{2}\.jpg$/, `页图地址不对：${page.src}`);
    const file = `${REPORTS_DIR}${page.src.replace("/reports/", "")}`;
    assert.ok(existsSync(file), `找不到页图：${file}（要跑一次 tools-夜间/render-report-pages.ps1）`);
    assert.ok(statSync(file).size > 20 * 1024, `第 ${page.index} 页页图只有 ${statSync(file).size} 字节，多半是空白图`);
  }
  /* 页码必须从 1 连续排下来（缺一页现场就看不出少了一页） */
  assert.deepEqual(
    GAUSSIAN_REPORT.pages.map((page) => page.index),
    GAUSSIAN_REPORT.pages.map((_, index) => index + 1),
    "页码要从 1 连续排",
  );
});

test("窗口里的结论摘要是照原件抄的六个关键数（不许空着、不许写成一句话）", () => {
  assert.ok(GAUSSIAN_REPORT.summary.length >= 4, "摘要太短，项目经理看不到结论");
  for (const item of GAUSSIAN_REPORT.summary) {
    assert.ok(item.label.trim().length > 0 && item.value.trim().length > 0, `摘要项不完整：${JSON.stringify(item)}`);
    /* 值是数字/参数，不是一句解释（写成长句就说明在编内容） */
    assert.ok(item.value.length <= 24, `摘要「${item.label}」的值太长，像是解释而不是数据：${item.value}`);
  }
  const labels = GAUSSIAN_REPORT.summary.map((item) => item.label);
  for (const key of ["照片数量", "入网率", "重建质量"]) {
    assert.ok(labels.includes(key), `摘要里应当有「${key}」`);
  }
});

test("原件 PDF 与页图两套地址都在（页图给人读，原件是凭据）", () => {
  assert.match(GAUSSIAN_REPORT.pdfHref, /^\/reports\/.+\.pdf$/);
  const pdfFile = `${REPORTS_DIR}${decodeURIComponent(GAUSSIAN_REPORT.pdfHref.replace("/reports/", ""))}`;
  assert.ok(existsSync(pdfFile), `找不到原件：${pdfFile}`);
});

test("日期与文件名里的日期段一致（改文件不改文案 = 展示上说谎）", () => {
  const fromName = GAUSSIAN_REPORT.fileName.match(/(\d{8})/)?.[1] ?? "";
  assert.equal(
    GAUSSIAN_REPORT.date.replace(/-/g, ""),
    fromName,
    `文案日期 ${GAUSSIAN_REPORT.date} 与文件名里的 ${fromName} 对不上`,
  );
});
