/**
 * 后端主机的只读资源采集
 *
 * 只做「读原始值」，不做任何映射（映射在 `platform-resources.mjs`）。
 * 所有外部命令都以**固定参数数组**调用，不接受浏览器传入的命令、路径或主机地址（PRD §10.1）。
 *
 * 采样时钟（PRD §9.1）：
 *   · GPU / 内存 / 网卡  2 秒
 *   · 磁盘空间          15 秒
 *   · 卷拓扑            30 秒（并且要连续两次确认才认变更）
 * 单次采集超时 3 秒；上一次没跑完就跳过这一拍，不叠进程（§10.1 / ERR-04）。
 *
 * 质量与降级（§10.3）：每项指标各自带 sampledAt 与 quality，某项失败不影响其他项。
 * 读不到就是 null —— 不用 0、"空闲" 或任何模拟值兜底（§2「未知数据」）。
 */

import { execFile } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { cpus, totalmem } from "node:os";
import { promisify } from "node:util";
import { num } from "./platform-resources.mjs";

const run = promisify(execFile);
const TIMEOUT_MS = 3000;

const GIB = 1024 ** 3;

async function exec(command, args, options = {}) {
  const { stdout } = await run(command, args, { timeout: TIMEOUT_MS, maxBuffer: 1 << 22, ...options });
  return stdout;
}

/* ------------------------------------------------------------------ *
 * 固定卷（§9.2 / §10.1）
 * ------------------------------------------------------------------ */

/**
 * Windows：Win32_LogicalDisk DriveType=3（本地固定盘）才算「固定卷」。
 * 无盘符隐藏卷、光驱、网络盘、可移除盘都不计入（§2 / RES-05）。
 */
async function readVolumesWindows() {
  const stdout = await exec("powershell", [
    "-NoProfile",
    "-Command",
    "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | " +
      "Select-Object DeviceID,VolumeSerialNumber,Size,FreeSpace | ConvertTo-Json -Compress",
  ]);
  const rows = JSON.parse(stdout || "[]");
  const list = Array.isArray(rows) ? rows : [rows];
  return list
    .filter((row) => num(Number(row.Size)) > 0)
    .map((row) => ({
      /* 稳定标识优先用卷序列号：盘符可能变，序列号跟着卷走（RES-06） */
      id: String(row.VolumeSerialNumber ?? row.DeviceID),
      label: String(row.DeviceID ?? ""),
      totalBytes: Number(row.Size),
      freeBytes: Number(row.FreeSpace),
    }));
}

/**
 * macOS / Linux：df 只给挂载点，这里按「一块物理盘 = 一个数据卷」折算。
 *
 * 需求口径是「有盘符的本地固定卷」；macOS 没有盘符，等价物就是
 * **每块物理磁盘上的数据卷**（`/System/Volumes/Data`）。
 * Recovery / Preboot / VM 是同一块盘上的系统卷，算进去就是把同一块盘数两遍。
 */
async function readVolumesUnix() {
  if (process.platform === "darwin") {
    const list = await exec("diskutil", ["list"]).then((stdout) =>
      stdout
        .split("\n")
        .filter((line) => /\(.*physical.*\):/.test(line))
        .map((line) => line.match(/^(\/dev\/disk\d+)/)?.[1])
        .filter(Boolean),
    );
    const volumes = [];
    for (const [index, device] of list.entries()) {
      const info = await exec("diskutil", ["info", device]).catch(() => "");
      const total = Number(info.match(/Disk Size:\s+[^\n]*?\((\d+)\s+Bytes\)/i)?.[1] ?? 0);
      if (total <= 0) continue;
      /* 数据卷的已用：df 的 Used 列（单位 1024 块） */
      const target = index === 0 ? "/System/Volumes/Data" : `/Volumes/${device.split("/").pop()}`;
      const df = await exec("df", ["-kP", target]).catch(() => "");
      const cols = df.trim().split("\n")[1]?.trim().split(/\s+/);
      const usedKb = Number(cols?.[2]);
      const free = Number.isFinite(usedKb) ? total - usedKb * 1024 : 0;
      volumes.push({
        id: `${device}`,
        label: device.replace("/dev/", ""),
        totalBytes: total,
        freeBytes: Math.max(0, free),
      });
    }
    if (volumes.length > 0) return volumes;
  }

  /* Linux（以及 macOS 的兜底）：df -P 按设备去重，跳过内存盘与虚拟文件系统 */
  const stdout = await exec("df", ["-kP"]);
  const skip = /^(tmpfs|devtmpfs|overlay|shm|none|udev|squashfs|ramfs)$/;
  const seen = new Set();
  const volumes = [];
  for (const line of stdout.trim().split("\n").slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 6) continue;
    const [device, blocks, used] = cols;
    if (skip.test(device) || seen.has(device)) continue;
    const totalKb = Number(blocks);
    if (!Number.isFinite(totalKb) || totalKb <= 0) continue;
    seen.add(device);
    volumes.push({
      id: device,
      label: device,
      totalBytes: totalKb * 1024,
      freeBytes: Math.max(0, totalKb * 1024 - Number(used) * 1024),
    });
  }
  return volumes;
}

/* ------------------------------------------------------------------ *
 * 物理内存（§9.3）：只用物理内存，不用 Node 进程内存 / 虚拟内存（RES-12）
 * ------------------------------------------------------------------ */

async function readMemory() {
  if (process.platform === "linux") {
    const text = await readFile("/proc/meminfo", "utf8");
    const pick = (key) => {
      const match = text.match(new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, "m"));
      return match ? Number(match[1]) * 1024 : null;
    };
    const total = pick("MemTotal");
    const available = pick("MemAvailable");
    if (total && available !== null) return { totalBytes: total, availableBytes: available };
  }

  if (process.platform === "darwin") {
    /* available 近似 = free + inactive + speculative + purgeable（与活动监视器同口径） */
    const [vmOut, pageSizeOut] = await Promise.all([
      exec("vm_stat"),
      exec("sysctl", ["-n", "hw.pagesize"]),
    ]);
    const pageSize = Number(pageSizeOut.trim()) || 4096;
    const pages = (key) => Number(vmOut.match(new RegExp(`${key}:\\s+(\\d+)`))?.[1] ?? 0);
    const freePages =
      pages("Pages free") + pages("Pages inactive") + pages("Pages speculative") + pages("Pages purgeable");
    return { totalBytes: totalmem(), availableBytes: freePages * pageSize };
  }

  if (process.platform === "win32") {
    const stdout = await exec("powershell", [
      "-NoProfile",
      "-Command",
      "$o=Get-CimInstance Win32_OperatingSystem; \"$($o.TotalVisibleMemorySize) $($o.FreePhysicalMemory)\"",
    ]);
    const [totalKb, freeKb] = stdout.trim().split(/\s+/).map(Number);
    if (totalKb > 0) return { totalBytes: totalKb * 1024, availableBytes: freeKb * 1024 };
  }

  return { totalBytes: totalmem(), availableBytes: null };
}

/* ------------------------------------------------------------------ *
 * GPU（§9.4）
 * ------------------------------------------------------------------ */

/**
 * 选中的独立 GPU。
 *
 * Windows / Linux 走 nvidia-smi：默认选**显存最大**的那张，可用
 * MUMAI_GPU_UUID 固定到某一张（PRD §2「允许配置 UUID 固定选择」）。
 * 显存占用率取 memory.used / memory.total，**不用** utilization.memory（RES-16）。
 */
async function readGpu() {
  const query = "uuid,name,utilization.gpu,memory.used,memory.total";
  const args = ["--query-gpu=" + query, "--format=csv,noheader,nounits"];
  const wantUuid = process.env.MUMAI_GPU_UUID;
  if (wantUuid) args.push("--id=" + wantUuid);

  const stdout = await exec("nvidia-smi", args).catch(() => "");
  if (stdout.trim()) {
    const rows = stdout
      .trim()
      .split("\n")
      .map((line) => line.split(",").map((cell) => cell.trim()))
      .filter((cells) => cells.length >= 5)
      .map(([uuid, name, util, used, total]) => ({
        uuid,
        name,
        utilizationPct: Number(util),
        memoryUsedBytes: Number(used) * 1024 ** 2,
        memoryTotalBytes: Number(total) * 1024 ** 2,
      }))
      .filter((row) => Number.isFinite(row.utilizationPct) && row.memoryTotalBytes > 0);
    if (rows.length > 0) {
      const selected = wantUuid ? rows[0] : rows.reduce((best, row) => (row.memoryTotalBytes > best.memoryTotalBytes ? row : best));
      return { source: "nvidia-smi", ...selected };
    }
  }

  /*
   * macOS：ioreg 拿到的是集成 GPU 的真实占用。它不是「独立 GPU」，
   * 但这是后端主机**真实采到的** GPU 利用率，比用 CPU 负载顶替要诚实得多
   * （§10.3 明令「不用 CPU 占用代替 GPU」）。显存读不到就保持 null。
   */
  if (process.platform === "darwin") {
    const stdout = await exec("ioreg", ["-r", "-d", "1", "-w", "0", "-c", "IOAccelerator"]).catch(() => "");
    const match = stdout.match(/"Device Utilization %"\s*=\s*(\d+)/);
    if (match) {
      return {
        source: "ioreg",
        uuid: null,
        name: "Apple Integrated GPU",
        utilizationPct: Number(match[1]),
        memoryUsedBytes: null,
        memoryTotalBytes: null,
      };
    }
  }

  /* 没有可采集的 GPU：返回 null，让上层把 GPU / 显存 / 功耗一起标为不可用 */
  return null;
}

/* ------------------------------------------------------------------ *
 * 网卡（§9.7）
 * ------------------------------------------------------------------ */

/** 排除回环 / VPN / 虚拟网桥，避免同一份流量被数两遍（RES-26） */
const VIRTUAL_INTERFACE = /^(lo|utun|awdl|llw|bridge|vmnet|vnic|docker|veth|br-|tun|tap|Tailscale|ZeroTier)/i;

/**
 * 选定活动物理网卡的累计收发字节数。
 * 返回的是**累计值**：速率由调用方按真实时间间隔差分（§9.7）。
 */
async function readNetworkCounters() {
  if (process.platform === "linux") {
    const text = await readFile("/proc/net/dev", "utf8");
    let sent = 0;
    let received = 0;
    const used = [];
    for (const line of text.split("\n").slice(2)) {
      const [rawName, rest] = line.split(":");
      const name = rawName?.trim();
      if (!rest || !name || VIRTUAL_INTERFACE.test(name)) continue;
      const cols = rest.trim().split(/\s+/).map(Number);
      received += cols[0] || 0;
      sent += cols[8] || 0;
      used.push(name);
    }
    return { sent, received, interfaces: used };
  }

  if (process.platform === "darwin") {
    const stdout = await exec("netstat", ["-ib"]);
    const lines = stdout.trim().split("\n");
    const header = lines[0].trim().split(/\s+/);
    const nameAt = 0;
    const ibAt = header.indexOf("Ibytes");
    const obAt = header.indexOf("Obytes");
    let sent = 0;
    let received = 0;
    const seen = new Set();
    const used = [];
    for (const line of lines.slice(1)) {
      const cols = line.trim().split(/\s+/);
      const name = cols[nameAt];
      /* 同一接口会出现多行（不同地址族），按接口名去重只取第一行 */
      if (!name || seen.has(name) || VIRTUAL_INTERFACE.test(name)) continue;
      const ib = Number(cols[ibAt]);
      const ob = Number(cols[obAt]);
      if (!Number.isFinite(ib) || !Number.isFinite(ob)) continue;
      seen.add(name);
      received += ib;
      sent += ob;
      used.push(name);
    }
    return { sent, received, interfaces: used };
  }

  const stdout = await exec("powershell", [
    "-NoProfile",
    "-Command",
    "$rows = Get-NetAdapter | Where-Object {$_.Status -eq 'Up' -and -not $_.Virtual} | " +
      "ForEach-Object { $s = $_ | Get-NetAdapterStatistics; [pscustomobject]@{Name=$_.Name;Sent=$s.SentBytes;Received=$s.ReceivedBytes} }; " +
      "$rows | ConvertTo-Json -Compress",
  ]);
  const rows = JSON.parse(stdout || "[]");
  const list = Array.isArray(rows) ? rows : [rows];
  let sent = 0;
  let received = 0;
  const used = [];
  for (const row of list) {
    const s = Number(row.Sent);
    const r = Number(row.Received);
    if (!Number.isFinite(s) || !Number.isFinite(r)) continue;
    sent += s;
    received += r;
    used.push(String(row.Name));
  }
  return { sent, received, interfaces: used };
}

/* ------------------------------------------------------------------ *
 * 采样器
 * ------------------------------------------------------------------ */

/** 各项质量时间窗（§10.3） */
const STALE_MS = { gpu: 6000, memory: 6000, network: 6000, storage: 45000 };
/** 超过这个时长直接算不可用 */
const UNAVAILABLE_MS = { gpu: 30000, memory: 30000, network: 30000, storage: 120000 };

/** 60 秒历史（§10.3：内存环形缓冲，不写库） */
const HISTORY_MS = 60000;

export function createHostSampler({ stateFile = resolve("server/data/platform-resources.json") } = {}) {
  const hostId = `${process.env.MUMAI_HOST_ID ?? "host"}-${process.platform}`;
  let epoch = 1;

  /** 最新原始样本 */
  const samples = {
    gpu: null,
    memory: null,
    storage: null,
    network: null,
  };
  const sampledAt = { gpu: 0, memory: 0, storage: 0, network: 0 };
  const errors = { gpu: null, memory: null, storage: null, network: null };

  /** 卷拓扑：连续两次确认才认变更（§9.2 / RES-08） */
  let topology = { signature: "", version: 1, pending: null, pendingHits: 0, volumes: [] };
  let lastVolumeCheck = 0;
  let lastNetworkCounters = null;
  const history = [];

  let running = false;
  let timer = null;

  async function loadState() {
    try {
      const raw = JSON.parse(await readFile(stateFile, "utf8"));
      if (raw && raw.signature) {
        topology = { ...topology, signature: raw.signature, version: raw.version ?? 1 };
        epoch = raw.epoch ?? 1;
      }
    } catch {
      /* 首次运行没有状态文件：保持默认 */
    }
  }

  async function saveState() {
    try {
      await mkdir(dirname(stateFile), { recursive: true });
      await writeFile(stateFile, JSON.stringify({ signature: topology.signature, version: topology.version, epoch }));
    } catch {
      /* 写不进去不影响本次采集 */
    }
  }

  function qualityOf(metric, now) {
    const age = now - sampledAt[metric];
    if (!sampledAt[metric]) return "unavailable";
    if (age > UNAVAILABLE_MS[metric]) return "unavailable";
    if (age > STALE_MS[metric]) return "stale";
    return "fresh";
  }

  async function sampleVolumes(now) {
    if (now - lastVolumeCheck < 15000) return;
    lastVolumeCheck = now;
    let volumes;
    try {
      volumes = process.platform === "win32" ? await readVolumesWindows() : await readVolumesUnix();
    } catch (error) {
      /* 查询失败：保留原拓扑并标过期，不减少服务器数（RES-08） */
      errors.storage = error instanceof Error ? error.message : String(error);
      return;
    }
    errors.storage = null;
    const signature = volumes.map((volume) => volume.id).sort().join(",");
    if (signature === topology.signature) {
      topology.pending = null;
      topology.pendingHits = 0;
      topology.volumes = volumes;
      samples.storage = volumes;
      sampledAt.storage = now;
      return;
    }
    /* 连续两次确认才变更 topologyVersion（RES-07） */
    if (topology.pending === signature) topology.pendingHits += 1;
    else {
      topology.pending = signature;
      topology.pendingHits = 1;
    }
    topology.volumes = volumes;
    samples.storage = volumes;
    sampledAt.storage = now;
    if (topology.pendingHits >= 2) {
      topology.signature = signature;
      topology.version += 1;
      topology.pending = null;
      topology.pendingHits = 0;
      await saveState();
    }
  }

  async function sampleMemory(now) {
    try {
      samples.memory = await readMemory();
      sampledAt.memory = now;
      errors.memory = null;
    } catch (error) {
      errors.memory = error instanceof Error ? error.message : String(error);
    }
  }

  async function sampleGpu(now) {
    try {
      const gpu = await readGpu();
      /* 采不到就是 null：不清空上一次样本，由 quality 的时间窗决定它还算不算数 */
      if (gpu) {
        samples.gpu = gpu;
        sampledAt.gpu = now;
      }
      errors.gpu = gpu ? null : "未检测到可采集的 GPU";
    } catch (error) {
      errors.gpu = error instanceof Error ? error.message : String(error);
    }
  }

  async function sampleNetwork(now) {
    try {
      const counters = await readNetworkCounters();
      const previous = lastNetworkCounters;
      lastNetworkCounters = { ...counters, at: now };
      if (!previous) {
        /* 首样本只建基线（F4-1） */
        samples.network = { uploadBytesPerSec: null, downloadBytesPerSec: null, sampling: true, interfaces: counters.interfaces };
        sampledAt.network = now;
        errors.network = null;
        return;
      }
      const elapsed = (now - previous.at) / 1000;
      const sentDelta = counters.sent - previous.sent;
      const receivedDelta = counters.received - previous.received;
      /* 计数器回退（接口重建 / 重启）：重新建基线，不出负速率（F4-4） */
      if (elapsed <= 0 || sentDelta < 0 || receivedDelta < 0) {
        samples.network = { uploadBytesPerSec: null, downloadBytesPerSec: null, sampling: true, interfaces: counters.interfaces };
        sampledAt.network = now;
        errors.network = "计数器回退，已重建基线";
        return;
      }
      samples.network = {
        /* 间隔用真实单调时钟差，不写死 2 秒（§9.7 / RES-23） */
        uploadBytesPerSec: sentDelta / elapsed,
        downloadBytesPerSec: receivedDelta / elapsed,
        sampling: false,
        interfaces: counters.interfaces,
      };
      sampledAt.network = now;
      errors.network = null;
    } catch (error) {
      errors.network = error instanceof Error ? error.message : String(error);
    }
  }

  async function tick() {
    if (running) return;
    running = true;
    const now = Date.now();
    try {
      await Promise.all([sampleVolumes(now), sampleMemory(now), sampleGpu(now), sampleNetwork(now)]);
      const network = samples.network;
      if (network && !network.sampling) {
        history.push({ at: now, upload: network.uploadBytesPerSec, download: network.downloadBytesPerSec });
        while (history.length > 0 && now - history[0].at > HISTORY_MS) history.shift();
      }
    } finally {
      running = false;
    }
  }

  return {
    hostId,
    /** 启动采集循环（2 秒一拍；磁盘与拓扑按各自间隔跳过） */
    async start(intervalMs = 2000) {
      await loadState();
      await tick();
      timer = setInterval(() => void tick(), intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    /** 最新原始样本 + 质量（映射器要的全部输入） */
    snapshotInput() {
      const now = Date.now();
      return {
        config: { hostId, atMs: now },
        volumes: samples.storage ?? [],
        memory: samples.memory,
        gpu: samples.gpu,
        network: samples.network && !samples.network.sampling ? samples.network : null,
        quality: {
          gpu: qualityOf("gpu", now),
          memory: qualityOf("memory", now),
          storage: qualityOf("storage", now),
          network: qualityOf("network", now),
        },
        sampledAt: { ...sampledAt },
        topologyVersion: topology.version,
        epoch,
        errors: { ...errors },
      };
    },
    history(windowSec = 60) {
      const now = Date.now();
      return history.filter((point) => now - point.at <= windowSec * 1000);
    },
    /** 采集器自述：供弹窗的「映射说明」追溯来源 */
    describe() {
      return {
        hostId,
        platform: process.platform,
        arch: process.arch,
        cpuCores: cpus().length,
        physicalMemoryBytes: totalmem(),
        gpuSource: samples.gpu?.source ?? null,
        gpuName: samples.gpu?.name ?? null,
        networkInterfaces: samples.network?.interfaces ?? [],
        topologyVersion: topology.version,
        epoch,
        errors: { ...errors },
      };
    },
  };
}

export const GIB_BYTES = GIB;
