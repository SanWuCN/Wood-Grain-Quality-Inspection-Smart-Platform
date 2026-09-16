import { test } from "node:test";
import assert from "node:assert/strict";

import { getSiteSafetyRecord, SITE_SAFETY_RECORD } from "./siteSafety.ts";

test("现场安全登记覆盖边界、出入口、应急集合点与状态追溯", () => {
  assert.deepEqual(
    SITE_SAFETY_RECORD.locations.map((item) => item.key),
    ["boundary", "entrance", "assembly"],
  );
  assert.equal(SITE_SAFETY_RECORD.locations[0]?.value, "四根木柱外围");
  assert.equal(SITE_SAFETY_RECORD.locations[1]?.value, "四柱区域入口");
  assert.equal(SITE_SAFETY_RECORD.locations[2]?.value, null);
  assert.match(SITE_SAFETY_RECORD.locations[2]?.note ?? "", /未提供具体位置|待现场标定/);
  assert.equal(SITE_SAFETY_RECORD.status, "隔离到位，无未排除隐患");
  assert.equal(SITE_SAFETY_RECORD.notification, "现场条件变化时通知各岗位");
  assert.equal(SITE_SAFETY_RECORD.updatedAt, "落地检查与开工指令（10:30—12:00）");
  assert.match(SITE_SAFETY_RECORD.source, /55.*60.*65/);
});

test("现场安全登记不把文档未给出的集合点位置编成事实", () => {
  const assembly = SITE_SAFETY_RECORD.locations.find((item) => item.key === "assembly");
  assert.ok(assembly);
  assert.equal(assembly.value, null);
  assert.equal(assembly.state, "待现场标定");
  assert.ok(Object.isFrozen(SITE_SAFETY_RECORD));
  assert.ok(Object.isFrozen(SITE_SAFETY_RECORD.locations));
});

test("脚本中的现场安全记录只绑定对应历史工单", () => {
  assert.equal(getSiteSafetyRecord("SH-2026-0901"), SITE_SAFETY_RECORD);
  assert.equal(getSiteSafetyRecord("MAY-DEMO-01"), null);
  assert.equal(getSiteSafetyRecord("WO-20260916-0001"), null);
});
