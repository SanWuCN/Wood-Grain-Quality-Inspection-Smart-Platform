/**
 * 小木助手 · 右侧可展开面板
 *
 * PRD 2.2：小木作为右侧可展开面板，另提供大屏对话模式。
 * PRD 4.1：不部署大模型的主链路 —— 意图命中本地工具目录。
 * PRD 4.2：意图目录（seed 的 XIAOMU_INTENTS）。
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
import { useMumai } from "./context";
import { Icon } from "./icons";
import { SourceTag, StateBlock, StatusChip } from "./ui";
import AgentHost from "./agent/AgentHost";
import { openAgent } from "./agent";
import { INTENT_COUNT } from "./agent/intents";
import {
  ANOMALY_EVENTS,
  CLEAN_STEPS,
  COMPONENTS,
  CURRENT_RISKS,
  DATASET,
  DRAFT_ORDER,
  EXPERIMENT,
  FUSION_RECORD,
  HISTORY_RISKS,
  HISTORY_STATS,
  HOTSPOTS,
  KNOWLEDGE_DOCS,
  KNOWLEDGE_META,
  REVISIT_PLAN,
  TRIAGE_ITEMS,
  UPDATE_PACKAGE,
  XIAOMU_INTENTS,
  XIAOMU_TOOLS,
} from "./seed/scenario";
import { clockStamp, fmtNum, runEvaluation } from "./lib";
import type { XiaomuIntent } from "./seed/scenario";

/** PRD 4.2：意图目录没有匹配项时的固定回复，不调用大模型猜测 */
const NO_HIT_REPLY = "可查询巡检资料、查看构件或启动当前业务流程";

interface BotTurn {
  kind: "bot";
  id: number;
  at: string;
  intent: XiaomuIntent;
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
function factsFor(intent: XiaomuIntent): { k: string; v: string }[] {
  /** 本轮重点构件：风险清单的首个构件 */
  const focusComponentId = CURRENT_RISKS[0]?.componentId ?? COMPONENTS[0].id;
  /** 「当时」指历史：按构件取五月的风险记录，用于关联历史 scene_id 与柱底书签（PRD 5.3） */
  const historyRisk =
    HISTORY_RISKS.find((item) => item.title.startsWith(focusComponentId)) ?? HISTORY_RISKS[0];
  const openRisks = HISTORY_RISKS.filter((item) => !item.closed);
  const anomaly = ANOMALY_EVENTS[0];
  /** 记录里出现待复核 / 超限 / 不适用 / 部分接收的检查项，其结论就是下一步动作 */
  const pendingChecks = TRIAGE_ITEMS.filter((item) =>
    item.records.some((record) =>
      ["待复核", "超限", "不适用", "部分接收"].includes(record.result),
    ),
  );
  const evaluation = runEvaluation(EXPERIMENT);
  const reviewPassed = DATASET.reviewAssign.filter((item) => item.state === "已通过").length;
  const compatPass = UPDATE_PACKAGE.compatibility.filter((item) => item.pass).length;
  const compatBlock = UPDATE_PACKAGE.compatibility.filter((item) => !item.pass).length;
  const acceptanceFailed = EXPERIMENT.acceptance.filter((item) => !item.pass);
  const cleanInput = CLEAN_STEPS[0]?.input ?? 0;
  const cleanKept = CLEAN_STEPS[CLEAN_STEPS.length - 1]?.kept ?? 0;
  const reviewCount = CLEAN_STEPS.reduce((sum, step) => sum + step.review, 0);

  const table: Record<string, string> = {
    // 历史汇总与未关闭项（PRD 5.3 / A01 / A02）
    total: String(HISTORY_STATS.total),
    reportedDone: String(HISTORY_STATS.reportedDone),
    closed: String(HISTORY_STATS.closed),
    open: String(HISTORY_STATS.open),
    items: openRisks.map((item) => `${item.id} ${item.next}`).join("；"),
    // 本次查询到的对象
    componentId: focusComponentId,
    imageIds: HOTSPOTS.map((item) => item.image.name).join(" / "),
    sceneId: historyRisk.sceneId,
    bookmark: historyRisk.bookmark,
    // 异常排查
    anomalyId: anomaly.id,
    nextActions: pendingChecks.map((item) => item.conclusion).join("；"),
    // 清洗与数据集
    cleanSteps: `${CLEAN_STEPS.length} 步（输入 ${cleanInput} → 保留 ${cleanKept}）`,
    reviewCount: `${reviewCount} 条`,
    reviewState: `${reviewPassed}/${DATASET.reviewAssign.length} 已通过`,
    // 训练验证与更新交付
    metrics: `精确率 ${fmtNum(evaluation.overall.old.precision)} → ${fmtNum(evaluation.overall.next.precision)}；召回率 ${fmtNum(evaluation.overall.old.recall)} → ${fmtNum(evaluation.overall.next.recall)}；F1 ${fmtNum(evaluation.overall.old.f1)} → ${fmtNum(evaluation.overall.next.f1)}`,
    acceptance: `${EXPERIMENT.acceptance.length - acceptanceFailed.length}/${EXPERIMENT.acceptance.length} 项通过${acceptanceFailed.length ? `（未通过：${acceptanceFailed.map((item) => item.label).join("、")}）` : ""}`,
    compatPass: String(compatPass),
    compatBlock: String(compatBlock),
    // 融合结果与复核工单草稿
    fusionRecordId: `${FUSION_RECORD.recordId}（规则 ${FUSION_RECORD.ruleVersion}）`,
    outputs: FUSION_RECORD.outputs.map((item) => `${item.riskId} ${item.priority}`).join("；"),
    orderId: DRAFT_ORDER.id,
    priority: DRAFT_ORDER.level,
    attachments: `${DRAFT_ORDER.attachments.length} 项：${DRAFT_ORDER.attachments.map((item) => item.name).join("、")}`,
    // 复巡计划
    planId: REVISIT_PLAN.id,
    status: REVISIT_PLAN.dispatched ? "已下发" : "未下发",
  };
  return intent.facts.map((key) => ({ k: key, v: table[key] ?? "—" }));
}

/** 把 {key} 占位符替换成事实值；缺值时显式说明，不编造 */
function renderAnswer(intent: XiaomuIntent, facts: { k: string; v: string }[]) {
  return intent.answerTemplate.replace(/\{(\w+)\}/g, (_, key: string) => {
    const hit = facts.find((item) => item.k === key);
    return hit ? hit.v : "未登记";
  });
}

/** 资料检索：本地关键词命中（PRD 5.2 首版检索），返回 Top K 片段位置 */
function searchDocs(text: string, topK = KNOWLEDGE_META.topK) {
  const scored: { title: string; locator: string; score: number }[] = [];
  const chars = Array.from(new Set(text.replace(/\s/g, ""))).slice(0, 40);
  for (const doc of KNOWLEDGE_DOCS) {
    for (const chunk of doc.chunks) {
      let hit = 0;
      for (const ch of chars) if (chunk.text.includes(ch)) hit += 1;
      const score = chars.length ? hit / chars.length : 0;
      if (score > KNOWLEDGE_META.noHitThreshold) {
        scored.push({
          title: doc.title,
          locator: `${chunk.section} · ${chunk.chunkId}`,
          score,
        });
      }
    }
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, topK);
}

export default function SmallWoodPanel() {
  const {
    setAssistantOpen,
    assistantSeed,
    currentOrder,
    componentById,
    domainPending,
    envRecord,
  } = useMumai();
  const navigate = useNavigate();
  const [input, setInput] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const listRef = useRef<HTMLDivElement>(null);
  const timers = useRef<number[]>([]);

  const toolLabel = useCallback(
    (key: string) => XIAOMU_TOOLS.find((tool) => tool.key === key)?.label ?? key,
    [],
  );
  const toolState = useCallback(
    (key: string) => XIAOMU_TOOLS.find((tool) => tool.key === key)?.state ?? "就绪",
    [],
  );

  /** 命中意图目录：关键词包含匹配，命中不了就明说，不乱答 */
  const matchIntent = useCallback((text: string): XiaomuIntent | null => {
    const cleaned = text.trim();
    if (!cleaned) return null;
    let best: { intent: XiaomuIntent; hit: number } | null = null;
    for (const intent of XIAOMU_INTENTS) {
      const words = Array.from(new Set(Array.from(intent.utterance))).filter((ch) =>
        /[\u4e00-\u9fa5A-Za-z0-9]/.test(ch),
      );
      let hit = 0;
      for (const word of words) if (cleaned.includes(word)) hit += 1;
      if (hit > 0 && (!best || hit > best.hit)) best = { intent, hit };
    }
    return best?.intent ?? null;
  }, []);

  const ask = useCallback(
    (text: string) => {
      const cleaned = text.trim();
      if (!cleaned) return;
      const at = clockStamp();
      const intent = matchIntent(cleaned);
      setInput("");

      if (!intent) {
        setTurns((list) => [
          ...list,
          { kind: "user", id: nextTurnId(), at, text: cleaned },
          {
            kind: "bot",
            id: nextTurnId(),
            at: clockStamp(),
            intent: {
              intentId: "no_hit",
              utterance: cleaned,
              tools: ["search"],
              answerTemplate: NO_HIT_REPLY,
              facts: [],
              voice: "—",
            },
            steps: [{ label: "查询资料", state: "done" }],
            facts: [],
            sources: searchDocs(cleaned),
          },
        ]);
        return;
      }

      const facts = factsFor(intent);
      const steps = intent.tools.map((label, index) => ({
        label,
        state: (index === 0 ? "running" : "wait") as "done" | "running" | "wait",
      }));
      const botId = nextTurnId();

      setTurns((list) => [
        ...list,
        { kind: "user", id: nextTurnId(), at, text: cleaned },
        {
          kind: "bot",
          id: botId,
          at: clockStamp(),
          intent,
          steps,
          facts,
          sources: searchDocs(intent.utterance),
        },
      ]);

      // 工具步骤依次点亮（短步骤，不假装长时间推理）
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
    },
    [matchIntent],
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

  const quick = useMemo(() => XIAOMU_INTENTS.slice(0, 4), []);

  return (
    <aside className="xm" aria-label="小木助手">
      {/* 语音控制台挂载点：收到 mumai:agent-open 事件时由 ./agent 内部渲染为浮层 */}
      <AgentHost />
      <header className="xm__head">
        <div>
          <Icon name="bot" />
          <span>
            <b>小木助手</b>
            <small>
              意图目录 {INTENT_COUNT} 条 · 工具 {XIAOMU_TOOLS.length} 个 · 不调用大模型
            </small>
          </span>
        </div>
        <div className="xm__head-actions">
          <button
            type="button"
            className="xm__voice-open"
            onClick={() => openAgent()}
            title="小木">
            <Icon name="wave" />
            语音
          </button>
          <button type="button" onClick={() => setAssistantOpen(false)} aria-label="关闭小木">
            <Icon name="close" />
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
                    <Icon name="sliders" />
                    {toolLabel(key)}
                    <em>{toolState(key)}</em>
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

              <p className="xm__reply">{renderAnswer(turn.intent, turn.facts)}</p>

              {turn.facts.length ? (
                <div className="xm__facts">
                  <small>业务状态（结构化数据）</small>
                  <ul>
                    {turn.facts.map((fact) => (
                      <li key={fact.k}>
                        <span>{fact.k}</span>
                        <b>{fact.v}</b>
                      </li>
                    ))}
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
          <Icon name="arrow" />
        </button>
      </form>

      <footer className="xm__foot">
        <span>工单 {currentOrder.id}</span>
        <span>构件 {componentById(currentOrder.componentIds[0])?.id ?? "Z04"}</span>
        <span>演示回放</span>
      </footer>
    </aside>
  );
}
