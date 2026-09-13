/**
 * 主机采集的真机回归（**跑在真机上，不是公式验算**）
 *
 * 运行：node server/services/host-sampler.test.mjs
 *
 * 为什么单独有这一份：`platform-resources.test.mjs` 全部用夹具喂公式，
 * 采集器本身一行都没被覆盖。mac→Windows 移植时就栽在这里 ——
 * Windows 分支原来靠 `Get-CimInstance` / `Get-NetAdapter` 读内存、卷、网卡，
 * 而**WMI 被系统策略拒绝的机器**上这些命令一律抛
 * `拒绝访问`（HRESULT 0x80041003），三项同时失败：
 *   总览「平台数据」五行全是「—」，界面显示「连接中断：没有这个接口 …」
 *   —— 看起来像接口 404（其实接口 200），排查方向被彻底带偏。
 *
 * 所以这份测试的断言只有一句：**这台机器上采集器能不能读到真值**。
 * 读不到就是失败，不降级、不跳过（§2「未知数据」：不许用 0 或模拟值兜底）。
 *
 * 已知的环境性例外 —— GPU：没有可采集的 GPU 时 `readGpu()` 返回 null 是
 * **设计内**行为（PRD §10.3 明令不许拿 CPU 占用顶替），不算失败；
 * 但内存 / 卷 / 网络三项读不到一定是环境或代码出了问题。
 */

import { createHostSampler } from "./host-sampler.mjs";

/** 采集钟 2 秒一拍；网络要两拍才能差分出速率（F4-1 首样本只建基线） */
const SETTLE_MS = 5200;

let failed = 0;
let passed = 0;

function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`✓ ${name}`);
  } else {
    failed += 1;
    console.error(`✗ ${name}${detail ? `\n    ${detail}` : ""}`);
  }
}

/** 把采集器给出的错误原文附在失败信息里，别让人再去猜 */
function explain(errors) {
  const lines = Object.entries(errors ?? {})
    .filter(([, message]) => message)
    .map(([metric, message]) => `${metric}: ${String(message).split("\n")[0]}`);
  return lines.length > 0 ? lines.join("\n    ") : "（采集器没有给出错误原因）";
}

const gib = (bytes) => (typeof bytes === "number" ? bytes / 1024 ** 3 : null);

console.log(`\n— 真机采集（platform=${process.platform} arch=${process.arch}）`);

const sampler = createHostSampler({ stateFile: "server/data/platform-resources.test.json" });
await sampler.start();
await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

const input = sampler.snapshotInput();
const explainText = sampler.describe();

/* 内存：Windows 走 GetPhysicallyInstalledSystemMemory，linux/darwin 走各自分支 */
check(
  "内存：读到物理内存总量",
  gib(input.memory?.totalBytes) !== null && gib(input.memory.totalBytes) > 1,
  `totalBytes=${input.memory?.totalBytes}  ${explain(input.errors)}`,
);
check(
  "内存：读到可用内存",
  gib(input.memory?.availableBytes) !== null,
  `availableBytes=${input.memory?.availableBytes}  ${explain(input.errors)}`,
);

/* 卷：Windows 走 Get-PSDrive + vol，macOS 走 diskutil，Linux 走 df */
check(
  "存储：识别到至少一个固定卷",
  Array.isArray(input.volumes) && input.volumes.length > 0,
  `volumes=${input.volumes?.length ?? 0}  ${explain(input.errors)}`,
);
if (Array.isArray(input.volumes) && input.volumes.length > 0) {
  check(
    "存储：每个卷都有稳定 id 与正容量",
    input.volumes.every((v) => v.id && v.totalBytes > 0 && v.freeBytes >= 0),
    JSON.stringify(input.volumes),
  );
  check(
    "存储：卷 id 不是空串（盘符 / 序列号必须落在快照里）",
    input.volumes.every((v) => String(v.id).trim().length > 0),
    JSON.stringify(input.volumes.map((v) => v.id)),
  );
}

/* 网络：读不到计数器时 network 恒为 null，平台上行/下行就是「—」 */
check(
  "网络：读到网卡累计计数器（速率已差分）",
  input.network !== null &&
    Number.isFinite(input.network.uploadBytesPerSec) &&
    Number.isFinite(input.network.downloadBytesPerSec),
  `network=${JSON.stringify(input.network)}  ${explain(input.errors)}`,
);
check(
  "网络：至少认出一张物理网卡（虚拟适配器已排除）",
  Array.isArray(explainText.networkInterfaces) && explainText.networkInterfaces.length > 0,
  `interfaces=${JSON.stringify(explainText.networkInterfaces)}  ${explain(input.errors)}`,
);

/* GPU：没有采集能力是设计内行为，只要求「要么有值、要么明确报没有」 */
if (input.gpu) {
  check(
    "GPU：读到利用率",
    Number.isFinite(input.gpu.utilizationPct),
    JSON.stringify(input.gpu),
  );
} else {
  console.log(`— GPU：本机没有可采集的独立 GPU（设计内，不计失败）：${input.errors.gpu}`);
}

/* 质量与自述：采样时间戳必须真的在走，否则前端只会一直显示「数据不可用」 */
const metrics = ["memory", "storage", "network"];
check(
  "质量：内存 / 存储 / 网络三项都不是 unavailable",
  metrics.every((metric) => input.quality[metric] !== "unavailable"),
  `quality=${JSON.stringify(input.quality)}  ${explain(input.errors)}`,
);
check(
  "自述：hostId 带平台后缀（快照要能追溯是哪台机器）",
  typeof sampler.hostId === "string" && sampler.hostId.endsWith(process.platform),
  `hostId=${sampler.hostId}`,
);

sampler.stop();

console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
if (failed > 0) {
  console.error(
    "\n提示：Windows 上内存/卷/网卡读不到，通常是把采集写成了 WMI 调用\n" +
      "（Get-CimInstance / Get-Volume / Get-NetAdapter*）。\n" +
      "在 WMI 被策略拒绝的机器上这些命令抛 HRESULT 0x80041003（拒绝访问），\n" +
      "即使管理员也一样；请改用 Get-PSDrive / .NET 类型 / Node 内置 API。",
  );
}
process.exit(failed === 0 ? 0 : 1);
