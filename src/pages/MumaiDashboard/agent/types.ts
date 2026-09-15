/**
 * 小木语音智能体 · 共享类型
 *
 * 放在单独文件里，避免 facts.ts / matcher.ts / tools.ts / store.ts 之间循环引用
 * （facts 需要 EntityBag，matcher 产出 EntityBag，store 又需要 facts）。
 */

/** 抽取到的槽位：键是槽位名（pillar / zone / risk / order / batch / page / scene / map / speed） */
export type EntityBag = Record<string, string | undefined>;

/** 状态（技术方案 §25）：IDLE / LISTENING / RECOGNIZING / UNDERSTANDING / THINKING /
 *  PLANNING / EXECUTING / WAITING_TOOL / RESPONDING / FINISHED / ERROR */
export type AgentState =
  | "IDLE"
  | "LISTENING"
  | "RECOGNIZING"
  | "UNDERSTANDING"
  | "THINKING"
  | "PLANNING"
  | "EXECUTING"
  | "WAITING_TOOL"
  | "RESPONDING"
  | "FINISHED"
  | "ERROR";

/** 状态机徽标的中文说明，界面与日志共用一份 */
export const AGENT_STATE_LABEL: Record<AgentState, string> = {
  IDLE: "待命",
  LISTENING: "正在聆听",
  RECOGNIZING: "语音识别中",
  UNDERSTANDING: "语义理解中",
  THINKING: "思考中",
  PLANNING: "生成执行计划",
  EXECUTING: "正在执行",
  WAITING_TOOL: "等待工具返回",
  RESPONDING: "组织回复",
  FINISHED: "已完成",
  ERROR: "异常",
};

/** 风险动作的确认请求（方案 §42） */
export type ConfirmRequest = {
  id: number;
  /** 确认层标题，例如「确认让小车前往一号木柱吗？」 */
  title: string;
  detail: string;
  risk: number;
  tool: string;
  /** 取消后的说明 */
  cancelText: string;
};

/** 一条工具调用记录（§22 / PRD 4.1 的「工具卡片显示实际调用状态」） */
export type ToolRunRecord = {
  id: number;
  tool: string;
  label: string;
  args: Record<string, string>;
  state: "running" | "waiting" | "done" | "failed" | "cancelled";
  risk: number;
  /** 工具返回的摘要，界面直接显示 */
  result: string;
  at: string;
  durationMs: number;
};

/** Agent 执行步骤（§24 的三态清单：done / running / pending） */
export type AgentStep = {
  index: number;
  name: string;
  status: "done" | "running" | "pending" | "failed" | "skipped";
  message: string;
  tool?: string;
};

/** 会话记录：用户一轮 / 小木一轮 */
export type UserTurn = {
  kind: "user";
  id: number;
  at: string;
  text: string;
  /** 文本输入 / 按住说话 / 示例问句 */
  via: "text" | "mic" | "example";
  level: number;
};

export type BotTurn = {
  kind: "bot";
  id: number;
  at: string;
  text: string;
  intentId: string | null;
  intentName: string;
  type: string;
  confidence: number;
  level: string;
  /** 命中的规则说明（空表示走了相似度匹配） */
  rule: string | null;
  /** 事实表（业务状态） */
  facts: { key: string; value: string; tone: string }[];
  entities: { name: string; value: string }[];
  /** 多步任务的步骤清单 */
  steps: AgentStep[];
  /** 语音包标签（seed 的 voice 列） */
  voice: string;
  toolRuns: ToolRunRecord[];
  /** 一句话说明这轮为什么这么答（回退 / 低置信 / 待确认…） */
  note: string;
};

export type Turn = UserTurn | BotTurn;


