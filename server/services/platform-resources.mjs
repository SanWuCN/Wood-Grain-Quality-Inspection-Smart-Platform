/**
 * 平台资源映射（PRD/平台资源与总览四窗口 v1.0 §9）
 *
 * 这一层只做一件事：把**后端主机的实测原始值**按 PRD 的公式映射成平台展示值。
 * 采集（读磁盘 / 内存 / GPU / 网卡）在 `host-sampler.mjs`，这里不碰系统调用，
 * 因此可以用确定性夹具直接验算公式（验收清单 §3 的 F1–F4）。
 *
 * 单位口径（§9 / RES-27，别混）：
 *   · 存储   十进制 TB：1 TB = 10¹² B
 *   · 内存/显存 GiB：1 GiB = 1024³ B
 *   · 网络   十进制 B/s（不是 bit/s，也不写 Mbps）
 *
 * 公式（§9.2–9.7）：
 *   r_i = (disk_i_total - disk_i_free) / disk_i_total       每卷使用率
 *   S_i_total = 24.35 TB / N                                 配额等分
 *   S_i_used  = S_i_total × r_i
 *   S_used    = Σ S_i_used                                   ← 合计用未舍入值求和
 *   R_storage = S_used / 24.35 TB = 各卷使用率的**算术平均**（不是容量加权）
 *   m         = (mem_total - mem_available) / mem_total
 *   M_used    = 672 GiB × m ；M_i = 672 GiB / N
 *   g_i       = clamp(g × (1 + ε_gpu_i), 0, 100)
 *   v_i       = clamp(v × (1 + ε_vram_i), 0, 1) ；V_i_used = V_total × v_i（V_total = 后端主机实测显存）
 *   P_i       = 600 + 500 × g_i / 100 ；P_total = Σ P_i
 *   net_up    = 实际发送速率 × 300 ；net_down = 实际接收速率 × 300（集群只乘一次）
 */

/* ------------------------------------------------------------------ *
 * 展示常量
 * ------------------------------------------------------------------ */

/** 平台总存储（十进制 TB） */
export const STORAGE_TOTAL_TB = 24.35;
/** 平台总内存（GiB） */
export const MEMORY_TOTAL_GIB = 672;
/** 单台服务器功耗区间 */
export const POWER_MIN_W = 600;
export const POWER_MAX_W = 1100;
/** 网络展示倍率 */
export const NETWORK_SCALE = 300;
/**
 * 显存展示总量（GiB）：**后端主机实测值**，不是预置型号。
 *
 * 这里不写任何 GPU 型号，也不预置 24 GiB —— 逐台显存是「主机实测显存 × 映射比例」，
 * 分母跟着真主机走（`MUMAI_VRAM_TOTAL_GIB` 只在确需固定展示总量时覆盖）。
 * 用哪张卡的实测显存在「映射说明」里可追溯（`gpuName` / `gpuVramTotalGib`）。
 */
export const VRAM_TOTAL_GIB_OVERRIDE = (() => {
  const value = Number(process.env.MUMAI_VRAM_TOTAL_GIB);
  return Number.isFinite(value) && value > 0 ? value : null;
})();
/** 节点动态浮动幅度：**相对值** ±12%，不是 ±12 个百分点（§2 / RES-14） */
export const JITTER_RATIO = 0.12;
/** 扰动时间桶：6 秒（§9.4） */
export const JITTER_BUCKET_MS = 6000;
/** 映射配置版本：进快照，便于验收核对（§10.2） */
export const MAPPING_VERSION = "overview-resources-v1";

const TB_BYTES = 1e12;
const GIB_BYTES = 1024 ** 3;

/* ------------------------------------------------------------------ *
 * 数值工具
 * ------------------------------------------------------------------ */

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
export const round = (value, digits) => Number(value.toFixed(digits));

/** 有限数值才算有效样本；null / NaN / 字符串一律无效（§10.2「缺失用 null」） */
export function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/* ------------------------------------------------------------------ *
 * 负载档位（§9.5）
 * ------------------------------------------------------------------ */

/**
 * GPU 利用率 → 负载档位。
 *
 * 阈值 25 / 50 / 75 是**闭开区间**的边界：24.999 是空闲、25 是低负载。
 * 判档用未舍入的实测 g —— 23.99% 不能因为界面上显示成 24.0% 就改档（F3）。
 * 缺失 / 过期 / 无采集能力一律"未知"，不能落到"空闲"（F3 最后一行）。
 */
export function loadState(gpuPercent, quality = "fresh") {
  if (quality !== "fresh" || gpuPercent === null) return "unknown";
  if (gpuPercent < 25) return "idle";
  if (gpuPercent < 50) return "low";
  if (gpuPercent < 75) return "medium";
  return "high";
}

/* ------------------------------------------------------------------ *
 * 确定性扰动（§9.4）
 * ------------------------------------------------------------------ */

/** 32 位整数哈希：把 hostId/serverId/metric 混成一个稳定种子 */
function hashSeed(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
}

/**
 * 某个 (host, server, metric) 在第 bucket 个 6 秒桶上的目标扰动系数。
 *
 * 取值落在 [-JITTER_RATIO, +JITTER_RATIO]；同一秒里问几次都是同一个值，
 * 因此**多个浏览器、主卡与弹窗读到的是同一个数**（RES-19），
 * 前端不需要也不可能自己随机（§9.4 明令禁止前端 Math.random）。
 */
export function jitterTarget(hostId, serverId, metric, bucket) {
  const base = hashSeed(`${hostId}|${serverId}|${metric}`);
  const value = Math.sin((bucket + base * 6.283) * (1.7 + base)) * 0.5 + 0.5; // 0..1
  return (value * 2 - 1) * JITTER_RATIO;
}

/**
 * 前后两个 6 秒桶之间线性平滑（§9.4「再在前后目标间线性平滑」）。
 * 桶边界处正好等于目标值，所以 6 秒周期的极值一定会被取到。
 */
export function jitterAt(hostId, serverId, metric, atMs, override) {
  if (override !== undefined && override !== null) return override;
  const bucket = Math.floor(atMs / JITTER_BUCKET_MS);
  const from = jitterTarget(hostId, serverId, metric, bucket);
  const to = jitterTarget(hostId, serverId, metric, bucket + 1);
  const ratio = (atMs % JITTER_BUCKET_MS) / JITTER_BUCKET_MS;
  return from + (to - from) * ratio;
}

/* ------------------------------------------------------------------ *
 * 映射主体
 * ------------------------------------------------------------------ */

/**
 * 原始样本 → 平台资源快照。
 *
 * @param {object} input
 * @param {object} input.config     映射配置（hostId / mappingVersion / 采样时钟）
 * @param {Array}  input.volumes    固定卷原始样本：{ id, label, totalBytes, freeBytes }
 * @param {object} input.memory     物理内存：{ totalBytes, availableBytes } | null
 * @param {object} input.gpu        选中 GPU：{ utilizationPct, memoryUsedBytes, memoryTotalBytes } | null
 * @param {number} [input.vramTotal] 显存展示总量（GiB，默认取主机实测显存）；逐台 V_i_used = 该值 × v_i
 * @param {object} input.network    { uploadBytesPerSec, downloadBytesPerSec } | null
 * @param {object} input.quality    各指标质量：fresh | stale | unavailable
 * @param {object} input.sampledAt  各指标采样时刻（毫秒）
 * @param {object} input.jitter     { [serverId]: { gpu, vram } } 固定扰动（仅用于验收夹具；正常不传）
 */
export function mapPlatformResources(input) {
  const {
    config,
    volumes = [],
    memory = null,
    gpu = null,
    vramTotal,
    network = null,
    quality = {},
    sampledAt = {},
    jitter = null,
    topologyVersion = 1,
    snapshotId,
    epoch,
  } = input;

  const hostId = config.hostId;
  const at = config.atMs ?? Date.now();
  const gpuQuality = quality.gpu ?? "fresh";
  const memoryQuality = quality.memory ?? "fresh";
  const storageQuality = quality.storage ?? "fresh";
  const networkQuality = quality.network ?? "fresh";

  /* ---- 卷 → 服务器（§9.2：一个固定卷一台，CON 编号按盘符排序且稳定） ---- */
  const sorted = [...volumes]
    .filter((volume) => num(volume.totalBytes) > 0)
    .sort((a, b) => String(a.label).localeCompare(String(b.label), "en"));
  const serverCount = sorted.length;

  const storageRatios = sorted.map((volume) => {
    const total = num(volume.totalBytes);
    const free = num(volume.freeBytes);
    if (total === null || total <= 0 || free === null) return null;
    return clamp((total - free) / total, 0, 1);
  });

  /* 合计用未舍入值求和（RES-10）；某一卷使用率读不到时该台为未知，不计入合计 */
  const knownRatios = storageRatios.filter((ratio) => ratio !== null);
  const perServerStorageTb = serverCount > 0 ? STORAGE_TOTAL_TB / serverCount : null;
  const storageUsedTb = perServerStorageTb === null
    ? null
    : knownRatios.reduce((sum, ratio) => sum + perServerStorageTb * ratio, 0);
  /* R_storage 是各卷使用率的算术平均（§9.2 / RES-03），不是容量加权 */
  const storageRatio = knownRatios.length > 0
    ? knownRatios.reduce((sum, ratio) => sum + ratio, 0) / knownRatios.length
    : null;

  /* ---- 内存（§9.3）：物理内存占用比例；不额外浮动 ---- */
  const memoryTotalBytes = memory ? num(memory.totalBytes) : null;
  const memoryAvailableBytes = memory ? num(memory.availableBytes) : null;
  const memoryRatio = memoryTotalBytes && memoryTotalBytes > 0 && memoryAvailableBytes !== null
    ? clamp((memoryTotalBytes - memoryAvailableBytes) / memoryTotalBytes, 0, 1)
    : null;
  const memoryUsedGib = memoryRatio === null ? null : MEMORY_TOTAL_GIB * memoryRatio;
  const perServerMemoryGib = serverCount > 0 ? MEMORY_TOTAL_GIB / serverCount : null;

  /* ---- GPU（§9.4）：基准 g 进摘要，逐台用 g×(1+ε) ---- */
  const gpuBase = gpu ? num(gpu.utilizationPct) : null;
  /* 非法原始值（负数 / >100）标无效，不当作正常样本（RES-17） */
  const gpuValid = gpuBase !== null && gpuBase >= 0 && gpuBase <= 100;
  const gpuBasePercent = gpuValid ? gpuBase : null;
  const gpuQualityFinal = !gpuValid ? "unavailable" : gpuQuality;
  /*
   * GPU 过期 / 不可用时：逐台的 GPU、显存、功耗一起变成未知（§10.3「GPU / 内存
   * 样本超过 30 秒不可用 → 显示 —，负载未知」、§9.6「GPU 样本不可用时功耗也显示 —，
   * 不能继续显示 600 W 冒充已测空闲」）。
   * 注意这时**不冻结扰动**，而是整条链都不出数 —— 冻结住会让人以为「还在正常采集中」。
   */
  const gpuUsable = gpuQualityFinal === "fresh";

  const vramRatioBase = gpu && num(gpu.memoryTotalBytes) > 0 && num(gpu.memoryUsedBytes) !== null
    ? clamp(num(gpu.memoryUsedBytes) / num(gpu.memoryTotalBytes), 0, 1)
    : null;
  /* 显存按容量比算，不用 utilization.memory（§9.4 / RES-16） */

  /*
   * 逐台显存总量的分母：主机实测显存 → 环境覆盖 → 读不到就是未知。
   * 不预置 24 GiB：预置值会让「后端主机按实测比例映射」这句话在界面上自相矛盾。
   */
  const hostVramTotalGib = gpu && num(gpu.memoryTotalBytes) > 0 ? num(gpu.memoryTotalBytes) / GIB_BYTES : null;
  const vramTotalGib = num(vramTotal) ?? VRAM_TOTAL_GIB_OVERRIDE ?? hostVramTotalGib;

  /* ---- 网络（§9.7）：集群只乘一次，不乘服务器数 ---- */
  const upload = network ? num(network.uploadBytesPerSec) : null;
  const download = network ? num(network.downloadBytesPerSec) : null;
  const uploadBps = upload === null ? null : upload * NETWORK_SCALE;
  const downloadBps = download === null ? null : download * NETWORK_SCALE;

  /* ---- 逐台（CON1..CONn） ---- */
  const servers = sorted.map((volume, index) => {
    const id = `CON${index + 1}`;
    const ratio = storageRatios[index];
    const override = jitter?.[id] ?? {};

    /* GPU 与显存各自独立扰动（§9.4），0 基准保持 0、100 封顶 */
    const gpuFactor = 1 + jitterAt(hostId, id, "gpu", at, override.gpu);
    const vramFactor = 1 + jitterAt(hostId, id, "vram", at, override.vram);
    const gpuPercent = !gpuUsable || gpuBasePercent === null ? null : clamp(gpuBasePercent * gpuFactor, 0, 100);
    const vramRatio = !gpuUsable || vramRatioBase === null ? null : clamp(vramRatioBase * vramFactor, 0, 1);
    const vramUsedGib = vramRatio === null || vramTotalGib === null ? null : vramTotalGib * vramRatio;

    /* 功耗用该台未舍入的 g_i 计算（§9.6） */
    const powerW = gpuPercent === null ? null : POWER_MIN_W + (POWER_MAX_W - POWER_MIN_W) * (gpuPercent / 100);

    return {
      id,
      volumeId: volume.id ?? null,
      storage: {
        totalTb: perServerStorageTb,
        usedTb: ratio === null || perServerStorageTb === null ? null : perServerStorageTb * ratio,
        freeTb: ratio === null || perServerStorageTb === null ? null : perServerStorageTb * (1 - ratio),
        ratio,
      },
      memory: {
        totalGib: perServerMemoryGib,
        usedGib: memoryRatio === null || perServerMemoryGib === null ? null : perServerMemoryGib * memoryRatio,
        ratio: memoryRatio,
      },
      gpu: {
        /* 逐台不写型号：CON1..CONn 是映射单元，头上没有任何一张实际安装的卡 */
        percent: gpuPercent,
        load: loadState(gpuPercent, gpuQualityFinal),
        vramUsedGib,
        vramRatio,
      },
      powerW,
    };
  });

  /*
   * 集群功耗 = 逐台未舍入功耗之和（§9.6）。只要有一台未知，合计就是未知 ——
   * 用「已知台数求和」会得到一个看起来正常、实际少算一台的数。
   */
  const powerTotalW = servers.length > 0 && servers.every((server) => server.powerW !== null)
    ? servers.reduce((sum, server) => sum + server.powerW, 0)
    : null;

  return {
    schemaVersion: 1,
    snapshotId: snapshotId ?? `${hostId}:${epoch ?? 1}:${Math.floor(at / 1000)}`,
    hostId,
    epoch: epoch ?? 1,
    topologyVersion,
    mappingVersion: config.mappingVersion ?? MAPPING_VERSION,
    sampledAt: new Date(at).toISOString(),
    /* 顶层质量取四项里最差的一档：界面按它决定要不要在标题区显示「过期」 */
    quality: worstQuality([gpuQualityFinal, memoryQuality, storageQuality, networkQuality]),
    serverCount,
    /* N=0：配置容量仍然给出，其余为未知，绝不虚构 CON1（RES-09） */
    noVolumeReason: serverCount === 0 ? "未识别存储卷" : null,
    /* 显存展示总量的分母（主机实测显存 / 环境覆盖）；读不到就是 null，界面显示「—」 */
    gpuVramTotalGib: vramTotalGib,
    summary: {
      storageTotalTB: STORAGE_TOTAL_TB,
      storageUsedTB: storageUsedTb,
      storageRatio,
      memoryTotalGiB: MEMORY_TOTAL_GIB,
      memoryUsedGiB: memoryUsedGib,
      memoryRatio,
      gpuBasePercent,
      loadState: loadState(gpuBasePercent, gpuQualityFinal),
      powerTotalW,
      uploadBytesPerSec: uploadBps,
      downloadBytesPerSec: downloadBps,
    },
    servers,
    metricQuality: {
      gpu: gpuQualityFinal,
      memory: memoryQuality,
      storage: storageQuality,
      network: networkQuality,
    },
    metricSampledAt: {
      gpu: sampledAt.gpu ?? null,
      memory: sampledAt.memory ?? null,
      storage: sampledAt.storage ?? null,
      network: sampledAt.network ?? null,
    },
  };
}

/** 质量取最差：unavailable > stale > fresh。用于顶层 quality 与界面降级 */
export function worstQuality(list) {
  if (list.includes("unavailable")) return "unavailable";
  if (list.includes("stale")) return "stale";
  return "fresh";
}

/** 字节 → GiB（映射内部与夹具校验共用） */
export const toGib = (bytes) => bytes / GIB_BYTES;
/** 字节 → 十进制 TB */
export const toTb = (bytes) => bytes / TB_BYTES;
