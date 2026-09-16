/**
 * 设备日志包与异常事件（异常排查页的数据源）
 *
 * ──────────────────────────────────────────────────────────────────
 * 为什么日志要「打成一包一包」
 * ──────────────────────────────────────────────────────────────────
 * 用户的原话是「每次启动设备就会产生一次日志，所以这个日志应该显示的是一个个
 * 日志包，点击日志包可以看到具体的日志内容」。所以数据模型是：
 *
 *   DeviceLogBoot（一次上电会话的索引信息，轻量，列表直接读它）
 *     ├ bootAt / date / durationMin / batchId / outcome   ← 列表与筛选要用的字段
 *     ├ stats{total,warn,error}                            ← 生成后算出来，不写模糊值
 *     └ （entries 按需生成，见 buildPacket）
 *
 * 一次上电会话两三百条是正常的：状态机每一步、采样心跳、接收进度、自检结论
 * 都会落一行。原来的 16 条并排铺在一页上，既看不出「这是哪一次启动」，
 * 也撑不起排查时「翻一段连续输出」的用法。
 *
 * ──────────────────────────────────────────────────────────────────
 * 关键口径：绝大多数启动是**正常**的
 * ──────────────────────────────────────────────────────────────────
 * 用户的要求是「95% 都是正常没有异常的记录」。这条约束落在两处：
 *   ① **包一级**：30 个包里只有 2 个带 WARN、1 个带 ERROR（其余 27 个零告警）；
 *   ② **行一级**：正常包里连一条 WARN 都没有 —— 不是「少」，是**没有**。
 *      日常输出本来就不该时不时冒警告，否则列表里每个包都挂着一个 WARN 徽标，
 *      「正常启动」这件事就看不出来了（第一版就是这么错的：
 *      boot 阶段模板里有一条「启动阶段堆余量偏低」是 WARN，每个包必然命中）。
 *
 * 所以模板分成两类：
 *   CLEAN_TEMPLATES —— 全是 INFO，正常包只从这里抽
 *   NOISY_TEMPLATES —— 含 WARN/ERROR，只有标记为 `noise` 的包才会用
 *
 * ──────────────────────────────────────────────────────────────────
 * 数据是真的还是生成的
 * ──────────────────────────────────────────────────────────────────
 * 生成，但**不是随手编的随机字符串**：
 *   · 参数值（电压 / 电量 / 存储 / 帧计数 / 有效比例 / 饱和帧）都是实数区间，
 *     且与 seed/scenario.ts 里的 SCAN_BATCHES、SCANNER_TELEMETRY 对得上；
 *   · 用 pyrandom 的 MT19937 按包 id 播种 —— 同一包每次生成的字节完全相同，
 *     刷新页面、换电脑、截图对比都不会变（随机日志会让「刚才那条」找不到）；
 *   · 关键叙事（28:04 适用域冻结、28:41 缺帧、28:52 有效比例偏低、
 *     31:22 参考样本、31:20 重传失败）是**手工写死的锚点**，精确落在与
 *     ANOMALY_EVENTS / WAVEFORMS / SCAN_BATCHES 一致的时间戳上，
 *     生成器只负责把它们之间的日常输出填满。
 *
 * 换句话说：日常输出是生成的，异常链是手写的，两者拼在同一条时间轴上。
 *
 * ──────────────────────────────────────────────────────────────────
 * 为什么索引与内容分开（懒生成）
 * ──────────────────────────────────────────────────────────────────
 * 30 个包 × 两三百条 ≈ 7000+ 条。全部在模块加载时生成，会把这一页的首屏
 * 拖慢，而这 7000 条里用户真正会点开的通常只有一两个。所以：
 *   · `DEVICE_LOG_BOOTS` 只包含索引信息，模块加载时就算好（筛选要用它们的统计量）；
 *   · `buildPacket(id)` 按需生成某一个包的完整内容，并按 id 缓存，
 *     同一个包点开两次拿到的是同一个对象。
 */

import { makePyRandom } from "../pyrandom";
import { DEVICES, DEMO_BUSINESS_DATE } from "./scenario.ts";
import type {
  AnomalyEvent,
  DeviceLogBoot,
  DeviceLogEntry,
  DeviceLogOutcome,
  DeviceLogPacket,
  DeviceLogSource,
} from "./types.ts";

/* ==================================================================
   1. 生成器基础设施
   ================================================================== */

/** 把秒数格式化成 mm:ss（与剧本时间轴同口径，可超过 59 分钟） */
function mmss(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

/** 反向：mm:ss → 秒，用于写死锚点 */
function minutesOf(stamp: string): number {
  const [m, s] = stamp.split(":").map(Number);
  return m * 60 + s;
}

type Rng = { random: () => number; uniform: (a: number, b: number) => number };

const between = (rng: Rng, a: number, b: number): number => rng.uniform(a, b);
const fixed = (value: number, digits = 2): string => value.toFixed(digits);

/** 用包 id 播种：同一个包在任何机器、任何时刻生成的字节都一致 */
function seedOf(id: string): number {
  return id.split("").reduce((sum, ch) => (sum * 31 + ch.charCodeAt(0)) % 2147483647, 7);
}

type Phase = "boot" | "active" | "idle" | "wrap";

type PacketContext = {
  battery: number;
  voltage: number;
  storageGb: number;
  firmware: string;
  config: string;
  batchId: string | null;
};

type Template = {
  source: DeviceLogSource;
  level: DeviceLogEntry["level"];
  /** 出现权重：整数，越大越常见 */
  weight: number;
  phases: readonly Phase[];
  text: (rng: Rng, ctx: PacketContext) => string;
};

/* ------------------------------------------------------------------
   正常输出模板（全部 INFO）
   ------------------------------------------------------------------
   正常包只从这里抽。加模板时**不要**往这里放 WARN ——
   用户明确要求正常记录里不该有异常，混一条进来整个「正常」口径就废了。
   ------------------------------------------------------------------ */

const CLEAN_TEMPLATES: Template[] = [
  /* ---------------- ESP32-S3（下位机：采集时序与模型输入） ---------------- */
  {
    source: "ESP32-S3", level: "INFO", weight: 10, phases: ["active"],
    text: (rng) => `采集循环 tick 正常，本批 ${Math.round(between(rng, 18, 26))} 帧，帧间隔抖动 ${fixed(between(rng, 0.4, 2.2), 1)}ms`,
  },
  {
    source: "ESP32-S3", level: "INFO", weight: 8, phases: ["active"],
    text: (rng) => `时序偏移 ${fixed(between(rng, -0.6, 0.6))}ms，采样窗口对齐主机时钟`,
  },
  {
    source: "ESP32-S3", level: "INFO", weight: 6, phases: ["active"],
    text: (rng) => `模型输入缓冲 ${Math.round(between(rng, 24, 48))} 帧，特征维度 256，队列水位 ${Math.round(between(rng, 12, 46))}%`,
  },
  {
    source: "ESP32-S3", level: "INFO", weight: 5, phases: ["active"],
    text: (rng) => `晶振温度补偿生效，频偏 ${fixed(between(rng, -18, 18), 1)} ppm`,
  },
  {
    source: "ESP32-S3", level: "INFO", weight: 5, phases: ["boot"],
    text: (rng) => `启动自检：堆余量 ${Math.round(between(rng, 118, 178))} KB，外设枚举完成`,
  },
  {
    source: "ESP32-S3", level: "INFO", weight: 4, phases: ["idle"],
    text: (_rng, ctx) => `空闲巡检：${ctx.batchId ? `批次 ${ctx.batchId} 落盘目录可写` : "等待新批次下发"}，堆余量充足`,
  },
  {
    source: "ESP32-S3", level: "INFO", weight: 3, phases: ["wrap"],
    text: () => "采集状态机回到待命，等待关机指令",
  },

  /* ---------------- 树莓派（上位机：汇集 / 界面 / 文件） ---------------- */
  {
    source: "树莓派", level: "INFO", weight: 9, phases: ["active"],
    text: (rng, ctx) => `落盘队列深度 ${Math.round(between(rng, 1, 9))}，写入 ${fixed(between(rng, 3.2, 9.6), 1)} MB/s，剩余 ${fixed(Math.max(0.4, ctx.storageGb - between(rng, 0.01, 0.09)), 2)} GB`,
  },
  {
    source: "树莓派", level: "INFO", weight: 7, phases: ["active"],
    text: (rng) => `CPU 占用 ${Math.round(between(rng, 22, 61))}%，内存 ${Math.round(between(rng, 38, 68))}%，无交换`,
  },
  {
    source: "树莓派", level: "INFO", weight: 6, phases: ["active"],
    text: (_rng, ctx) => `已归档分片 ${Math.round(between(_rng, 12, 48))} 个，清单校验 ${ctx.batchId ?? "临时"} 一致`,
  },
  {
    source: "树莓派", level: "INFO", weight: 5, phases: ["active"],
    text: (rng) => `位姿回传 ${fixed(between(rng, 9.4, 10.6), 1)} Hz，时间戳单调递增`,
  },
  {
    source: "树莓派", level: "INFO", weight: 4, phases: ["boot"],
    text: (rng) => `自检：文件系统只读挂载正常，日志分区余量 ${Math.round(between(rng, 62, 88))}%`,
  },
  {
    source: "树莓派", level: "INFO", weight: 4, phases: ["idle"],
    text: (rng) => `空闲：索引缓存命中率 ${Math.round(between(rng, 78, 96))}%，无待处理分片`,
  },
  {
    source: "树莓派", level: "INFO", weight: 3, phases: ["wrap"],
    text: () => "会话清单已刷新，等待下一次启动",
  },

  /* ---------------- 毫米波模块 ---------------- */
  {
    source: "毫米波模块", level: "INFO", weight: 9, phases: ["active"],
    text: (rng) => `回波采集正常，本批峰值 ${fixed(between(rng, 0.42, 0.88), 3)}，噪声底 ${fixed(between(rng, 0.012, 0.03), 3)}`,
  },
  {
    source: "毫米波模块", level: "INFO", weight: 7, phases: ["active"],
    text: (rng) => `空帧 0，非有限值 0，饱和帧比例 ${fixed(between(rng, 0.3, 2.6), 1)}%`,
  },
  {
    source: "毫米波模块", level: "INFO", weight: 5, phases: ["active"],
    text: (rng) => `增益 ${Math.round(between(rng, 18, 26))} dB，频段按配置下发，温度 ${fixed(between(rng, 36, 44), 1)}℃`,
  },
  {
    source: "毫米波模块", level: "INFO", weight: 4, phases: ["active"],
    text: (rng) => `参考件比对偏差 ${fixed(between(rng, 0.1, 0.5), 2)}dB，与出厂基线同向`,
  },
  {
    source: "毫米波模块", level: "INFO", weight: 3, phases: ["boot"],
    text: () => "模块自检通过，天线阵元响应一致",
  },
  {
    source: "毫米波模块", level: "INFO", weight: 2, phases: ["wrap"],
    text: () => "模块进入低功耗待命，温控正常",
  },

  /* ---------------- 传输（USB / 链路） ---------------- */
  {
    source: "传输", level: "INFO", weight: 9, phases: ["active"],
    text: (rng, ctx) => `USB 批量传输 ${Math.round(between(rng, 24, 64))} KB/s，无丢包，已接收 ${Math.round(between(rng, 120, 380))} 帧${ctx.batchId ? `（${ctx.batchId}）` : ""}`,
  },
  {
    source: "传输", level: "INFO", weight: 6, phases: ["active"],
    text: (rng) => `分片序号连续，重传计数 0，链路误码率 ${fixed(between(rng, 0.00002, 0.00035), 5)}`,
  },
  {
    source: "传输", level: "INFO", weight: 4, phases: ["idle"],
    text: () => "链路空闲心跳，对端应答正常",
  },
  {
    source: "传输", level: "INFO", weight: 3, phases: ["wrap"],
    text: () => "链路握手正常，会话清单已同步",
  },

  /* ---------------- 供电 ---------------- */
  {
    source: "供电", level: "INFO", weight: 8, phases: ["active"],
    text: (rng, ctx) => `电池电量 ${Math.round(Math.max(12, ctx.battery - between(rng, 0.4, 2.2)))}%，供电电压 ${fixed(ctx.voltage + between(rng, -0.06, 0.06))}V`,
  },
  {
    source: "供电", level: "INFO", weight: 5, phases: ["active"],
    text: (rng) => `输入电流 ${Math.round(between(rng, 420, 760))}mA，纹波 ${Math.round(between(rng, 18, 42))}mV`,
  },
  {
    source: "供电", level: "INFO", weight: 3, phases: ["boot"],
    text: (_rng, ctx) => `上电自检完成，电池电量 ${Math.round(ctx.battery)}%，供电电压 ${fixed(ctx.voltage)}V`,
  },
  {
    source: "供电", level: "INFO", weight: 3, phases: ["wrap"],
    text: (_rng, ctx) => `收工检查：电量 ${Math.round(Math.max(12, ctx.battery - between(_rng, 4, 12)))}%，电压稳定`,
  },
];

/* ------------------------------------------------------------------
   带噪声的模板（含 WARN / ERROR）
   ------------------------------------------------------------------
   只有 `noise` 包会用到。正常包抽到这些的概率是 0 —— 这是「95% 正常」
   这条要求在代码里的落点，不是靠调低权重碰运气。
   ------------------------------------------------------------------ */

const NOISY_TEMPLATES: Template[] = [
  {
    source: "ESP32-S3", level: "WARN", weight: 3, phases: ["active"],
    text: (rng) => `单帧解析耗时 ${Math.round(between(rng, 320, 460))}ms，超过软阈值 300ms（未丢帧）`,
  },
  {
    source: "树莓派", level: "WARN", weight: 3, phases: ["active"],
    text: (rng) => `写入延迟抖动 ${Math.round(between(rng, 180, 340))}ms（峰值），已由队列吸收`,
  },
  {
    source: "树莓派", level: "WARN", weight: 2, phases: ["active"],
    text: (rng) => `时钟同步偏差 ${fixed(between(rng, 0.10, 0.24), 2)}s，超过 0.20s 观察线（仍在允许范围内）`,
  },
  {
    source: "毫米波模块", level: "WARN", weight: 2, phases: ["active"],
    text: (rng) => `增益自动上调 ${fixed(between(rng, 0.5, 1.6), 1)} dB（回波偏弱），未触发重采`,
  },
  {
    source: "毫米波模块", level: "WARN", weight: 1, phases: ["active"],
    text: (rng) => `单帧有效比例 ${fixed(between(rng, 88.5, 93.5), 1)}%，低于整批阈值 95%（单帧，整批结论以批校验为准）`,
  },
  {
    source: "传输", level: "WARN", weight: 3, phases: ["active"],
    text: (rng) => `分片 ${Math.round(between(rng, 180, 400))} 重传 1 次后成功，记录重传计数`,
  },
  {
    source: "传输", level: "WARN", weight: 1, phases: ["active"],
    text: (rng) => `链路抖动 ${Math.round(between(rng, 90, 260))}ms，分片未丢失，等待对端确认`,
  },
  {
    source: "供电", level: "WARN", weight: 2, phases: ["active"],
    text: (rng) => `电压瞬降 ${fixed(between(rng, 0.18, 0.34), 2)}V（持续 ${Math.round(between(rng, 12, 40))}ms），未触发欠压保护`,
  },
];

/**
 * 按阶段与权重抽一条模板。
 *
 * `noise` 为 false 时只在 CLEAN_TEMPLATES 里抽 —— 保证正常包内一条
 * WARN/ERROR 都不会出现（用户要的「正常记录」是干净的正常，不是「比较少警告」）。
 */
function drawTemplate(rng: Rng, phase: Phase, noise: boolean): Template {
  /* 带噪包里有 18% 的输出来自噪声模板；正常包完全不碰它们 */
  const useNoisy = noise && NOISY_TEMPLATES.some((item) => item.phases.includes(phase)) && rng.random() < 0.18;
  const pool = (useNoisy ? NOISY_TEMPLATES : CLEAN_TEMPLATES).filter((item) => item.phases.includes(phase));
  const total = pool.reduce((sum, item) => sum + item.weight, 0);
  let roll = rng.random() * total;
  for (const item of pool) {
    roll -= item.weight;
    if (roll <= 0) return item;
  }
  return pool[pool.length - 1];
}

/* ==================================================================
   2. 启动会话定义
   ================================================================== */

type BootSpec = {
  id: string;
  date: string;
  bootAt: string;
  /** 会话时长（分钟） */
  spanMin: number;
  battery: number;
  voltage: number;
  storageGb: number;
  batchId: string | null;
  outcome: DeviceLogOutcome;
  /** 会话结果说明：为什么停的 / 这一趟干了什么，不能只写「已停止」 */
  endNote: string;
  /**
   * 是否允许出现 WARN/ERROR。
   * false = 正常启动：包内**不会**有任何 WARN/ERROR（用户要求 95% 正常）。
   */
  noise: boolean;
  anchors?: {
    at: string;
    level: DeviceLogEntry["level"];
    source: DeviceLogSource;
    text: string;
  }[];
  phases?: { boot: number; active: number; idle?: number; wrap?: number };
};

/** 正常启动的通用参数：按 id 播种，同一次启动每次生成都一致 */
function normalBoot(
  id: string,
  date: string,
  bootAt: string,
  spanMin: number,
  batchId: string | null,
  endNote: string,
): BootSpec {
  const rng = makePyRandom(seedOf(id));
  return {
    id,
    date,
    bootAt,
    spanMin,
    battery: Math.round(between(rng, 72, 97)),
    voltage: Number(between(rng, 12.32, 12.62).toFixed(2)),
    storageGb: Number(between(rng, 14, 46).toFixed(1)),
    batchId,
    outcome: "正常",
    endNote,
    noise: false,
    phases: { boot: 4, active: 8, wrap: spanMin - 3 },
  };
}

/**
 * 作业日程：3 个业务日共 30 次启动。
 *
 * 为什么这么多：用户的原话是「哪有这么少」—— 现场一天开关机十来次是常态
 * （进场、换个测区、中午收工、下午再上）。之前 4 次是把它当成「一天开一次机」了。
 *
 * 噪声分布（用户要求 95% 正常）：
 *   正常 27 个（90%）· 需留意 2 个（带 WARN，无 ERROR）· 异常 1 个（带 ERROR）
 * 正常包里连一条 WARN 都没有 —— 不是「比较少」。
 */
const NORMAL_BOOTS: BootSpec[] = [
  /* ---- 2026-09-08 现场踩点：开关机 7 次，全程正常 ---- */
  normalBoot("packet-260908-01", "2026-09-08", "09:12", 46, null, "踩点后正常关机，未开展采集"),
  normalBoot("packet-260908-02", "2026-09-08", "10:26", 38, null, "测区巡视完成，正常关机"),
  normalBoot("packet-260908-03", "2026-09-08", "11:40", 52, null, "点位核对完成，正常关机"),
  normalBoot("packet-260908-04", "2026-09-08", "13:55", 41, null, "待命结束，正常关机"),
  normalBoot("packet-260908-05", "2026-09-08", "15:08", 63, null, "通道连通验证完成，正常关机"),
  normalBoot("packet-260908-06", "2026-09-08", "16:44", 35, null, "收工关机"),
  normalBoot("packet-260908-07", "2026-09-08", "18:02", 29, null, "设备复位后确认正常，关机"),

  /* ---- 2026-09-10 参考样本采集：开关机 6 次（其中 1 次需留意） ---- */
  normalBoot("packet-260910-01", "2026-09-10", "14:20", 44, null, "参考样本准备完成，正常关机"),
  {
    /* 需留意：一次重传与空文件，都当场解决，没有 ERROR */
    id: "packet-260910-02",
    date: "2026-09-10",
    bootAt: "15:38",
    spanMin: 65,
    battery: 88,
    voltage: 12.44,
    storageGb: 24.6,
    batchId: "ref-batch-01",
    outcome: "需留意",
    endNote: "参考样本采集完成；过程中 1 次分片重传与 1 个空文件均已当场处理",
    noise: true,
    anchors: [
      { at: "21:05", level: "INFO", source: "树莓派", text: "参考样本批次 ref-batch-01 开始，按 0° / 45° / 90° 三向采集" },
      { at: "21:47", level: "WARN", source: "传输", text: "分片 214 CRC 校验失败，重传 1 次后通过，帧计数一致" },
      { at: "27:30", level: "INFO", source: "毫米波模块", text: "参考件回波与出厂基线一致（偏差 0.3dB）" },
      { at: "33:48", level: "WARN", source: "树莓派", text: "自检发现 ref-Z04-g2 分片 scan_001 为空文件（0 字节），已标记待复核" },
      { at: "41:12", level: "INFO", source: "传输", text: "线缆检查：接口接触正常，无重传" },
    ],
    phases: { boot: 15, active: 20, wrap: 72 },
  },
  normalBoot("packet-260910-03", "2026-09-10", "17:02", 47, "ref-batch-01", "参考样本补采完成，正常关机"),
  normalBoot("packet-260910-04", "2026-09-10", "18:36", 33, null, "样本归位后关机"),
  normalBoot("packet-260910-05", "2026-09-10", "20:14", 51, null, "设备保养后验证正常，关机"),
  normalBoot("packet-260910-06", "2026-09-10", "21:48", 26, null, "收工关机"),

  /* ---- 2026-09-11 正式巡检：开关机 17 次（含当日异常那一次） ---- */
  normalBoot("packet-260911-01", "2026-09-11", "07:34", 28, null, "进场开机自检，正常关机"),
  normalBoot("packet-260911-02", "2026-09-11", "08:05", 52, null, "等待任务下发后关机"),
  normalBoot("packet-260911-03", "2026-09-11", "09:20", 36, null, "测区确认完成，正常关机"),
  normalBoot("packet-260911-05", "2026-09-11", "11:58", 44, null, "中间休整，正常关机"),
  normalBoot("packet-260911-06", "2026-09-11", "13:06", 39, null, "换测区后重启，正常关机"),
  normalBoot("packet-260911-07", "2026-09-11", "14:40", 57, null, "Z01 测区采集完成，正常关机"),
  normalBoot("packet-260911-08", "2026-09-11", "15:52", 31, null, "配置核对后关机"),
  {
    /* 需留意：电量偏低被采集前检查拦下 —— 这正是那套检查存在的意义 */
    id: "packet-260911-09",
    date: "2026-09-11",
    bootAt: "17:24",
    spanMin: 34,
    battery: 41,
    voltage: 12.36,
    storageGb: 19.4,
    batchId: null,
    outcome: "需留意",
    endNote: "电量接近下限，采集前检查拦下并换电；未产生作废批次",
    noise: true,
    anchors: [
      { at: "17:52", level: "WARN", source: "供电", text: "电池电量 38%，低于采集前检查下限 40%" },
      { at: "18:06", level: "INFO", source: "供电", text: "更换电池完成，电量 97%，电压 12.61V" },
      { at: "18:20", level: "INFO", source: "树莓派", text: "换电后重新逐条签署采集前检查，全部通过" },
    ],
    phases: { boot: 6, active: 12, wrap: 30 },
  },
  normalBoot("packet-260911-10", "2026-09-11", "18:34", 48, null, "Z02 测区试扫完成，正常关机"),
  normalBoot("packet-260911-11", "2026-09-11", "19:46", 42, null, "换测区后重启，正常关机"),
  normalBoot("packet-260911-12", "2026-09-11", "21:02", 55, null, "Z03 测区采集完成，正常关机"),
  normalBoot("packet-260911-13", "2026-09-11", "22:18", 37, null, "数据核对完成，正常关机"),
  normalBoot("packet-260911-14", "2026-09-11", "23:40", 46, null, "夜间值守开机，正常关机"),
  normalBoot("packet-260911-15", "2026-09-11", "25:12", 33, null, "值守结束，正常关机"),
  normalBoot("packet-260911-16", "2026-09-11", "26:20", 41, null, "Z04 测区准备，正常关机"),
  normalBoot("packet-260911-17", "2026-09-11", "28:44", 38, null, "核验期间继续值守，正常关机"),
];

/** 当日那次异常启动（唯一带 ERROR 的包） */
const FAULT_BOOT: BootSpec = {
  id: "packet-260911-04",
  date: DEMO_BUSINESS_DATE,
  bootAt: "27:31",
  spanMin: 42,
  battery: 68,
  voltage: 12.4,
  storageGb: 12.4,
  batchId: "scan-Z04-001",
  outcome: "异常",
  endNote: "适用域待核验：批次 scan-Z04-001 已封存，采集停在暂停点等待核验",
  noise: true,
  anchors: [
    /* —— 开机自检：与 DEVICE_LOGS_LEGACY 原有的四条一致 —— */
    { at: "27:52", level: "INFO", source: "供电", text: "上电自检完成，电池电量 68%，供电电压 12.4V" },
    { at: "27:53", level: "INFO", source: "ESP32-S3", text: "固件 FW-2.4.1 启动，采集配置 CFG-02 已加载" },
    { at: "27:54", level: "INFO", source: "树莓派", text: "上位机服务就绪，存储余量 12.4 GB，时间同步偏差 0.18s" },
    { at: "27:56", level: "INFO", source: "毫米波模块", text: "模块自检通过，频段与增益按 CFG-02 下发" },
    { at: "28:01", level: "INFO", source: "毫米波模块", text: "参考件回波与出厂基线一致（偏差 0.3dB）" },
    /* —— 异常链：与 ANOMALY_EVENTS 的 evt-domain-01 / evt-recv-01 / evt-signal-01 对齐 —— */
    { at: "28:04", level: "WARN", source: "树莓派", text: "适用域检查未通过：模型 DEMO-M02 缺少该批次木材标定记录" },
    { at: "28:04", level: "WARN", source: "树莓派", text: "特征偏移 2.7σ 超限，诊断输出已冻结，暂停输出结论" },
    { at: "28:18", level: "INFO", source: "毫米波模块", text: "信号质量：空帧 0，非有限值 0，饱和帧比例 2.1%" },
    { at: "28:20", level: "WARN", source: "ESP32-S3", text: "收到暂停请求，停止采集控制；等待上位机确认落盘" },
    { at: "28:41", level: "WARN", source: "传输", text: "批次 scan-Z04-001 雷达原始数据 386/420 帧，34 帧未回传" },
    { at: "28:44", level: "WARN", source: "传输", text: "缺帧区间与 28:20 暂停时刻重叠，判定为暂停导致而非链路丢包" },
    { at: "28:52", level: "WARN", source: "树莓派", text: "有效数据比例 91.9%，低于整批校验阈值 95%" },
    { at: "29:05", level: "INFO", source: "传输", text: "USB 传输无丢包，落盘 386/420 帧" },
    { at: "29:30", level: "INFO", source: "树莓派", text: "批次 scan-Z04-001 已封存，原始数据保留，未做清理" },
    /* —— 参考样本：重传失败后重试成功（对应批次 ref-batch-01 于 31:22 开始） —— */
    { at: "31:12", level: "INFO", source: "ESP32-S3", text: "切换到参考样本采集模式，等待新批次下发" },
    { at: "31:20", level: "ERROR", source: "传输", text: "参考样本批次 ref-Z04-g1 第 3 条重传失败一次，已自动重试成功" },
    { at: "31:22", level: "INFO", source: "树莓派", text: "参考样本批次 ref-batch-01 开始，按 0° / 45° / 90° 三向采集" },
    { at: "33:48", level: "WARN", source: "树莓派", text: "自检发现 ref-Z04-g2 分片 scan_001 为空文件（0 字节），已标记待复核" },
    /* —— 收尾：为什么停 —— */
    { at: "38:10", level: "WARN", source: "树莓派", text: "适用域核验未完成，诊断输出保持冻结；批次 scan-Z04-001 等待处理" },
    { at: "41:30", level: "INFO", source: "ESP32-S3", text: "停止采集控制，进入待命；未执行关机（等待核验结论）" },
  ],
  phases: { boot: 21, active: 27 },
};

const BOOTS: BootSpec[] = [...NORMAL_BOOTS, FAULT_BOOT];

/* ==================================================================
   3. 生成
   ================================================================== */

/** 把 BootSpec 展开成一个完整日志包 */
function buildPacketFrom(spec: BootSpec): DeviceLogPacket {
  const rng = makePyRandom(seedOf(spec.id));

  const bootSeconds = minutesOf(spec.bootAt);
  const startSeconds = bootSeconds - 60; /* 上电前 1 分钟开始记：搬运 / 接电 */
  const endSeconds = bootSeconds + spec.spanMin * 60;

  const ctx: PacketContext = {
    battery: spec.battery,
    voltage: spec.voltage,
    storageGb: spec.storageGb,
    firmware: "FW-2.4.1",
    config: "CFG-02",
    batchId: spec.batchId,
  };

  const phases = spec.phases ?? { boot: 4, active: 8 };
  const phaseAt = (seconds: number): Phase => {
    const minute = (seconds - startSeconds) / 60;
    if (minute < phases.boot) return "boot";
    if (phases.wrap !== undefined && minute >= phases.wrap) return "wrap";
    if (phases.idle !== undefined && minute >= phases.idle) return "idle";
    if (minute >= phases.active) return "active";
    return "boot";
  };

  /*
    时间轴：按**目标条数**铺，而不是按固定步长走。

    固定步长（不管会话多长都每 4–18 秒一条）会让短会话的包掉到 200 条以下 ——
    实测 26 分钟那一包只有 142 条。而「每次启动两三百条」是用户明确要的观感，
    不能因为这一趟开得短就变成稀疏的几十条。
    所以先定这一包要落多少条（220–320），再把它们大致均匀分布到会话时长上，
    每步 ±35% 抖动 —— 既保证条数下限，又不会出现等间隔的机械感。
  */
  const targetEntries = Math.round(between(rng, 220, 320));
  const span = endSeconds - startSeconds;
  const step = span / targetEntries;
  const timeline: number[] = [];
  for (let index = 0; index < targetEntries; index += 1) {
    const jitter = step * between(rng, -0.35, 0.35);
    timeline.push(Math.round(startSeconds + index * step + jitter));
  }

  const anchors = (spec.anchors ?? [])
    .map((item, index) => ({ ...item, seconds: minutesOf(item.at), index }))
    .sort((a, b) => a.seconds - b.seconds || a.index - b.index);

  const merged: { seconds: number; entry: Omit<DeviceLogEntry, "id"> }[] = [];
  let anchorCursor = 0;

  for (const seconds of timeline) {
    while (anchorCursor < anchors.length && anchors[anchorCursor].seconds <= seconds) {
      const anchor = anchors[anchorCursor];
      merged.push({
        seconds: anchor.seconds,
        entry: { at: mmss(anchor.seconds), level: anchor.level, source: anchor.source, text: anchor.text },
      });
      anchorCursor += 1;
    }
    /*
     * 锚点前后 20 秒内不放日常输出：那几秒是异常链的关键片段，
     * 混进「心跳正常」这类例行行会把因果读乱。
     */
    if (anchors.some((anchor) => Math.abs(anchor.seconds - seconds) <= 20)) continue;

    const template = drawTemplate(rng, phaseAt(seconds), spec.noise);
    merged.push({
      seconds,
      entry: {
        at: mmss(seconds),
        level: template.level,
        source: template.source,
        text: template.text(rng, ctx),
      },
    });
  }

  while (anchorCursor < anchors.length) {
    const anchor = anchors[anchorCursor];
    merged.push({
      seconds: anchor.seconds,
      entry: { at: mmss(anchor.seconds), level: anchor.level, source: anchor.source, text: anchor.text },
    });
    anchorCursor += 1;
  }

  merged.sort((a, b) => a.seconds - b.seconds);

  const entries: DeviceLogEntry[] = merged.map((item, index) => ({
    id: `${spec.id}-e${String(index + 1).padStart(4, "0")}`,
    ...item.entry,
  }));

  const warnEntries = entries.filter((item) => item.level === "WARN");
  const errorEntries = entries.filter((item) => item.level === "ERROR");

  return {
    id: spec.id,
    bootAt: spec.bootAt,
    date: spec.date,
    durationMin: Math.round((endSeconds - startSeconds) / 60),
    deviceId: DEVICES.scanner.id,
    deviceName: DEVICES.scanner.name,
    firmwareVersion: ctx.firmware,
    configVersion: ctx.config,
    batchId: spec.batchId,
    outcome: spec.outcome,
    endNote: spec.endNote,
    /*
      结束方式由结果档位推出，不单独维护一个字段 ——
      两个字段各写一遍迟早会不一致（「异常」却写着「正常结束」）。
    */
    endedAs: spec.outcome === "异常" ? "异常结束" : "正常结束",
    entries,
    stats: {
      total: entries.length,
      info: entries.filter((item) => item.level === "INFO").length,
      warn: warnEntries.length,
      error: errorEntries.length,
      errorSummary: errorEntries[0]?.text ?? null,
      warnSummary: warnEntries[0]?.text ?? null,
    },
  };
}

/**
 * 按需生成 + 缓存。
 *
 * 30 个包 × 两三百条 ≈ 7000+ 条，全部在模块加载时生成会把这一页的首屏拖慢，
 * 而用户真正会点开的通常只有一两个。所以列表只读下面的索引，
 * 内容等点开再算 —— 同一个包点开两次拿到同一个对象。
 */
const packetCache = new Map<string, DeviceLogPacket>();

export function buildPacket(id: string): DeviceLogPacket | null {
  const cached = packetCache.get(id);
  if (cached) return cached;
  const spec = BOOTS.find((item) => item.id === id);
  if (!spec) return null;
  const packet = buildPacketFrom(spec);
  packetCache.set(id, packet);
  return packet;
}

/**
 * 索引（列表与筛选用的轻量视图）。
 *
 * 统计量在这一步就算出来（生成一次、丢弃 entries），因为筛选要按
 * 「正常 / 需留意 / 异常」和条数判断，不能等点开才知道。
 * 这也是模块加载时唯一的重活：30 次生成 ≈ 7000 条文本，实测毫秒级。
 */
export const DEVICE_LOG_BOOTS: DeviceLogBoot[] = BOOTS.map((spec) => {
  const packet = buildPacketFrom(spec);
  return {
    id: packet.id,
    bootAt: packet.bootAt,
    date: packet.date,
    durationMin: packet.durationMin,
    deviceId: packet.deviceId,
    deviceName: packet.deviceName,
    firmwareVersion: packet.firmwareVersion,
    configVersion: packet.configVersion,
    batchId: packet.batchId,
    outcome: packet.outcome,
    endNote: packet.endNote,
    stats: packet.stats,
  };
}).sort((a, b) => (a.date === b.date ? b.bootAt.localeCompare(a.bootAt) : b.date.localeCompare(a.date)));

/** 当日（有异常链的那一段）包，页面上默认高亮它 */
export const CURRENT_LOG_PACKET_ID = "packet-260911-04";

/** 可筛选的三种结果 —— 顺序就是「用户关心的顺序」 */
export const LOG_OUTCOMES: DeviceLogOutcome[] = ["正常", "需留意", "异常"];

/* ==================================================================
   4. 异常事件
   ==================================================================
   用户要求「异常事件可以补多一些，但是大多数要已经解决的」。

   为什么大多数要「已结案」：这一页是**事后排查**用的。如果大半事件挂着待处理，
   页面读起来像「这台设备一直在出事」；真实的巡检记录里，绝大多数异常在当轮
   就被定位并解决了，留下的是少量仍在跟踪的。所以这里 17 条里 13 条已结案，
   只有 4 条还在跟踪，且这 4 条都对应剧本里真实存在的悬念，不是随手编的。
   ================================================================== */

/** 原有的四条（保留原文，它们是剧本里真实存在的悬念） */
const CORE_EVENTS: AnomalyEvent[] = [
  {
    id: "evt-domain-01",
    at: "T+28:04",
    kind: "适用域待核验",
    summary: "Z04 初扫批次触发模型适用性检查，诊断输出已冻结",
    detail:
      "输入质量合格、特征偏移超限、模型配置不覆盖该材种，三项合并后触发。该批次暂不输出病害结论。",
    frozenBatch: "scan-Z04-001",
    outputsFrozen: true,
    trigger: "排练控制事件",
    deviceEvidence: [
      { at: "28:12", text: "供电电压 12.4V，传感器响应正常", result: "正常" },
      { at: "28:40", text: "参考件回波与出厂基线一致（偏差 0.3dB）", result: "正常" },
      { at: "29:05", text: "USB 传输无丢包，落盘 386/420 帧", result: "部分接收" },
    ],
    modelEvidence: [
      { at: "30:02", text: "输入质量：信号完整度 91.9%", result: "合格" },
      { at: "30:20", text: "特征偏移：与参考分布偏离 2.7σ", result: "超限" },
      { at: "30:38", text: "模型配置：DEMO-M02 缺少该批次木材标定记录", result: "不适用" },
    ],
    handling: [
      { at: "28:04", owner: "史", text: "发现适用域事件，要求暂停当前采集并保留原始数据" },
      { at: "28:20", owner: "饶", text: "停止采集，封存批次 scan-Z04-001，记录设备位置" },
      { at: "29:30", owner: "马", text: "确认小车已到安全点暂停，核对 Z04 编号与扫描方向" },
      { at: "30:50", owner: "饶", text: "参考件复核与设备日志检查完成，未发现足以解释异常的明显设备问题" },
    ],
    conclusion: null,
    state: "处理中",
    owner: "史",
  },
  {
    id: "evt-recv-01",
    at: "T+28:41",
    kind: "接收不完整",
    summary: "scan-Z04-001 雷达原始数据 386/420，34 帧未回传",
    detail:
      "整批校验未通过，不报「数据全部回传」。缺帧集中在批次后段，与暂停时间点吻合。",
    frozenBatch: "scan-Z04-001",
    outputsFrozen: false,
    trigger: "排练控制事件",
    deviceEvidence: [
      { at: "28:41", text: "雷达 386/420、图像 12/12、结果 0/1", result: "部分接收" },
      { at: "28:44", text: "缺帧区间与 28:20 暂停时刻重叠", result: "记录" },
    ],
    modelEvidence: [],
    handling: [
      { at: "28:45", owner: "饶", text: "已向扫描枪请求重传未接收分片，等待设备回报" },
    ],
    conclusion: null,
    state: "处理中",
    owner: "饶",
  },
  {
    id: "evt-signal-01",
    at: "T+28:52",
    kind: "信号质量",
    summary: "有效数据比例 91.9%，低于整批校验阈值",
    detail: "信号可用但有效比例偏低。整批校验未通过前不进入后续分析；需补采后再判定。",
    frozenBatch: "scan-Z04-001",
    outputsFrozen: false,
    trigger: "排练控制事件",
    deviceEvidence: [
      { at: "28:18", text: "空帧 0，非有限值 0，饱和帧比例 2.1%", result: "合格" },
      { at: "28:52", text: "有效数据比例 91.9%", result: "待复核" },
    ],
    modelEvidence: [],
    handling: [
      { at: "28:55", owner: "饶", text: "标记该批次待补采，保持当前配置不变" },
    ],
    conclusion: "信号可用但有效比例偏低，需补采后再判定",
    state: "已结案",
    owner: "饶",
  },
  {
    id: "evt-img-01",
    at: "2026-09-11 22:06",
    kind: "表面疑点",
    summary: "四柱关键帧对比，Z04 视角可见表面缺损与孔洞状疑点",
    detail:
      "图像可提示外观异常，不能确认内部是否存在空洞，也不能直接判定承载能力。已建立 Z04 下部精扫任务。",
    frozenBatch: "—",
    outputsFrozen: false,
    trigger: "排练控制事件",
    deviceEvidence: [
      { at: "22:06", text: "关键帧 keyframe-Z04-03 与 Z01-02 对比", result: "记录" },
    ],
    modelEvidence: [
      { at: "22:08", text: "视觉初筛：表面缺损与孔洞状疑点", result: "优先复核" },
    ],
    handling: [
      { at: "22:10", owner: "史", text: "在平台标注建立 Z04 下部精扫任务" },
      { at: "22:15", owner: "沈", text: "核对现场编号，指定对 Z04 测区开展手持精扫" },
    ],
    conclusion: "已转入 Z04 下部测区精扫，内部情况待精扫确认",
    state: "已结案",
    owner: "史",
  },
];

/**
 * 新增的事件。
 *
 * 每一条都遵守三条约束：
 *   ① `conclusion` 只有已结案才写，未结案写 null（不用空字符串冒充「已处理」）；
 *   ② 证据分设备侧 / 模型侧，且**不能靠改配置绕过**的要写清「不是设备问题」；
 *   ③ 时间落在 09-08 / 09-10 / 09-11 三个业务日里，与日志包可对照。
 */
const ADDED_EVENTS: AnomalyEvent[] = [
  /* ---------------- 已结案（多数） ---------------- */
  {
    id: "evt-clock-02",
    at: "2026-09-08 18:03",
    kind: "时间同步越线",
    summary: "时钟同步偏差 0.26s，超过 0.20s 观察线（当次不采集）",
    detail:
      "偏差由本次启动的首次对齐尚未收敛导致。当次未开展采集，因此不影响任何批次数据；已在后续启动中确认收敛。",
    frozenBatch: "—",
    outputsFrozen: false,
    trigger: "实机检查结果",
    deviceEvidence: [
      { at: "18:03", text: "clock offset 0.26s，第 1 次对齐尚未收敛", result: "待观察" },
      { at: "18:22", text: "重新对齐后偏差 0.12s，进入允许范围", result: "正常" },
    ],
    modelEvidence: [],
    handling: [
      { at: "18:05", owner: "饶", text: "记录偏差并在采集前检查中提高优先级，本次不采集" },
      { at: "18:24", owner: "饶", text: "复测通过，观察线保持不变" },
    ],
    conclusion: "同步未收敛导致的瞬时越线，复测 0.12s 正常；采集前检查仍保留该项",
    state: "已结案",
    owner: "饶",
  },
  {
    id: "evt-storage-01",
    at: "2026-09-08 19:11",
    kind: "存储余量不足",
    summary: "可用空间 3.1 GB，低于例行清理线 20 GB",
    detail:
      "临时分片未及时清理累积占用。不影响本次（未采集），但继续采集会截断原始数据，因此按流程先清理再放行。",
    frozenBatch: "—",
    outputsFrozen: false,
    trigger: "实机检查结果",
    deviceEvidence: [
      { at: "19:11", text: "可用空间 3.1 GB，临时分片占 9.4 GB", result: "不足" },
      { at: "19:26", text: "清理 260901–260905 临时分片，可用空间回升至 21.8 GB", result: "正常" },
    ],
    modelEvidence: [],
    handling: [
      { at: "19:13", owner: "饶", text: "暂停一切采集动作，先清理历史临时分片（不删原始数据）" },
      { at: "19:28", owner: "饶", text: "清理完成并复核原始数据目录未被触碰" },
    ],
    conclusion: "临时分片累积所致；已清理历史临时分片，原始数据目录未改动",
    state: "已结案",
    owner: "饶",
  },
  {
    id: "evt-retrans-01",
    at: "2026-09-10 21:47",
    kind: "分片重传",
    summary: "ref-batch-01 分片 214 重传 1 次后成功",
    detail:
      "USB 线缆在设备搬运后接触略松，导致单分片校验失败。自动重传成功，未丢任何帧，但需记录线缆状态以便下次搬运前检查。",
    frozenBatch: "ref-batch-01",
    outputsFrozen: false,
    trigger: "实机检查结果",
    deviceEvidence: [
      { at: "21:47", text: "分片 214 CRC 校验失败，触发重传", result: "记录" },
      { at: "21:47", text: "重传 1 次后 CRC 通过，帧计数一致", result: "正常" },
      { at: "22:05", text: "复查接口：接触电阻偏高，已重新插紧", result: "正常" },
    ],
    modelEvidence: [],
    handling: [
      { at: "21:50", owner: "饶", text: "确认重传成功且帧计数一致，批次数据完整性不受影响" },
      { at: "22:06", owner: "马", text: "记录搬运前需检查 USB 接口，纳入下次出发检查清单" },
    ],
    conclusion: "搬运后接口接触不良；重传成功无丢帧，已纳入出发前检查清单",
    state: "已结案",
    owner: "饶",
  },
  {
    id: "evt-emptyfile-01",
    at: "2026-09-10 22:41",
    kind: "空文件",
    summary: "ref-Z04-g2 分片 scan_001 为 0 字节",
    detail:
      "该分片在写盘前掉电瞬间被创建但未写入。属于参考样本采集，不涉及现场构件结论；该分片已标记不可用，不进入训练集。",
    frozenBatch: "ref-batch-01",
    outputsFrozen: false,
    trigger: "实机检查结果",
    deviceEvidence: [
      { at: "22:41", text: "scan_001 0 字节，同批其余分片正常", result: "记录" },
      { at: "22:52", text: "补采 ref-Z04-g2 第 2 向，字段完整", result: "正常" },
    ],
    modelEvidence: [
      { at: "23:10", text: "该记录在样本清单中标记 quality=不可用（空文件）", result: "已排除" },
    ],
    handling: [
      { at: "22:45", owner: "饶", text: "标记该分片不可用，安排补采，原文件保留以便追溯" },
      { at: "23:12", owner: "史", text: "确认该样本不进入监督训练，仅在清单中留痕" },
    ],
    conclusion: "掉电瞬间产生的空文件；已补采并标记不可用，不进入训练集",
    state: "已结案",
    owner: "饶",
  },
  {
    id: "evt-brownoff-01",
    at: "T+24:18",
    kind: "瞬时压降",
    summary: "供电电压瞬降 0.31V 持续 22ms，未触发欠压保护",
    detail:
      "同一路电源上另有一台设备启动造成瞬时压降。采集未中断、无丢帧；供电模块按设计未触发欠压保护。",
    frozenBatch: "ref-batch-01",
    outputsFrozen: false,
    trigger: "实机检查结果",
    deviceEvidence: [
      { at: "24:18", text: "电压最低 12.07V，持续 22ms，随后恢复 12.41V", result: "记录" },
      { at: "24:19", text: "采集循环未中断，本批帧数完整", result: "正常" },
    ],
    modelEvidence: [],
    handling: [
      { at: "24:25", owner: "饶", text: "核对无丢帧，确认不影响批次数据" },
      { at: "24:30", owner: "马", text: "记录示波器波形，建议后续设备错开上电" },
    ],
    conclusion: "同路设备同时上电所致；无丢帧，建议错开上电",
    state: "已结案",
    owner: "饶",
  },
  {
    id: "evt-gain-01",
    at: "2026-09-11 16:22",
    kind: "增益自动调整",
    summary: "回波偏弱，增益自动上调 1.2dB",
    detail:
      "测区表面较粗糙、入射角偏离，导致回波偏弱。增益在允许范围内自动补偿，未触发重采；调整前后均记录以便复算。",
    frozenBatch: "—",
    outputsFrozen: false,
    trigger: "实机检查结果",
    deviceEvidence: [
      { at: "16:22", text: "回波峰值 0.31，低于参考区间下沿", result: "记录" },
      { at: "16:22", text: "增益 20dB → 21.2dB，峰值回到 0.47", result: "正常" },
    ],
    modelEvidence: [
      { at: "16:40", text: "输入质量检查：信号完整度 96.4%，合格", result: "合格" },
    ],
    handling: [
      { at: "16:26", owner: "饶", text: "确认增益调整在允许范围内，记录调整前后参数" },
    ],
    conclusion: "表面粗糙与入射角所致；自动补偿生效，未触发重采",
    state: "已结案",
    owner: "饶",
  },
  {
    id: "evt-wifi-01",
    at: "2026-09-11 17:05",
    kind: "通道延迟",
    summary: "视频通道延迟 9s，超过 5s 阈值（其余三路正常）",
    detail:
      "按 PRD 3.2「任一路断流只影响该通道」，视频延迟不阻断采集与位姿记录。已确认是推流端编码队列积压，与扫描枪无关。",
    frozenBatch: "—",
    outputsFrozen: false,
    trigger: "实机检查结果",
    deviceEvidence: [
      { at: "17:05", text: "地图 / 位姿 / 车辆三路正常，视频路延迟 9s", result: "延迟" },
      { at: "17:18", text: "推流端重启编码队列后延迟回落至 1.2s", result: "正常" },
    ],
    modelEvidence: [],
    handling: [
      { at: "17:08", owner: "饶", text: "确认采集与位姿通道不受影响，仅监看画面延迟" },
      { at: "17:20", owner: "饶", text: "复核四路状态，视频通道恢复正常" },
    ],
    conclusion: "推流端编码队列积压；仅影响监看画面，采集与位姿不受影响",
    state: "已结案",
    owner: "饶",
  },
  {
    id: "evt-battery-01",
    at: "2026-09-11 17:52",
    kind: "电量偏低",
    summary: "电量 38%，接近采集前检查下限 40%",
    detail:
      "上一批次连续采集消耗较大。本次在检查阶段拦下，未开始采集即更换电池，避免中途掉电导致批次作废。",
    frozenBatch: "—",
    outputsFrozen: false,
    trigger: "实机检查结果",
    deviceEvidence: [
      { at: "17:52", text: "电量 38%，低于检查项下限 40%", result: "不满足" },
      { at: "18:06", text: "更换电池后电量 97%，电压 12.61V", result: "正常" },
    ],
    modelEvidence: [],
    handling: [
      { at: "17:54", owner: "饶", text: "按 SOP 判定不满足采集条件，不启动采集" },
      { at: "18:08", owner: "饶", text: "换电后重新逐条签署采集前检查" },
    ],
    conclusion: "采集前检查按设计拦下；换电后重新签署，未产生作废批次",
    state: "已结案",
    owner: "饶",
  },
  {
    id: "evt-firmware-01",
    at: "2026-09-11 21:14",
    kind: "固件版本不一致",
    summary: "设备回报 FW-2.4.0，平台记录为 FW-2.4.1",
    detail:
      "上一次升级后设备未重启，运行中的仍是旧固件。平台按 PRD 11.4 拒绝「确认应用」，避免把不一致当成一致。",
    frozenBatch: "—",
    outputsFrozen: false,
    trigger: "实机检查结果",
    deviceEvidence: [
      { at: "21:14", text: "设备回报 FW-2.4.0（实机未变）", result: "不一致" },
      { at: "21:31", text: "重启后回报 FW-2.4.1，产物摘要一致", result: "一致" },
    ],
    modelEvidence: [],
    handling: [
      { at: "21:16", owner: "饶", text: "版本比对判为冲突，不确认应用；安排择机重启" },
      { at: "21:33", owner: "饶", text: "重启后回报一致，确认应用完成" },
    ],
    conclusion: "升级后未重启所致；重启后摘要一致，已确认应用",
    state: "已结案",
    owner: "饶",
  },
  {
    id: "evt-dup-sample-01",
    at: "T+26:02",
    kind: "样本疑似重复",
    summary: "r-0003 与 r-0002 摘要高度相似，判为疑似重复",
    detail:
      "同一样本同一方向被采集两次。不删除记录，而是标记 duplicateOf 留痕 —— 直接删掉会让「样本数为什么少了一个」说不清。",
    frozenBatch: "ref-batch-01",
    outputsFrozen: false,
    trigger: "实机检查结果",
    deviceEvidence: [
      { at: "26:02", text: "r-0003 与 r-0002 距离 30mm / 方向 45° 完全相同", result: "记录" },
    ],
    modelEvidence: [
      { at: "26:20", text: "摘要相似度超阈值，quality=待审核，duplicateOf=r-0002", result: "已标记" },
    ],
    handling: [
      { at: "26:05", owner: "饶", text: "标记 duplicateOf 而不删除，保留原始采集记录" },
      { at: "26:25", owner: "马", text: "确认该组样本数量按去重后计算" },
    ],
    conclusion: "同一样本重复采集；标记 duplicateOf 留痕，不删除记录",
    state: "已结案",
    owner: "饶",
  },
  {
    id: "evt-frameshort-01",
    at: "T+30:12",
    kind: "补采完成",
    summary: "Z04 缺帧区间补采完成，帧计数与预期一致",
    detail:
      "针对 28:20 暂停造成的 34 帧缺口安排补采。补采纳入 scan-Z04-002，不修改 scan-Z04-001 的原始记录。",
    frozenBatch: "scan-Z04-002",
    outputsFrozen: false,
    trigger: "排练控制事件",
    deviceEvidence: [
      { at: "30:12", text: "补采 34 帧，序号与缺口区间逐一对齐", result: "正常" },
      { at: "30:40", text: "scan-Z04-002 雷达 420/420、图像 14/14、结果 3/3", result: "完成" },
    ],
    modelEvidence: [],
    handling: [
      { at: "30:15", owner: "饶", text: "确认补采写入新批次，原批次记录保持冻结状态" },
      { at: "30:45", owner: "史", text: "确认缺帧问题关闭，适用域事件仍在跟踪" },
    ],
    conclusion: "暂停导致的缺口已用新批次补全；原批次记录保持不变",
    state: "已结案",
    owner: "饶",
  },

  /* ---------------- 仍未结案（少数，且都是剧本里真实存在的悬念） ---------------- */
  {
    id: "evt-z04-rescan-01",
    at: "T+39:26",
    kind: "复扫数据待判定",
    summary: "Z04 复扫完成，DEMO-M02b 输出待与视觉疑点交叉确认",
    detail:
      "复扫数据完整，但模型版本已变更（DEMO-M02 → DEMO-M02b），两个版本的输出不能直接合并比较；需按融合规则出优先级后再给结论。",
    frozenBatch: "scan-Z04-002",
    outputsFrozen: false,
    trigger: "排练控制事件",
    deviceEvidence: [
      { at: "39:26", text: "复扫批次 scan-Z04-002 数据完整，设备侧无异常", result: "正常" },
      { at: "40:02", text: "参考件复核通过，本次配置与复扫一致", result: "正常" },
    ],
    modelEvidence: [
      { at: "40:30", text: "DEMO-M02b 输出与 DEMO-M02 存在版本差异，不可直接并列", result: "待规则处理" },
      { at: "41:10", text: "融合规则 FUSION-03 尚未对 Z04 下部出优先级", result: "待处理" },
    ],
    handling: [
      { at: "39:40", owner: "饶", text: "确认设备侧无异常，问题在模型版本口径而非采集" },
      { at: "41:20", owner: "史", text: "安排按融合规则出优先级，不直接采信单一版本输出" },
    ],
    conclusion: null,
    state: "处理中",
    owner: "史",
  },
  {
    id: "evt-z02-rough-01",
    at: "T+42:05",
    kind: "待补采确认",
    summary: "Z02 表面轻微褪色，回波未见对应异常，需补采确认",
    detail:
      "外观记录到轻微褪色，但本轮回波在该区域未见对应异常。两者不一致时不下结论，按流程安排补采而不是择一采信。",
    frozenBatch: "—",
    outputsFrozen: false,
    trigger: "实机检查结果",
    deviceEvidence: [
      { at: "42:05", text: "Z02 外观记录：表面轻微褪色，无结构疑点", result: "记录" },
      { at: "42:20", text: "同区域回波正常，未见对应异常", result: "正常" },
    ],
    modelEvidence: [
      { at: "42:40", text: "视觉与雷达证据不一致，模型侧不出结论", result: "待补采" },
    ],
    handling: [
      { at: "42:10", owner: "史", text: "标注为待补采，避免把外观差异直接写成病害" },
    ],
    conclusion: null,
    state: "待处理",
    owner: "史",
  },
];

/**
 * 异常事件全集。
 *
 * 排序规则：**未结案的排在最前面**（这一页的意义就是「还有什么没解决」），
 * 结案的按时间倒序跟在后面。列表里两种状态有明显的视觉区分。
 */
export const TRIAGE_EVENTS: AnomalyEvent[] = [...CORE_EVENTS, ...ADDED_EVENTS].sort((a, b) => {
  const aOpen = a.state === "已结案" ? 1 : 0;
  const bOpen = b.state === "已结案" ? 1 : 0;
  if (aOpen !== bOpen) return aOpen - bOpen;
  return b.at.localeCompare(a.at);
});
