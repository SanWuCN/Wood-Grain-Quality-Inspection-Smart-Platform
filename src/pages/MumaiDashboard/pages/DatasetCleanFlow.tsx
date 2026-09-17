/**
 * 数据集清洗 · 流程组件
 *
 * 用户原话：「数据集清洗不是应该选择已经采集好的原始数据集，然后配置算法和细节，
 * 然后开始清洗嘛，还需要人工核验，这一步是通过算法清洗数据集，展示流程，
 * 不是拿文字在那里糊弄」。
 *
 * 原来的「智能清洗过程」是一张静态表，一进页面就写着五步全部完成 ——
 * 那是把结论摆出来当过程。这里改成真的分段推进：
 *
 *   选原始数据集 → 配置算法与阈值 → 预检查 → 执行清洗
 *   → 输出疑似异常项 → 人工核验 → 确认结果 → 生成新数据集版本
 *
 * 每一步都要用户点，前一步没做完下一步不可用；清洗结果由 cleanLogic 的规则
 * 在当前样本上真算。**纯逻辑在 cleanLogic.ts**，本文件只放组件
 * （react-refresh 要求组件文件不导出非组件）。
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import NumberAnimation from "@/components/numberAnimation";
import { Panel } from "../Panel";
import { Btn, Modal, StatusChip } from "../ui";
import { DATASET, SAMPLES } from "../seed/scenario";
import { cancelCleanFlowReveal, useCleanFlowReveal } from "../cleanFlowReveal";
import { clockStamp } from "../lib";
import {
  DEFAULT_THRESHOLDS,
  checkSplitLeakage,
  runClean,
  selectCleanVersionRecords,
  type CleanOutcome,
  type CleanThresholds,
} from "../cleanLogic";
import { buildCleanProgress } from "./operationInsights";

type Stage = "pick" | "configure" | "precheck" | "cleaned" | "reviewed" | "versioned";

const STAGE_ORDER: Stage[] = ["pick", "configure", "precheck", "cleaned", "reviewed", "versioned"];

const STAGE_LABEL: Record<Stage, string> = {
  pick: "选择原始数据集",
  configure: "配置算法与阈值",
  precheck: "预检查",
  cleaned: "执行清洗",
  reviewed: "人工核验",
  versioned: "生成数据集版本",
};

export type CleanVersionResult = {
  label: string;
  sourceDatasetId: string;
  generatedAt: string;
  includedRecordIds: string[];
  removedRecordIds: string[];
};

export function DatasetCleanFlow({ onVersioned }: { onVersioned: (result: CleanVersionResult) => void }) {
  const [stage, setStage] = useState<Stage>("pick");
  const [thresholds, setThresholds] = useState<CleanThresholds>(DEFAULT_THRESHOLDS);
  const [configOpen, setConfigOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  /** 人工核验结论：recordId → 采纳 / 排除 */
  const [decisions, setDecisions] = useState<Record<string, "accept" | "exclude">>({});
  const [precheck, setPrecheck] = useState<{ at: string; checks: { label: string; ok: boolean; detail: ReactNode }[] } | null>(null);
  const [outcome, setOutcome] = useState<(CleanOutcome & { at: string }) | null>(null);
  const [versionLabel, setVersionLabel] = useState<string | null>(null);

  /*
    ── 小木带着这一页走（用户口径 2026-09-18）────────────────────────
    「…这个对话需要小木跳转到固件及模型，数据集，直接一步一步引导到人工核验」。
    `useCleanFlowReveal` 给出脚本已经推进到的阶段；这里只**向前**跟到最后一个，
    并复用按钮那两条副作用（预检查 / 执行清洗）——
    所以"跟着念"与"自己点"走的是同一段代码。
    ⚠ 用户一旦自己点过任何一步（`manual`），计划立刻作废：页面归人，脚本不再抢。
  */
  const revealed = useCleanFlowReveal(DATASET.id);
  const manual = useRef(false);
  /** 包一层：用户点任何一步都视为"接管这一页" */
  const userAdvance = (run: () => void) => () => {
    manual.current = true;
    cancelCleanFlowReveal();
    run();
  };

  const sourceBatchCount = useMemo(() => new Set(SAMPLES.map((sample) => sample.sourceBatch)).size, []);
  const physicalSampleCount = useMemo(() => new Set(SAMPLES.map((sample) => sample.physicalSampleId)).size, []);
  /** 物理样本 → 分组（分组与划分那一段用它，顺便当"同一样本两处分组"的可视检查） */
  const groups = useMemo(() => {
    const map = new Map<string, string>();
    for (const sample of SAMPLES) if (!map.has(sample.physicalSampleId)) map.set(sample.physicalSampleId, sample.groupId);
    return [...map.entries()].map(([physicalSampleId, groupId]) => ({ physicalSampleId, groupId }));
  }, []);
  /** 划分泄漏检查（纯函数在 cleanLogic，单独一步：改划分不必重跑清洗） */
  const splitLeaks = useMemo(() => checkSplitLeakage(DATASET.splits), []);
  const stepIndex = STAGE_ORDER.indexOf(stage);

  /** 预检查：真的看一眼这份数据集能不能洗（体量、格式、标签依据、分组） */
  const runPrecheck = () => {
    const records = SAMPLES.length;
    const withLabel = SAMPLES.filter((sample) => sample.labelBasis).length;
    const unknown = SAMPLES.filter((sample) => sample.knownState === "未知待核验").length;
    const groups = new Set(SAMPLES.map((sample) => sample.groupId)).size;
    /*
      预检查的 `detail` 从字符串放宽成节点：这几项里带的是**样本量级**（记录数 /
      覆盖条数 / 分组数 / 未知标签数），预检查跑出来时应该滚到位，而不是直接拍一个
      数字上去。原来拼模板串就把数字写死了，节点化之后数字才能自己逐帧改。
    */
    setPrecheck({
      at: clockStamp(),
      checks: [
        {
          label: "记录数",
          ok: records > 0,
          detail: (
            <>
              <NumberAnimation value={records} /> 条记录
            </>
          ),
        },
        {
          label: "来源与路径",
          ok: SAMPLES.every((sample) => Boolean(sample.path && sample.sourceBatch)),
          detail: `${sourceBatchCount} 个来源批次 · ${records} 条路径已登记`,
        },
        {
          label: "标签依据覆盖",
          ok: withLabel === records,
          detail: (
            <>
              <NumberAnimation value={withLabel} />/<NumberAnimation value={records} /> 条有 label_basis
            </>
          ),
        },
        {
          label: "物理样本分组",
          ok: groups > 0,
          detail: (
            <>
              <NumberAnimation value={groups} /> 个组
            </>
          ),
        },
        {
          label: "未知标签单列",
          ok: true,
          detail: (
            <>
              <NumberAnimation value={unknown} /> 条标为未知待核验，不进入监督训练
            </>
          ),
        },
      ],
    });
    setStage("precheck");
  };

  const runCleaning = () => {
    setOutcome({ ...runClean(SAMPLES, thresholds), at: clockStamp() });
    setDecisions({});
    setStage("cleaned");
  };

  const accepted = useMemo(
    () => (outcome?.flagged ?? []).filter((flag) => decisions[flag.recordId] === "accept").length,
    [decisions, outcome],
  );
  const excluded = useMemo(
    () => (outcome?.flagged ?? []).filter((flag) => decisions[flag.recordId] === "exclude").length,
    [decisions, outcome],
  );
  const total = outcome?.flagged.length ?? 0;
  const undecided = total - accepted - excluded;
  const progress = buildCleanProgress({
    stage,
    totalRecords: SAMPLES.length,
    outcome: outcome ? { kept: outcome.kept, flagged: outcome.flagged.length } : undefined,
    acceptedAnomalies: accepted,
    excludedFalsePositives: excluded,
  });

  /*
    跟着小木往前走：计划推到哪一步，这一页就走到哪一步（**只向前**，不回退）。
    「预检查 / 执行清洗」各有副作用（跑规则、算漏斗），所以这里调的是与按钮同一个函数 ——
    否则舞台上是"到了这一步，但页面上没有这一步的结果"。
  */
  useEffect(() => {
    if (!revealed || manual.current) return;
    const target = revealed[revealed.length - 1];
    if (!target) return;
    const targetIndex = STAGE_ORDER.indexOf(target);
    if (targetIndex <= STAGE_ORDER.indexOf(stage)) return;
    if (target === "configure") {
      setStage("configure");
      return;
    }
    if (target === "precheck") {
      runPrecheck();
      return;
    }
    if (target === "cleaned") {
      runCleaning();
    }
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [revealed, stage]);

  const makeVersion = () => {
    if (!outcome) return;
    const membership = selectCleanVersionRecords(SAMPLES, outcome, decisions);
    if (membership.undecidedRecordIds.length > 0) return;
    const label = "DS-07（本轮清洗产物）";
    const generatedAt = clockStamp();
    setVersionLabel(label);
    setStage("versioned");
    onVersioned({
      label,
      sourceDatasetId: DATASET.id,
      generatedAt,
      includedRecordIds: membership.includedRecordIds,
      removedRecordIds: membership.removedRecordIds,
    });
  };

  return (
    <>
      <Panel
        title="数据集清洗"
        /* PRD §5「固件及模型：清洗、分组、适配、校验使用业务图标」 */
        icon="biz-data-cleaning"
        extra={
          stage === "versioned" ? (
            <StatusChip text={versionLabel ?? "已生成"} tone="ok" />
          ) : (
            /* 当前步号跟着流程走；总步数 `STAGE_ORDER.length` 是常量，保持字面量。
               文案裹成单个 span：`.chip` 是 inline-flex + 5px gap，
               散开的文本节点会被 gap 当成独立 flex item 撑开 */
            <StatusChip
              text={
                <span>
                  第 <NumberAnimation value={stepIndex + 1} group={false} /> / {STAGE_ORDER.length} 步 ·{" "}
                  {STAGE_LABEL[stage]}
                </span>
              }
              tone="info"
            />
          )
        }
        className="fw-panel fw-panel--wide">
        {/* 阶段轨道：一级页面只表达「现在在哪一步、下一步做什么」 */}
        <ol className="dc-track">
          {STAGE_ORDER.map((key, index) => (
            <li key={key} className={index < stepIndex ? "is-done" : index === stepIndex ? "is-next" : "is-wait"}>
              <span className="dc-track__dot" />
              <b>{STAGE_LABEL[key]}</b>
            </li>
          ))}
        </ol>

        <section className="dc-overview" aria-label="清洗作业进度">
          <div className="dc-overview__progress">
            <span>全流程完成度</span>
            <strong><NumberAnimation value={progress.percent} group={false} /><small>%</small></strong>
            <progress max={100} value={progress.percent} aria-label="数据清洗全流程完成度" />
          </div>
          <dl>
            <div><dt>记录总数</dt><dd><NumberAnimation value={SAMPLES.length} /></dd></div>
            <div><dt>已处理</dt><dd><NumberAnimation value={progress.processed} /></dd></div>
            <div className={progress.pendingReview ? "is-warn" : ""}><dt>待人工核验</dt><dd><NumberAnimation value={progress.pendingReview} /></dd></div>
            <div><dt>核验状态</dt><dd>{progress.reviewState}</dd></div>
          </dl>
        </section>

        {outcome ? (
          <section className="dc-process" aria-label="清洗执行明细">
            <header>
              <b>清洗执行明细</b>
              <span>
                {outcome.at} · {outcome.steps.length} 个算法步骤 · 参考件标定中位 {outcome.nominalMm} mm
              </span>
            </header>
            <ol>
              {outcome.steps.map((item, index) => (
                <li key={item.key} className={item.kind === "check" ? "is-check" : item.hits.length ? "is-hit" : ""}>
                  <span className="dc-process__index">{String(index + 1).padStart(2, "0")}</span>
                  <span className="dc-process__copy">
                    <b>{item.label}</b>
                    <small>{item.detail}</small>
                    {/*
                      每一步都要能**逐条对上**：命中了哪几条记录写在行里，
                      核对的人在核验弹窗里能看到同样的记录号（不再只给一个数字）。
                    */}
                    {item.hits.length ? (
                      <small className="dc-process__hits">
                        命中 {item.hits.length} 条：{item.hits.join(" / ")}
                        {item.kind === "removed" ? "（确定不可用，直接剔除、不进核验队列）" : ""}
                      </small>
                    ) : (
                      <small className="dc-process__hits is-clean">本步无命中（校验通过）</small>
                    )}
                  </span>
                  <span className="dc-process__counts">
                    输入 {item.input} · 保留 {item.kept}
                    {item.kind === "check" ? " · 仅校验" : ` · 待核验 ${item.review}`}
                  </span>
                  <progress max={item.input || 1} value={item.kept + item.review} aria-label={`${item.label}处理进度`} />
                  <StatusChip
                    text={item.kind === "removed" ? "已剔除" : item.kind === "check" ? "校验通过" : item.hits.length ? "待核验" : "自动通过"}
                    tone={item.kind === "removed" ? "warn" : item.kind === "check" ? "ok" : item.hits.length ? "warn" : "ok"}
                  />
                </li>
              ))}
            </ol>
          </section>
        ) : null}

        {/* 分组与划分：清洗完成后紧接着要交代的两件事（分组对不对、划分漏没漏） */}
        {outcome ? (
          <section className="dc-groups" aria-label="物理样本分组与数据集划分">
            <header>
              <b>物理样本分组与划分</b>
              <span>
                {physicalSampleCount} 个物理样本 · {groups.length} 个分组 ·{" "}
                {splitLeaks.length ? `⚠ ${splitLeaks.length} 处跨划分泄漏` : "无跨划分泄漏"}
              </span>
            </header>
            <ul className="dc-groups__list">
              {DATASET.splits.map((split) => (
                <li key={split.name}>
                  <b>{split.name}</b>
                  <span>{split.sampleIds.join(" / ") || "—"}</span>
                  <small>
                    {/* 写清"清洗后"：这段的小卡与隔壁「分组检查」（按物理样本计数）挨着，
                        不写清楚会被当成清洗前的记录数 */}
                    清洗后记录{" "}
                    {SAMPLES.filter(
                      (sample) =>
                        split.sampleIds.includes(sample.physicalSampleId) &&
                        outcome.flagged.every((flag) => flag.recordId !== sample.recordId) &&
                        outcome.dropped.every((item) => item.recordId !== sample.recordId),
                    ).length}{" "}
                    条
                  </small>
                </li>
              ))}
            </ul>
            <p className="muted">
              同一 physical_sample_id 的记录必须落在同一个划分里 —— 这是"同一块木样的连续扫描不能
              一边训练一边验证"的硬约束（跨组泄漏会让验证分数虚高）。
            </p>
          </section>
        ) : null}

        {stage === "pick" ? (
          <div className="dc-stage">
            <label className="field">
              <span>当前清洗数据集</span>
              <input value={DATASET.label} readOnly />
            </label>
            <span className="muted">
              <NumberAnimation value={SAMPLES.length} group={false} /> 条记录 ·{" "}
              <NumberAnimation value={physicalSampleCount} group={false} /> 个物理样本 ·{" "}
              <NumberAnimation value={sourceBatchCount} group={false} /> 个来源批次
            </span>
            <Btn tone="primary" onClick={userAdvance(() => setStage("configure"))}>
              下一步：配置算法与阈值
            </Btn>
          </div>
        ) : null}

        {stage === "configure" ? (
          <div className="dc-stage">
            <ul className="dc-config">
              <li>
                <span>饱和比例上限</span>
                <b>{thresholds.saturationMax}%</b>
              </li>
              <li>
                <span>参考距离允许偏差</span>
                <b>±{thresholds.referenceToleranceMm} mm</b>
              </li>
              <li>
                <span>重复帧合并</span>
                <b>{thresholds.dedupe ? "开启" : "关闭"}</b>
              </li>
            </ul>
            <Btn onClick={userAdvance(() => setConfigOpen(true))}>调整算法与阈值</Btn>
            <Btn tone="primary" onClick={userAdvance(runPrecheck)}>
              下一步：预检查
            </Btn>
          </div>
        ) : null}

        {stage === "precheck" && precheck ? (
          <div className="dc-stage dc-stage--block">
            <ul className="dc-checks">
              {precheck.checks.map((check) => (
                <li key={check.label} className={check.ok ? "is-ok" : "is-bad"}>
                  <b>{check.label}</b>
                  <span>{check.detail}</span>
                </li>
              ))}
            </ul>
            <div className="adapt-actions">
              <span className="muted">预检查 {precheck.at}</span>
              <Btn tone="primary" onClick={userAdvance(runCleaning)}>
                下一步：执行清洗
              </Btn>
            </div>
          </div>
        ) : null}

        {stage === "cleaned" && outcome ? (
          <div className="dc-stage dc-stage--block">
            {/* 清洗产出的四个口径是一排 KPI：整排一起滚（执行时间是时间戳，保持原样） */}
            <ul className="dc-kpi">
              <li>
                <small>输入</small>
                <b>
                  <NumberAnimation value={SAMPLES.length} />
                </b>
              </li>
              <li>
                <small>保留</small>
                <b>
                  <NumberAnimation value={outcome.kept} />
                </b>
              </li>
              <li className={outcome.flagged.length ? "is-warn" : ""}>
                <small>疑似异常项</small>
                <b>
                  <NumberAnimation value={outcome.flagged.length} />
                </b>
              </li>
              <li>
                <small>执行时间</small>
                <b>{outcome.at}</b>
              </li>
            </ul>
            <div className="adapt-actions">
              <Btn
                onClick={userAdvance(() => setOutcome({ ...runClean(SAMPLES, thresholds), at: clockStamp() }))}>
                重跑
              </Btn>
              <Btn tone="primary" disabled={!outcome.flagged.length} onClick={userAdvance(() => setReviewOpen(true))}>
                {/* `.btn` 是 inline-flex + 8px gap：文案保持一个 span，间距与原样一致 */}
                <span>
                  下一步：人工核验 <NumberAnimation value={outcome.flagged.length} /> 条
                </span>
              </Btn>
            </div>
          </div>
        ) : null}

        {stage === "reviewed" && outcome ? (
          <div className="dc-stage dc-stage--block">
            <ul className="dc-kpi">
              <li className="is-ok">
                <small>采纳为异常</small>
                <b>
                  <NumberAnimation value={accepted} />
                </b>
              </li>
              <li>
                <small>排除（误报）</small>
                <b>
                  <NumberAnimation value={excluded} />
                </b>
              </li>
              <li className={undecided ? "is-warn" : ""}>
                <small>待定</small>
                <b>
                  <NumberAnimation value={undecided} />
                </b>
              </li>
            </ul>
            <div className="adapt-actions">
              <Btn onClick={userAdvance(() => setReviewOpen(true))}>继续核验</Btn>
              <Btn tone="primary" disabled={undecided > 0} onClick={userAdvance(makeVersion)}>
                确认结果并生成新版本
              </Btn>
            </div>
          </div>
        ) : null}

        {stage === "versioned" ? (
          <div className="dc-stage dc-stage--block">
            <ul className="dc-kpi">
              <li className="is-ok">
                <small>新数据集版本</small>
                <b>{versionLabel}</b>
              </li>
              <li>
                <small>保留记录</small>
                <b>
                  <NumberAnimation value={progress.outputRecords} />
                </b>
              </li>
              <li>
                <small>已确认异常</small>
                <b>
                  <NumberAnimation value={accepted} />
                </b>
              </li>
              <li>
                <small>已排除</small>
                <b>
                  <NumberAnimation value={excluded} />
                </b>
              </li>
            </ul>
          </div>
        ) : null}
      </Panel>

      {/* 配置弹窗：算法与阈值属于「配置这次清洗时才需要看」的信息 */}
      {configOpen ? (
        <Modal
          title="清洗算法与阈值"
          subtitle={`${DATASET.label} · 共 ${SAMPLES.length} 条记录`}
          onClose={() => setConfigOpen(false)}
          footer={
            <>
              <Btn onClick={() => setThresholds(DEFAULT_THRESHOLDS)}>恢复默认</Btn>
              <Btn
                tone="primary"
                onClick={userAdvance(() => {
                  setConfigOpen(false);
                  // 改了阈值就要重跑预检查与清洗，否则页面上留着上一套阈值的结果
                  setPrecheck(null);
                  setOutcome(null);
                  setDecisions({});
                  setStage("configure");
                })}>
                保存并重跑
              </Btn>
            </>
          }>
          <label className="field">
            <span>饱和比例上限（%）</span>
            <input
              type="number"
              min={1}
              max={50}
              value={thresholds.saturationMax}
              onChange={(event) => setThresholds((prev) => ({ ...prev, saturationMax: Number(event.target.value) }))}
            />
          </label>
          <label className="field">
            <span>参考距离允许偏差（mm）</span>
            <input
              type="number"
              min={1}
              max={100}
              value={thresholds.referenceToleranceMm}
              onChange={(event) =>
                setThresholds((prev) => ({ ...prev, referenceToleranceMm: Number(event.target.value) }))
              }
            />
          </label>
          <label className="field">
            <span>重复帧合并</span>
            <select
              value={thresholds.dedupe ? "on" : "off"}
              onChange={(event) => setThresholds((prev) => ({ ...prev, dedupe: event.target.value === "on" }))}>
              <option value="on">开启</option>
              <option value="off">关闭</option>
            </select>
          </label>
        </Modal>
      ) : null}

      {/*
        核验弹窗：逐条给出「哪条、被哪条规则挑出来、命中值多少、采纳还是排除」。
        这一步是人工责任，必须逐条过，不能在一级页面上糊一行字。
      */}
      {reviewOpen && outcome ? (
        <Modal
          wide
          title="疑似异常项核验"
          subtitle={
            /* `.modal__sub` 是 flex + 6px gap：整句裹成一个 span，
               否则「N」「条待核验 · …」会各成一个 flex item 被 gap 撑开 */
            <span>
              <NumberAnimation value={total} /> 条待核验 · 采纳为异常或排除误报
            </span>
          }
          onClose={() => setReviewOpen(false)}
          footer={
            <>
              <span className="muted">
                已核验 <NumberAnimation value={accepted + excluded} />/{total}
              </span>
              <Btn onClick={() => setReviewOpen(false)}>稍后继续</Btn>
              <Btn
                tone="primary"
                disabled={undecided > 0}
                onClick={userAdvance(() => {
                  setReviewOpen(false);
                  setStage("reviewed");
                })}>
                完成核验
              </Btn>
            </>
          }>
          <ul className="dc-review">
            {outcome.flagged.map((flag) => (
              <li key={flag.recordId} className={`is-${decisions[flag.recordId] ?? "pending"}`}>
                <b>{flag.recordId}</b>
                <span className="dc-review__sample">{flag.physicalSampleId}</span>
                <span className="dc-review__reason">
                  {flag.step} · {flag.reason}
                </span>
                <em>{flag.value}</em>
                <span className="dc-review__ops">
                  <Btn
                    active={decisions[flag.recordId] === "accept"}
                    onClick={() => setDecisions((prev) => ({ ...prev, [flag.recordId]: "accept" }))}>
                    采纳
                  </Btn>
                  <Btn
                    active={decisions[flag.recordId] === "exclude"}
                    onClick={() => setDecisions((prev) => ({ ...prev, [flag.recordId]: "exclude" }))}>
                    排除
                  </Btn>
                </span>
              </li>
            ))}
          </ul>
        </Modal>
      ) : null}
    </>
  );
}

export default DatasetCleanFlow;
