import type { DeviceHardwareView } from "./types.ts";

export type DeviceDataSource = {
  deviceId: string;
  deviceName: string;
  hostname: string | null;
  batchId: string;
  batchRound: string;
  channels: string[];
  sampledAt: string | null;
  receivedAt: string;
};

export type DeviceStreamEntry = Omit<DeviceDataSource, "channels"> & {
  id: string;
  channels: string;
};

export function deriveDeviceDataSource(
  view: DeviceHardwareView | null | undefined,
  batchId: string,
  expectedDeviceId?: string,
): DeviceDataSource | null {
  const report = view?.report;
  if (!view?.receivedAt || !report) return null;
  const reportedDeviceId = report.deviceId || view.deviceId;
  if (expectedDeviceId && reportedDeviceId !== expectedDeviceId) return null;
  const batch = report.batches?.find((item) => item.batchId === batchId);
  if (!batch) return null;
  return {
    deviceId: reportedDeviceId,
    deviceName: report.hardware?.model || "手持毫米波扫描仪",
    hostname: report.hardware?.hostname ?? null,
    batchId: batch.batchId,
    batchRound: batch.round || "未标注轮次",
    channels: (report.channels ?? []).map((channel) => `${channel.label} · ${channel.source}`),
    sampledAt: report.sampledAt ?? null,
    receivedAt: view.receivedAt,
  };
}

export function toDeviceStreamEntry(
  view: DeviceHardwareView | null | undefined,
  batchId: string,
  expectedDeviceId?: string,
): DeviceStreamEntry | null {
  const source = deriveDeviceDataSource(view, batchId, expectedDeviceId);
  const channels = view?.report?.channels;
  if (!source || !channels?.length) return null;
  return {
    ...source,
    id: `${source.deviceId}:${source.batchId}:${source.receivedAt}`,
    channels: channels
      .map((channel) => `${channel.label} ${channel.state === "online" ? "正常" : channel.state === "stale" ? "延迟" : channel.state === "offline" ? "断开" : "未知"}`)
      .join(" / "),
  };
}
