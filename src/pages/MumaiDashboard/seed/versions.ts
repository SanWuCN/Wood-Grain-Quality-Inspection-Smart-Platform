/**
 * 平台版本矩阵（PRD 3.6 / 11.3 / 11.4，剧本 S15–S18）
 *
 * 「固件及模型」页要能全局配置当前平台使用的模型、Agent、小车程序、
 * 毫米波扫描枪固件、采集配置、推理流水线 —— 这些版本号必须是**单一来源**，
 * 不能散落在页面里各自写一份（PRD 16 的硬要求）。
 *
 * 这里给的不是「一个当前值 + 两个候选」，而是每个组件的**发行历史**。
 * 理由是版本管理页面的真实职责是回答三个问题，只给两个 chip 一个都答不了：
 *   ① 现在跑的是哪个版本，它是什么时候、因为什么发出来的；
 *   ② 出问题能退到哪个版本去（可回退 / 已弃用要分得清）；
 *   ③ 设备**回报**的版本和平台**以为**的版本是否一致
 *      —— PRD 11.4 明说 live_reported_version 与 demo_reported_version
 *      要分开保存，不能让模拟回执覆盖真机状态。
 *
 * 取值口径与既有种子保持一致：
 *   - 模型版本沿用 DEMO-M02（见 SCAN_BATCHES 的 modelVersion），候选 DEMO-M02b
 *   - 配置版本沿用 CFG-02（见 ENV_RECORD 与 CONFIG_DIFF）
 *   - 更新包沿用 DEMO-PKG-02（见 UPDATE_PACKAGE）
 *
 * 与实际设备的关系标注为 `live` / `replay` / `simulation`，
 * 与 seed 其它部分同一套 SourceMode 语义。
 */

import type { SourceMode } from "./types";

/**
 * 交付物类型（PRD 11.3：平台管理三类交付）。
 *
 * 前三项是 PRD 原文的三类；配置 / 平台 / 索引不是「交付给设备的包」，
 * 各自单列一类，避免把配置文件硬说成固件（PRD 11.3 明确禁止
 * 「给占位数据命名成可烧录固件」）。
 */
export type ArtifactKind =
  | "独立模型包"
  | "集成模型固件包"
  | "演示包"
  | "配置包"
  | "平台构建"
  | "索引快照";

/** 发行状态。只表达「现在能不能用」，不表达新旧 */
export type ReleaseStatus = "当前生效" | "可回退" | "候选" | "已弃用";

/** 一次发行记录 */
export type Release = {
  version: string;
  /** 构建 / 发布日（演示业务日期附近） */
  releasedAt: string;
  status: ReleaseStatus;
  artifactKind: ArtifactKind;
  /** 包大小；索引这类不按包走的给数据量 */
  size: string;
  /** 变更说明：为什么会有这个版本。写事实，不写「优化了体验」这种话 */
  change: string;
  /** 目标芯片与加载位置（PRD 11.3 要求真实固件分支记录这几项） */
  target: string;
  /** 运行依赖与约束 —— 版本能不能换，一半取决于这一条 */
  depends: string;
  /** 内容摘要前 12 位，够在界面上核对；完整摘要在更新交付页 */
  digest: string;
};

/** 一个可配置组件：当前生效值 + 设备回报值 + 完整发行历史 */
export type VersionItem = {
  key: string;
  /** 分组：硬件 / 算法 / 平台 */
  group: "硬件" | "算法" | "平台";
  label: string;
  /** 当前生效版本 */
  current: string;
  /** 当前版本的来源模式 */
  sourceMode: SourceMode;
  /** 这个组件的载体（哪台设备 / 哪个进程） */
  target: string;
  /**
   * 设备回报版本。实机与演示分开保存（PRD 11.4）——
   * `null` 表示该侧没有回报，**不要用当前值冒充回报值**：
   * 「平台以为的版本」和「设备回报的版本」一致才算更新成功。
   */
  reported: { live: string | null; demo: string | null };
  /** 为什么是当前这个值 —— 页面上要能说明依据，不能只给一个数字 */
  note: string;
  /** 发行历史，按时间倒序 */
  releases: Release[];
};

export const VERSION_ITEMS: VersionItem[] = [
  {
    key: "scanner-firmware",
    group: "硬件",
    label: "毫米波扫描枪固件",
    current: "FW-2.4.1",
    sourceMode: "simulation",
    target: "手持毫米波 02 号机（scan-dev-02）",
    reported: { live: null, demo: "FW-2.4.1" },
    note: "负责原始 ADC 采集与落盘。升级需要设备侧停机，且必须与采集配置版本匹配。",
    releases: [
      {
        version: "FW-2.5.0-rc1",
        releasedAt: "2026-09-09",
        status: "候选",
        artifactKind: "集成模型固件包",
        size: "2.8 MB",
        change: "打通 IAP 更新通道，模型参数与采集程序分开写入、分开回读",
        target: "ESP32-S3 · 模型区 ota_1（与 app 分区分离）",
        depends: "采集配置 CFG-02 及以上；需上位机 IAP 脚本 1.3+",
        digest: "9d4c7a1e0b35",
      },
      {
        version: "FW-2.4.1",
        releasedAt: "2026-08-21",
        status: "当前生效",
        artifactKind: "集成模型固件包",
        size: "2.6 MB",
        change: "修正连续采集 40 分钟以上时的 ADC 丢帧；落盘改为双缓冲",
        target: "ESP32-S3 · app 分区 ota_0",
        depends: "采集配置 CFG-02；模型 DEMO-M02 及以下",
        digest: "3f9c1d2a7b45",
      },
      {
        version: "FW-2.4.0",
        releasedAt: "2026-07-30",
        status: "可回退",
        artifactKind: "集成模型固件包",
        size: "2.6 MB",
        change: "落盘吞吐由 1.2 MB/s 提到 2.4 MB/s，支持 420 点频谱整帧落盘",
        target: "ESP32-S3 · app 分区 ota_0",
        depends: "采集配置 CFG-02",
        digest: "a17e5b93c204",
      },
      {
        version: "FW-2.3.2",
        releasedAt: "2026-06-18",
        status: "已弃用",
        artifactKind: "集成模型固件包",
        size: "2.4 MB",
        change: "420 点频谱下堆内存不足，运行约 12 分钟后重启，已停止使用",
        target: "ESP32-S3 · app 分区 ota_0",
        depends: "仅支持 256 点频谱",
        digest: "5b20f8c7de91",
      },
    ],
  },
  {
    key: "scanner-config",
    group: "硬件",
    label: "采集配置版本",
    current: "CFG-02",
    sourceMode: "simulation",
    target: "手持毫米波 02 号机（scan-dev-02）",
    reported: { live: null, demo: "CFG-02" },
    note: "决定频段、增益与采样窗口。改动会影响已采批次的可用性，回退需重采。",
    releases: [
      {
        version: "CFG-02",
        releasedAt: "2026-09-11",
        status: "当前生效",
        artifactKind: "配置包",
        size: "4 KB",
        change: "采样窗口由 256 点放宽到 420 点，增益下调 3 dB 避免近距饱和",
        target: "扫描枪运行时配置区",
        depends: "固件 FW-2.4.0 及以上",
        digest: "c81f2d6a0b47",
      },
      {
        version: "CFG-01",
        releasedAt: "2026-05-28",
        status: "可回退",
        artifactKind: "配置包",
        size: "4 KB",
        change: "首版现场配置，256 点频谱；参考样本批次沿用这一版",
        target: "扫描枪运行时配置区",
        depends: "固件 FW-2.3.x 及以上",
        digest: "2e6b904f7a15",
      },
    ],
  },
  {
    key: "cart-program",
    group: "硬件",
    label: "小车程序版本",
    current: "DEMO-CART-1.6.0",
    sourceMode: "replay",
    target: "演示车 DEMO-CART-01",
    reported: { live: "未获运动权限（只读监视）", demo: "DEMO-CART-1.6.0" },
    note: "负责建图、定位与巡检执行。实机 FIREBAT-N100 未获运动权限，只做只读监视。",
    releases: [
      {
        version: "DEMO-CART-1.7.0-rc2",
        releasedAt: "2026-09-10",
        status: "候选",
        artifactKind: "演示包",
        size: "18.4 MB",
        change: "航点执行改为到点确认后再走下一段，避免窄通道内抢行",
        target: "上位机 ROS1 Noetic · 演示车",
        depends: "需配合 MAP-SH-06 地图版本",
        digest: "7a3d15e8b062",
      },
      {
        version: "DEMO-CART-1.6.0",
        releasedAt: "2026-08-14",
        status: "当前生效",
        artifactKind: "演示包",
        size: "18.1 MB",
        change: "建图与巡检任务拆分；任务暂停后可原地恢复继续",
        target: "上位机 ROS1 Noetic · 演示车",
        depends: "地图 MAP-SH-05 及以上",
        digest: "b6409c2fe713",
      },
      {
        version: "DEMO-CART-1.5.3",
        releasedAt: "2026-07-02",
        status: "可回退",
        artifactKind: "演示包",
        size: "17.9 MB",
        change: "修正长走廊回环失败；重定位耗时由 8s 降到 3s",
        target: "上位机 ROS1 Noetic · 演示车",
        depends: "地图 MAP-SH-05",
        digest: "41c8ea07b395",
      },
    ],
  },
  {
    key: "model",
    group: "算法",
    label: "检测模型版本",
    current: "DEMO-M02",
    sourceMode: "simulation",
    target: "毫米波扫描枪推理进程",
    reported: { live: "FW-1.4.2（实机未变）", demo: "DEMO-M02b（已回验）" },
    note: "DEMO-M02 缺少该批次木材的有效标定记录，所以 Z04 初扫批次已冻结为「适用域待核验」。",
    releases: [
      {
        version: "DEMO-M03-candidate",
        releasedAt: "2026-09-11",
        status: "候选",
        artifactKind: "独立模型包",
        size: "3.2 MB",
        change: "本轮 Z04 新材小样本适配产物，仅更新材质相关分支（约 8.4% 参数）",
        target: "ESP32-S3 · 模型区 ota_1（独立于 app 分区）",
        depends: "预处理 comp-v1.4 / 输入 1×420 频谱向量",
        digest: "e2f71b4c9a08",
      },
      {
        version: "DEMO-M02b",
        releasedAt: "2026-09-11",
        status: "可回退",
        artifactKind: "独立模型包",
        size: "3.2 MB",
        change: "INT8 量化后复测通过；边界样本 2 条回退 float 分支",
        target: "ESP32-S3 · 模型区 ota_1",
        depends: "预处理 comp-v1.4；算子 conv2d/bn/relu/gap/fc",
        digest: "3f9c1d2a7b45",
      },
      {
        version: "DEMO-M02",
        releasedAt: "2026-08-25",
        status: "当前生效",
        artifactKind: "独立模型包",
        size: "3.1 MB",
        change: "离线基线：异常二分类 + 3 类材质；本轮作为对照基线使用",
        target: "ESP32-S3 · 模型区 ota_0",
        depends: "预处理 comp-v1.3 及以上",
        digest: "88ad3f106c72",
      },
      {
        version: "DEMO-M01",
        releasedAt: "2026-06-30",
        status: "已弃用",
        artifactKind: "独立模型包",
        size: "3.0 MB",
        change: "首版单任务模型，只输出异常二分类，无材质分支，已被 M02 取代",
        target: "ESP32-S3 · 模型区 ota_0",
        depends: "预处理 comp-v1.1",
        digest: "0c5be7412fd9",
      },
    ],
  },
  {
    key: "agent",
    group: "算法",
    label: "Agent 版本",
    current: "AGENT-1.2.0",
    sourceMode: "simulation",
    target: "平台语义路由与任务编排",
    reported: { live: null, demo: "AGENT-1.2.0" },
    note: "只负责意图识别与工具编排，不参与缺陷判定；工具白名单与风险等级随版本一起下发。",
    releases: [
      {
        version: "AGENT-1.3.0-rc1",
        releasedAt: "2026-09-08",
        status: "候选",
        artifactKind: "平台构建",
        size: "1.1 MB",
        change: "多步编排支持回滚点：任一步失败可退到该步之前，不再整段重来",
        target: "平台前端 AgentHost",
        depends: "工具白名单 1.3；需与 PIPE-A 同时生效",
        digest: "6f14d0b83a25",
      },
      {
        version: "AGENT-1.2.0",
        releasedAt: "2026-08-19",
        status: "当前生效",
        artifactKind: "平台构建",
        size: "1.0 MB",
        change: "意图识别改为槽位校验后再编排；越权工具直接拒绝并说明原因",
        target: "平台前端 AgentHost",
        depends: "工具白名单 1.2",
        digest: "d9704a2c5e18",
      },
      {
        version: "AGENT-1.1.0",
        releasedAt: "2026-07-11",
        status: "已弃用",
        artifactKind: "平台构建",
        size: "0.9 MB",
        change: "首次接入语音控制台；槽位缺失时会直接跳到默认页面，已因此下线",
        target: "平台前端 AgentHost",
        depends: "工具白名单 1.1",
        digest: "38ef6c07b4a1",
      },
    ],
  },
  {
    key: "pipeline",
    group: "算法",
    label: "推理流水线",
    current: "PIPE-A",
    sourceMode: "simulation",
    target: "毫米波扫描枪推理进程",
    reported: { live: null, demo: "PIPE-A" },
    note: "A：频谱直接入模；B：先做一次时域降噪再入模。两者输出口径不同，不可混用同一批结论。",
    releases: [
      {
        version: "PIPE-B",
        releasedAt: "2026-09-07",
        status: "候选",
        artifactKind: "配置包",
        size: "12 KB",
        change: "入模前加一级时域降噪，低信噪比样本响应更稳，输出口径与 A 不同",
        target: "扫描枪推理进程",
        depends: "需重新标定，不能与 PIPE-A 的结论混用同一批",
        digest: "a4c19e0d7f36",
      },
      {
        version: "PIPE-A",
        releasedAt: "2026-08-25",
        status: "当前生效",
        artifactKind: "配置包",
        size: "12 KB",
        change: "频谱直接入模，不经降噪；与本轮全部已出结论的批次一致",
        target: "扫描枪推理进程",
        depends: "预处理 comp-v1.3 及以上",
        digest: "1d7b53f0ca82",
      },
    ],
  },
  {
    key: "platform",
    group: "平台",
    label: "平台版本",
    current: "v1.0.0",
    sourceMode: "replay",
    target: "本平台前端",
    reported: { live: null, demo: "v1.0.0" },
    note: "随更新包整体升级，不支持单独切换。",
    releases: [
      {
        version: "v1.0.0",
        releasedAt: "2026-09-11",
        status: "当前生效",
        artifactKind: "平台构建",
        size: "—",
        change: "第二章演示版本：九页路由、四角色权限、小木工具编排",
        target: "浏览器（HashRouter）",
        depends: "无",
        digest: "local-build",
      },
    ],
  },
  {
    key: "knowledge-index",
    group: "平台",
    label: "知识库索引",
    current: "KB-11",
    sourceMode: "replay",
    target: "本地检索索引",
    reported: { live: null, demo: "KB-11" },
    note: "由知识库页的「更新向量库」推进版本，不在这里手工指定。",
    releases: [
      {
        version: "KB-11",
        releasedAt: "2026-09-10",
        status: "当前生效",
        artifactKind: "索引快照",
        size: "2.1 MB",
        change: "并入修缮工法与木材病害两类资料；切分长度统一到 512 字",
        target: "本地索引快照",
        depends: "无",
        digest: "7c0f4b91e2a6",
      },
      {
        version: "KB-10",
        releasedAt: "2026-08-02",
        status: "可回退",
        artifactKind: "索引快照",
        size: "1.8 MB",
        change: "首版资料索引，仅含工单与检测报告",
        target: "本地索引快照",
        depends: "无",
        digest: "b3e84107dc59",
      },
    ],
  },
];

/**
 * 重训练流水线的阶段。
 *
 * 与 PRD 3.6 的 job 阶段（排队 / 数据准备 / 适配 / 验证 / 完成）一一对应，
 * 但把「数据准备」展开成清洗与分组两步 —— 那两步在 PRD 11.1 里有独立的
 * 校验语义（同物理样本不得跨集合），摊平成一个「数据准备」会看不出来。
 * `jobStep` 指回 EXPERIMENT.jobSteps 的 key，控制台按这个字段把日志分行。
 */
export const RETRAIN_STAGES = [
  { key: "collect", label: "汇总采集数据", detail: "并入候选池", jobStep: "queue" },
  { key: "clean", label: "清洗与去重", detail: "去重与剔除", jobStep: "prepare" },
  { key: "split", label: "分组划分", detail: "按物理样本组划分", jobStep: "prepare" },
  { key: "train", label: "训练候选模型", detail: "固定随机种子", jobStep: "adapt" },
  { key: "evaluate", label: "对比基线评估", detail: "同测试集对比基线", jobStep: "validate" },
  { key: "package", label: "封装更新包", detail: "登记 SHA-256", jobStep: "done" },
  { key: "dispatch", label: "下发硬件工程师", detail: "指派接收人", jobStep: "done" },
] as const;
