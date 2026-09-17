import { test } from "node:test";
import assert from "node:assert/strict";

import { getSiteSafetyRecord, SITE_SAFETY_RECORD } from "./siteSafety.ts";

test("现场安全登记覆盖边界、区域划分、出入口、应急集合点与状态追溯", () => {
  assert.deepEqual(
    SITE_SAFETY_RECORD.locations.map((item) => item.key),
    ["boundary", "zone", "entrance", "assembly"],
  );
  assert.equal(SITE_SAFETY_RECORD.locations[0]?.value, "四根木柱外围");
  assert.equal(SITE_SAFETY_RECORD.locations[2]?.value, "四柱区域入口");
  assert.equal(SITE_SAFETY_RECORD.locations[3]?.value, null);
  assert.match(SITE_SAFETY_RECORD.locations[3]?.note ?? "", /未提供具体位置|待现场标定/);
  assert.equal(SITE_SAFETY_RECORD.status, "隔离到位，无未排除隐患");
  assert.equal(SITE_SAFETY_RECORD.notification, "现场条件变化时通知各岗位");
  assert.equal(SITE_SAFETY_RECORD.updatedAt, "落地检查与开工指令（10:30—12:00）");
  assert.match(SITE_SAFETY_RECORD.source, /55.*60.*64.*65/);
});

test("批注「设备摆放区」落到第 64 段原文，且出入口不重复登记", () => {
  /**
   * 批注原文：`木柱四周出入口，设备摆放区`（ull N，锚在第 65 段）
   * 依据：第 64 段「以四柱外围为界…划分人员作业区和设备暂存区」。
   * 判据按**逐字**写：区域名与脚本原文不一致就必须回改这里。
   */
  const zone = SITE_SAFETY_RECORD.locations.find((item) => item.key === "zone");
  assert.ok(zone, "必须登记区域划分（设备暂存区）这一项");
  assert.equal(zone.value, "人员作业区、设备暂存区");
  assert.equal(zone.state, "已登记");
  assert.equal(SITE_SAFETY_RECORD.locations.filter((item) => item.key === "entrance").length, 1);
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
