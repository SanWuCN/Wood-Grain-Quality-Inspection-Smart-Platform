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
import { cpus, freemem, totalmem } from "node:os";
import { promisify } from "node:util";
import { num } from "./platform-resources.mjs";

const run = promisify(execFile);
const TIMEOUT_MS = 3000;

const GIB = 1024 ** 3;

/**
 * 执行一个采集命令。
 *
 * ⚠ **`windowsHide: true` 是硬要求，不能去掉**（2026-09-15 定位到的一个真实故障）。
 *
 * `execFile` 在 Windows 上默认**为每个子进程创建一个可见的控制台窗口**。
 * 采集器每 2 秒跑一拍（见下方 `start(intervalMs = 2000)`），而每一拍都会调
 * `powershell` / `nvidia-smi` / `netstat` —— 于是桌面上就出现
 * **每 2 秒弹出一次、随即消失的 cmd 窗口**，成串、停不下来。
 *
 * 用户侧的描述是「反复弹出一堆类 cmd 窗口又消失」，而且这类窗口
 * 与"平台自己在跑"强相关（服务一被停掉，闪烁立刻消失）。
 * 排查时先怀疑过远控软件、华硕奥创、计划任务，都不是 ——
 * 真凶就是这里少了一个 `windowsHide`。
 *
 * 放在**默认值**里而不是各个调用点：本文件有 8 处 `exec()` 调用
 * （powershell ×3、nvidia-smi、netstat、df/vm_stat/sysctl/ioreg/diskutil），
 * 逐处加必然会漏；`...options` 仍在最后，个别调用需要覆盖时依然能覆盖。
 */
async function exec(command, args, options = {}) {
  const { stdout } = await run(command, args, {
    timeout: TIMEOUT_MS,
    maxBuffer: 1 << 22,
    windowsHide: true,
    ...options,
  });
  return stdout;
}

/* ------------------------------------------------------------------ *
 * Windows 采集的公共约定（见 readVolumesWindows 的注释）
 * ------------------------------------------------------------------ */

/**
 * PowerShell 侧一律把结果 **UTF-8 → Base64** 回传：
 * 管道输出会按控制台代码页编码，中文卷标 / 网卡名（「以太网」「软件」）直接变乱码。
 */
function decodeBase64Json(stdout) {
  const payload = String(stdout).trim().split(/\s+/).pop();
  if (!payload) return [];
  return JSON.parse(Buffer.from(payload, "base64").toString("utf8") || "[]");
}

/**
 * 「不依赖 WMI」的 Windows 读法为什么是硬要求：
 *
 * 在 WMI 被策略拒绝的 Windows 上（本机实测 Win11：`Get-CimInstance` 抛
 * `拒绝访问`，HRESULT 0x80041003），`Get-CimInstance Win32_*`、
 * `Get-Volume`、`Get-NetAdapter*` 全部不可用 —— 连**管理员**也一样。
 * 采集器三项（内存 / 卷 / 网卡）同时失败时，总览「平台数据」五行都是「—」，
 * 界面还会显示「连接中断」，看起来像接口没了（其实接口 200）。
 *
 * 因此 Windows 分支只允许用这三类读法：
 *   · Node 内置（`os.*`、`fs.*`）
 *   · `Get-PSDrive`（读注册表）
 *   · `[System.Net.NetworkInformation]` / `[System.IO]` 等 .NET 类型
 *   · 外部命令的文本输出（`vol`、`nvidia-smi`）
 * 新增采集项时请沿用，别把 WMI 调用再加回来。
 */

/* ------------------------------------------------------------------ *
 * 固定卷（§9.2 / §10.1）
 * ------------------------------------------------------------------ */

/**
 * Windows：逻辑盘里的**本地固定卷**才算数 —— 无盘符隐藏卷、光驱、网络盘、
 * 可移除盘都不计入（§2 / RES-05）。
 *
 * ⚠️ 必须用**不经过 WMI/CIM** 的读法，这是 mac→Windows 移植踩过的坑：
 * `Get-CimInstance` / `Get-Volume` / `Get-NetAdapter*` 在 WMI 被系统策略拒绝的
 * 机器上会抛 `拒绝访问 / 无法从客户端中访问 CIM 资源`
 * （HRESULT 0x80041003 / 0x800706BA，且**普通权限与管理员都一样**）。
 * 采集器一失败，总览「平台数据」整列就是「—」，界面还显示「连接中断」，
 * 很容易被误读成接口挂了。
 *
 *   · 卷列表 / 容量 / 卷标 → `[System.IO.DriveInfo]::GetDrives()`（Win32 直接调用）
 *   · 卷序列号             → `GetVolumeInformation`（kernel32 P/Invoke，稳定标识，
 *                            盘符变它不变，RES-06）
 *
 * 读法选择是量过的：本机实测单次 PowerShell 启动约 0.8–1.2 秒，而
 * `Get-PSDrive` 要 3.4–4.1 秒、再加上每个盘一次 `vol` 是 3.6–5.1 秒 ——
 * **超过 §10.1 规定的 3 秒单次采集超时**，卷会一直采样失败（表现为「存储」
 * 长期停在「—」）。DriveInfo + 卷 API 是 0.8–1.8 秒，留足余量。
 *
 * 走 PowerShell 的编码陷阱：管道输出按控制台代码页编码，中文卷标会变乱码。
 * 所以固定用 **UTF-8 → Base64** 回传，由 Node 侧解码（见 `decodeBase64Json`）。
 */
async function readVolumesWindows() {
  const stdout = await exec("powershell", [
    "-NoProfile",
    "-Command",
    [
      "$sig = @'",
      "using System;",
      "using System.Text;",
      "using System.Runtime.InteropServices;",
      "public static class MumaiVolume {",
      '  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]',
      "  public static extern bool GetVolumeInformation(string root, StringBuilder label, int labelSize,",
      "    out uint serial, out uint maxComponent, out uint flags, StringBuilder fileSystem, int fileSystemSize);",
      "}",
      "'@",
      "Add-Type -TypeDefinition $sig | Out-Null",
      "$rows = @()",
      "foreach ($d in [System.IO.DriveInfo]::GetDrives()) {",
      "  if ($d.DriveType -ne 'Fixed') { continue }",
      "  if (-not $d.IsReady) { continue }",
      "  if ($d.TotalSize -le 0) { continue }",
      "  $label = New-Object System.Text.StringBuilder 256",
      "  $fileSystem = New-Object System.Text.StringBuilder 256",
      "  $serial = [uint32]0; $maxComponent = [uint32]0; $flags = [uint32]0",
      "  $ok = [MumaiVolume]::GetVolumeInformation($d.Name, $label, 256, [ref]$serial, [ref]$maxComponent, [ref]$flags, $fileSystem, 256)",
      "  $serialText = if ($ok) { '{0:X4}-{1:X4}' -f ($serial -shr 16), ($serial -band 0xFFFF) } else { '' }",
      "  $rows += [pscustomobject]@{ Name = $d.Name.Substring(0, 1); Label = $label.ToString(); Serial = $serialText;",
      "    Total = [double]$d.TotalSize; Free = [double]$d.AvailableFreeSpace }",
      "}",
      "[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($rows | ConvertTo-Json -Compress)))",
      /* 语句之间必须是换行（或分号）：拼成一行 PowerShell 会报 UnexpectedToken */
    ].join("\n"),
  ]);
  const rows = decodeBase64Json(stdout);
  const list = Array.isArray(rows) ? rows : [rows];
  return list
    .filter((row) => num(Number(row.Total)) > 0)
    .map((row) => ({
      /* 稳定标识优先用卷序列号：盘符可能变，序列号跟着卷走（RES-06） */
      id: String(row.Serial || row.Name || ""),
      label: String(row.Name ?? ""),
      totalBytes: Number(row.Total),
      freeBytes: Number(row.Free),
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
    /*
     * Windows 不碰 WMI（原因见文件上方约定）：
     *   · 总内存 → `GetPhysicallyInstalledSystemMemory`（kernel32 P/Invoke，
     *     返回**已安装**物理内存，与任务管理器口径一致；它比 `os.totalmem()`
     *     更准 —— 后者在核显共享显存 / 保留内存的机器上会少算 1–2 GiB）
     *   · 可用   → `os.freemem()`（GlobalMemoryStatusEx，Node 内置）
     */
    const stdout = await exec("powershell", [
      "-NoProfile",
      "-Command",
      [
        '$sig = @"',
        "using System;",
        "using System.Runtime.InteropServices;",
        "public static class MumaiMemory {",
        '  [DllImport("kernel32.dll", SetLastError = true)]',
        "  [return: MarshalAs(UnmanagedType.Bool)]",
        "  public static extern bool GetPhysicallyInstalledSystemMemory(out ulong kiloBytes);",
        "}",
        '"@',
        "Add-Type -TypeDefinition $sig | Out-Null",
        "$kiloBytes = [uint64]0",
        "if ([MumaiMemory]::GetPhysicallyInstalledSystemMemory([ref]$kiloBytes) -and $kiloBytes -gt 0)",
        '{ [string]$kiloBytes } else { throw "GetPhysicallyInstalledSystemMemory 读取失败" }',
      ].join("\n"),
    ]);
    const totalKb = Number(stdout.trim());
    if (!Number.isFinite(totalKb) || totalKb <= 0) throw new Error("Windows 物理内存读取失败");
    return { totalBytes: totalKb * 1024, availableBytes: freemem() };
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

  /*
   * Windows：`[System.Net.NetworkInformation.NetworkInterface]`（IP 助手 API，
   * **不经过 WMI**）。原来的 `Get-NetAdapter` + `Get-NetAdapterStatistics` 在本机
   * 直接抛 `拒绝访问`（0x80041003），网络这一项永远是「—」。
   *
   * 口径与 macOS 分支对齐：只看 Up 的物理网卡，虚拟适配器一律排除
   * （vEthernet / VMware / VirtualBox / Radmin / WireGuard / Tailscale …），
   * 否则同一份流量会被数两遍（RES-26）。
   */
  const stdout = await exec("powershell", [
    "-NoProfile",
    "-Command",
    [
      "$skip = 'Loopback|Tunnel|Radmin|VirtualBox|VMware|Hyper-V|vEthernet|TAP-|WireGuard|Tailscale|ZeroTier|Virtual Adapter|Pseudo-Interface|Bluetooth|Npcap|WAN Miniport'",
      "$rows = @()",
      "foreach ($i in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {",
      "  if ($i.OperationalStatus -ne 'Up') { continue }",
      "  if ($i.NetworkInterfaceType -eq 'Loopback') { continue }",
      "  if (($i.Name + ' ' + $i.Description) -match $skip) { continue }",
      "  $s = $null",
      "  try { $s = $i.GetIPStatistics() } catch { continue }",
      "  if (-not $s) { continue }",
      "  $rows += [pscustomobject]@{ Name = $i.Name; Sent = [double]$s.BytesSent; Received = [double]$s.BytesReceived }",
      "}",
      "[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($rows | ConvertTo-Json -Compress)))",
      /* 换行不能省：拼成一行 PowerShell 会在 `$rows` / `foreach` 上报 UnexpectedToken */
    ].join("\n"),
  ]);
  const rows = decodeBase64Json(stdout);
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
