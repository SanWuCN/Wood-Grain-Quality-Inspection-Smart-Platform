/**
 * 小木助手 · 右侧可展开面板
 *
 * PRD 2.2：小木作为右侧可展开面板，另提供大屏对话模式。
 * PRD 4.1：不部署大模型的主链路 —— 意图命中本地工具目录。
 * PRD 4.2：意图目录（agent/intents.ts 的 INTENTS，文字与语音共用这一份）。
 * PRD 5.1：资料与业务状态分开读取 —— 回答里「状态」来自结构化数据，
 *          「解释」来自资料检索，两类来源在界面上分开显示。
 * PRD 15：工具过程用短步骤卡片（动作 / 对象 / 状态 / 结果入口），不显示虚构长篇推理。
 *
 * 语音智能体（第二章新增）：本面板的文字问答保持原样，
 * 另在标题栏提供一个入口打开 ./agent 的语音控制台（实时字幕 + 意图识别 + 工具执行 + 多步 Agent）。
 * 控制台本体、事件约定与全部逻辑都在 ./agent 下，本文件只负责挂载与按钮。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import NumberAnimation from "@/components/numberAnimation";
import { useMumai } from "./context";
import { Icon } from "./icons";
import { Illustration } from "./illustrations";
import { SourceTag, StateBlock, StatusChip } from "./ui";
import AgentHost from "./agent/AgentHost";
import { openAgent } from "./agent";
import { wakeChannel } from "./agent/wakeChannel";
import type { WakeChannelState } from "./agent/wakeChannel";
import { INTENTS, INTENT_COUNT, intentById } from "./agent/intents";
import { searchKnowledge } from "./agent/replyView";
import { sourcesOf } from "./agent/facts";
import type { Intent } from "./agent/intents";
import {
  KNOWLEDGE_DOCS,
  KNOWLEDGE_META,
} from "./seed/scenario";
import { clockStamp } from "./lib";
import type { XiaomuIntent } from "./seed/scenario";

/**
 * 小木的意图目录只有**一套**：`agent/intents.ts` 的 `INTENTS`。
 *
 * 评审 §3.8：「所有输入进入同一个 SmallWoodService」—— 执行器已经统一，
 * 目录原来还是两套（本页面自己的 `XIAOMU_INTENTS` 10 条、agent 28 条），
 * 同一个问题在文字入口和语音入口能问出不同结果。
 * 现在文字入口把 agent 的意图**映射**成本面板的渲染形状（下面 `toPanelIntent`），
 * 数据源只剩 agent 那一份。
 */
function toPanelIntent(source: Intent): XiaomuIntent {
  /*
   * 工具芯片显示 agent 工具自己的 label（`TOOL_BY_NAME`），不是目录里的文案。
   * 意图没有工具（纯查询）时不显示芯片。
   */
  const toolNames = source.action
    ? [source.action.tool]
    : (source.plan?.steps.map((step) => step.tool) ?? []);
  return {
    intentId: source.id,
    // 快捷按钮与「示例说法」用 agent 目录的第一条示例
    utterance: source.examples[0] ?? source.name,
    tools: toolNames.map((name) => TOOL_BY_NAME[name]?.label ?? name),
    answerTemplate: source.response.text,
    facts: source.response.facts,
    // 有预录音频就放录音，否则走浏览器合成 —— 这是操作员能感知到的差别
    voice: source.response.audio ? "预录音频" : "合成语音",
  };
}

// 经过校准的意图匹配器与项目槽位：评审 F05 要求「先解析项目与时间，再检索；
// 无匹配拒绝执行」，所以匹配不再由本页面自己按字符重叠猜，统一走 agent/matcher。
import { PROJECT_SLOT, understand } from "./agent/matcher";
import { TOOL_BY_NAME, resolveArgs } from "./agent/tools";
import { composeReply, runTool, type Runtime } from "./agent/executor";

/** PRD 4.2：意图目录没有匹配项时的固定回复，不调用大模型猜测 */
const NO_HIT_REPLY = "可查询巡检资料、查看构件或启动当前业务流程";

interface BotTurn {
  kind: "bot";
  id: number;
  at: string;
  intent: XiaomuIntent;
  /** 回复正文。由 agent 的 composeReply 组装，与语音控制台同一份（评审 §3.8） */
  reply: string;
  /** 工具步骤的推进状态 */
  steps: { label: string; state: "done" | "running" | "wait" }[];
  /** 结构化业务状态（facts 拼接结果） */
  facts: { k: string; v: string }[];
  /** 资料引用（可追溯原文位置） */
  sources: { title: string; locator: string }[];
}

interface UserTurn {
  kind: "user";
  id: number;
  at: string;
  text: string;
}

type Turn = UserTurn | BotTurn;

let turnSeq = 1;
const nextTurnId = () => (turnSeq += 1);

/**
 * 事实键 → 当前业务状态（PRD 5.1：状态来自结构化数据，不来自资料）。
 * 全部取种子与 lib 的实时计算结果：意图模板里出现过的键都必须在这里登记，
 * 否则回答会渲染成「未登记」。
 */
/** 事实表：值全部来自种子，键由调用方给出（agent 意图的 response.facts） */

/** 把 {key} 占位符替换成事实值；缺值时显式说明，不编造 */

/**
 * 资料检索已经搬到 `agent/replyView.ts` 的 `searchKnowledge`，**全平台只剩那一份**。
 *
 * ── 为什么必须合并（PRD §10.2 / AC-06）────────────────────────────
 * 本文件原先自带一份 `searchDocs`，右下角语音气泡那边没有 —— 于是同一个
 * 天气问题，文字入口能给出引用、语音入口给不出（或者给出另一条）。
 * PRD 要求"结构化事实和资料引用只有一个来源"，所以两处现在都从
 * `replyView.ts` 取：声明式引用优先（意图在 `response.sources` 里声明
 * 依据哪个文档的哪一块），检索只作兜底。
 *
 * 注意：`searchDocs` 与共享实现**算法完全相同**（都是字符重叠 Top-K），
 * 所以这次合并是行为等价的替换，不是改判定。
 */
/**
 * 事实值全部是**字符串**（见 agent/facts.ts 的 `FactRow`）：有的是纯数字（"0.842"）、
 * 有的是「数字 + 单位/说明」（"87%"、"12 项待复核"）、还有构件编号（"Z04 上部"）、
 * 时间（"2026-09-10 16:40"）与区间（"3/12 已通过"）。
 *
 * 只有**以数字开头、后面不再夹数字**的值才拆出数字交给 NumberAnimation ——
 * 编号与时间不是「会变的数」，滚动它们只会变成噪音；区间（"3/12"）也不拆，
 * 免得把一半的比值滚成一个孤立的数。小数位与千分位按原字符串还原，
 * 因此动画落值后的文本与改造前逐字一致（展示精度不变）。
 */
function splitFactValue(value: string): { amount: number; digits: number; group: boolean; suffix: string } | null {
  const matched = /^(-?\d[\d,]*(?:\.\d+)?)(\D*)$/.exec(value);
  if (!matched) return null;
  const amount = Number(matched[1].replace(/,/g, ""));
  if (!Number.isFinite(amount)) return null;
  const [, fraction] = matched[1].split(".");
  return {
    amount,
    digits: fraction ? fraction.length : 0,
    group: matched[1].includes(","),
    suffix: matched[2],
  };
}

export default function SmallWoodPanel() {
  const {
    setAssistantOpen,
    assistantSeed,
    currentOrder,
    componentById,
    domainPending,
    envRecord,
    // 工具运行时要用会话上下文（阶段 / 账号 / 数据来源 / 通道摘要），与语音控制台同一份
    stage,
    accountLogin,
    channels,
    deviceSource,
  } = useMumai();
  const navigate = useNavigate();
  const [input, setInput] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const listRef = useRef<HTMLDivElement>(null);
  const timers = useRef<number[]>([]);
  /**
   * 常驻唤醒开关。
   *
   * 状态**不是**本组件自己的 useState —— 它必须反映 `wakeChannel()` 的真实状态，
   * 否则"面板关掉再打开"就会显示成关闭，而通道其实还在听。
   * 单例在模块级，所以关闭面板不会停掉唤醒，这正是想要的行为：
   * 用户点一次「常驻唤醒」，关掉面板，之后随时喊「小木小木」都能唤起。
   */
  const [wakeState, setWakeState] = useState<WakeChannelState>(() => wakeChannel().currentState);
  useEffect(() => wakeChannel().subscribe((snap) => setWakeState(snap.state)), []);
  const toggleWake = useCallback(async () => {
    const channel = wakeChannel();
    if (channel.currentState === "live" || channel.currentState === "starting") {
      channel.stop();
      return;
    }
    await channel.start();
    // 失败时不要在这里写死状态：start() 内部会把 error 推给订阅者，
    // 这里再写一次就会出现"两个来源"，界面上看到哪个取决于时序
  }, []);

  const toolLabel = useCallback(
    (key: string) => key,
    [],
  );

  /**
   * 命中意图目录。
   *
   * 原来这里是一段**按字符重叠数打分**的匹配：把意图示例拆成单字，
   * 问句里出现过哪个字就加一分，分最高的胜出。评审 F05 的现象
   * 「对无关问题『火星上的菠萝产量是多少』返回历史场景」就是这么来的 ——
   * 任何一句中文都能和某条示例共享几个常用字，「命中任意一个字就执行」。
   *
   * 现在换成 agent/matcher.ts 里那个经过校准的匹配器：
   *   - 白名单意图 + bigram 覆盖率 × 单条示例余弦，低置信一律回 Fallback
   *   - 返回的 intent.id 与 INTENTS 的 id 是同一套命名，直接对上
   *   - 项目槽位单独判一次：问的是别的寺庙就直接说没有，不套示例寺的数字
   */
  const decide = useCallback((text: string) => {
    const cleaned = text.trim();
    if (!cleaned) return { kind: "empty" as const };

    const match = understand(cleaned);
    const project = match.entities.project;
    if (project && project !== PROJECT_SLOT.current) {
      return { kind: "other-project" as const, project };
    }
    if (match.level === "fallback" || !match.intent) {
      return { kind: "no-hit" as const, score: match.confidence };
    }
    // 目录只有 agent 那一份：命中即映射成本面板的渲染形状，不再有第二张白名单
    const source = INTENTS.find((item) => item.id === match.intent?.id) ?? null;
    const intent = source ? toPanelIntent(source) : null;
    // 匹配器认得、但这个面板没有对应话术的意图，同样按「没听懂」处理，不硬凑。
    // 命中时把整份 MatchResult 一起带出去：工具执行要用它的 entities 解槽位。
    return intent && source
      ? { kind: "hit" as const, intent, source, match, action: match.intent.action }
      : { kind: "no-hit" as const, score: match.confidence };
  }, []);

  /**
   * 小木的运行环境。与语音控制台注入的是同一个类型（agent/executor 的 Runtime），
   * 工具执行因此走同一条路径 —— 这是评审 §3.8「两个入口共用一个执行器」的落点。
   */
  const runtime = useMemo<Runtime>(
    () => ({
      navigate: (to: string) => navigate(to),
      session: {
        stageKey: stage,
        accountLabel: accountLogin,
        sourceMode: deviceSource,
        channelSummary: channels
          .map((item) => `${item.label}${item.state === "online" ? "正常" : item.state === "stale" ? "延迟" : "离线"}`)
          .join(" / "),
      },
      // 文字面板不播报：屏幕上已经把答案写出来了，再念一遍是噪音
      speak: () => {},
    }),
    [accountLogin, channels, deviceSource, navigate, stage],
  );

  const ask = useCallback(
    (text: string) => {
      const cleaned = text.trim();
      if (!cleaned) return;
      const at = clockStamp();
      const decision = decide(cleaned);
      setInput("");

      if (decision.kind !== "hit") {
        const reply =
          decision.kind === "other-project"
            ? `本资料库只索引了${PROJECT_SLOT.current}的资料，没有${decision.project}的记录。` +
              `可以换个说法问${PROJECT_SLOT.current}，或者先把该项目的历史报告导入知识库。`
            : NO_HIT_REPLY;
        setTurns((list) => [
          ...list,
          { kind: "user", id: nextTurnId(), at, text: cleaned },
          {
            kind: "bot",
            id: nextTurnId(),
            at: clockStamp(),
            intent: {
              intentId: decision.kind === "other-project" ? "other_project" : "no_hit",
              utterance: cleaned,
              tools: [],
              answerTemplate: reply,
              facts: [],
              voice: "—",
            },
            // 没命中就不执行任何工具：步骤列表留空，不假装查过
            reply,
            steps: [],
            facts: [],
            sources: decision.kind === "no-hit" ? searchKnowledge(cleaned).map((s) => ({ title: s.title, locator: s.locator })) : [],
          },
        ]);
        return;
      }

      const intent = decision.intent;
      /*
       * 事实与回复文本由 agent 组装（`composeReply`），与语音控制台同一份 ——
       * 面板原来自己有一张 25 个键的事实表，agent 有 99 个，同一个问题两个入口
       * 能问出不同数字。占位符取不到值时降级成「没听懂」，不猜数字（PRD 4.2）。
       */
      const reply = decision.source
        ? composeReply(decision.source, decision.match.entities, runtime)
        : { text: NO_HIT_REPLY, rows: [], missing: [] };
      const facts = reply.missing.length ? [] : reply.rows.map((row) => ({ k: row.key, v: row.value }));
      const botId = nextTurnId();
      /*
       * 有真实工具时，步骤就写**那个工具**，不再放意图目录里的文案标签。
       *
       * 目录里的 `tools: ["检索报告", "打开场景"]` 是给话术看的说法，原来被逐个
       * 点亮成「就绪」—— 接上真实执行之后，屏幕上会同时出现「检索报告 就绪」
       * 和一次页面跳转，两句话对不上。有工具就照工具写。
       */
      const realTool = decision.action ? TOOL_BY_NAME[decision.action.tool] : undefined;
      const steps = realTool
        ? [{ label: realTool.label, state: "running" as const }]
        : intent.tools.map((label, index) => ({
            label,
            state: (index === 0 ? "running" : "wait") as "done" | "running" | "wait",
          }));

      setTurns((list) => [
        ...list,
        { kind: "user", id: nextTurnId(), at, text: cleaned },
        {
          kind: "bot",
          id: botId,
          at: clockStamp(),
          intent,
          reply: facts.length ? reply.text : NO_HIT_REPLY,
          steps,
          facts,
          /**
           * 引用优先取**意图声明**的那一条（`sourcesOf`），检索只作兜底 ——
           * 与右下角语音气泡用的是同一条规则，两个入口才会给出同一份引用（AC-06）。
           *
           * ⚠ 兜底用的**检索文本必须与语音侧一致**（实测出来的不一致，见手册 §7.12）：
           * 原来这里传的是 `intent.utterance`（意图的示例句），而 `agent/replyView.ts`
           * 的 `buildReplyView` 传的是 `query + intentName`。同一个意图、同一句话，
           * 一边按示例句检索、一边按用户问句+意图名检索，结果就是
           * **一个入口有引用、另一个引用为空**（`introduce_platform` 实测如此）。
           * 现在两边都用「用户问句 + 意图名」：示例句只在"用户没问句"时兜底。
           */
          sources: (() => {
            const intentDef = intentById(intent.intentId);
            const declared = sourcesOf(intentDef);
            if (declared.length) return declared.map((ref) => ({ title: ref.title, locator: ref.locator }));
            // 意图名从**共享意图表**取（`intentById(...).name`），与语音侧
            // `buildReplyView` 用的 `turn.intentName` 是同一个字符串
            const searchText = `${cleaned || intent.utterance} ${intentDef?.name ?? ""}`.trim();
            return searchKnowledge(searchText).map((s) => ({ title: s.title, locator: s.locator }));
          })(),
        },
      ]);

      // 没有真实工具的意图才走这段动画（短步骤，不假装长时间推理）
      if (!realTool) {
        intent.tools.forEach((_, index) => {
          const timer = window.setTimeout(() => {
            setTurns((list) =>
              list.map((turn) =>
                turn.kind === "bot" && turn.id === botId
                  ? {
                      ...turn,
                      steps: turn.steps.map((step, i) => ({
                        ...step,
                        state: i <= index ? "done" : i === index + 1 ? "running" : "wait",
                      })),
                    }
                  : turn,
              ),
            );
          }, 380 * (index + 1));
          timers.current.push(timer);
        });
      }

      /*
       * 真正执行工具（评审 §3.8）。
       *
       * 原来上面那段只是把 `intent.tools` 里的**文案标签**逐个点亮成「就绪」——
       * 说「打开场景 就绪」，页面纹丝不动。语音控制台走的是 agent 的
       * planner/executor，文字入口走的是这段动画，这就是评审说的
       * 「一套仅改聊天记录、另一套才改页面」。现在两边共用一个 `runTool`。
       *
       * 需要二次确认的工具**不在面板里执行**：确认层（§42）只挂在语音控制台上，
       * 这里直接跑就等于绕过高危动作的确认。这类意图转交控制台，
       * 面板如实说明「已转到语音控制台确认」，而不是假装执行了。
       */
      const action = decision.action;
      const tool = action ? TOOL_BY_NAME[action.tool] : undefined;
      if (tool && tool.requireConfirmation) {
        openAgent(cleaned);
        setTurns((list) =>
          list.map((turn) =>
            turn.kind === "bot" && turn.id === botId
              ? {
                  ...turn,
                  reply: `「${tool.label}」属于需要二次确认的动作（风险等级 ${tool.risk}/4），已在语音控制台打开待确认；确认之前不会执行任何动作。`,
                }
              : turn,
          ),
        );
        return;
      }

      if (tool) {
        const args = resolveArgs(action?.params, decision.match.entities);
        void runTool(tool, args, runtime, decision.match.entities, false).then((outcome) => {
          setTurns((list) =>
            list.map((turn) =>
              turn.kind === "bot" && turn.id === botId
                ? {
                    ...turn,
                    steps: turn.steps.map((step) => ({ ...step, state: "done" as const })),
                    // 失败时把工具的话说回来 —— 步骤状态只有 running/done/wait，
                    // 绿色勾配上「没执行成功」的原文比一个假勾诚实
                    reply: outcome.ok ? turn.reply : `没有执行成功：${outcome.summary}`,
                  }
                : turn,
            ),
          );
        });
      }
    },
    [decide, runtime],
  );

  // 页面通过 askAssistant 调起的提问
  useEffect(() => {
    if (assistantSeed) ask(assistantSeed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assistantSeed]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [turns]);

  useEffect(
    () => () => {
      timers.current.forEach((timer) => window.clearTimeout(timer));
    },
    [],
  );

  /** 快捷问法取自 agent 目录的前四条，不再是另一份手写清单 */
  const quick = useMemo(() => INTENTS.slice(0, 4).map(toPanelIntent), []);

  return (
    <aside className="xm" aria-label="小木助手">
      {/* 语音控制台挂载点：收到 mumai:agent-open 事件时由 ./agent 内部渲染为浮层 */}
      <AgentHost />
      <header className="xm__head">
        <div>
          {/*
            PRD §5 知识库与小木：「展开区 40–48px」。
            这里是展开后的面板头部，是 I04 头像真正合适的尺寸；
            收起态的浮标用线性标识（见 Shell.tsx 的说明）。
          */}
          <Illustration id="i04-xiaomu" height={44} avatar alt="小木助手头像" />
          <span>
            <b>小木助手</b>
            <small>
              意图目录 {INTENT_COUNT} 条 · 工具 {Object.keys(TOOL_BY_NAME).length} 个 · 不调用大模型
            </small>
          </span>
        </div>
        <div className="xm__head-actions">
          <button
            type="button"
            className={`xm__voice-open${wakeState === "live" ? " is-live" : ""}`}
            onClick={() => void toggleWake()}
            title={
              wakeState === "live"
                ? "常驻唤醒已开启：说两遍「小木小木」即可唤起。点此关闭。"
                : "开启常驻唤醒：说两遍「小木小木」就能唤起小木，不用点任何按钮。需要麦克风权限。"
            }
          >
            <Icon name="wave" />
            {wakeState === "live" ? "唤醒中" : wakeState === "starting" ? "启动中" : "常驻唤醒"}
          </button>
          <button
            type="button"
            className="xm__voice-open"
            onClick={() => openAgent()}
            title="小木">
            {/*
              PRD §3.3：「wave 保留原图标 —— 数据波形不改成装饰融合图标」。
              这里是语音入口，波形表示声音输入，保留原图形。
            */}
            <Icon name="wave" size={16} aria-hidden />
            语音
          </button>
          <button
            type="button"
            className="mumai-icon-button"
            onClick={() => setAssistantOpen(false)}
            aria-label="关闭小木">
            <Icon name="action-close" size={16} aria-hidden />
          </button>
        </div>
      </header>

      <div className="xm__meta">
        <SourceTag label={`资料索引 ${KNOWLEDGE_META.indexVersion}`} />
        <StatusChip text={`资料 ${KNOWLEDGE_DOCS.length} 篇`} tone="info" />
        <StatusChip
          text={domainPending ? "适用域待核验" : "适用域正常"}
          tone={domainPending ? "warn" : "ok"}
        />
        <StatusChip text={`环境配置 ${envRecord.configVersion}`} tone="ok" />
      </div>

      <div className="xm__list" ref={listRef}>
        {turns.length === 0 ? (
          <StateBlock
            kind="empty"
            title="小木按意图目录工作"
            hint={`资料用于解释，业务状态来自结构化数据，两类来源分开显示；检索器 ${KNOWLEDGE_META.retriever}`}
          />
        ) : null}

        {turns.map((turn) =>
          turn.kind === "user" ? (
            <div key={turn.id} className="xm__turn xm__turn--user">
              <p>{turn.text}</p>
              <time>{turn.at}</time>
            </div>
          ) : (
            <div key={turn.id} className="xm__turn xm__turn--bot">
              <div className="xm__tools">
                {turn.intent.tools.map((key) => (
                  <span key={key} className="xm__tool">
                    {/*
                      PRD §3.3 迁移表：「sliders → 原参数滑杆或 action-settings；
                      参数调整与系统设置分开，不全局替换成齿轮」。
                      这里是「工具已就绪」的状态标记（不是参数滑杆），
                      按迁移表归到 action-settings。
                    */}
                    <Icon name="action-settings" size={16} aria-hidden />
                    {toolLabel(key)}
                    <em>就绪</em>
                  </span>
                ))}
                {turn.intent.voice !== "—" ? (
                  <span className="xm__voice">{turn.intent.voice}</span>
                ) : null}
              </div>

              <ol className="xm__steps">
                {turn.steps.map((step) => (
                  <li key={step.label} className={`is-${step.state}`}>
                    <i />
                    {step.label}
                  </li>
                ))}
              </ol>

              <p className="xm__reply">{turn.reply}</p>

              {turn.facts.length ? (
                <div className="xm__facts">
                  <small>业务状态（结构化数据）</small>
                  <ul>
                    {turn.facts.map((fact) => {
                      // 事实值是字符串，能拆出数字的才滚动，其余（编号 / 时间 / 区间）原样渲染
                      const numeric = splitFactValue(fact.v);
                      return (
                        <li key={fact.k}>
                          <span>{fact.k}</span>
                          <b>
                            {numeric ? (
                              <NumberAnimation
                                value={numeric.amount}
                                digits={numeric.digits}
                                group={numeric.group}
                                suffix={numeric.suffix}
                              />
                            ) : (
                              fact.v
                            )}
                          </b>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ) : null}

              {turn.sources.length ? (
                <div className="xm__sources">
                  <small>资料引用（可追溯原文位置）</small>
                  {turn.sources.map((source) => (
                    <button
                      key={source.locator}
                      type="button"
                      onClick={() => navigate("/knowledge")}
                      title="打开知识库查看原文">
                      {source.title}
                      <em>{source.locator}</em>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="xm__sources">
                  <small>{KNOWLEDGE_META.note}</small>
                </div>
              )}

              <time>{turn.at}</time>
            </div>
          ),
        )}
      </div>

      <div className="xm__quick">
        {quick.map((intent) => (
          <button key={intent.intentId} type="button" onClick={() => ask(intent.utterance)}>
            {intent.utterance}
          </button>
        ))}
      </div>

      <form
        className="xm__input"
        onSubmit={(event) => {
          event.preventDefault();
          ask(input);
        }}>
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="例如：比较四根木柱 / 查今年五月示例寺巡检"
          aria-label="向小木提问"
        />
        <button type="submit" aria-label="发送">
          {/*
            PRD §3.3：「send → 对应 action-*，保留原事件和禁用条件」。
            这里刻意仍用 arrow：v2 的 action-send 是纸飞机，换上去会改变这个
            一直在用的发送按钮外观；本轮以统一素材为主，不借机改交互图形。
            语义名登记在迁移表里，后续需要换图形时只改这一处。
          */}
          <Icon name="arrow" size={20} aria-hidden />
        </button>
      </form>

      <footer className="xm__foot">
        <span>工单 {currentOrder.id}</span>
        <span>构件 {componentById(currentOrder.componentIds[0])?.id ?? "Z04"}</span>
        <span>归档回放</span>
      </footer>
    </aside>
  );
}
