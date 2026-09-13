/**
 * 小木语音智能体 · Intent Dispatcher + Executor（技术方案 §18 / §19 / §24 / §25 / §45 / §58）
 *
 * 一次请求的完整链路（方案 §45）：
 *
 *   Final Text → Normalize → Rule Matcher ─┬─ Hit → Execute
 *                                          └─ Miss → Similarity（本地等价 Embedding）
 *                                                   ├─ High → Intent Execute
 *                                                   ├─ Low  → 回复但标注低置信；高风险动作不执行
 *                                                   └─ 复杂任务（AGENT）→ Plan → Tool Calling
 *
 * 状态机（§25）在每一步推进，界面据此播放动画：
 *   UNDERSTANDING → [PLANNING] → EXECUTING / WAITING_TOOL → RESPONDING → FINISHED
 *
 * 安全约束（§41 / §42 / §44 / §58）：
 *   - 低置信度不执行高风险动作
 *   - risk ≥ 3 的工具必须二次确认；一次请求只确认一次（多步任务在执行前统一确认）
 *   - 工具只能来自 Tool Registry，规划器不能造工具名
 */

import { clockStamp } from "../lib";
import { CURRENT_RISKS, KNOWLEDGE_META, WAYPOINTS } from "../seed/scenario";
import {
  annotateHighRiskBlocked,
  annotateLowConfidence,
  installDegradeGuard,
  replyFallback,
  replyNotHeard,
  type MatchJudge,
} from "./degrade";
import { evaluateFacts, factToneOf, type FactContext, type FactRow, type LiveSnapshot } from "./facts";
import {
  FALLBACK_TEXT,
  voicePackOf,
  type Intent,
} from "./intents";
import { understand, SEMANTIC_THRESHOLDS, type MatchResult } from "./matcher";
import { planFacts, planTask, type TaskPlan } from "./planner";
import {
  finishToolRun,
  getAgentState,
  makeToolContext,
  nextId,
  patchStep,
  pushTurn,
  requestConfirm,
  setAgent,
  setSteps,
  startToolRun,
  updateLastBot,
} from "./store";
import { resolveArgs, toolByName, TOOL_BY_NAME, type ToolDef } from "./tools";
import type { AgentStep, BotTurn, EntityBag } from "./types";

/** 小木运行时的外部依赖：由 VoiceConsole 注入（路由 + Mumai 会话状态 + 播报） */
export type Runtime = {
  navigate: ((to: string) => void) | null;
  /** 会话上下文：阶段、账号、通道摘要、数据来源 */
  session: Pick<FactContext, "stageKey" | "accountLabel" | "sourceMode" | "channelSummary">;
  /** 播报（TTS） */
  speak: (text: string) => void;
};

/** 每步之间的真实延时上限，让观众看清执行过程（§24 的重点就是「看得见」） */
const STEP_DELAY = 900;

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/* ------------------------------------------------------------------ *
 * 本轮取消令牌（AC-04「统一关闭生命周期」）
 * ------------------------------------------------------------------ */

/**
 * 为什么需要它：`ask()` 是**异步**的，一轮里要 await 好几次
 * （160ms 理解、每步最多 900ms、确认气泡、工具调用、220ms 组织回复）。
 * 关闭界面时如果只是把 store 里的 `open` 置 false，已经飞在半空的那一轮
 * 醒来后照样 `setAgent(...)`、照样 `runtime.speak(...)`，于是：
 *
 *   · 面板"关掉又自己冒出来"（状态机回到 RESPONDING/EXECUTING，而面板的
 *     可见判据里包含"正在交互"，这是复现过的现象）；
 *   · TTS 明明被 `speechSynthesis.cancel()` 掐掉了，几百毫秒后又从头念一遍；
 *   · 未确认的高风险确认层被关掉后又被重新拉起。
 *
 * AC-04 要求的是「关闭 → 取消本轮 → 待机」，所以关闭必须能**真正打断**
 * 这条异步链。做法是给每一轮发一个代号，关闭时把代号 +1；链上每个
 * await 之后都先问一句"我还是当前这一轮吗"，不是就直接退出、不再写任何状态。
 * 这比在每处 await 上挂 AbortController 更轻，也不必给 `window.setTimeout`
 * 包一层可取消实现（`sleep` 仍然只是 sleep）。
 */
let runGeneration = 0;

/** 取消当前这一轮并把状态机复位（幂等；关闭界面、开新一轮都会调用） */
export function cancelRun(reason = "已取消本轮"): void {
  runGeneration += 1;
  setAgent({ agentState: "IDLE", stateNote: reason, level: 0, partial: "" });
}

/** 这一轮是否已经被取消（代号变了就说明它已经不是"当前轮"） */
function stale(gen: number | undefined): boolean {
  return gen !== undefined && gen !== runGeneration;
}

const ENTITY_LABEL: Record<string, string> = {
  pillar: "构件",
  zone: "测区",
  risk: "风险编号",
  order: "工单号",
  batch: "批次号",
  page: "页面",
  pageLabel: "页面名",
  scene: "场景",
  map: "地图版本",
  speed: "速度",
  route: "路由",
};

function entityRows(entities: EntityBag): { name: string; value: string }[] {
  return Object.entries(entities)
    .filter(([, value]) => Boolean(value))
    .map(([name, value]) => ({ name: ENTITY_LABEL[name] ?? name, value: String(value) }));
}

function liveSnapshot(): LiveSnapshot {
  const live = getAgentState().live;
  return {
    battery: live.battery,
    position: live.waypointLabel,
    missionState: live.missionState,
    mapId: live.mapId,
    mapping: live.mapping,
    scanning: live.scanning,
    waypointDone: Math.min(live.waypointIndex + 1, WAYPOINTS.length),
    waypointTotal: WAYPOINTS.length,
  };
}

function factContext(
  runtime: Runtime,
  entities: EntityBag,
  template: string,
  extra?: Record<string, string>,
): FactContext {
  return { ...runtime.session, entities, template, live: liveSnapshot(), extra };
}

/** §30：同一意图的多个说法随机选一个，降低机械感 */
function pickTemplate(intent: Intent): string {
  const alternatives = intent.response.alternatives ?? [];
  if (alternatives.length === 0) return intent.response.text;
  const pool = [intent.response.text, ...alternatives];
  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * 组装一条意图回复 —— **文字入口与语音入口共用这一个入口**（评审 §3.8）。
 *
 * 面板原来自己有一张 25 个键的事实表和一套 `renderAnswer`，与 agent 的
 * `facts.ts`（99 个键）各算各的：同一个问题在两个入口能问出不同数字。
 * 现在两边都从这里拿模板与事实，模板占位符取不到值时返回 `missing`，
 * 由调用方降级成「没听懂」，不猜数字（PRD 4.2）。
 */
export function composeReply(
  intent: Intent,
  entities: EntityBag,
  runtime: Runtime,
): { text: string; rows: FactRow[]; missing: string[] } {
  const factSet = evaluateFacts(intent, factContext(runtime, entities, pickTemplate(intent)));
  return { text: factSet.text, rows: factSet.rows, missing: factSet.missing };
}

function botTurnBase(patch: Partial<BotTurn> & { text: string }): BotTurn {
  return {
    kind: "bot",
    id: nextId(),
    at: clockStamp(),
    intentId: null,
    intentName: "未命中意图目录",
    type: "RESPONSE",
    confidence: 0,
    level: "fallback",
    rule: null,
    facts: [],
    entities: [],
    steps: [],
    voice: "—",
    toolRuns: [],
    note: "",
    ...patch,
  };
}

/* ------------------------------------------------------------------ *
 * 回复组装
 * ------------------------------------------------------------------ */

/** 构造一轮小木回复并推入会话流 */
function replyIntent(
  runtime: Runtime,
  intent: Intent,
  match: MatchResult,
  opts: {
    text?: string;
    steps?: AgentStep[];
    note?: string;
    templateOverride?: string;
    extraFacts?: Record<string, string>;
  } = {},
): BotTurn {
  const template = opts.templateOverride ?? pickTemplate(intent);
  const factSet = evaluateFacts(intent, factContext(runtime, match.entities, template, opts.extraFacts));
  const turn = botTurnBase({
    text: factSet.missing.length ? FALLBACK_TEXT : (opts.text ?? factSet.text),
    intentId: intent.id,
    intentName: intent.name,
    type: intent.type,
    confidence: match.confidence,
    level: match.level,
    rule: match.rule?.reason ?? null,
    facts: factSet.rows.map((row) => ({ ...row, tone: factToneOf(row.key, row.value) })),
    entities: entityRows(match.entities),
    steps: opts.steps ?? [],
    voice: voicePackOf(intent.id),
    note:
      opts.note ??
      (match.level === "rule"
        ? "一级规则匹配：确定性指令，直接执行（§11）"
        : match.level === "low"
          ? `低置信命中（Top1 ${match.confidence.toFixed(3)}，margin ${match.margin.toFixed(3)}）：先回复并标注不确定（§15 / §41）`
          : `相似度匹配 Top1 ${match.confidence.toFixed(3)}（margin ${match.margin.toFixed(3)}）`),
  });
  pushTurn(turn);
  return turn;
}

/**
 * Fallback 回复（§41）：不猜、不执行，给出可选动作。
 *
 * 实现已挪到 `degrade.ts` 的 `replyFallback(judge?)` —— 四种失败降级
 * （未听清 / 低置信 / 未命中 / 服务断开）现在集中在同一处，便于一处读完、
 * 一处断言（PRD §FR-10）。这里保留一个薄封装，只是把 `MatchResult`
 * 翻译成它要的判据，避免调用方都要自己拆字段。
 *
 * 换掉旧实现的一个实际好处：旧版把阈值 `0.68` **硬编码在提示文案里**，
 * 与 `SEMANTIC_THRESHOLDS.lowConfidence` 是两个可能漂移的数字；
 * 现在从常量取。
 */
function replyFallbackFromMatch(match: MatchResult, runtime: Runtime): void {
  const judge: MatchJudge = {
    confidence: match.confidence,
    margin: match.margin,
    lowThreshold: SEMANTIC_THRESHOLDS.lowConfidence,
  };
  // 播报回调必须传：兜底回复也要出声，否则用户以为设备没反应（见 degrade.ts 的说明）
  replyFallback(judge, runtime.speak);
}

/* ------------------------------------------------------------------ *
 * 工具执行（含确认层）
 * ------------------------------------------------------------------ */

export type ToolOutcome = {
  ok: boolean;
  summary: string;
  facts: Record<string, string>;
  blocked: boolean;
  args: Record<string, string>;
  tool: string;
  label: string;
};

/**
 * 执行单个工具。
 * askConfirm=false 时跳过确认（多步任务在执行前已经统一确认过一次）。
 */
export async function runTool(
  tool: ToolDef,
  args: Record<string, string>,
  runtime: Runtime,
  entities: EntityBag,
  askConfirm: boolean,
  confirmTitle?: string,
  gen?: number,
): Promise<ToolOutcome> {
  const ctx = makeToolContext(runtime.navigate, entities);
  const runId = startToolRun({ tool: tool.name, label: tool.label, args, risk: tool.risk, state: "running" });
  const startedAt = Date.now();

  // §42：高风险动作二次确认
  if (tool.requireConfirmation && askConfirm) {
    finishToolRun(runId, "等待用户确认", "waiting", Date.now() - startedAt);
    setAgent({ agentState: "WAITING_TOOL", stateNote: `等待确认：${tool.label}` });
    const approved = await requestConfirm({
      title: confirmTitle ?? tool.confirmText?.(args) ?? `确认执行「${tool.label}」吗？`,
      detail: `${tool.description}（风险等级 ${tool.risk}/4；参数 ${JSON.stringify(args)}）`,
      risk: tool.risk,
      tool: tool.name,
      cancelText: "已取消，未执行任何动作。",
    });
    if (!approved || stale(gen)) {
      finishToolRun(runId, stale(gen) ? "本轮已取消" : "用户取消", "cancelled", Date.now() - startedAt);
      return { ok: false, summary: "用户取消", facts: {}, blocked: true, args, tool: tool.name, label: tool.label };
    }
  }

  // 关闭界面/新一轮到来后，绝不允许旧的一轮把工具真的跑出去
  if (stale(gen)) {
    finishToolRun(runId, "本轮已取消", "cancelled", Date.now() - startedAt);
    return { ok: false, summary: "本轮已取消", facts: {}, blocked: true, args, tool: tool.name, label: tool.label };
  }

  setAgent({ agentState: "EXECUTING", stateNote: `调用工具：${tool.label}` });
  try {
    const result = await tool.run(args, ctx);
    finishToolRun(runId, result.summary, result.ok ? "done" : "failed", Date.now() - startedAt);
    return {
      ok: result.ok,
      summary: result.summary,
      facts: result.facts ?? {},
      blocked: false,
      args,
      tool: tool.name,
      label: tool.label,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    finishToolRun(runId, `工具异常：${message}`, "failed", Date.now() - startedAt);
    return {
      ok: false,
      summary: `工具异常：${message}`,
      facts: {},
      blocked: false,
      args,
      tool: tool.name,
      label: tool.label,
    };
  }
}

/* ------------------------------------------------------------------ *
 * 多步 Agent 任务（§23 / §24）
 * ------------------------------------------------------------------ */

async function runPlan(runtime: Runtime, intent: Intent, match: MatchResult, plan: TaskPlan, gen?: number): Promise<void> {
  setAgent({ agentState: "PLANNING", stateNote: `生成执行计划（${plan.steps.length} 步）` });

  // §24 的步骤清单：理解任务 → 生成执行计划 → 逐步动作（✓ / ● / ○ 三态）
  const steps: AgentStep[] = [
    { index: 0, name: "理解任务", status: "done", message: `目标：${plan.goal}` },
    { index: 1, name: "生成执行计划", status: "done", message: `${plan.steps.length} 步 · 计划里程 ${plan.distanceM} m` },
    ...plan.steps.map((step, index) => ({
      index: index + 2,
      name: step.label,
      status: "pending" as const,
      message: step.runningMessage,
      tool: step.tool,
    })),
  ];
  setSteps(steps);

  const template = pickTemplate(intent);
  const factSet = evaluateFacts(intent, factContext(runtime, match.entities, template, planFacts(plan)));
  const turn = botTurnBase({
    text: factSet.text,
    intentId: intent.id,
    intentName: intent.name,
    type: "AGENT",
    confidence: match.confidence,
    level: match.level,
    rule: match.rule?.reason ?? null,
    facts: factSet.rows.map((row) => ({ ...row, tone: factToneOf(row.key, row.value) })),
    entities: entityRows(match.entities),
    steps,
    voice: voicePackOf(intent.id),
    note: `Agent 编排：规则规划器解析出 ${plan.steps.length} 个动作（§23 的 plan 形态，工具全部来自 Registry）`,
  });
  pushTurn(turn);

  // 多步任务在执行前统一确认一次（避免每一步都弹确认层）
  const risky = plan.steps.filter((step) => TOOL_BY_NAME[step.tool]?.requireConfirmation);
  if (risky.length > 0) {
    setAgent({ agentState: "WAITING_TOOL", stateNote: "等待用户确认整条任务" });
    const approved = await requestConfirm({
      title: `确认执行这条任务吗？（${plan.steps.length} 步）`,
      detail: `${plan.goal}；步骤：${plan.steps.map((step) => step.label).join(" → ")}`,
      risk: Math.max(...risky.map((step) => TOOL_BY_NAME[step.tool]?.risk ?? 3)),
      tool: "agent_plan",
      cancelText: "已取消，未执行任何步骤。",
    });
    if (!approved || stale(gen)) {
      setSteps(
        steps.map((step) => (step.status === "pending" ? { ...step, status: "skipped", message: "用户取消" } : step)),
      );
      updateLastBot(() => ({ note: "用户取消了这条多步任务，未执行任何步骤。" }));
      setAgent({ agentState: "FINISHED", stateNote: "任务已取消" });
      if (!stale(gen)) runtime.speak("好的，这条任务已经取消。");
      return;
    }
  }

  let failed = false;
  for (let i = 0; i < plan.steps.length; i += 1) {
    const spec = plan.steps[i];
    const stepIndex = i + 2;
    // 关闭界面后不再逐步推进：留在"待执行"上比继续跑工具安全得多
    if (stale(gen)) return;
    const tool = toolByName(spec.tool);
    patchStep(stepIndex, { status: "running", message: spec.runningMessage });
    if (!tool) {
      patchStep(stepIndex, { status: "failed", message: `工具 ${spec.tool} 不在白名单内，已跳过（§44）` });
      failed = true;
      break;
    }
    await sleep(Math.min(spec.delayMs, STEP_DELAY));
    if (stale(gen)) return;
    const outcome = await runTool(tool, resolveArgs(spec.args, match.entities), runtime, match.entities, false, undefined, gen);
    if (stale(gen)) return;
    if (!outcome.ok) {
      patchStep(stepIndex, { status: "failed", message: outcome.summary });
      failed = true;
      break;
    }
    patchStep(stepIndex, { status: "done", message: spec.doneMessage });
    updateLastBot((current) => ({
      note: `${current.note}；第 ${i + 1}/${plan.steps.length} 步完成：${spec.doneMessage}`,
    }));
  }

  if (stale(gen)) return;
  setAgent({ agentState: "RESPONDING", stateNote: "汇总执行结果" });
  const doneCount = getAgentState().steps.filter((step) => step.status === "done").length;
  const tail = failed
    ? `任务未全部完成：${doneCount} 个步骤成功，已停止后续动作。`
    : `任务执行完成，${plan.steps.length} 个动作全部成功，小车已返回起点。`;
  updateLastBot((current) => ({ text: `${current.text}${tail}`, note: `${current.note}。${tail}` }));
  setAgent({ agentState: "FINISHED", stateNote: failed ? "任务部分完成" : "任务执行完成" });
  if (!stale(gen)) runtime.speak(tail);
}

/* ------------------------------------------------------------------ *
 * 单步动作 / 查询
 * ------------------------------------------------------------------ */

async function runSingleAction(runtime: Runtime, intent: Intent, match: MatchResult, gen?: number): Promise<void> {
  const action = intent.action;
  if (!action) {
    const turn = replyIntent(runtime, intent, match);
    setAgent({ agentState: "RESPONDING", stateNote: "组织回复并播报" });
    await sleep(200);
    if (stale(gen)) return;
    runtime.speak(turn.text);
    setAgent({ agentState: "FINISHED", stateNote: "已完成" });
    return;
  }

  const tool = toolByName(action.tool);
  if (!tool) {
    replyIntent(runtime, intent, match, {
      note: `意图声明的工具 ${action.tool} 不在 Tool Registry 内，已拒绝执行（§44）`,
    });
    setAgent({ agentState: "FINISHED", stateNote: "工具不在白名单，未执行" });
    runtime.speak(FALLBACK_TEXT);
    return;
  }

  // §41 / §58：低置信度不执行高风险动作
  if (match.level === "low" && tool.risk >= 3) {
    const turn = replyIntent(runtime, intent, match, {
      note: `低置信（${match.confidence.toFixed(3)}）且工具风险 ${tool.risk}：按安全策略不执行动作，只回复`,
    });
    /**
     * FR-10 第 2 条：低置信必须让用户看见"识别成了什么""应该怎么说"，
     * 并明确标注不确定；高风险被拦下时还要说清是**因为**低置信才没执行
     * （不然用户会以为功能坏了）。
     */
    annotateLowConfidence(match.raw, intent);
    annotateHighRiskBlocked();
    setAgent({ agentState: "FINISHED", stateNote: "低置信 + 高风险：不执行" });
    runtime.speak(`${turn.text}我没有完全听清，如果确认要执行，请再说一次，例如「${intent.examples[0]}」。`);
    return;
  }

  const outcome = await runTool(tool, resolveArgs(action.params, match.entities), runtime, match.entities, true, undefined, gen);
  if (stale(gen)) return;
  if (outcome.blocked) {
    updateLastBot(() => ({ text: outcome.summary === "用户取消" ? "好的，这条指令已经取消，我没有执行任何动作。" : outcome.summary }));
    setAgent({ agentState: "FINISHED", stateNote: "等待确认时被取消" });
    runtime.speak("好的，这条指令已经取消。");
    return;
  }

  // PRD 4.2：工具失败时如实说明失败，不播成功话术
  const turn = replyIntent(runtime, intent, match, {
    text: outcome.ok ? undefined : `这一步没有成功：${outcome.summary}`,
    extraFacts: outcome.facts,
  });
  setAgent({ agentState: "RESPONDING", stateNote: "组织回复并播报" });
  await sleep(220);
  if (stale(gen)) return;
  runtime.speak(turn.text);
  setAgent({ agentState: "FINISHED", stateNote: outcome.ok ? "已完成" : "工具失败，已如实说明" });
}

/** 纯查询意图：先跑一次只读工具，再按工具返回的真实结果回答（§18 QUERY） */
async function runQuery(runtime: Runtime, intent: Intent, match: MatchResult, gen?: number): Promise<void> {
  let facts: Record<string, string> | undefined;
  const action = intent.action;
  if (action) {
    const tool = toolByName(action.tool);
    if (tool && tool.risk === 0) {
      const outcome = await runTool(tool, resolveArgs(action.params, match.entities), runtime, match.entities, false, undefined, gen);
      if (stale(gen)) return;
      facts = outcome.facts;
      if (!outcome.ok) {
        const failedTurn = replyIntent(runtime, intent, match, {
          text: `这一步没有成功：${outcome.summary}`,
          extraFacts: facts,
        });
        setAgent({ agentState: "FINISHED", stateNote: "工具失败，已如实说明" });
        runtime.speak(failedTurn.text);
        return;
      }
    }
  }
  const turn = replyIntent(runtime, intent, match, { extraFacts: facts });
  /**
   * FR-10 第 2 条：查询类低置信**可以回复**，但必须标注不确定，
   * 并把「识别成了什么 / 建议怎么说」摆出来，用户才有纠正的抓手。
   */
  if (match.level === "low") annotateLowConfidence(match.raw, intent);
  setAgent({ agentState: "RESPONDING", stateNote: "组织回复并播报" });
  await sleep(200);
  if (stale(gen)) return;
  runtime.speak(turn.text);
  setAgent({ agentState: "FINISHED", stateNote: "已完成" });
}

/* ------------------------------------------------------------------ *
 * 对外唯一入口
 * ------------------------------------------------------------------ */

/**
 * 模块加载即装上降级守卫（PRD FR-10 第 4 条 / FR-02 第 5 条）。
 *
 * 为什么放在模块级而不是某个组件的 effect：执行器被多个入口 import
 * （右下角气泡、全屏控制台、standalone 兜底），**谁先 import 谁就装上**，
 * 不依赖任何组件是否挂载。放在组件里会出现"控制台没开就没人订阅通道状态"，
 * 而那恰恰是最需要它的时候（面板关着、靠唤醒说话）。
 */
installDegradeGuard();

export async function ask(text: string, runtime: Runtime, via: "text" | "mic" | "example" = "text"): Promise<void> {
  const trimmed = text.trim();
  /**
   * 空文本 = 「未听清」（PRD FR-10 第 1 条）。
   *
   * 原先是 `if (!trimmed) return;` —— **静默返回**。后果很具体：
   * 用户喊醒了小木、说了句谁都没听懂的话，服务端如实回了一条空命令，
   * 而这里直接吞掉，界面上什么都没有 —— 比说错话更糟，
   * 因为用户不知道是自己的问题还是它坏了。
   *
   * 现在给一条可见的提示，并且**一个工具都不调用**（`replyNotHeard` 里
   * 没有任何通向 Tool Registry 的路径）。
   */
  if (!trimmed) {
    replyNotHeard(via);
    return;
  }

  /**
   * 本轮代号：**新命令进来会让上一轮作废**（AC-03 的串行化纪律）。
   * 与其让两轮交错写同一个 store，不如明确地"后到者打断先到者" ——
   * 用户看到的是最新那条被完整回答，而不是两条回答互相盖。
   */
  const gen = ++runGeneration;

  pushTurn({ kind: "user", id: nextId(), at: clockStamp(), text: trimmed, via, level: getAgentState().level });
  setAgent({ agentState: "UNDERSTANDING", stateNote: "规范化 + 意图匹配", partial: "", finalText: trimmed });

  await sleep(160);
  if (stale(gen)) return;
  const match = understand(trimmed, 4);

  if (!match.intent) {
    replyFallbackFromMatch(match, runtime);
    return;
  }

  if (match.missingSlots.length > 0) {
    // §17：槽位缺失时给出可选值，不猜着执行
    const hint = match.missingSlots.includes("pillar") ? "（可选构件：Z01 / Z02 / Z03 / Z04）" : "";
    const turn = replyIntent(runtime, match.intent, match, {
      text: `这条指令还缺一个必要参数，我没有执行。${hint}`,
      note: `槽位缺失：${match.missingSlots.join("、")}（PRD 4.2 必需槽位校验）`,
    });
    setAgent({ agentState: "FINISHED", stateNote: "槽位缺失，未执行" });
    runtime.speak(turn.text);
    return;
  }

  if (match.intent.type === "AGENT") {
    const plan = planTask(trimmed, match.entities);
    if (plan.steps.length === 0) {
      replyFallbackFromMatch(match, runtime);
      return;
    }
    await runPlan(runtime, match.intent, match, plan, gen);
    return;
  }

  if (match.intent.type === "QUERY") {
    await runQuery(runtime, match.intent, match, gen);
    return;
  }

  await runSingleAction(runtime, match.intent, match, gen);
}

/* ------------------------------------------------------------------ *
 * 供界面 / 自检使用的小工具
 * ------------------------------------------------------------------ */

/** 一句话说明这一轮匹配是怎么来的（界面上显示，让观众看到「不是大模型」） */
export function describeMatch(match: MatchResult): string {
  if (match.rule) return `规则命中：${match.rule.reason}`;
  if (!match.intent) return `未命中：Top1 ${match.confidence.toFixed(3)} 低于置信阈值，按 Fallback 处理`;
  return `相似度命中 ${match.intent.id}（${match.confidence.toFixed(3)}，margin ${match.margin.toFixed(3)}）`;
}

/** 检索说明：与知识库共用同一份检索配置文案（PRD 5.2） */
export const RETRIEVAL_NOTE = `${KNOWLEDGE_META.retriever} · TopK ${KNOWLEDGE_META.topK}`;

/** 本轮重点风险（回复里「先给证据再打开」的顺序依据） */
export const FOCUS_RISK_ID = CURRENT_RISKS[0]?.id ?? "";

/** 不执行任何工具的干跑，供演示控制台自检 */
export function dryRun(text: string): MatchResult {
  return understand(text, 4);
}

/** 工具是否在 Registry 内（§44 自检） */
export function hasTool(name: string): boolean {
  return Boolean(TOOL_BY_NAME[name]);
}

/** 供界面读取实时快照 */
export function readLive() {
  return getAgentState().live;
}
