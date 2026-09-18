/**
 * 平台资源映射的验算（对应验收清单 §3 的 F1–F4 与 §6 的量化容差）
 *
 * 运行：node server/services/platform-resources.test.mjs
 * 这些断言全部对着 PRD §9 的公式写，改公式必须同时改这里，不能只改一边。
 */

import { mapPlatformResources, loadState, jitterAt, STORAGE_TOTAL_TB, MEMORY_TOTAL_GIB, POWER_MIN_W, POWER_MAX_W, NETWORK_SCALE } from "./platform-resources.mjs";

const GiB = 1024 ** 3;
let failed = 0;
let passed = 0;

function check(name, actual, expected, tolerance = 1e-9) {
  const ok = typeof expected === "number"
    ? Math.abs(actual - expected) <= Math.max(tolerance, Math.abs(expected) * 1e-9)
    : actual === expected;
  if (ok) passed += 1;
  else {
    failed += 1;
    console.error(`✗ ${name}\n    实际 ${JSON.stringify(actual)}\n    期望 ${JSON.stringify(expected)}`);
  }
}

function section(text) {
  console.log(`\n— ${text}`);
}

const baseConfig = { hostId: "test-host", atMs: 1_700_000_000_000, mappingVersion: "overview-resources-v1" };

/* ---------------- F1：单服务器、半占用 ---------------- */
section("F1 单服务器、半占用");
{
  const snapshot = mapPlatformResources({
    config: baseConfig,
    volumes: [{ id: "vol-c", label: "C:", totalBytes: 500 * GiB, freeBytes: 250 * GiB }],
    memory: { totalBytes: 32 * GiB, availableBytes: 16 * GiB },
    gpu: { utilizationPct: 50, memoryUsedBytes: 4 * GiB, memoryTotalBytes: 8 * GiB },
    network: { uploadBytesPerSec: 1_000_000, downloadBytesPerSec: 2_000_000 },
    jitter: { CON1: { gpu: 0, vram: 0 } },
  });
  const s = snapshot.summary;
  check("服务器数", snapshot.serverCount, 1);
  check("存储已用 TB（未舍入）", s.storageUsedTB, 12.175, 1e-9);
  check("存储已用显示两位", Number(s.storageUsedTB.toFixed(2)), 12.18);
  check("不等于 12.12", Number(s.storageUsedTB.toFixed(2)) === 12.12, false);
  check("存储比例", s.storageRatio, 0.5, 1e-12);
  check("内存已用 GiB", s.memoryUsedGiB, 336, 1e-9);
  check("GPU 基准", s.gpuBasePercent, 50);
  check("负载", s.loadState, "medium");
  check("CON1 显存已用（主机实测 8 GiB × 50%）", snapshot.servers[0].gpu.vramUsedGib, 4, 1e-9);
  check("显存分母即主机实测（不是预置 24 GiB）", snapshot.gpuVramTotalGib, 8, 1e-9);
  check("CON1 功耗", snapshot.servers[0].powerW, 850, 1e-9);
  check("集群功耗", s.powerTotalW, 850, 1e-9);
  check("平台上行 B/s", s.uploadBytesPerSec, 300_000_000, 1e-3);
  check("平台下行 B/s", s.downloadBytesPerSec, 600_000_000, 1e-3);
  check("平台内存总量未按本机显示", s.memoryTotalGiB, MEMORY_TOTAL_GIB);
}

/* ---------------- F2：四个不同大小的卷 + 固定扰动 ---------------- */
section("F2 四个卷 + 确定性扰动");
{
  const volumes = [
    { id: "vol-c", label: "C:", totalBytes: 500 * GiB, freeBytes: 250 * GiB },
    { id: "vol-d", label: "D:", totalBytes: 1000 * GiB, freeBytes: 750 * GiB },
    { id: "vol-e", label: "E:", totalBytes: 250 * GiB, freeBytes: 62.5 * GiB },
    { id: "vol-f", label: "F:", totalBytes: 2000 * GiB, freeBytes: 0 },
  ];
  const snapshot = mapPlatformResources({
    config: baseConfig,
    volumes,
    memory: { totalBytes: 32 * GiB, availableBytes: 16 * GiB },
    gpu: { utilizationPct: 50, memoryUsedBytes: 4 * GiB, memoryTotalBytes: 8 * GiB },
    network: { uploadBytesPerSec: 1_000_000, downloadBytesPerSec: 2_000_000 },
    jitter: {
      CON1: { gpu: -0.12, vram: -0.12 },
      CON2: { gpu: -0.04, vram: 0.12 },
      CON3: { gpu: 0.04, vram: 0 },
      CON4: { gpu: 0.12, vram: -0.04 },
    },
  });
  const s = snapshot.summary;
  check("每台配额 TB", snapshot.servers[0].storage.totalTb, 6.0875, 1e-12);
  check("集群已用 TB", s.storageUsedTB, 15.21875, 1e-9);
  check("主卡显示 15.22", Number(s.storageUsedTB.toFixed(2)), 15.22);
  check("算术平均比例 62.5%", Number((s.storageRatio * 100).toFixed(1)), 62.5);
  check("不是容量加权 71.67%", Number((s.storageRatio * 100).toFixed(2)) === 71.67, false);
  check("每台内存配额 GiB", snapshot.servers[0].memory.totalGib, 168, 1e-9);
  check("每台内存已用 GiB", snapshot.servers[0].memory.usedGib, 84, 1e-9);
  check("GPU 基准仍 50%", s.gpuBasePercent, 50);
  check("负载中负载", s.loadState, "medium");
  const gpuPercents = snapshot.servers.map((server) => Number(server.gpu.percent.toFixed(4)));
  check("逐台 GPU 44 / 48 / 52 / 56", JSON.stringify(gpuPercents), JSON.stringify([44, 48, 52, 56]));
  const vram = snapshot.servers.map((server) => Number(server.gpu.vramUsedGib.toFixed(2)));
  check("逐台显存 3.52 / 4.48 / 4 / 3.84（8 GiB × 比例）", JSON.stringify(vram), JSON.stringify([3.52, 4.48, 4, 3.84]));
  const power = snapshot.servers.map((server) => Number(server.powerW.toFixed(4)));
  check("逐台功耗 820 / 840 / 860 / 880", JSON.stringify(power), JSON.stringify([820, 840, 860, 880]));
  check("集群功耗 3400 W", s.powerTotalW, 3400, 1e-6);
  check("网络不乘服务器数", s.uploadBytesPerSec, 300_000_000, 1e-3);
}

/* ---------------- F3：阈值与极值 ---------------- */
section("F3 阈值与极值");
{
  check("0 → 空闲", loadState(0), "idle");
  check("24.9 → 空闲", loadState(24.9), "idle");
  check("24.999 → 空闲", loadState(24.999), "idle");
  check("25 → 低负载", loadState(25), "low");
  check("49.999 → 低负载", loadState(49.999), "low");
  check("50 → 中负载", loadState(50), "medium");
  check("74.999 → 中负载", loadState(74.999), "medium");
  check("75 → 高负载", loadState(75), "high");
  check("100 → 高负载", loadState(100), "high");
  check("null → 未知", loadState(null), "unknown");
  check("过期 → 未知", loadState(80, "stale"), "unknown");

  /* 0% 与 100% 的扰动边界 */
  const zero = mapPlatformResources({
    config: baseConfig,
    volumes: [{ id: "v", label: "C:", totalBytes: 100 * GiB, freeBytes: 100 * GiB }],
    memory: { totalBytes: 32 * GiB, availableBytes: 32 * GiB },
    gpu: { utilizationPct: 0, memoryUsedBytes: 0, memoryTotalBytes: 8 * GiB },
    network: null,
    jitter: { CON1: { gpu: 0.12, vram: 0.12 } },
  });
  check("0% 基准 ±12% 仍为 0", zero.servers[0].gpu.percent, 0);
  check("0% 显存仍为 0", zero.servers[0].gpu.vramUsedGib, 0);
  check("0% 功耗 600 W", zero.servers[0].powerW, POWER_MIN_W);

  const full = mapPlatformResources({
    config: baseConfig,
    volumes: [{ id: "v", label: "C:", totalBytes: 100 * GiB, freeBytes: 0 }],
    memory: { totalBytes: 32 * GiB, availableBytes: 0 },
    gpu: { utilizationPct: 100, memoryUsedBytes: 8 * GiB, memoryTotalBytes: 8 * GiB },
    network: null,
    jitter: { CON1: { gpu: 0.12, vram: 0.12 } },
  });
  check("100% 封顶 100", full.servers[0].gpu.percent, 100);
  check("显存封顶 = 主机实测 8 GiB", full.servers[0].gpu.vramUsedGib, 8);
  check("100% 功耗 1100 W", full.servers[0].powerW, POWER_MAX_W);

  const invalid = mapPlatformResources({
    config: baseConfig,
    volumes: [{ id: "v", label: "C:", totalBytes: 100 * GiB, freeBytes: 50 * GiB }],
    memory: { totalBytes: 32 * GiB, availableBytes: 16 * GiB },
    gpu: { utilizationPct: 137, memoryUsedBytes: 4 * GiB, memoryTotalBytes: 8 * GiB },
    network: null,
  });
  check("越界原始值 → GPU 缺失", invalid.summary.gpuBasePercent, null);
  check("越界原始值 → 负载未知", invalid.summary.loadState, "unknown");
  check("越界原始值 → 功耗不可用", invalid.servers[0].powerW, null);
  check("存储不受 GPU 影响", Number(invalid.summary.storageUsedTB.toFixed(2)), 12.18);

  /* 显存分母只有「显式传入」才可能不是主机实测值；不传就是主机实测（这里是 8 GiB） */
  const explicitVram = mapPlatformResources({
    config: baseConfig,
    volumes: [{ id: "v", label: "C:", totalBytes: 100 * GiB, freeBytes: 50 * GiB }],
    memory: { totalBytes: 32 * GiB, availableBytes: 16 * GiB },
    gpu: { utilizationPct: 50, memoryUsedBytes: 4 * GiB, memoryTotalBytes: 8 * GiB },
    vramTotal: 24,
    network: null,
    /* 固定扰动为 0：这里要验的是分母，不是抖动 */
    jitter: { CON1: { gpu: 0, vram: 0 } },
  });
  check("显式显存总量才覆盖分母", explicitVram.gpuVramTotalGib, 24);
  check("显式分母逐台算值", explicitVram.servers[0].gpu.vramUsedGib, 12, 1e-9);
}

/* ---------------- F4：网络差分 ---------------- */
section("F4 网络与缺口");
{
  const sample = (upload, download) => mapPlatformResources({
    config: baseConfig,
    volumes: [{ id: "v", label: "C:", totalBytes: 100 * GiB, freeBytes: 50 * GiB }],
    memory: { totalBytes: 32 * GiB, availableBytes: 16 * GiB },
    gpu: null,
    network: upload === null ? null : { uploadBytesPerSec: upload, downloadBytesPerSec: download },
  });
  check("无样本 → null（不是 0）", sample(null, null).summary.uploadBytesPerSec, null);
  check("1,000,000 B/s → 300 MB/s", sample(1_000_000, 2_000_000).summary.uploadBytesPerSec, 300 * 1_000_000);
  check("无增长 → 0 B/s", sample(0, 0).summary.uploadBytesPerSec, 0);
  check("倍率常量 = 300", NETWORK_SCALE, 300);
}

/* ---------------- N=0 与质量降级 ---------------- */
section("N=0 / 质量降级");
{
  const none = mapPlatformResources({
    config: baseConfig,
    volumes: [],
    memory: { totalBytes: 32 * GiB, availableBytes: 16 * GiB },
    gpu: { utilizationPct: 50, memoryUsedBytes: 4 * GiB, memoryTotalBytes: 8 * GiB },
    network: { uploadBytesPerSec: 0, downloadBytesPerSec: 0 },
  });
  check("零卷：不虚构 CON1", none.serverCount, 0);
  check("零卷：配置容量仍给出", none.summary.storageTotalTB, STORAGE_TOTAL_TB);
  check("零卷：已用未知", none.summary.storageUsedTB, null);
  check("零卷：原因文案", none.noVolumeReason, "未识别存储卷");

  const stale = mapPlatformResources({
    config: baseConfig,
    volumes: [{ id: "v", label: "C:", totalBytes: 100 * GiB, freeBytes: 50 * GiB }],
    memory: { totalBytes: 32 * GiB, availableBytes: 16 * GiB },
    gpu: { utilizationPct: 80, memoryUsedBytes: 4 * GiB, memoryTotalBytes: 8 * GiB },
    network: null,
    quality: { gpu: "stale" },
  });
  check("GPU 过期 → 负载未知", stale.summary.loadState, "unknown");
  check("GPU 过期 → 功耗不可用", stale.summary.powerTotalW, null);
  check("顶层质量取最差", stale.quality, "stale");
}

console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
