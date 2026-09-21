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

test("报告登记表非空，且每一条的地址都能解回它自己的文件名", () => {
  assert.ok(DELIVERY_REPORTS.length >= 1, "至少要有一份报告");
  for (const report of DELIVERY_REPORTS) {
    assert.ok(report.title.trim().length > 0, "报告要有给人看的标题");
    assert.ok(report.subtitle.trim().length > 0, "报告要有一句说明");
    assert.match(report.href, /^\/reports\//, `地址要在静态托管的 /reports 下：${report.href}`);
    const decoded = decodeURIComponent(report.href.replace("/reports/", ""));
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

test("日期与文件名里的日期段一致（改文件不改文案 = 展示上说谎）", () => {
  const fromName = GAUSSIAN_REPORT.fileName.match(/(\d{8})/)?.[1] ?? "";
  assert.equal(
    GAUSSIAN_REPORT.date.replace(/-/g, ""),
    fromName,
    `文案日期 ${GAUSSIAN_REPORT.date} 与文件名里的 ${fromName} 对不上`,
  );
});
