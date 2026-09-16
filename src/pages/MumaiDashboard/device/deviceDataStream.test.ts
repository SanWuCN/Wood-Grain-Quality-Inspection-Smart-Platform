import { test } from "node:test";
import assert from "node:assert/strict";

import type { DeviceHardwareView } from "./types.ts";
import { deriveDeviceDataSource, toDeviceStreamEntry } from "./deviceDataStream.ts";

const view: DeviceHardwareView = {
  ok: true,
  deviceId: "handheld-02",
  receivedAt: "2026-09-16T10:19:02.000Z",
  stale: false,
  ageSec: 1,
  serverTime: "2026-09-16T10:19:03.000Z",
  link: { state: "online", ageSec: 1, lastSeenAt: "2026-09-16T10:19:02.000Z", socketConnected: true },
  ledger: null,
  telemetry: null,
  lastEvent: null,
  configAck: null,
  recentCommands: [],
  report: {
    deviceId: "handheld-02",
    sampledAt: "2026-09-16T10:19:01.000Z",
    hardware: { model: "WoodPulse Handheld", hostname: "woodpulse-02" },
    channels: [
      { key: "map", label: "毫米波", state: "online", updatedAt: "10:19:01", ageSec: 1, source: "设备采集进程" },
      { key: "video", label: "相机", state: "online", updatedAt: "10:19:01", ageSec: 1, source: "设备相机" },
    ],
    batches: [
      { batchId: "scan-Z04-002", round: "复扫", state: "capturing", startedAt: "2026-09-16T10:18:00.000Z" },
      { batchId: "scan-Z04-001", round: "初扫", state: "complete", startedAt: "2026-09-16T10:10:00.000Z" },
    ],
  },
};

test("设备来源随选中批次绑定设备、通道与接收时间", () => {
  const source = deriveDeviceDataSource(view, "scan-Z04-002");
  assert.ok(source);
  assert.deepEqual(source, {
    deviceId: "handheld-02",
    deviceName: "WoodPulse Handheld",
    hostname: "woodpulse-02",
    batchId: "scan-Z04-002",
    batchRound: "复扫",
    channels: ["毫米波 · 设备采集进程", "相机 · 设备相机"],
    sampledAt: "2026-09-16T10:19:01.000Z",
    receivedAt: "2026-09-16T10:19:02.000Z",
  });
});

test("批次切换时来源摘要同步，缺少指定批次时不借用别的批次", () => {
  assert.equal(deriveDeviceDataSource(view, "scan-missing"), null);
  assert.equal(deriveDeviceDataSource({ ...view, report: null }, "scan-Z04-002"), null);
  assert.equal(deriveDeviceDataSource(view, "scan-Z04-002", "handheld-03"), null);
});

test("流记录只由当前设备上报生成，不为未上报设备制造记录", () => {
  const entry = toDeviceStreamEntry(view, "scan-Z04-002");
  assert.ok(entry);
  assert.equal(entry.deviceId, "handheld-02");
  assert.equal(entry.batchId, "scan-Z04-002");
  assert.equal(entry.receivedAt, "2026-09-16T10:19:02.000Z");
  assert.equal(entry.channels, "毫米波 正常 / 相机 正常");
  assert.equal(toDeviceStreamEntry({ ...view, report: null }, "scan-Z04-002"), null);
});

test("未知通道状态保持未知，不显示成已经断开", () => {
  const unknown = structuredClone(view);
  (unknown.report!.channels![0] as { state: string }).state = "unknown";

  assert.match(toDeviceStreamEntry(unknown, "scan-Z04-002")?.channels ?? "", /毫米波 未知/);
});
