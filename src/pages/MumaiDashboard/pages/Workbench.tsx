/**
 * 执行工作台（`/workbench`）· 剧本第一幕与第三幕的任务卡页面
 *
 * ── 剧本依据 ────────────────────────────────────────────────────────
 *   ⑥ 小木：「我已把工单任务同步到工作台。环境配置、地图、场景和检测批次将关联本次工单」；
 *   ⑭ 小木：「建议核对材种来源与标定范围，补充有来源的参考样本，检查数据质量，并验证候选模型」；
 *   ⑮ 小木：「任务卡已生成。补采交全栈执行，样本与测区由具身核对，项目经理审核分组和验证结果，
 *            平台记录各项回执」+ 夹注「小木创建任务草稿，按本轮岗位分工预填执行人；
 *            史核对后保存，**不直接把任务标成已完成**」。
 *
 * ── 这一页为什么是独立页面，而不是又往首页塞一块 ─────────────────────
 *   · 首页（任务总览）是 `position:absolute` 的地图工作台，左右两栏是
 *     `grid-template-rows: repeat(2, minmax(0,1fr))` 的固定两行 —— 再塞一块会把
 *     两栏挤变形（用户对"一级页面上生成并堆元素、排版就乱了"有过明确意见）；
 *   · PRD 2.2 的一级导航固定八项，不许加第九项 —— 所以这一页与
 *     `/present`（投屏）、`/console`（排练控制台）同一种做法：**有路由、不进导航**，
 *     由小木带路（⑥ ⑮ 两轮）与工单页的「执行工作台」入口进入。
 *
 * ── 三条边界 ────────────────────────────────────────────────────────
 *   1. **卡片存服务端**（`taskCard` 实体）：内网哪台电脑打开都是同一份，
 *      谁保存、谁回执都记在卡上；
 *   2. **小木只生成草稿**：自动操作只调 `task.create`（幂等），
 *      保存与回执必须由人在这一页点 —— 服务端连 `done` 状态都没有；
 *   3. **没生成过就显示空态**，并给一个手动生成的按钮（现场漏触发时不用去按快捷键）。
 */

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { Panel } from "../Panel";
import { useMumai } from "../context";
import { Icon } from "../icons";
import { Btn, KV, PermNote, SourceTag, StateBlock, StatusChip, Toolbar } from "../ui";
import { isApiError } from "../api/client";
import type { TaskCardEntity } from "../api/client";
import { commissionBinding } from "../commissionBinding";
import { isOnline, taskCards, useSharedStore } from "../store/shared";
import { ackTaskCard, ensureTaskCards, saveTaskCard } from "../store/taskCards";
import { useWorkOrderStore } from "../store/workOrders";
import { WORKBENCH_SLOTS, useWorkbenchReveal } from "../workbenchReveal";
import {
  TASK_BATCHES,
  TASK_STATE_LABEL,
  TASK_STATE_STEP,
  batchOf,
  canAdvance,
  cardsOfOrder,
  groupByBatch,
  ownerOf,
  progressOf,
} from "./workbench/taskCards";
import "./workbench/workbench.css";

export function Workbench() {
  const { toast, can, accountId } = useMumai();
  const [params] = useSearchParams();
  const paramOrder = params.get("order");

  const online = useSharedStore(isOnline);
  const records = useSharedStore(taskCards);
  const orders = useWorkOrderStore((state) => state.orders);
  const detail = useWorkOrderStore((state) => state.detail);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!online) return;
    void useWorkOrderStore.getState().refresh();
  }, [online]);

  /* 选哪张工单：`?order=` → 绑定的那张 → 列表最新（与工单页、小木同一条口径） */
  const activeId = useMemo(() => {
    const list = orders.map((item) => item.id);
    const bound = commissionBinding.get();
    return (paramOrder && list.includes(paramOrder) ? paramOrder : null) ?? (bound && list.includes(bound) ? bound : (orders[0]?.id ?? null));
  }, [orders, paramOrder]);

  useEffect(() => {
    if (!activeId) return;
    if (detail?.order.id === activeId) return;
    void useWorkOrderStore.getState().select(activeId);
  }, [activeId, detail?.order.id]);

  const order = detail && detail.order.id === activeId ? detail.order : null;
  const cards = useMemo(() => cardsOfOrder(records, activeId), [records, activeId]);
  const groups = useMemo(() => groupByBatch(cards), [cards]);
  const progress = progressOf(cards);
  const actor = { id: accountId };

  /*
    两批各订阅一次（**不在 map 里调 hook**：批次表虽然是常量，但"循环里调 hook"
    迟早会因为有人往里加条件而错位）。`null` = 没有计划 → 全部可见。
  */
  const startupRevealed = useWorkbenchReveal("startup");
  const adaptRevealed = useWorkbenchReveal("adapt");
  const revealedOf = (batchKey: string) => (batchKey === "startup" ? startupRevealed : adaptRevealed);

  const generate = async (batchKey: string) => {
    if (!activeId || !order) return;
    setBusy(batchKey);
    try {
      const result = await ensureTaskCards(batchKey, activeId, order.orderNo);
      toast(result.created ? `${batchOf(batchKey)?.label ?? batchKey}：已生成 ${result.cardIds.length} 张任务卡草稿` : "这一批任务卡已经生成过了", "ok");
    } catch (error) {
      toast(isApiError(error) ? error.message : "生成任务卡失败：连不上共享服务", "danger");
    } finally {
      setBusy(null);
    }
  };

  const advance = async (card: TaskCardEntity, revision: number) => {
    const action = TASK_STATE_STEP[card.state].action;
    if (!action) return;
    setBusy(card.id);
    try {
      if (action === "task.save") {
        await saveTaskCard(card.id, revision);
        toast(`${card.id} 已核对保存；等执行人回执`, "ok");
      } else {
        await ackTaskCard(card.id, revision);
        toast(`${card.id} 已回执`, "ok");
      }
    } catch (error) {
      toast(isApiError(error) ? error.message : "操作失败：连不上共享服务", "danger");
    } finally {
      setBusy(null);
    }
  };

  const batchOfCards = (batchKey: string) => groups.find((item) => item.batchKey === batchKey)?.cards ?? [];

  return (
    <div className="page wb">
      <Toolbar
        note={
          <>
            <SourceTag label={online ? "服务端留存 · 内网同步" : "未连接共享服务"} />
            <span>{order ? `当前工单 ${order.orderNo}` : "未选中工单"}</span>
            <span>
              任务卡 {progress.accepted}/{progress.total} 已回执 · {progress.saved} 已保存 · {progress.draft} 草稿
            </span>
          </>
        }>
        <Btn tone="ghost" onClick={() => (window.location.hash = "#/orders")}>
          <Icon name="nav-orders" size={16} aria-hidden />
          回到工单
        </Btn>
      </Toolbar>

      <Panel
        title="本单执行工作台"
        icon="biz-sample-group"
        extra={
          <span className="wb-head">
            {order ? <StatusChip text={order.status} tone="info" /> : null}
            <span className="muted">按岗位分工预填执行人 · 完成条件可核对</span>
          </span>
        }
        className="wb-panel">
        {order ? (
          <KV
            columns={4}
            items={[
              { k: "工单号", v: order.orderNo },
              { k: "现场地点", v: order.location || "—" },
              { k: "计划时间", v: order.plannedStart ? `${order.plannedStart}${order.plannedEnd ? ` 至 ${order.plannedEnd}` : ""}` : "—" },
              { k: "检测主体", v: detail?.subjects.map((item) => item.code).join("、") || "—" },
            ]}
          />
        ) : (
          <StateBlock
            kind={online ? "empty" : "offline"}
            title={online ? "当前没有可关联的工单" : "未连接共享服务"}
            hint={
              online
                ? "任务卡按工单生成：先在工单档案里选中一张，或按 Ctrl+Q+L 建单后对小木说「核对开工清单」。"
                : "卡片与回执都存在服务端；连上共享服务后自动出现。"
            }
          />
        )}
      </Panel>

      {TASK_BATCHES.map((batch) => {
        /*
          逐张铺开（`workbenchReveal.ts`）：小木这一轮念到哪一句，就亮到哪一张卡。
          `null` 表示**没有计划** —— 用户自己点进来、刷新、换页都走这一支，看到完整的一批
          （演示效果不会传染成"页面坏了"）。
        */
        const revealed = revealedOf(batch.batchKey);
        const list = batchOfCards(batch.batchKey).filter(
          (card) => revealed === null || revealed.includes(`c${card.seq}` as (typeof WORKBENCH_SLOTS)[number]),
        );
        return (
          <Panel
            key={batch.batchKey}
            title={`${batch.label} · ${list.length}/${batch.cards.length}`}
            icon="biz-manual-mark"
            extra={
              <span className="wb-head">
                <span className="muted">剧本第 {batch.roundNo} 轮由小木生成草稿</span>
                <Btn
                  tone="ghost"
                  disabled={!online || !activeId || busy === batch.batchKey || list.length > 0}
                  title={list.length ? "这一批已经生成过了" : "手动生成这一批任务卡草稿"}
                  onClick={() => void generate(batch.batchKey)}>
                  {busy === batch.batchKey ? "生成中…" : list.length ? "已生成" : "生成草稿"}
                </Btn>
              </span>
            }
            className="wb-panel">
            {list.length === 0 ? (
              <StateBlock
                kind="empty"
                title={`还没有生成「${batch.label}」`}
                hint={`小木在第 ${batch.roundNo} 轮会生成这一批草稿；现场漏触发时用右上角「生成草稿」。`}
              />
            ) : (
              <ul className="wb-cards">
                {list.map((card) => {
                  const state = TASK_STATE_LABEL[card.state];
                  const step = TASK_STATE_STEP[card.state];
                  const gate = canAdvance(card, actor, can);
                  const owner = ownerOf(card.ownerAccountId);
                  return (
                    <li key={card.id} className={`wb-card is-${card.state}`}>
                      <header>
                        <span className="wb-card__no">{card.id}</span>
                        <b>{card.title}</b>
                        <StatusChip text={state.text} tone={state.tone} />
                      </header>
                      <div className="wb-card__owner">
                        <Icon name="identity-user" size={16} aria-hidden />
                        <b>{card.ownerLabel}</b>
                        <span>{card.ownerRole ?? owner.role}</span>
                      </div>
                      <dl className="wb-card__meta">
                        <div>
                          <dt>输入</dt>
                          <dd>
                            <ul>
                              {card.inputs.map((item) => (
                                <li key={item}>{item}</li>
                              ))}
                            </ul>
                          </dd>
                        </div>
                        <div>
                          <dt>完成条件</dt>
                          <dd>{card.doneCondition}</dd>
                        </div>
                        {card.note ? (
                          <div>
                            <dt>备注</dt>
                            <dd>{card.note}</dd>
                          </div>
                        ) : null}
                      </dl>
                      <footer className="wb-card__foot">
                        {step.action ? (
                          <Btn
                            tone={step.action === "task.save" ? "primary" : "default"}
                            disabled={!online || busy === card.id || !gate.allowed}
                            title={gate.allowed ? step.label : gate.reason}
                            onClick={() => void advance(card, revisionOf(records, card.id))}>
                            {busy === card.id ? "处理中…" : step.label}
                          </Btn>
                        ) : (
                          <span className="wb-card__done">
                            <Icon name="status-success" size={16} aria-hidden />
                            {card.ownerLabel} 已回执{card.ackedAt ? ` · ${card.ackedAt.slice(5, 16).replace("T", " ")}` : ""}
                          </span>
                        )}
                        {card.savedAt ? <span className="muted">保存于 {card.savedAt.slice(5, 16).replace("T", " ")}</span> : null}
                        {!gate.allowed && step.action ? <span className="muted">{gate.reason}</span> : null}
                      </footer>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>
        );
      })}

      <p className="note wb-note">
        <Icon name="biz-multimodal" size={16} aria-hidden />
        卡片由小木生成草稿（第 ⑥ / ⑮ 轮，幂等：同一批只生成一次）；<b>核对后保存</b>与<b>执行人回执</b>
        都要人在这里点，服务端没有"已完成"这个状态 —— 完成情况由后续工单与验收环节表达。
      </p>
      {can("task:manage") && !can("task:execute") ? <PermNote permissions={["task:execute"]} /> : null}
    </div>
  );
}

/** 卡片当前 revision（命令总线按它做冲突检测；取不到就不带，服务端会跳过冲突判定） */
function revisionOf(records: ReturnType<typeof taskCards>, cardId: string): number {
  return records.find((item) => item.id === cardId)?.revision ?? 0;
}

export default Workbench;
