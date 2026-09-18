/**
 * 平台资源服务（总览「平台数据」与资源弹窗的唯一数据源）
 *
 * 组装：主机采样器（`host-sampler.mjs`）+ 版本化映射器（`platform-resources.mjs`）。
 * 所有浏览器读到的是**同一份后端快照**，前端不做任何映射或随机（PRD §9.4 / RES-19）。
 *
 * 确定性夹具（验收清单 §3）：
 *   浏览器带 `?fixture=f1|f2|f3|f4`，或后端设 `MUMAI_RESOURCE_FIXTURE=f1`，
 *   可用固定输入验算映射公式。夹具只在开发环境生效（生产构建忽略），
 *   并且界面会标出「验收夹具」—— 夹具不能冒充真实采集。
 */

import { createHostSampler } from "./host-sampler.mjs";
import {
  MAPPING_VERSION,
  MEMORY_TOTAL_GIB,
  NETWORK_SCALE,
  POWER_MAX_W,
  POWER_MIN_W,
  STORAGE_TOTAL_TB,
  VRAM_TOTAL_GIB_OVERRIDE,
  mapPlatformResources,
} from "./platform-resources.mjs";

const GiB = 1024 ** 3;
/** 逐台显存总量的分母：主机实测显存（GiB）→ 环境覆盖 → null（界面显示「—」） */
const vramTotalOf = (bytes) =>
  Number.isFinite(bytes) && bytes > 0 ? bytes / GiB : VRAM_TOTAL_GIB_OVERRIDE;
/** 夹具里的「500 G 盘」按 Windows 口径算 GiB（验收清单 F1 写的是 GiB） */
const FIXTURE_VOLUME = (label, totalGib, usedGib) => ({
  id: `fixture-${label}`,
  label,
  totalBytes: totalGib * GiB,
  freeBytes: (totalGib - usedGib) * GiB,
});

/** 验收清单 §3 的四个夹具 */
export const FIXTURES = {
  /* F1：单服务器、半占用 */
  f1: {
    label: "F1 单卷半占用",
    volumes: [FIXTURE_VOLUME("C:", 500, 250)],
    memory: { totalBytes: 32 * GiB, availableBytes: 16 * GiB },
    gpu: { utilizationPct: 50, memoryUsedBytes: 4 * GiB, memoryTotalBytes: 8 * GiB },
    network: { uploadBytesPerSec: 1_000_000, downloadBytesPerSec: 2_000_000 },
    jitter: { CON1: { gpu: 0, vram: 0 } },
  },
  /* F2：四个不同大小的卷 + 确定性扰动（44/48/52/56%） */
  f2: {
    label: "F2 四卷 + 固定扰动",
    volumes: [
      FIXTURE_VOLUME("C:", 500, 1000 * 0 + 250),
      FIXTURE_VOLUME("D:", 1000, 250),
      FIXTURE_VOLUME("E:", 250, 187.5),
      FIXTURE_VOLUME("F:", 2000, 2000),
    ],
    memory: { totalBytes: 32 * GiB, availableBytes: 16 * GiB },
    gpu: { utilizationPct: 50, memoryUsedBytes: 4 * GiB, memoryTotalBytes: 8 * GiB },
    network: { uploadBytesPerSec: 1_000_000, downloadBytesPerSec: 2_000_000 },
    jitter: {
      CON1: { gpu: -0.12, vram: -0.12 },
      CON2: { gpu: -0.04, vram: 0.12 },
      CON3: { gpu: 0.04, vram: 0 },
      CON4: { gpu: 0.12, vram: -0.04 },
    },
  },
  /* F3：阈值与极值（0% / 100% / 越界） */
  f3: {
    label: "F3 阈值与极值（0%）",
    volumes: [FIXTURE_VOLUME("C:", 500, 250)],
    memory: { totalBytes: 32 * GiB, availableBytes: 16 * GiB },
    gpu: { utilizationPct: 0, memoryUsedBytes: 0, memoryTotalBytes: 8 * GiB },
    network: { uploadBytesPerSec: 0, downloadBytesPerSec: 0 },
    jitter: { CON1: { gpu: 0.12, vram: 0.12 } },
  },
  /* F4：网络差分（含计数器回退） */
  f4: {
    label: "F4 网络差分",
    volumes: [FIXTURE_VOLUME("C:", 500, 250)],
    memory: { totalBytes: 32 * GiB, availableBytes: 16 * GiB },
    gpu: { utilizationPct: 50, memoryUsedBytes: 4 * GiB, memoryTotalBytes: 8 * GiB },
    network: { uploadBytesPerSec: 1_000_000, downloadBytesPerSec: 2_000_000 },
    jitter: { CON1: { gpu: 0, vram: 0 } },
  },
};

export function createPlatformResources() {
  const sampler = createHostSampler();
  /* 服务端固定的夹具（无浏览器时也能验算；前端 ?fixture= 会覆盖它） */
  const serverFixture = process.env.MUMAI_RESOURCE_FIXTURE ?? null;
  /** 夹具在真实主机上的等效采样时间：始终用「现在」，避免被质量窗口判过期 */
  const started = Date.now();
  let snapshotCounter = 0;

  function build(fixtureName) {
    const name = fixtureName ?? serverFixture;
    const fixture = name ? FIXTURES[String(name).toLowerCase()] : null;

    if (fixture) {
      const now = Date.now();
      const snapshot = mapPlatformResources({
        config: { hostId: "fixture-host", atMs: now, mappingVersion: MAPPING_VERSION },
        volumes: fixture.volumes,
        memory: fixture.memory,
        gpu: fixture.gpu,
        /* 夹具的显存总量就是夹具 GPU 自己的总容量，不另立一套展示常量 */
        vramTotal: vramTotalOf(fixture.gpu.memoryTotalBytes),
        network: fixture.network,
        quality: { gpu: "fresh", memory: "fresh", storage: "fresh", network: "fresh" },
        sampledAt: { gpu: now, memory: now, storage: now, network: now },
        jitter: fixture.jitter,
        epoch: 1,
        topologyVersion: 1,
      });
      snapshot.snapshotId = `fixture:${String(name).toLowerCase()}:${++snapshotCounter}`;
      snapshot.fixture = { name: String(name).toLowerCase(), label: fixture.label };
      snapshot.mappingExplain = {
        hostId: "fixture-host",
        note: "验收夹具输入，不是真实主机采集",
        storageTotalTB: STORAGE_TOTAL_TB,
        memoryTotalGiB: MEMORY_TOTAL_GIB,
        vramTotalGiB: vramTotalOf(fixture.gpu.memoryTotalBytes),
        powerRangeW: [POWER_MIN_W, POWER_MAX_W],
        networkScale: NETWORK_SCALE,
        mappingVersion: MAPPING_VERSION,
      };
      return snapshot;
    }

    const input = sampler.snapshotInput();
    const snapshot = mapPlatformResources({
      ...input,
      /* 显存分母 = 被采集那张卡自己的实测显存（不再预置 24 GiB） */
      vramTotal: vramTotalOf(input.gpu?.memoryTotalBytes),
      snapshotId: `${sampler.hostId}:${input.epoch}:${++snapshotCounter}`,
    });
    snapshot.fixture = null;
    snapshot.mappingExplain = {
      hostId: sampler.hostId,
      note: "资源按后端主机实测比例映射，服务器与容量是展示单元，不是主机物理规格",
      storageTotalTB: STORAGE_TOTAL_TB,
      memoryTotalGiB: MEMORY_TOTAL_GIB,
      vramTotalGiB: vramTotalOf(input.gpu?.memoryTotalBytes),
      powerRangeW: [POWER_MIN_W, POWER_MAX_W],
      networkScale: NETWORK_SCALE,
      mappingVersion: MAPPING_VERSION,
      startedAt: new Date(started).toISOString(),
      ...sampler.describe(),
    };
    return snapshot;
  }

  return {
    async start() {
      await sampler.start();
    },
    stop() {
      sampler.stop();
    },
    /** 最新快照。fixtureName 由路由从查询串取（仅开发环境会传进来） */
    snapshot(fixtureName) {
      return build(fixtureName);
    },
    history(windowSec = 60) {
      const points = sampler.history(windowSec);
      return {
        windowSec,
        scale: NETWORK_SCALE,
        points: points.map((point) => ({
          at: new Date(point.at).toISOString(),
          atMs: point.at,
          uploadBytesPerSec: point.upload === undefined ? null : point.upload * NETWORK_SCALE,
          downloadBytesPerSec: point.download === undefined ? null : point.download * NETWORK_SCALE,
        })),
      };
    },
  };
}
