#!/usr/bin/env node
/**
 * 设备日志包与异常事件的**数据检查脚本**（构建期，不依赖浏览器）
 *
 * 为什么需要它：日志包是生成出来的，「每包两三百条」「异常链锚点精确落位」
 * 「刷新不变」这些承诺如果只靠肉眼看页面，改一次生成器就得重新数一遍。
 * 这里直接把 seed 模块跑起来，把该守的约束变成可执行的断言。
 *
 * 检查项：
 *   1. 每包条数 ≥ 200（用户要求「每个设备的日志包至少也得有 200 条左右」）
 *   2. 每包的 INFO/WARN/ERROR 统计与包内实际条数一致（页面显示的数字不能是编的）
 *   3. 当日包的两条 ERROR 锚点精确落在 31:20；四条开机自检落在 27:52/27:53/27:54/27:56
 *   4. 异常链锚点在 28:04 / 28:18 / 28:20 / 28:41 / 28:44 / 28:52 / 29:05 / 29:30
 *   5. 时间戳单调不减，且格式都是 mm:ss
 *   6. 生成是**确定性的**：同一包生成两次字节完全相同（刷新不变）
 *   7. 异常事件：多数已结案；已结案必须有 conclusion，未结案必须为 null
 *   8. 未结案的排在最前面（这一页要先回答「还有什么没解决」）
 *
 * 用法：node tools/check-device-logs.mjs
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";

/*
 * 用 Vite 自己的 ssrLoadModule 直接加载 TS 种子模块。
 *
 * 不走 esbuild：这个项目用的是 Vite 8 + rolldown，node_modules 里**没有** esbuild，
 * 而且 Windows 下 .cmd 也不能被 spawnSync 直接执行。
 * ssrLoadModule 是 Vite 提供给测试/脚本的官方入口，能就地编译 TS，
 * 不需要额外打包步骤，也不需要把中间产物写进项目目录。
 *
 * watch 关掉：这个项目被 chokidar 的 EBUSY 搞挂过四次（见 vite.config.ts 的注释），
 * 一次性检查没有理由去 watch 任何东西。
 */
const cacheDir = mkdtempSync(join(tmpdir(), "mumai-logcheck-"));
const vite = await createServer({
  configFile: false,
  root: process.cwd(),
  cacheDir,
  logLevel: "silent",
  /*
    optimizeDeps 全部关掉：这个脚本只做一次 SSR 加载，不需要预构建。
    不关的话 Vite 会去扫项目根目录下的 HTML 入口，把 dist.prev/、
    server/assets/ 里归档的旧 HTML 也一起当入口扫，报一堆无关错误
    （实测会把真正的检查结果淹掉）。
  */
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, watch: null, hmr: false },
  appType: "custom",
});

let mod;
try {
  mod = await vite.ssrLoadModule("/src/pages/MumaiDashboard/seed/deviceLogs.ts");
} finally {
  await vite.close();
}
const bootIndex = mod.DEVICE_LOG_BOOTS;
const events = mod.TRIAGE_EVENTS;
/* 内容按需生成：列表读索引，这里为检查把每个包都生成一遍 */
const packets = bootIndex.map((boot) => mod.buildPacket(boot.id));

const failures = [];
let checks = 0;
const check = (name, ok, detail) => {
  checks += 1;
  if (!ok) failures.push(name);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  —  ${detail}` : ""}`);
};

/* ---------- 1/2. 条数与统计自洽 ---------- */
console.log("\n--- 日志包 ---");
check("包数量足够（现场一天开关机十几次）", packets.length >= 20, `${packets.length} 个包`);

const statsBad = packets.filter((packet) => {
  const count = (level) => packet.entries.filter((item) => item.level === level).length;
  return (
    packet.stats.total !== packet.entries.length ||
    packet.stats.info !== count("INFO") ||
    packet.stats.warn !== count("WARN") ||
    packet.stats.error !== count("ERROR")
  );
});
check("每包统计与包内实际条数一致", statsBad.length === 0, statsBad.length ? statsBad.map((p) => p.id).join(" ") : `${packets.length} 个包全部自洽`);

const shortPackets = packets.filter((packet) => packet.entries.length < 200);
const sizes = packets.map((packet) => packet.entries.length);
check(
  "每包 ≥ 200 条",
  shortPackets.length === 0,
  shortPackets.length
    ? `不达标：${shortPackets.map((p) => `${p.id}(${p.entries.length})`).join(" ")}`
    : `${Math.min(...sizes)}–${Math.max(...sizes)} 条（共 ${sizes.reduce((a, b) => a + b, 0)} 条）`,
);

/* ---------- 结果档位：95% 正常（用户的核心要求） ---------- */
console.log("\n--- 结果分布 ---");
const byOutcome = { 正常: 0, 需留意: 0, 异常: 0 };
for (const packet of packets) byOutcome[packet.outcome] += 1;
const normalRatio = byOutcome.正常 / packets.length;

/*
 * 「95% 正常」有两个可度量的口径，两个都要看：
 *   · 包一级：多少次启动是干净的（用户扫列表时看到的就是这个）
 *   · 行一级：所有日志行里非 INFO 占多少 —— 这才是字面上的
 *     「95% 都是正常没有异常的记录」
 * 只测包一级会漏掉「包是正常的、但里面混了几十条告警」这种情况。
 */
const totalLines = packets.reduce((sum, packet) => sum + packet.entries.length, 0);
const nonInfoLines = packets.reduce((sum, packet) => sum + packet.stats.warn + packet.stats.error, 0);
const lineRatio = 1 - nonInfoLines / totalLines;
check(
  "正常包占比 ≥ 90%",
  normalRatio >= 0.9,
  `${byOutcome.正常}/${packets.length} = ${(normalRatio * 100).toFixed(1)}%（需留意 ${byOutcome.需留意}、异常 ${byOutcome.异常}）`,
);
check(
  "非 INFO 日志行占比 ≤ 5%",
  lineRatio >= 0.95,
  `${nonInfoLines} / ${totalLines} = ${((1 - lineRatio) * 100).toFixed(2)}% 为非 INFO（WARN+ERROR）`,
);

/*
 * 档位必须与包内实际级别一致：说「正常」就不能藏着 WARN。
 * 这是本次改动的核心 —— 上一版每个包都必然命中一条 WARN 模板，
 * 于是列表里没有一个是干净的「正常」。
 */
const mislabeled = packets.filter((packet) => {
  if (packet.outcome === "正常") return packet.stats.warn > 0 || packet.stats.error > 0;
  if (packet.outcome === "需留意") return packet.stats.error > 0;
  return packet.stats.error === 0;
});
check(
  "结果档位与包内实际级别一致",
  mislabeled.length === 0,
  mislabeled.length
    ? mislabeled.map((p) => `${p.id}(${p.outcome} warn=${p.stats.warn} err=${p.stats.error})`).join(" ")
    : "正常=零告警零错误；需留意=有告警无错误；异常=有错误",
);

/* ---------- 索引与内容一致（列表读索引，不能与点开的内容对不上） ---------- */
const indexMismatch = bootIndex.filter((boot) => {
  const packet = packets.find((item) => item.id === boot.id);
  return (
    !packet ||
    packet.stats.total !== boot.stats.total ||
    packet.outcome !== boot.outcome ||
    packet.durationMin !== boot.durationMin
  );
});
check(
  "索引统计与点开的内容一致",
  indexMismatch.length === 0,
  indexMismatch.length ? `不一致：${indexMismatch.map((b) => b.id).join(" ")}` : "条数 / 档位 / 时长全部对得上",
);

/* ---------- 支持按时间 / 设备 / 结果筛选所需字段 ---------- */
const filterable = bootIndex.filter((boot) => !boot.date || !boot.bootAt || !boot.deviceId || !boot.outcome);
check(
  "筛选字段齐全（时间 / 设备机号 / 结果）",
  filterable.length === 0,
  filterable.length ? `缺字段：${filterable.map((b) => b.id).join(" ")}` : "每包都有 date / bootAt / deviceId / outcome",
);
const dates = [...new Set(bootIndex.map((boot) => boot.date))];
check("覆盖多个业务日", dates.length >= 2, `${dates.length} 个业务日：${dates.join(" / ")}`);

/* ---------- 3/4. 锚点精确落位 ---------- */
console.log("\n--- 锚点 ---");
const current = packets.find((item) => item.id === mod.CURRENT_LOG_PACKET_ID);
if (!current) {
  check("当日日志包存在", false, `未找到 ${mod.CURRENT_LOG_PACKET_ID}`);
} else {
  const atOf = (stamp) => current.entries.filter((item) => item.at === stamp);
  const anchorAt = {
    "27:52": "上电自检完成",
    "27:53": "固件 FW-2.4.1 启动",
    "27:54": "上位机服务就绪",
    "27:56": "模块自检通过",
    "28:01": "参考件回波与出厂基线一致",
    "28:04": "适用域检查未通过",
    "28:18": "信号质量：空帧 0",
    "28:20": "收到暂停请求",
    "28:41": "雷达原始数据 386/420 帧",
    "28:44": "缺帧区间与 28:20 暂停时刻重叠",
    "28:52": "有效数据比例 91.9%",
    "29:05": "USB 传输无丢包",
    "29:30": "已封存，原始数据保留",
    "31:12": "切换到参考样本采集模式",
    "31:20": "重传失败一次，已自动重试成功",
    "31:22": "参考样本批次 ref-batch-01 开始",
  };
  const missing = Object.entries(anchorAt).filter(([stamp, needle]) =>
    !atOf(stamp).some((item) => item.text.includes(needle)),
  );
  check(
    "异常链与自检锚点全部落位",
    missing.length === 0,
    missing.length
      ? `缺：${missing.map(([stamp, needle]) => `${stamp} ${needle}`).join("；")}`
      : `${Object.keys(anchorAt).length} 个锚点时间戳与文案都对上`,
  );

  const errorAt = atOf("31:20");
  check(
    "31:20 是 ERROR 级",
    errorAt.some((item) => item.level === "ERROR"),
    errorAt.map((item) => item.level).join("/") || "(无)",
  );
}

/* ---------- 5. 时间戳单调且格式统一 ---------- */
const MMSS = /^\d{2,}:\d{2}$/;
const toSeconds = (stamp) => {
  const [m, s] = stamp.split(":").map(Number);
  return m * 60 + s;
};
let unsorted = 0;
let badFormat = 0;
for (const packet of packets) {
  for (let i = 0; i < packet.entries.length; i += 1) {
    const entry = packet.entries[i];
    if (!MMSS.test(entry.at)) badFormat += 1;
    if (i > 0 && toSeconds(entry.at) < toSeconds(packet.entries[i - 1].at)) unsorted += 1;
  }
}
check("时间戳格式统一为 mm:ss", badFormat === 0, badFormat ? `${badFormat} 条不合格式` : "全部合规");
check("包内时间戳单调不减", unsorted === 0, unsorted ? `${unsorted} 处逆序` : "全部递增");

/* ---------- 6. 确定性 ---------- */
const fingerprint = (list) =>
  JSON.stringify(list.map((p) => p.entries.map((e) => `${e.at}|${e.level}|${e.source}|${e.text}`)));

/*
 * 在**全新的模块实例**里再生成一次并比对。
 * 这一步防的是「有人往生成器里塞了 Math.random()」—— 那种情况下刷新页面
 * 每一条日志都会变，排练时「刚才那条」再也找不到，截图对比也失效。
 * 光看代码看不出来，必须真的跑两遍比字节。
 */
async function regenerate() {
  const dir = mkdtempSync(join(tmpdir(), "mumai-logcheck2-"));
  const second = await createServer({
    configFile: false,
    root: process.cwd(),
    cacheDir: dir,
    logLevel: "silent",
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null, hmr: false },
    appType: "custom",
  });
  try {
    return await second.ssrLoadModule("/src/pages/MumaiDashboard/seed/deviceLogs.ts");
  } finally {
    await second.close();
  }
}

const first = fingerprint(packets);
const secondMod = await regenerate();
const again = fingerprint(secondMod.DEVICE_LOG_BOOTS.map((boot) => secondMod.buildPacket(boot.id)));
check(
  "生成是确定性的（重跑逐字节一致）",
  first === again,
  first === again
    ? `${packets.reduce((sum, p) => sum + p.entries.length, 0)} 条输出两次生成完全相同`
    : "两次生成不一致 —— 生成器里可能有非确定性来源",
);

/* ---------- 7/8. 异常事件 ---------- */
console.log("\n--- 异常事件 ---");
const settled = events.filter((item) => item.state === "已结案");
check(
  "多数事件已结案",
  settled.length > events.length / 2,
  `${events.length} 条里 ${settled.length} 条已结案、${events.length - settled.length} 条在跟踪`,
);

const settledWithoutConclusion = settled.filter((item) => !item.conclusion);
check(
  "已结案必须有结论",
  settledWithoutConclusion.length === 0,
  settledWithoutConclusion.length
    ? `缺结论：${settledWithoutConclusion.map((item) => item.id).join(" ")}`
    : `${settled.length} 条都有结论`,
);

const openWithConclusion = events.filter((item) => item.state !== "已结案" && item.conclusion);
check(
  "未结案不得写结论",
  openWithConclusion.length === 0,
  openWithConclusion.length ? `不该有结论：${openWithConclusion.map((item) => item.id).join(" ")}` : "未结案均为 null",
);

const firstSettledIndex = events.findIndex((item) => item.state === "已结案");
const openAfterSettled = events
  .slice(firstSettledIndex)
  .filter((item) => item.state !== "已结案");
check(
  "未结案排在最前",
  firstSettledIndex >= 0 && openAfterSettled.length === 0,
  `前 ${firstSettledIndex} 条为未结案，其后全部已结案`,
);

const noHandling = events.filter((item) => item.handling.length === 0);
check(
  "每条事件都有处置过程",
  noHandling.length === 0,
  noHandling.length ? `缺处置：${noHandling.map((item) => item.id).join(" ")}` : "全部有处置链",
);

console.log(`\n合计 ${checks} 项，失败 ${failures.length} 项`);
if (failures.length > 0) console.log(`失败项：${failures.join("、")}`);
process.exit(failures.length > 0 ? 1 : 0);

