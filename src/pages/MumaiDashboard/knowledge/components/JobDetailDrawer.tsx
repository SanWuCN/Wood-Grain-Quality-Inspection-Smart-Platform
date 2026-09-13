/**
 * 数据与知识中心 · 任务详情抽屉
 *
 * 依据：PRD §9.3（阶段与进度）、§9.4（失败、重试、取消）、§5.4（更新任务）。
 *
 * 为什么任务列表只留摘要、细节放这里：总览的任务区只有一百多像素高，
 * 把阶段、明细、错误码全铺在主界面上会把图和状态一起挤下去。列表给出
 * 「状态 + 目标版本 + 成功/失败数 + 时间」，要逐项核对时再打开这个抽屉。
 */

import { Btn, StateBlock } from "../../ui";
import type { JobDetail } from "../types";
import { formatCount, formatMoment, jobStatusTone, stageSummary } from "../selectors";
import { KbCollapse, KbDrawer, KbEmpty, KbKV, KbState } from "./KnowledgeUi";
import type { KnowledgeApiActions } from "./api-actions";

export function JobDetailDrawer({
  open,
  detail,
  loading,
  error,
  actions,
  onClose,
  onOpenAsset,
}: {
  open: boolean;
  detail: JobDetail | null;
  loading: boolean;
  error: string | null;
  actions: KnowledgeApiActions;
  onClose: () => void;
  onOpenAsset: (assetId: string) => void;
}) {
  if (!open) return null;
  const job = detail?.job ?? null;
  const items = detail?.items ?? [];
  const failed = items.filter((item) => item.status === "失败");
  const skipped = items.filter((item) => item.status === "跳过");
  const live = job ? job.status === "运行" || job.status === "排队" : false;

  return (
    <KbDrawer
      open={open}
      title={job ? `${job.kind} · ${job.id}` : "任务详情"}
      subtitle={
        job ? (
          <span className="kb-drawer-sub">
            <KbState text={job.status} tone={jobStatusTone(job.status)} />
            <code>{job.targetVersion}</code>
            <span className="kb-muted">触发来源 {job.triggerSource}</span>
          </span>
        ) : null
      }
      onClose={onClose}
      footer={
        job ? (
          <div className="kb-drawer-actions">
            {live ? (
              <Btn tone="danger" onClick={() => void actions.cancelJob(job.id)} disabled={!actions.canIndex}>
                取消任务
              </Btn>
            ) : null}
            {job.counts.failed ? (
              <Btn onClick={() => void actions.retryErrors()} disabled={!actions.canIndex}>
                重试失败项
              </Btn>
            ) : null}
            <Btn
              onClick={() => {
                onClose();
              }}>
              关闭
            </Btn>
          </div>
        ) : null
      }>
      {loading && !job ? <StateBlock kind="loading" title="正在读取任务" hint="包含阶段、明细与错误码。" /> : null}
      {error ? <StateBlock kind="error" title="读取失败" hint={error} /> : null}
      {!job && !loading && !error ? <KbEmpty title="任务不存在" hint="它可能已经被清理，刷新后重试。" /> : null}

      {job ? (
        <>
          <KbKV
            items={[
              { k: "状态", v: <KbState text={job.status} tone={jobStatusTone(job.status)} /> },
              { k: "当前阶段", v: job.stage },
              { k: "目标版本", v: <code>{job.targetVersion}</code> },
              { k: "起始版本", v: <code>{job.baseVersion ?? "—"}</code> },
              { k: "输入项", v: `${formatCount(job.counts.total)} 项` },
              { k: "成功 / 失败 / 跳过", v: `${job.counts.succeeded} / ${job.counts.failed} / ${job.counts.skipped}` },
              { k: "新增分块", v: `${formatCount(job.counts.chunks)} 个` },
              { k: "被替换的旧块", v: `${formatCount(job.counts.replacedChunks ?? 0)} 个` },
              { k: "开始时间", v: formatMoment(job.startedAt) },
              { k: "结束时间", v: job.endedAt ? formatMoment(job.endedAt) : "进行中" },
              { k: "操作者", v: job.actorId ?? "—" },
              { k: "说明", v: job.message || "—" },
            ]}
          />

          <h3 className="kb-detail-h3">流水线阶段</h3>
          <ol className="kb-stage-list kb-stage-list--drawer">
            {job.stages.map((stage) => (
              <li
                key={stage.key}
                className={`kb-stage-item is-${stage.status === "运行" ? "active" : stage.status === "完成" ? "done" : stage.status === "失败" ? "failed" : "wait"}`}>
                <strong>{stage.label}</strong>
                <span>{stage.detail || stageSummary(stage.processed, stage.total)}</span>
              </li>
            ))}
          </ol>

          {failed.length ? (
            <>
              <h3 className="kb-detail-h3">失败项（{failed.length}）</h3>
              <ul className="kb-job-item-list">
                {failed.map((item) => (
                  <li key={item.assetId}>
                    <button type="button" className="kb-link" onClick={() => onOpenAsset(item.assetId)}>
                      {item.assetId}
                    </button>
                    <em>{item.errorCode ?? "ERROR"}</em>
                    <span className="kb-muted">{item.message}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}

          {skipped.length ? (
            <KbCollapse summary={`跳过项（${skipped.length}）`}>
              <ul className="kb-job-item-list">
                {skipped.map((item) => (
                  <li key={item.assetId}>
                    <button type="button" className="kb-link" onClick={() => onOpenAsset(item.assetId)}>
                      {item.assetId}
                    </button>
                    <em>{item.errorCode ?? "SKIPPED"}</em>
                    <span className="kb-muted">{item.message}</span>
                  </li>
                ))}
              </ul>
            </KbCollapse>
          ) : null}

          <KbCollapse summary={`全部明细（${items.length} 项）`}>
            <ul className="kb-job-item-list">
              {items.map((item) => (
                <li key={item.assetId}>
                  <button type="button" className="kb-link" onClick={() => onOpenAsset(item.assetId)}>
                    {item.assetId}
                  </button>
                  <span>{item.stage}</span>
                  <KbState
                    text={item.status}
                    tone={item.status === "成功" ? "ok" : item.status === "失败" ? "danger" : "muted"}
                  />
                  <span className="kb-muted">{item.message}</span>
                </li>
              ))}
            </ul>
          </KbCollapse>
        </>
      ) : null}
    </KbDrawer>
  );
}
