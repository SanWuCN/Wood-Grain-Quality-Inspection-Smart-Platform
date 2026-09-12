/**
 * 平台版本矩阵（PRD 3.6 / 剧本 S15–S18）
 *
 * 「固件及模型」页要能全局配置当前平台使用的模型、agent、小车程序、
 * 毫米波扫描枪固件、模型版本 —— 这些版本号必须是**单一来源**，
 * 不能散落在页面里各自写一份（PRD 16 的硬要求）。
 *
 * 取值口径与既有种子保持一致：
 *   - 模型版本沿用 DEMO-M02（见 SCAN_BATCHES 的 modelVersion）
 *   - 配置版本沿用 CFG-02（见 ENV_RECORD 与 CONFIG_DIFF）
 *   - 更新包沿用 DEMO-PKG-02（见 UPDATE_PACKAGE）
 *
 * 与实际设备的关系标注为 `live` / `replay` / `simulation`，
 * 与 seed 其它部分同一套 SourceMode 语义。
 */

import type { SourceMode } from "./types";

/** 一个可配置项的当前值、候选值与约束 */
export type VersionItem = {
  key: string;
  /** 分组：硬件 / 算法 / 平台 */
  group: "硬件" | "算法" | "平台";
  label: string;
  /** 当前生效版本 */
  current: string;
  /** 当前版本的来源模式 */
  sourceMode: SourceMode;
  /** 可切换到的版本；空数组表示只能随更新包升级 */
  candidates: string[];
  /** 这个组件的载体（哪台设备 / 哪个进程） */
  target: string;
  /** 为什么是这个值 —— 页面上要能说明依据，不能只给一个数字 */
  note: string;
};

export const VERSION_ITEMS: VersionItem[] = [
  {
    key: "scanner-firmware",
    group: "硬件",
    label: "毫米波扫描枪固件",
    current: "FW-2.4.1",
    sourceMode: "simulation",
    candidates: ["FW-2.4.1", "FW-2.5.0-rc1"],
    target: "手持毫米波 02 号机（scan-dev-02）",
    note: "负责原始 ADC 采集与落盘。升级需要设备侧停机，且必须与采集配置版本匹配。",
  },
  {
    key: "scanner-config",
    group: "硬件",
    label: "采集配置版本",
    current: "CFG-02",
    sourceMode: "simulation",
    candidates: ["CFG-01", "CFG-02"],
    target: "手持毫米波 02 号机（scan-dev-02）",
    note: "决定频段、增益与采样窗口。改动会影响已采批次的可用性，回退需重采。",
  },
  {
    key: "cart-program",
    group: "硬件",
    label: "小车程序版本",
    current: "DEMO-CART-1.6.0",
    sourceMode: "replay",
    candidates: ["DEMO-CART-1.6.0", "DEMO-CART-1.7.0-rc2"],
    target: "演示车 DEMO-CART-01",
    note: "负责建图、定位与巡检执行。实机 FIREBAT-N100 未获运动权限，只做只读监视。",
  },
  {
    key: "model",
    group: "算法",
    label: "检测模型版本",
    current: "DEMO-M02",
    sourceMode: "simulation",
    candidates: ["DEMO-M01", "DEMO-M02", "DEMO-M03-candidate"],
    target: "毫米波扫描枪推理进程",
    note: "DEMO-M02 缺少该批次木材的有效标定记录，所以 Z04 初扫批次已冻结为「适用域待核验」。",
  },
  {
    key: "agent",
    group: "算法",
    label: "Agent 版本",
    current: "AGENT-1.2.0",
    sourceMode: "simulation",
    candidates: ["AGENT-1.2.0", "AGENT-1.3.0-rc1"],
    target: "平台语义路由与任务编排",
    note: "只负责意图识别与工具编排，不参与缺陷判定；工具白名单与风险等级随版本一起下发。",
  },
  {
    key: "pipeline",
    group: "算法",
    label: "推理流水线",
    current: "PIPE-A",
    sourceMode: "simulation",
    candidates: ["PIPE-A", "PIPE-B"],
    target: "毫米波扫描枪推理进程",
    note: "A：频谱直接入模；B：先做一次时域降噪再入模。两者输出口径不同，不可混用同一批结论。",
  },
  {
    key: "platform",
    group: "平台",
    label: "平台版本",
    current: "v1.0.0",
    sourceMode: "replay",
    candidates: [],
    target: "本平台前端",
    note: "随更新包整体升级，不支持单独切换。",
  },
  {
    key: "knowledge-index",
    group: "平台",
    label: "知识库索引",
    current: "KB-11",
    sourceMode: "replay",
    candidates: [],
    target: "本地检索索引",
    note: "由知识库页的「更新向量库」推进版本，不在这里手工指定。",
  },
];

/** 重训练流水线的阶段（PRD 3.6 / 11.2，剧本 S15） */
export const RETRAIN_STAGES = [
  { key: "collect", label: "汇总采集数据", detail: "并入候选池" },
  { key: "clean", label: "清洗与去重", detail: "去重与剔除" },
  { key: "split", label: "分组划分", detail: "按物理样本组划分" },
  { key: "train", label: "训练候选模型", detail: "固定随机种子" },
  { key: "evaluate", label: "对比基线评估", detail: "同测试集对比基线" },
  { key: "package", label: "封装更新包", detail: "登记 SHA-256" },
  { key: "dispatch", label: "下发硬件工程师", detail: "指派接收人" },
] as const;
