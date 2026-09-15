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
  INTENT_BY_ID,
  voicePackOf,
  type Intent,
} from "./intents";
import { advanceOrderReveal, beginOrderReveal, CHARS_PER_SECOND } from "../ordersReveal";
import { useWorkOrderStore } from "../store/workOrders";
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
import { mainLineOf, type ScriptRound } from "./script";

import { routeUtterance, type ScriptMatch } from "./scriptMatch";
import type { AgentStep, BotTurn, EntityBag } from "./types";

/** 小木运行时的外部依赖：由 VoiceConsole 注入（路由 + Mumai 会话状态 + 播报） */
export type Runtime = {
  navigate: ((to: string) => void) | null;
  /** 会话上下文：阶段、账号、通道摘要、数据来源 */
  session: Pick<FactContext, "stageKey" | "accountLabel" | "sourceMode" | "channelSummary">;
  /** 播报（TTS） */
  /**
   * 播报（TTS）。
   *
   * ⚠ 返回类型是 `void | Promise<void>`，**不要**收窄成 `void`：
   * `VoiceOutput.speak()` 本来就是 Promise（音频 onended / 合成 onend 时 resolve），
   * 剧本轮次靠它把"逐段展开"校准到**真实播报时长**。
   * 声明成 `void` 会让调用方拿不到这个 Promise，只能退回按字数估算 ——
   * 实测那会让板块比声音慢好几秒（64 字估算 16.6s，实际约 11.6s）。
   */
  speak: (text: string) => void | Promise<void>;
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
 * 剧本轮次回复：命中第二章剧本时，播**逐字台词**。
 *
 * ── 为什么要单独一条路径，而不是塞进意图表 ──────────────────────────
 * `INTENTS` 是**意图目录**（回答"用户想干什么"），台词是**排练稿**
 * （回答"这一轮小木该说哪几句原话"）。两者更新节奏完全不同：
 * 意图随产品能力增删，台词是按稿子逐字对的。
 * 混进意图表还会破坏 `voicePackOf()` 的编号映射 ——
 * 稿子里只有六轮带 `AI语音3`~`AI语音8` 标注，而那个函数是按数组下标推编号的。
 *
 * 所以剧本走 `script.ts` 自己的表 + `scriptMatch.ts` 的模糊匹配，
 * 命中后在这里组装成一轮正常的 `BotTurn` 推入会话流，并交给 `runtime.speak` 播报 ——
 * 与意图回复走**同一套落库与播报机制**，界面上看不出两套。
 */
function replyScript(round: ScriptRound, match: ScriptMatch, runtime: Runtime): BotTurn {
  /*
    取哪一句：
      · 默认取 main
      · ⑮ 那种带"等待时选用"的备用播报，只有在该轮确实处于等待/审核未结束时才追加 ——
        现在没有真实审核状态可依据，所以**只播 main**，并把备用句写进 note 让排练者知道它存在。
        （排演约束明确要求"不按倒计时编造成功"，不能凭空把备用句也念出来。）
  */
  const line = mainLineOf(round);
  const extras = round.lines.filter((l) => l.role !== "main");

  const turn = botTurnBase({
    text: line,
    intentId: round.intentId,
    intentName: `剧本 ${round.roundNo} · ${round.title}`,
    type: "RESPONSE",
    confidence: match.score,
    level: "rule",
    rule: match.reason,
    /* 剧本轮次不展示业务事实表：台词里已经把该说的都说完了 */
    facts: [],
    entities: [
      { name: "剧本轮次", value: `${round.roundNo}（${round.paragraph}）` },
      { name: "幕", value: round.act },
      ...(round.precondition ? [{ name: "前置条件", value: round.precondition }] : []),
    ],
    /* ⑦ 步：这一轮是否需要真实工具尚未接通 */
    steps: [],
    voice: round.voicePack ?? "（未标注语音编号，走 TTS）",
    note:
      `剧本命中：${match.reason}` +
      (extras.length
        ? ` · 另有 ${extras.length} 句"等待时选用"的备用播报（${extras.map((l) => l.role).join("/")}），` +
          "在对应时机才播，此处不念。"
        : ""),
  });
  pushTurn(turn);
  const spoken = runtime.speak(turn.text);
  /**
   * 剧本轮次**也要执行该轮声明的动作**。
   *
   * 原来这里播完就 `return turn` —— 于是第①轮「读取这份工单」说完之后页面纹丝不动，
   * 用户看到的是"小木只是回了句话"（这正是本次要修的现象）。
   *
   * 播报是同步的、工具往返是异步的，所以这里**不 await**：先让声音起来，
   * 导航与逐段揭示随后跟上，与现场观感一致（等到 await 回来再出声就慢了半拍）。
   *
   * ── 把播报的 Promise 传下去，用来**校准**揭示节奏 ────────────────────
   * 「随语音播放展开板块」这件事，原先只有"按字数估时"一条路：
   * 估算偏长时，声音早已念完、板块还在慢慢亮（实测第①轮揭示跨 13.5s，
   * 而 64 字的台词按 5.5 字/秒 约 11.6s —— 观感就是"页面跟不上嘴"）。
   * `VoiceOutput.speak()` 本身是 Promise（音频 `onended` / 合成 `onend` 时 resolve，
   * 且有看门狗兜底），把它传下去，就能在**真实播报结束**时把最后一段落定，
   * 而不是继续等估算。拿不到 Promise（注入的是同步实现）时退回纯估算，行为不变。
   */
  void applyScriptAction(round, runtime, spoken);
  return turn;
}

/**
 * 执行剧本轮次声明的动作，并在需要时驱动「随播报逐步加载」。
 *
 * 两条硬约束：
 *   ① **只跑低风险工具**（`risk === 0`）。剧本是排练稿，不能因为改了台词就顺手
 *      执行高风险动作；导航类（`open_order` / `open_panel`）的风险都是 0。
 *   ② **不伪造成功**。台词已经说完了，工具失败只记日志、不补播成功话术。
 */
async function applyScriptAction(round: ScriptRound, runtime: Runtime, spoken?: unknown): Promise<void> {
  const intent = round.intentId ? INTENT_BY_ID[round.intentId] : undefined;
  const action = intent?.action;
  const entities = scriptEntities();

  /**
   * **显式导航优先**（`round.nav`）。
   *
   * 为什么不只靠下面那段"跑该轮 intent 的 action"：逐轮验证时发现
   * 22 轮里只有少数几轮的 intent 恰好指向工单页 —— ④ ㉑ ㉒ 的 `intentId` 是 null
   * （没有 action 可跑），⑧ ⑩ ⑰ 的动作指向别的页面，⑳ 甚至跳到字面量
   * `?order=draft`（占位符没人替换）。结果就是"台词念完了，页面纹丝不动"。
   * 现在把导航写成剧本自己的声明，与 intent 解耦；`nav` 存在时**也不再跑**
   * 那个不相干的 intent 动作，避免"先跳到 A、又被拽去 B"。
   */
  if (round.nav?.route === "order") {
    const wanted = round.nav.order === "current" ? (entities.order ?? "") : round.nav.order;
    const tool = toolByName("open_order");
    if (tool && wanted) {
      try {
        await runTool(tool, { order: wanted }, runtime, entities, false);
      } catch (error) {
        console.warn(`[script] 第 ${round.roundNo} 轮的导航失败：`, error);
      }
    } else if (!wanted) {
      console.warn(`[script] 第 ${round.roundNo} 轮要打开工单，但拿不到工单 id（列表可能还没拉回来）`);
    }
  } else if (action) {
    const tool = toolByName(action.tool);
    /**
     * 门槛是「**不产生副作用、也不需要二次确认**」，不是「风险为 0」。
     *
     * 踩过的坑：这里一开始写 `tool.risk === 0`，结果第①轮的 `open_order`
     * 风险等级是 **1**（打开页面/跳转类都不是 0），于是导航被自己挡掉，
     * 现象与"没接动作"一模一样 —— 排查时先怀疑了路由、又怀疑了权限，最后才发现是门槛。
     *
     * 现在按语义放行：`risk <= 1` 且 `requireConfirmation === false`
     * （导航、选中、只读）；风险 ≥2 或需要确认的动作**一律不执行**——
     * 那类必须走正常意图链路，让用户在意图层显式确认。
     */
    const scriptsMayRun = tool && tool.risk <= 1 && !tool.requireConfirmation;
    if (scriptsMayRun) {
      try {
        await runTool(tool, resolveArgs(action.params, entities), runtime, entities, false);
      } catch (error) {
        console.warn(`[script] 第 ${round.roundNo} 轮的动作 ${action.tool} 执行失败：`, error);
      }
    } else if (tool) {
      console.warn(
        `[script] 第 ${round.roundNo} 轮的动作 ${action.tool}（风险 ${tool.risk}${tool.requireConfirmation ? "，需确认" : ""}）剧本不执行`,
      );
    }
  }
  if (round.reveal?.target === "order-detail") {
    startOrderDetailReveal(round, entities.order ?? "", spoken);
  }
}

/**
 * 剧本轮次的槽位来源。
 *
 * 剧本没有 matcher 抽出来的 `entities`，但第①轮的动作是"打开**这份**工单" ——
 * 指的就是快捷键刚建出来的那张。工单列表由服务端按创建时间倒序返回，取第一条即最新；
 * 列表还没拉回来时，退回详情里正在看的那一张。
 */
function scriptEntities(): EntityBag {
  const state = useWorkOrderStore.getState();
  const newest = state.orders[0]?.id ?? state.detail?.order?.id ?? "";
  return newest ? { order: newest } : {};
}

/**
 * 让工单详情**跟着这句台词的节奏**逐段出现。
 *
 * 节拍口径与 `tts.ts` 的看门狗一致（按字数估时、不短于 2.5s）：
 * 声音一响先揭示第 1 段（页面不能是空的），随后按比例推进，
 * 最后一段落在约 80% 处 —— 留出收尾，避免"话还没说完页面就铺满了"。
 */
function startOrderDetailReveal(round: ScriptRound, orderId: string, spoken?: unknown): void {
  const total = round.reveal?.panels ?? 0;
  if (!orderId || total <= 0) return;
  beginOrderReveal(orderId, total);

  /*
    ⚠ 估时口径统一到**字/秒**，不再用"每字 260ms"。
    正文里 64 字 × 260ms ≈ 16.6s，而中文播报约 5.5 字/秒（≈182ms/字）——
    260ms 明显偏长，这正是"板块比声音慢"的算术来源。
    语速常量从 `ordersReveal.ts` 取（与揭示机制同源），避免两处口径漂移。
  */
  const chars = mainLineOf(round).length;
  const estimatedMs = Math.max(2500, Math.round((chars / CHARS_PER_SECOND) * 1000));

  let done = 0;
  const timers: number[] = [];
  for (let stage = 1; stage <= total; stage += 1) {
    const at = stage === 1 ? 0 : Math.round((estimatedMs * 0.8 * stage) / total);
    timers.push(window.setTimeout(() => {
      done = Math.max(done, stage);
      advanceOrderReveal(orderId, stage);
    }, at));
  }

  /*
    真实播报结束 → 把剩下的段落立刻补齐，并撤掉还没到点的定时器。
    `VoiceOutput.speak()` 是 Promise（音频 onended / 合成 onend 时 resolve，且有看门狗兜底），
    所以"最后一块亮起"永远不会晚于声音结束 —— 这就是用户要的「随语音播放展开」。
    拿不到 Promise（注入的是同步实现）时什么都不做，退回纯估算。
  */
  if (spoken && typeof (spoken as Promise<void>).then === "function") {
    void (spoken as Promise<void>)
      .catch(() => { /* 播报失败也要把页面铺完，不能停在半截 */ })
      .then(() => {
        for (const t of timers) window.clearTimeout(t);
        if (done < total) advanceOrderReveal(orderId, total);
      });
  }
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

  /**
   * ── 剧本优先（用户需求：呼叫「小木小木」→ 听后文关键词 → 播对应台词）──
   *
   * 判据放在意图匹配**之前**，因为剧本台词是**逐字稿**：
   * 排演/验收都按稿子对字，一旦命中就不能被意图的模板文案改写。
   * 剧本没命中（`matchScriptRound` 返回 null 或 verdict 不是 hit）时
   * 完全不影响下面原有的意图链路 —— 这就是"加一条支路"而不是"改主路"。
   *
   * ⚠ 只有 `verdict === "hit"` 才走剧本：`ambiguous`（两轮得分接近）与
   *   `too-weak`（没够阈值）都交回原有链路处理，避免"猜错轮次播错台词"，
   *   那在演示现场是最难堪的错。
   */
  const route = routeUtterance(trimmed);
  if (route.kind === "script") {
    setAgent({ agentState: "RESPONDING", stateNote: `剧本命中 ${route.round.roundNo}` });
    replyScript(route.round, route.match, runtime);
    setAgent({ agentState: "FINISHED", stateNote: "" });
    return;
  }

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


