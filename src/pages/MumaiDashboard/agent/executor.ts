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
import { CURRENT_RISKS, DATASET, KNOWLEDGE_META, WAYPOINTS } from "../seed/scenario";
import {
  annotateHighRiskBlocked,
  annotateLowConfidence,
  installDegradeGuard,
  replyFallback,
  replyNotHeard,
  type MatchJudge,
} from "./degrade";
import { evaluateFacts, factToneOf, type FactContext, type FactRow, type LiveSnapshot } from "./facts";
import { buildSyncBackupStream } from "./syncBackup";
import { voicePackEntryCount } from "./voicePack";
import {
  FALLBACK_TEXT,
  INTENT_BY_ID,
  voicePackOf,
  type Intent,
} from "./intents";
import { advanceOrderReveal, beginOrderReveal, cancelOrderReveal, runRevealTimeline, splitClauses, splitSegments } from "../ordersReveal";
import {
  advanceCleanFlowReveal,
  beginCleanFlowReveal,
  cancelCleanFlowReveal,
  cleanFlowMounted,
} from "../cleanFlowReveal";
import {
  advanceWorkbenchReveal,
  beginWorkbenchReveal,
  cancelWorkbenchReveal,
  workbenchMounted,
} from "../workbenchReveal";
import { commissionBinding } from "../commissionBinding";
import { useWorkOrderStore } from "../store/workOrders";
import { ensureTaskCards } from "../store/taskCards";
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
import { SCRIPT_ROUNDS, mainLineOf, type ScriptRound } from "./script";

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

/**
 * 播报前的「思考」时长（毫秒）。
 *
 * 用户口径：**2.5~4 秒之间取随机数**，不要固定值。
 *
 * 为什么是随机而不是固定：固定时长连着念几轮会显出机械感 ——
 * 每次都"不多不少卡在同一秒"开口，演示时一眼就能看出是写死的延时。
 * 取随机数之后节奏更像真的在想。
 *
 * 为什么下限是 2.5 秒、上限 4 秒：
 *   · 原先写的 5 秒是**为了看清思考动画**才拉长的（`bb20efc` 从 2 秒翻到 4 秒、
 *     后来又被调到 5 秒），不是交互本身的需要；
 *   · 2.5 秒是"思考动画看得清"与"不让人干等"之间的折中 ——
 *     低于 2 秒思考动画会一闪而过（`a190c45` 修的就是"只显示 0.5 秒"）；
 *   · 4 秒上限保证整轮节奏不拖。
 *
 * ⚠ 改这个范围要同步两处判据，否则会误报失败：
 *   · `voice-module/tools/验唤醒链路.mjs` 的等待上限（现为 20 秒，覆盖 4 秒足够）
 *   · 任何按墙上时钟断言"思考完了没"的验收工装
 */
const THINK_MIN_MS = 2500;
const THINK_MAX_MS = 4000;

function thinkingDelayMs(): number {
  return THINK_MIN_MS + Math.round(Math.random() * (THINK_MAX_MS - THINK_MIN_MS));
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
function replyScript(
  round: ScriptRound,
  match: ScriptMatch,
  runtime: Runtime,
  /**
   * 快捷键要求**只念这一句**（逐字）。
   *
   * ── 为什么需要它 ────────────────────────────────────────────────
   * 一轮可能有多句戏（如 ⑮ 的主台词 + `audit` 审核播报、④ 的主台词 + 段15 同步备份）。
   * 默认口径是"只念 main、备用句只写进 note"（防凭空把等待语当结论念出来），
   * 于是**指向备用句的那条快捷键会念成主台词** —— 按的是段221、听到的是段229，
   * 演示人当场就会发现"按键说的和它回答的不是一件事"。
   *
   * ⚠ 生效范围**只有按键直达这条路**（`ask()` 的 `target.lineOverride`），
   *   语音命中一律不传它，保持"一轮只念 main"的原有约束不变。
   *   而且覆写值必须**确实是该轮 lines 里的一句**（下面会核对），
   *   不允许由按键传进任意文本 —— 否则快捷键就成了"随便让小木念任何话"的后门。
   */
  lineOverride?: string,
): BotTurn {
  /*
    取哪一句：
      · 默认取 main
      · ⑮ 那种带"等待时选用"的备用播报，只有在该轮确实处于等待/审核未结束时才追加 ——
        现在没有真实审核状态可依据，所以**只播 main**，并把备用句写进 note 让排练者知道它存在。
        （排演约束明确要求"不按倒计时编造成功"，不能凭空把备用句也念出来。）
      · 例外：快捷键明确指向某一句时（`lineOverride`），念那一句 —— 前提是它
        **确实是本轮的台词**，否则忽略覆写、退回 main（宁可不换，也不能念稿外的文本）。
  */
  const requested =
    lineOverride != null && round.lines.some((l) => l.text === lineOverride) ? lineOverride : null;
  const line = requested ?? mainLineOf(round);
  /*
    `main` 之外的句子一律**不念**，但要说清是哪一类：
      · `waiting` / `audit` 是备用播报（在对应时机才播）；
      · `host` 是**讲解人自己说的**（第 ④ 轮文档后半句，用户 2026-09-18 口径）——
        它既不是小木的备用句，也不会被播报，所以不能混进"备用播报"那句说明里。
  */
  const extras = round.lines.filter((l) => l.role !== "main");
  const waiting = extras.filter((l) => l.role === "waiting" || l.role === "audit");
  const hostLines = extras.filter((l) => l.role === "host");

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
      (waiting.length
        ? ` · 另有 ${waiting.length} 句"等待时选用"的备用播报（${waiting.map((l) => l.role).join("/")}），` +
          "在对应时机才播，此处不念。"
        : "") +
      (hostLines.length ? ` · 另有 ${hostLines.length} 句由**讲解人自己说**（不播报）。` : ""),
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
   * 25 轮里只有少数几轮的 intent 恰好指向工单页，很多轮的 `intentId` 是 null
   * （没有 action 可跑），另一些轮的动作指向别的页面，还有的跳到字面量
   * `?order=draft`（占位符没人替换）。结果就是"台词念完了，页面纹丝不动"。
   *
   * ⚠ 这里**刻意不再逐轮列编号**：剧本按用户文档重排过三次（22→23→25 轮），
   *   每列一次编号就会过期一次，而"哪些轮 intent 是 null"随时可查。
   * 现在把导航写成剧本自己的声明，与 intent 解耦；`nav` 存在时**也不再跑**
   * 那个不相干的 intent 动作，避免"先跳到 A、又被拽去 B"。
   */
  if (round.nav && round.nav.route === "order") {
    /*
      `order` 的三种取值：
        · "bound"   —— **显式绑定优先**（用户点「查看」新工单通知时绑上的那张，
                       防幻觉规则 3 的落点）。绑定时一律以它为准，绝不因为
                       "列表里还有更新的"就改念另一张；
        · "current" —— 列表最新那张（其余轮次的既有口径，经 entities 解析）；
        · 其它字符串 —— 明确指定的工单 id。
      ⚠ v2 起 `order` 是可选字段（非工单页的轮次不写它）：缺省按 "current" 处理。

      ── 未绑定时**退回 current**（2026-09-23 小木带路验收暴露出的静默失手）────
      原实现是"没绑定就**不导航**"。但**同一轮的台词取值**用的是 `scriptEntities()`
      = `bound ?? 列表最新`（见本文件下面那个函数）：于是未绑定时会出现"小木照着最新
      那张工单念完了四组内容，页面却停在原地"——台词与页面各说一套，正是用户抱怨的
      "念完没有页面动作"。现在两支合成同一条口径（绑定优先、未绑定退回 current），
      并在退回时留一条 info 日志，排练时一看便知这次靠的是哪张单。
      没有工单可退（列表为空 / 还没拉回来）时仍然**不导航、不猜**。
    */
    const want = round.nav.order ?? "current";
    const bound = want === "bound" ? (commissionBinding.get() ?? "") : "";
    if (want === "bound" && !bound) {
      console.info(
        `[script] 第 ${round.roundNo} 轮没有显式绑定的工单，退回列表最新那张（台词取值本来就是这条口径）`,
      );
    }
    const wanted = want === "bound" ? bound || (entities.order ?? "") : want === "current" ? (entities.order ?? "") : want;
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
  } else if (round.nav) {
    /*
      ── 非工单页的页面落点（v2 小木带路，用户 2026-09-23 口径）────────────
      剧本每一轮都发生在某张页面上（天气档案 / 建图巡航 / 三维场景 / 异常排查 /
      数据集 / 训练验证 / 更新交付 / 融合分析…）。原先只有工单页那 8 轮会真的跳转，
      其余轮次"念完停在原地、只弹一个小卡片"，观众看到的是"小木只是回了句话"。
      现在按该轮声明的 route + tab / view / component / batch 走**既有的** `navigate_page`
      工具（与自由问答里"打开数据集"走的是同一个工具、同一条 withQuery），
      不新增第二套跳转实现，也不会出现"两套路由写法各说一套"。

      ⚠ 与上面那支一样：工具失败只记日志，**不补播成功话术**（剧本是排练稿，
        页面没跳过去时该看见的是现象，不是一句安慰）。
    */
    const tool = toolByName("navigate_page");
    const args: Record<string, string> = { route: round.nav.route };
    if (round.nav.tab) args.tab = round.nav.tab;
    if (round.nav.view) args.view = round.nav.view;
    if (round.nav.component) args.component = round.nav.component;
    if (round.nav.batch) args.batch = round.nav.batch;
    if (tool) {
      try {
        await runTool(tool, args, runtime, entities, false);
      } catch (error) {
        console.warn(`[script] 第 ${round.roundNo} 轮的页面跳转失败（${round.nav.route}）：`, error);
      }
    } else {
      console.warn(`[script] 第 ${round.roundNo} 轮要跳转到 ${round.nav.route}，但 navigate_page 工具没注册`);
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
  } else if (round.reveal?.target === "clean-flow") {
    /* ⑰：数据集页跟着播报逐拍推进（推到「执行清洗」为止，人工核验不替人点） */
    startCleanFlowReveal(round, spoken);
  } else if (round.reveal?.target === "workbench-cards") {
    /* ⑥⑮：执行工作台的任务卡跟着播报**逐张铺开**（一句一张，见 script.ts 的 reveal 注释） */
    startWorkbenchReveal(round, spoken);
  }

  /*
    ── 演示表面（工作清单 v1.0 §10 阶段 C/D）──────────────────────────
    这一轮"必须发生的可见动作"里，除了导航与工单详情展开之外的部分
    （天气四分类、素材质检、异常帧、清洗漏斗、模型对照…）通过一个事件交给外壳渲染。

    为什么在**说完之后**派发、而不是播报开始时：§8 的动作列写的是
    "播到哪一项就依次展开"，即页面变化要跟着播报走；而表面是一个整块浮层，
    没有内部分段，所以放在这一轮收尾（`applyScriptAction` 的末尾）最稳 ——
    此时导航已发出、揭示已登记，用户看到的是"念完 → 屏幕出现对应面板"。

    事件名与 `Shell.tsx` 的监听一一对应；找不到动作的轮次由组件自己返回 null
    （`actionFor` 查不到就不渲染），所以这里不必再判一次。
  */
  window.dispatchEvent(new CustomEvent("mumai:demo-surface", { detail: { roundNo: round.roundNo } }));

  /*
    ── 执行工作台的任务卡（剧本 ⑥ ⑮；用户 2026-09-23「小木互动触发的自动操作」）──
    ⑥ 小木说「我已把工单任务同步到工作台」→ 生成「开工四项」草稿；
    ⑮ 小木说「任务卡已生成……」→ 生成「异常适配四项」草稿。
    两条都走服务端 `task.create`（`store/taskCards.ts` 的 `ensureTaskCards`）：

      · **幂等**：同一张工单的同一批只生成一次 —— 连按两次快捷键、两台电脑同时
        触发都不会出现八张卡（服务端按 `batchKey` 去重）；
      · **只生成草稿**：保存（核对后）与回执（执行人）都不在这里做 ——
        剧本明令「不直接把任务标成已完成」，服务端连 `done` 状态都没有；
      · **不伪造成功**：拿不到工单、服务端失败都只记日志（页面自己会显示空态与原因），
        绝不补一句"任务卡已生成"糊过去。

    ⚠ 只认 `roundNo`；剧本重排编号时这一条与 `script.ts` 的 nav 一起改
      （`scriptNav.test.ts` 会核对 ⑥⑮ 落在 /workbench 上）。
  */
  if (round.roundNo === "⑥" || round.roundNo === "⑮") {
    const batchKey = round.roundNo === "⑥" ? "startup" : "adapt";
    const orderId = entities.order ?? "";
    if (orderId) {
      void ensureTaskCards(batchKey, orderId).catch((error) => {
        console.warn(`[script] 第 ${round.roundNo} 轮的任务卡生成失败：`, error);
      });
    } else {
      console.warn(`[script] 第 ${round.roundNo} 轮要生成任务卡，但拿不到工单 id（列表可能还没拉回来）`);
    }
  }

  /*
    ── 同步备份小窗（用户口径 2026-09-16；2026-09-17 拆轮；2026-09-18 改台词）─
    第④轮「同步备份」小木说完「收到，已启用同步备份。」之后弹出小窗，
    列出**真实**的备份对象（当前工单的附件清单 + 本地播报语音包段数），
    过一段时间自动收起。文档第 4 条后半句（平台服务可访问…）由讲解人自己说，
    登记在 `script.ts` 的 `role: "host"` 行里 —— 不播报、也不进这段小窗。

    ⚠ 判据是 `roundNo === "④"`：2026-09-17 剧本按《小木对话总文案.txt》重排时
    原第④轮（开工清单核对）变成第③轮、「同步备份」独立成第④轮，编号仍指向这一轮；
    2026-09-18 用户把台词改成短句后，这里依旧不用改（只改了每轮念什么，没改哪一轮弹窗）。

    ── 为什么必须**等播报结束**再弹（实测出来的坑）─────────────────────
    第一版是立刻派发，小窗的自动收起到点即关。结果：小木那句念了约 7 秒，
    而小窗的计时从派发那一刻就开始跑（8 行 × 620ms ≈ 5 秒），
    于是**话还没念完，窗就关了** —— 现场观感就是"刚出来就没了"。
    现在与 `startOrderDetailReveal` 用同一套办法：拿到播报 Promise 就等它 resolve
    （`VoiceOutput.speak()` 本来就是 Promise，有看门狗兜底）；注入的是同步实现
    （拿不到 Promise）时直接派发，退回"立刻显示"。
    ⚠ 台词改短（2026-09-18）之后这里更要按"播报完再弹"，不能改成固定延时：
      短句约 2 秒、长句约 7 秒，固定延时必然在其中一种情况下错位。

    ── 为什么语音段数要 await ──────────────────────────────────────
    这个数字要从语音包清单里数出来（真实 64 段），拿不到就传 0 ——
    小窗会**不显示**那一行，而不是编一个数字。
  */
  if (round.roundNo === "④") {
    const showSyncPanel = () => {
      void voicePackEntryCount()
        .catch(() => 0)
        .then((segments) => {
          window.dispatchEvent(
            new CustomEvent("mumai:sync-backup", { detail: buildSyncBackupStream(segments) }),
          );
        });
    };
    if (spoken && typeof (spoken as Promise<void>).then === "function") {
      void (spoken as Promise<void>)
        .catch(() => { /* 播报失败也要把窗弹出来，不能因为没声音就少一个动作 */ })
        .then(showSyncPanel);
    } else {
      showSyncPanel();
    }
  }
}

/**
 * 剧本轮次的槽位来源（**防幻觉规则 3 的落点**）。
 *
 * 顺序是刻意的：
 *   1. **显式绑定**的待读取工单 —— 用户点「查看」通知时绑上的那张。
 *      这是"我想要哪张"的唯一权威来源，优先于任何猜测。
 *   2. 没绑定时才退回"列表最新那张"（其余轮次的既有口径）。
 *   3. 列表还没拉回来时，退回详情里正在看的那一张。
 *
 * ⚠ 旧实现**只有 2 和 3**（`orders[0]`）。交接文档明令不得用 `orders[0]` 猜，
 *   因为它在两处会错：用户点的是第二条通知却念了第一条；连按两次快捷键建两单，
 *   语音永远只读最新那张。两种都是"把 A 的委托当 B 的念出来"。
 */
function scriptEntities(): EntityBag {
  const bound = commissionBinding.get();
  if (bound) return { order: bound };
  const state = useWorkOrderStore.getState();
  const newest = state.orders[0]?.id ?? state.detail?.order?.id ?? "";
  return newest ? { order: newest } : {};
}

/**
 * 让工单详情**跟着这句台词的节奏**逐组出现。
 *
 * ── 节拍怎么算 ──────────────────────────────────────────────────────
 * 台词按标点切成语义段，`round.reveal.beats[i]` 说明"第 i 段念完该亮哪一组"；
 * `buildRevealSchedule()` 把每段的估算时长**累加**成拍点时刻。
 *
 * ⚠ 旧算法是把**整段总时长**按分区数平均分配（`estimatedMs * 0.8 * stage / total`），
 *   各拍等距 —— 短句和长句落点一样长，"念到哪、亮到哪"就对不上。
 *   交接文档明确要求"按标点切分后的语义段计算，不得再按整段总字数平均分配"。
 *
 * ── 收尾（文档第 12 条的落点）───────────────────────────────────────
 * 播报结束 / 播报失败 / 交互被中断，三种情况都必须让页面回到**完整可见**，
 * 不得永久停在半展开。前两种在这里处理；第三种由 `cancelOrderReveal()` +
 * 计划自带的兜底 TTL 处理。
 */
function startOrderDetailReveal(round: ScriptRound, orderId: string, spoken?: unknown): void {
  const reveal = round.reveal;
  if (!orderId || !reveal || reveal.sections.length === 0) return;

  beginOrderReveal(orderId, reveal.sections);
  /*
    时间线（切段 → 对齐拍点 → 按时刻推进 → 播报结束补拍）统一在
    ordersReveal 的 runRevealTimeline 里，数据清洗流程页走的是同一份实现 ——
    那三条规矩（先对齐、只补到点、等挂载）抄第二遍必漏一条。
  */
  runRevealTimeline({
    segments: splitSegments(mainLineOf(round)),
    beats: reveal.beats,
    apply: (sections) => advanceOrderReveal(orderId, sections),
    clear: () => cancelOrderReveal(),
    spoken,
    mountReady: orderDetailMounted,
  });
}

/**
 * 第 17 条（⑰ 数据清洗与人工审核）：数据集页**跟着播报逐拍推进**。
 *
 * 用户口径 2026-09-18：「…这个对话需要小木跳转到固件及模型，数据集，
 * 直接一步一步引导到人工核验」——脚本把流程推到「执行清洗」为止，
 * **人工核验一步不替人点**（核验是人的责任，逐条采纳/排除）。
 * 台词里一句话有三小句（清洗完成 / 待审核记录已列出 / 数据集已按物理样本分组），
 * 按小句切正好一拍推一段。
 */
function startCleanFlowReveal(round: ScriptRound, spoken?: unknown): void {
  const reveal = round.reveal;
  if (!reveal || reveal.sections.length === 0) return;
  const datasetId = DATASET.id;
  beginCleanFlowReveal(datasetId, reveal.sections);
  runRevealTimeline({
    segments: splitClauses(mainLineOf(round)),
    beats: reveal.beats,
    apply: (stages) => advanceCleanFlowReveal(datasetId, stages),
    clear: () => cancelCleanFlowReveal(),
    spoken,
    mountReady: cleanFlowMounted,
  });
}

/**
 * ⑥⑮（执行工作台）：任务卡**跟着播报逐张铺开**。
 *
 * 剧本 ⑮ 一口气点了四张卡的分工（补采 / 样本与测区 / 分组与验证 / 适配验证），
 * 所以这一轮按**小句**切段、一句点亮一张；⑥ 是两句话，前一句亮前两张、后一句亮后两张。
 * 批次键用 `batchKey`（开工四项 / 异常适配四项各登记一次计划，互不顶掉）。
 *
 * ⚠ 卡片是异步生成的：探针只等页面挂载（`workbenchMounted` 看 `.wb`），
 *   不等卡片 —— 等卡片会让计划在卡片到达前就走到"到点补齐"，逐张铺开等于没发生。
 */
function startWorkbenchReveal(round: ScriptRound, spoken?: unknown): void {
  const reveal = round.reveal;
  if (!reveal || reveal.sections.length === 0) return;
  const batchKey = round.roundNo === "⑥" ? "startup" : "adapt";
  beginWorkbenchReveal(batchKey, reveal.sections);
  runRevealTimeline({
    segments: splitClauses(mainLineOf(round)),
    beats: reveal.beats,
    apply: (slots) => advanceWorkbenchReveal(batchKey, slots),
    clear: () => cancelWorkbenchReveal(),
    spoken,
    mountReady: workbenchMounted,
  });
}
/**
 * 等工单详情页**真的挂载**之后再执行 `settle`（最多等 `CATCHUP_MOUNT_DEADLINE_MS`）。
 *
 * 为什么不用固定延时：导航耗时取决于接口 —— 固定延时要么不够（页面还没来、
 * 计划先被解掉，展开效果丢失），要么白等（页面早就到了）。
 * 直接探测挂载点最准，这也是判断"能不能看见展开动画"的唯一依据。
 */
function orderDetailMounted(): boolean {
    /*
      两个条件都看，缺一不可：
        · `.wop-actions` —— 工单详情页骨架已渲染（说明导航真的到了）；
        · `.wop-reveal` —— 逐组展开的挂载点已存在（说明四组确实在这个页面上）。
      ⚠ 踩过的坑：第一版只探 `.wop`（一个不存在的根类），探测**永远为假** →
        立刻走到"到点补齐"，逐组展开等于没发生
        （实测时序：计划登记 0.2 秒后就被解除，点亮数从 0 直接跳到 7）。
        判据本身写错，看起来却像"功能没生效"。
    */
  return (
    document.querySelector(".wop-actions") !== null && document.querySelector(".wop-reveal") !== null
  );
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

/**
 * 造一个"确定命中"的判据给 `replyScript`。
 *
 * 为什么不传 `null`：`ScriptMatch` 是结构化字段（score / margin / hits / verdict），
 * `replyScript` 会用它渲染气泡上的"判据"那行与置信度。快捷键与"小木主动发起"
 * 这两条路**本来就是确定命中**（前者是人按的键，后者压根没有用户指令），
 * 所以如实给 `score: 1 / verdict: "hit"`，并把判定理由写清楚，
 * 让界面与日志都能看出这一轮不是语音猜出来的。
 */
function certainMatch(round: ScriptRound, reason: string): ScriptMatch {
  return { round, score: 1, runnerUp: null, margin: 1, hits: [], verdict: "hit", reason };
}

/**
 * 「直达某一轮」的公共前半段：收掉残留浮层 → 置思考态 → 等一小会儿。
 *
 * 三种入口共用：快捷键直达（`ask` 的 pinned 分支）、语音命中剧本（`ask` 的
 * script 分支）、**小木主动发起**（`speakProactive`）。三处原来各写一遍，
 * 表现不一致的风险很实在 —— 少一处 `dismiss-overlays` 就会"上一张浮层还压着"。
 *
 * @returns false = 这一轮已经被后来的指令作废（调用方直接返回，别接着播）
 */
async function enterThinking(gen: number, note: string): Promise<boolean> {
  window.dispatchEvent(new CustomEvent("mumai:dismiss-overlays"));
  setAgent({ agentState: "THINKING", stateNote: note });
  await sleep(thinkingDelayMs());
  return !stale(gen);
}

/**
 * **小木主动发起**地说一轮 —— 没有用户指令，也不模拟"听到"。
 *
 * ── 为什么必须与 `ask()` 分开（用户口径 2026-09-17）──────────────────
 * 用户原话：「部分主动触发的对话，其也会模拟接受消息，这是不对的，
 * 应该在我按按钮后小木思考一小会儿后主动说话」。
 *
 * 之前"按钮触发"的那几条（文档第 6/13/20 条）走的是 `ask()` + 该轮台词兜底：
 * 于是屏幕上先**逐字"收到"**一遍小木自己的台词（像用户说了这句话），
 * 然后小木再把同一句话念一遍 —— 同一句话说两遍，而且第二遍还假装是听来的。
 * 那是把"主动播报"演成了"被动应答"。
 *
 * 现在这条路：不 push 用户轮次、不跑识别与匹配、不写 `finalText`，
 * 只清浮层 → 思考（2.5–4 秒，与其它轮同一套延时）→ 播这一轮的台词与页面动作。
 */
export async function speakProactive(roundNo: string, runtime: Runtime): Promise<void> {
  const round = SCRIPT_ROUNDS.find((item) => item.roundNo === roundNo) ?? null;
  if (!round) {
    /* 与 `ask()` 的 pinned 分支同一口径：认不出编号就什么都不做，不硬造一轮 */
    console.warn(`[script] 主动发起：剧本里没有第 ${roundNo} 轮 —— 不播报、不改状态`);
    return;
  }
  const gen = ++runGeneration;
  /* 主动发起没有"听到的那句话"：先把上一轮残留的识别文本清掉，
     否则气泡里会挂着上一轮的字，看起来又像"收到了什么" */
  setAgent({ open: true, partial: "", finalText: "" });
  if (!(await enterThinking(gen, `小木主动发起第 ${round.roundNo} 轮，思考中...`))) return;
  replyScript(round, certainMatch(round, "小木主动发起（按钮 / 本地事件），没有用户指令"), runtime);
  setAgent({ agentState: "FINISHED", stateNote: "" });
}

/**
 * 执行一次"用户说了这句话"。
 *
 * @param target 可选的**目标轮次提示**（`roundNo`，如 "⑤"）。
 *   由剧本快捷键（`useScriptShortcut`）传入：按 `Ctrl+B/Y/M+<数字>` 时，演示人期望的就是
 *   **第 N 条戏**，而识别/说法本身可能落到相邻轮次（实测：「请各岗位报告出发前准备
 *   情况。小木，请帮我做同步备份。」会命中第④轮而不是它自己的那一条）。
 *   给了提示就以它为准；**语音与文本入口不传这个参数**，仍然走正常的模糊匹配 ——
 *   演示现场按键要确定，说话要宽容，两者不能混。
 * @param target.lineOverride 只要该轮里的**这一句**（逐字，必须是本轮 lines 里真实存在的）。
 *   值不在本轮 lines 里时会被忽略、退回主台词 —— 不给按键留"念任意文本"的口子。
 *
 * ⚠ 「小木主动发起」的那几轮**不走这里**，走 `speakProactive()` ——
 *   它们没有用户指令，不该在对话里留下一条"用户说"的记录。
 */
export async function ask(
  text: string,
  runtime: Runtime,
  via: "text" | "mic" | "example" = "text",
  target?: { roundNo?: string; lineOverride?: string },
): Promise<void> {
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
  /**
   * 快捷键指定了目标轮次 → **以它为准**，不再靠说法去猜。
   *
   * ⚠ 只认剧本里真实存在的 `roundNo`：传进来的编号找不到轮次时**回落**到正常路由，
   * 而不是硬造一轮 —— 否则现场会出现"按键后小木什么都不说"，
   * 那比答错更难排查（现象与"没反应"一模一样）。
   */
  const pinned =
    target?.roundNo != null
      ? (SCRIPT_ROUNDS.find((item) => item.roundNo === target.roundNo) ?? null)
      : null;
  if (pinned) {
    if (!(await enterThinking(gen, `剧本快捷键指定第 ${pinned.roundNo} 轮，思考中...`))) return;
    replyScript(
      pinned,
      certainMatch(pinned, "剧本快捷键（Ctrl+B/Y/M 序列）直接指定轮次，未经语音匹配"),
      runtime,
      target?.lineOverride,
    );
    return;
  }
  if (route.kind === "script") {
    /*
      ── 先把屏幕上残留的浮层收掉（现场实测出的穿帮）──────────────────
      演示动线是：按 Ctrl+Q+L → 点通知里的「查看」→ 弹出红头委托预览
      → 喊「读取这份工单」。此时预览还盖在屏幕上，而这一轮要导航到工单页：
      画面变成"工单页在下面加载、委托预览还压在上面"，看起来像两个页面打架。

      真人会先关掉那张预览再操作，所以**命中剧本这一刻就替他关掉**。
      时机放在这里（理解完成、还没进思考延时）而不是导航之后：
      关窗要发生在用户"说完话"的瞬间，不能拖到播报开始。
    */
    if (!(await enterThinking(gen, `剧本命中 ${route.round.roundNo}，思考中...`))) return;
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




