/**
 * 检测适配的页签组件（共享模块）
 *
 * 原「检测适配」单页已拆成两个页面，本文件只保留页签**内容**、不导出页面：
 *   - pages/Hardware.tsx  硬件详情（`/hardware`）—— 采集作业 / 异常排查 / 硬件监看
 *   - pages/Firmware.tsx  固件及模型（`/firmware`）—— 全局配置 / 数据集 / 训练验证 /
 *     更新交付 / 融合分析
 *
 * 六个页签的实现原样保留在这里，两个页面按职责各自组合，避免把已经做完的内容重写一遍。
 * 页签切换器与 Toolbar 归各页面自己负责。
 *
 * ⚠️ 文件名里的 `adapt` 是历史遗留，**没有 `/adapt` 这条路由了**。
 * 往这里加跳转时请指向 `/hardware?tab=…` 或 `/firmware?tab=…`：
 * 已下线的 `/adapt` 现在会落到「页面不存在」，小木和登录跳转都踩过这个坑。
 * 新页签归属按「设备侧 → /hardware，算法与交付侧 → /firmware」判断。
 *
 * PRD 2.2：切换页签保留筛选条件、当前批次和滚动位置；
 * 页面用 URL 记录 batch_id / component_id。
 * 各页签对应 PRD：
 *   采集 3.4 / 异常排查 3.4 / 数据集 3.5 / 训练验证 3.6 / 更新交付 3.6 / 融合分析 3.7
 */

import { useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { useMumai } from "../context";
import { permissionHint } from "../auth";
import { Panel } from "../Panel";
import {
  Btn,
  ConfusionMatrix,
  DataTable,
  LineChart,
  PermNote,
  SourceTag,
  StateBlock,
  StatusChip,
  StepFlow,
  WaveChart,
} from "../ui";
import { checkGrouping, fmtNum, fmtPct, runEvaluation } from "../lib";
import {
  ANOMALY_EVENTS,
  CLEAN_STEPS,
  DATASET,
  EXPERIMENT,
  FAILED_EXPERIMENT,
  FUSION_RECORD,
  FUSION_RULES,
  REFERENCE_BATCHES,
  SAMPLES,
  SCAN_BATCHES,
  TRIAGE_ITEMS,
  UPDATE_PACKAGE,
  WAVEFORMS,
} from "../seed/scenario";
import type { SplitGroup } from "../seed/types";

/* ------------------------------------------------------------------ *
 * 采集
 * ------------------------------------------------------------------ */

export function CaptureTab() {
  const { domainPending, toast } = useMumai();
  /** PRD 2.2：当前批次写在 URL 里，切页签 / 刷新都保留（单一批次来源） */
  const [params, setParams] = useSearchParams();
  const batchId = params.get("batch") ?? SCAN_BATCHES[0]?.batchId ?? "";
  const batch = SCAN_BATCHES.find((item) => item.batchId === batchId) ?? SCAN_BATCHES[0];
  const waveform = WAVEFORMS.find((item) => item.batchId === batchId) ?? WAVEFORMS[0];

  const selectBatch = (nextBatchId: string) => {
    const next = new URLSearchParams(params);
    next.set("batch", nextBatchId);
    next.set("tab", params.get("tab") ?? "capture");
    setParams(next, { replace: true });
  };

  if (!batch) return <StateBlock kind="empty" title="暂无采集批次" />;

  const receiveRows = (["radar", "image", "result"] as const).map((key) => {
    const item = batch.receive[key];
    const label = key === "radar" ? "雷达原始数据" : key === "image" ? "表面图像" : "结果文件";
    return [
      <b key={`l-${key}`}>{label}</b>,
      `${item.received} / ${item.expected}`,
      <StatusChip
        key={`s-${key}`}
        text={item.state}
        tone={item.state === "完成" ? "ok" : item.state === "部分接收" ? "warn" : "muted"}
      />,
    ];
  });

  return (
    <div className="adapt-grid">
      <Panel title="采集配置" extra={<SourceTag label={`批次 ${batch.batchId}`} />}>
        <dl className="kv">
          <div>
            <dt>构件 / 测区</dt>
            <dd>
              {batch.componentId} · {batch.zoneId}
            </dd>
          </div>
          <div>
            <dt>轮次</dt>
            <dd>{batch.round}</dd>
          </div>
          <div>
            <dt>配置版本</dt>
            <dd>{batch.configVersion}</dd>
          </div>
          <div>
            <dt>模型版本</dt>
            <dd>{batch.modelVersion}</dd>
          </div>
          <div>
            <dt>原始数据级别</dt>
            <dd>{batch.rawLevel}</dd>
          </div>
          <div>
            <dt>开始时间</dt>
            <dd>{batch.startedAt}</dd>
          </div>
        </dl>

        <label className="field">
          <span>切换批次</span>
          <select value={batchId} onChange={(event) => selectBatch(event.target.value)}>
            {SCAN_BATCHES.map((item) => (
              <option key={item.batchId} value={item.batchId}>
                {item.batchId} · {item.round} · {item.frozen ? "已冻结" : "正常"}
              </option>
            ))}
          </select>
        </label>

        <div className="adapt-actions">
          <Btn tone="primary" onClick={() => toast("采集已启动，等待帧号与时间戳", "ok")}>
            启动采集
          </Btn>
          <Btn onClick={() => toast("已请求暂停采集，等待设备确认", "warn")}>
            暂停采集
          </Btn>
        </div>

        {batch.frozen ? (
          <StateBlock
            kind="partial"
            title="该批次已冻结"
            hint={`${batch.freezeReason ?? "等待适用域核验"}。`}
          />
        ) : null}
      </Panel>

      <Panel title="接收情况">
        <DataTable head={["数据类型", "已接收 / 预期", "状态"]} rows={receiveRows} />
        <h4 className="sub">实时波形</h4>
        <WaveChart
          points={waveform?.points ?? []}
          unit={waveform?.unit}
          axisLabel={waveform?.axisLabel}
          markers={waveform?.markers ?? []}
        />
      </Panel>

      <Panel title="参考样本批次">
        <DataTable
          head={["批次", "分组", "材种来源", "扫描次数", "方向"]}
          rows={REFERENCE_BATCHES.map((item) => [
            item.batchId,
            item.groupId,
            item.material,
            String(item.scans),
            item.direction,
          ])}
        />
        {domainPending ? (
          <StateBlock
            kind="partial"
            title="适用域待核验"
            hint="该批次诊断输出已冻结，等待适用域核验。"
          />
        ) : null}
      </Panel>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 异常排查
 * ------------------------------------------------------------------ */

export function TriageTab() {
  const { domainPending, setDomainPending, toast, pushEvent } = useMumai();
  const [conclusions, setConclusions] = useState<Record<string, string>>({});
  const [signed, setSigned] = useState<Record<string, string>>({});

  const event = ANOMALY_EVENTS[0];
  const done = Object.keys(signed).length;

  return (
    <div className="adapt-grid">
      <Panel title="异常事件" extra={<StatusChip text={event?.kind ?? "—"} tone="danger" />}>
        {event ? (
          <>
            <dl className="kv">
              <div>
                <dt>时间</dt>
                <dd>{event.at}</dd>
              </div>
              <div>
                <dt>冻结批次</dt>
                <dd>{event.frozenBatch}</dd>
              </div>
              <div>
                <dt>触发来源</dt>
                <dd>{event.trigger}</dd>
              </div>
              <div>
                <dt>输出状态</dt>
                <dd>
                  <StatusChip
                    text={event.outputsFrozen ? "已冻结" : "正常"}
                    tone={event.outputsFrozen ? "warn" : "ok"}
                  />
                </dd>
              </div>
            </dl>
            <p className="note">{event.detail}</p>
            <ul className="evidence-list">
              {event.evidence.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </>
        ) : (
          <StateBlock kind="empty" title="暂无异常事件" />
        )}

        <div className="adapt-actions">
          <Btn
            tone="danger"
            onClick={() => {
              setDomainPending(true);
              pushEvent("适用域待核验：冻结该批诊断输出", "danger");
            }}>
            标记待核验
          </Btn>
          <Btn
            onClick={() => {
              setDomainPending(false);
              pushEvent("适用域核验通过，恢复诊断输出", "ok");
              toast("已恢复诊断输出", "ok");
            }}>
            核验通过并恢复
          </Btn>
        </div>

        {domainPending ? (
          <StateBlock
            kind="partial"
            title="诊断输出已冻结"
            hint="该批次不输出病害结论，等待适用域核验。"
          />
        ) : null}
      </Panel>

      <Panel title="四项检查与签名" extra={<span className="muted">{done}/{TRIAGE_ITEMS.length} 已签名</span>}>
        <ul className="triage-list">
          {TRIAGE_ITEMS.map((item) => (
            <li key={item.id} className={signed[item.id] ? "is-done" : ""}>
              <header>
                <b>{item.title}</b>
                <StatusChip text={item.state} tone={item.state === "已签名" ? "ok" : "warn"} />
                <em>负责人 {item.owner}</em>
              </header>
              <ul className="triage-records">
                {item.records.map((record) => (
                  <li key={record.at}>
                    <time>{record.at}</time>
                    <span>{record.text}</span>
                    <StatusChip
                      text={record.result}
                      tone={record.result === "正常" ? "ok" : record.result === "异常" ? "danger" : "warn"}
                    />
                  </li>
                ))}
              </ul>
              <div className="triage-form">
                <input
                  value={conclusions[item.id] ?? item.conclusion ?? ""}
                  placeholder="填写检查结论"
                  onChange={(event) =>
                    setConclusions((current) => ({ ...current, [item.id]: event.target.value }))
                  }
                />
                <Btn
                  tone="primary"
                  onClick={() => {
                    const text = conclusions[item.id] ?? item.conclusion ?? "";
                    if (!text.trim()) {
                      toast("请先填写结论再签名", "danger");
                      return;
                    }
                    setSigned((current) => ({ ...current, [item.id]: item.owner }));
                    pushEvent(`${item.title} 检查结论已签名（${item.owner}）`, "ok");
                  }}>
                  签名
                </Btn>
                {signed[item.id] ? <StatusChip text={`已签名 ${signed[item.id]}`} tone="ok" /> : null}
              </div>
            </li>
          ))}
        </ul>

        <Btn
          tone="primary"
          disabled={done < TRIAGE_ITEMS.length}
          onClick={() => {
            toast("已创建参考样本采集任务", "ok");
            pushEvent("四项检查完成，创建参考样本采集任务", "ok");
          }}>
          创建参考样本采集任务
        </Btn>
      </Panel>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 数据集
 * ------------------------------------------------------------------ */

export function DatasetTab() {
  const { toast } = useMumai();

  /** 分组可调整：默认取冻结版本的划分，调整只改这份副本，不改种子 */
  const [splits, setSplits] = useState<SplitGroup[]>(() =>
    DATASET.splits.map((split) => ({ ...split, sampleIds: [...split.sampleIds] })),
  );
  const groups = useMemo(() => [...new Set(SAMPLES.map((sample) => sample.physicalSampleId))], []);
  const [group, setGroup] = useState(groups[0] ?? "");
  const [target, setTarget] = useState<SplitGroup["name"]>("训练集");

  /** PRD 3.5 / 12：经理程序真读训练 / 验证 / 测试的物理样本 ID，输出交集与冲突清单 */
  const grouping = useMemo(() => checkGrouping({ ...DATASET, splits }, SAMPLES), [splits]);

  /**
   * 未纳入任何集合的样本与混入监督训练的未知标签：
   * lib.checkGrouping 把它们写成 details 行，这里按同一口径把样本 ID 列出来。
   */
  const usedIds = useMemo(() => new Set(splits.flatMap((split) => split.sampleIds)), [splits]);
  const orphans = useMemo(
    () => [...new Set(SAMPLES.map((sample) => sample.physicalSampleId))].filter((id) => !usedIds.has(id)),
    [usedIds],
  );
  const unknownInSupervised = useMemo(
    () => SAMPLES.filter((sample) => sample.knownState === "未知待核验" && usedIds.has(sample.physicalSampleId)),
    [usedIds],
  );

  /** A13：故意让同一木样跨集合，验证经理程序能检出交集 */
  const crossGroup = () => {
    const next = splits.map((split) =>
      split.name === target ? { ...split, sampleIds: [...new Set([...split.sampleIds, group])] } : split,
    );
    setSplits(next);
    const after = checkGrouping({ ...DATASET, splits: next }, SAMPLES);
    toast(
      after.conflicts.length
        ? `已把 ${group} 同时编入${target}：检出 ${after.conflicts.length} 组跨集合冲突`
        : `${group} 已在${target}中，未形成跨集合；请把目标集合换成另一个集合`,
      after.conflicts.length ? "danger" : "warn",
    );
  };

  /** A13：整组调整后重跑 —— 整组只保留在目标集合，再运行一次受限校验单元 */
  const regroupAndRerun = () => {
    const next = splits.map((split) =>
      split.name === target
        ? { ...split, sampleIds: [...new Set([...split.sampleIds, group])] }
        : { ...split, sampleIds: split.sampleIds.filter((id) => id !== group) },
    );
    setSplits(next);
    const after = checkGrouping({ ...DATASET, splits: next }, SAMPLES);
    const cleanIntersection = after.intersections.every((pair) => pair.ids.length === 0);
    const failed = after.details.filter((detail) => !detail.ok).map((detail) => detail.label);
    toast(
      cleanIntersection
        ? `整组调整后重跑：交集为空，${group} 整组保留在${target}${failed.length ? `；仍有未通过项：${failed.join("、")}` : ""}`
        : `整组调整后仍有 ${after.conflicts.length} 组跨集合冲突，请检查其它集合`,
      cleanIntersection ? "ok" : "danger",
    );
  };

  return (
    <div className="adapt-grid">
      <Panel
        title="智能清洗过程"
        extra={<StatusChip text={DATASET.frozen ? `已冻结 ${DATASET.frozenAt}` : "未冻结"} tone={DATASET.frozen ? "ok" : "warn"} />}>
        <DataTable
          head={["步骤", "输入", "保留", "待审核", "处理口径"]}
          rows={CLEAN_STEPS.map((step) => [
            <b key={`k-${step.key}`}>{step.label}</b>,
            String(step.input),
            String(step.kept),
            String(step.review),
            step.reason,
          ])}
        />
      </Panel>

      <Panel title="样本清单" extra={<span className="muted">{SAMPLES.length} 条记录</span>}>
        <DataTable
          compact
          head={["样本", "记录", "材种来源", "已知状态", "质量", "说明"]}
          rows={SAMPLES.map((sample) => [
            <b key={`p-${sample.recordId}`}>{sample.physicalSampleId}</b>,
            sample.recordId,
            sample.materialSource,
            sample.knownState,
            <StatusChip
              key={`q-${sample.recordId}`}
              text={sample.quality}
              tone={sample.quality === "可用" ? "ok" : sample.quality === "待审核" ? "warn" : "danger"}
            />,
            sample.qualityReason,
          ])}
        />
      </Panel>

      <Panel
        title="分组检查"
        extra={
          <StatusChip
            text={grouping.passed ? "校验通过" : "存在问题"}
            tone={grouping.passed ? "ok" : "danger"}
          />
        }>
        <div className="split-groups">
          {splits.map((split) => (
            <article key={split.name}>
              <header>{split.name}</header>
              <strong>{split.sampleIds.length} 个物理样本</strong>
              <ul>
                {split.sampleIds.map((id) => (
                  <li key={id}>{id}</li>
                ))}
              </ul>
            </article>
          ))}
        </div>

        <pre className="code-block">{grouping.expression}</pre>

        <DataTable
          head={["交集", "重复的物理样本"]}
          rows={grouping.intersections.map((pair) => [
            pair.pair,
            pair.ids.length ? pair.ids.join(", ") : "—（无交叉）",
          ])}
        />

        <h4 className="sub">三类问题明细</h4>
        <DataTable
          head={["检查项", "对象", "结论"]}
          rows={[
            [
              "同一物理样本跨集合",
              grouping.conflicts.length
                ? grouping.conflicts
                    .map((item) => `${item.groupId}（记录 ${item.sampleIds.join("、")}）：${item.detail}`)
                    .join("；")
                : "无",
              <StatusChip
                key="conflict"
                text={grouping.conflicts.length ? `${grouping.conflicts.length} 组冲突` : "整组未被拆散"}
                tone={grouping.conflicts.length ? "danger" : "ok"}
              />,
            ],
            [
              "未纳入任何集合的样本",
              orphans.length ? orphans.join("、") : "无",
              <StatusChip
                key="orphan"
                text={orphans.length ? `${orphans.length} 组未纳入` : "全部已纳入"}
                tone={orphans.length ? "warn" : "ok"}
              />,
            ],
            [
              "未知标签混入监督训练",
              unknownInSupervised.length
                ? unknownInSupervised.map((sample) => `${sample.recordId}（${sample.physicalSampleId}）`).join("、")
                : "无",
              <StatusChip
                key="unknown"
                text={unknownInSupervised.length ? `${unknownInSupervised.length} 条待核验` : "未知标签单列"}
                tone={unknownInSupervised.length ? "danger" : "ok"}
              />,
            ],
          ]}
        />

        <DataTable
          compact
          head={["校验断言", "结果", "结论"]}
          rows={grouping.details.map((detail) => [
            detail.label,
            detail.value,
            <StatusChip
              key={detail.label}
              text={detail.ok ? "通过" : "未通过"}
              tone={detail.ok ? "ok" : "danger"}
            />,
          ])}
        />
        <p className="note">
          执行时间 {grouping.executedAt} · 数据版本 {grouping.dataVersion}
          {grouping.error ? ` · ${grouping.error}` : ""}
        </p>

        <div className="adapt-actions">
          <label className="field">
            <span>物理样本组</span>
            <select value={group} onChange={(event) => setGroup(event.target.value)}>
              {groups.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>目标集合</span>
            <select
              value={target}
              onChange={(event) => setTarget(event.target.value as SplitGroup["name"])}>
              {DATASET.splits.map((split) => (
                <option key={split.name} value={split.name}>
                  {split.name}
                </option>
              ))}
            </select>
          </label>
          <Btn onClick={crossGroup}>编入所选集合</Btn>
          <Btn tone="primary" onClick={regroupAndRerun}>
            整组调整后重跑
          </Btn>
        </div>

        <ul className="review-assign">
          {DATASET.reviewAssign.map((item) => (
            <li key={item.owner}>
              <b>{item.owner}</b>
              <span>{item.task}</span>
              <StatusChip text={item.state} tone={item.state === "已通过" ? "ok" : "warn"} />
            </li>
          ))}
        </ul>

        <Btn
          tone="primary"
          onClick={() => {
            toast(
              grouping.passed
                ? `分组检查通过，可冻结 dataset_version ${DATASET.id}`
                : "分组检查未通过，请整组调整后重跑",
              grouping.passed ? "ok" : "danger",
            );
          }}>
          冻结数据集版本
        </Btn>
      </Panel>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 训练验证
 * ------------------------------------------------------------------ */

export function TrainingTab() {
  const [useFailed, setUseFailed] = useState(false);
  const experiment = useFailed ? FAILED_EXPERIMENT : EXPERIMENT;

  /** PRD 3.6 / 12：比较程序读归档预测表真算精确率 / 召回率 / F1，页面不再自己数 TP/FP */
  const evaluation = useMemo(() => runEvaluation(experiment), [experiment]);
  const fnDelta = evaluation.overall.next.fn - evaluation.overall.old.fn;
  const fpDelta = evaluation.overall.next.fp - evaluation.overall.old.fp;
  const regression = evaluation.acceptance.find((item) => item.key === "regression");

  return (
    <div className="adapt-grid">
      <Panel title="训练任务" extra={<SourceTag label="演示记录（归档实验包）" />}>
        <dl className="kv">
          <div>
            <dt>实验</dt>
            <dd>{experiment.title}</dd>
          </div>
          <div>
            <dt>基线 / 候选</dt>
            <dd>
              {experiment.baselineVersion} → {experiment.candidateVersion}
            </dd>
          </div>
          <div>
            <dt>数据集</dt>
            <dd>{experiment.datasetVersion}</dd>
          </div>
          <div>
            <dt>学习率</dt>
            <dd>{experiment.learningRate}</dd>
          </div>
          <div>
            <dt>更新范围</dt>
            <dd>{experiment.updateScope}</dd>
          </div>
          <div>
            <dt>判定阈值</dt>
            <dd>{experiment.threshold}</dd>
          </div>
        </dl>
        <p className="note">{experiment.stopCondition}</p>
        <p className="note">{experiment.inputSpec}</p>

        <StepFlow steps={experiment.jobSteps} />

        <label className="twin-compare">
          <input
            type="checkbox"
            checked={useFailed}
            onChange={(event) => setUseFailed(event.target.checked)}
          />
          切换到失败案例
        </label>
      </Panel>

      <Panel title="损失曲线">
        <LineChart
          series={[
            {
              id: experiment.curveOld.id,
              label: experiment.curveOld.label,
              color: experiment.curveOld.color,
              points: experiment.curveOld.points,
            },
            {
              id: experiment.curveNew.id,
              label: experiment.curveNew.label,
              color: experiment.curveNew.color,
              points: experiment.curveNew.points,
            },
          ]}
          xLabel="轮次"
          yLabel="损失"
        />
      </Panel>

      <Panel
        title="独立测试集对比"
        extra={
          <StatusChip
            text={`同一测试集 ${evaluation.testSetIds.length} 条`}
            tone={evaluation.testSetConsistent ? "ok" : "danger"}
          />
        }>
        <div className="matrix-row">
          <ConfusionMatrix
            title={`${experiment.baselineVersion}（旧）`}
            metrics={evaluation.overall.old}
          />
          <ConfusionMatrix
            title={`${experiment.candidateVersion}（新）`}
            metrics={evaluation.overall.next}
          />
        </div>

        <div className="delta-row">
          <span>
            漏检变化{" "}
            <b className={fnDelta > 0 ? "is-danger" : "is-ok"}>
              {fnDelta > 0 ? "+" : ""}
              {fnDelta}
            </b>
          </span>
          <span>
            误报变化{" "}
            <b className={fpDelta > 0 ? "is-warn" : "is-ok"}>
              {fpDelta > 0 ? "+" : ""}
              {fpDelta}
            </b>
          </span>
          <span>
            逐样本 <b>{evaluation.summary.improved} 改善 / {evaluation.summary.regressed} 退化 / {evaluation.summary.same} 不变</b>
          </span>
        </div>

        <h4 className="sub">按材种回归</h4>
        <DataTable
          compact
          head={["材种", "测试样本", "旧版召回", "新版召回", "召回变化", "新版精确率", "新版 F1"]}
          rows={evaluation.perMaterial.map((item) => {
            const size =
              item.next.tp + item.next.fp + item.next.tn + item.next.fn;
            const recallDelta =
              item.old.recall === null || item.next.recall === null
                ? null
                : item.next.recall - item.old.recall;
            return [
              <b key={`m-${item.material}`}>{item.material}</b>,
              String(size),
              fmtPct(item.old.recall),
              fmtPct(item.next.recall),
              <span
                key={`d-${item.material}`}
                className={recallDelta === null ? undefined : recallDelta < 0 ? "is-warn" : "is-ok"}>
                {recallDelta === null
                  ? "不适用"
                  : `${recallDelta > 0 ? "+" : ""}${(recallDelta * 100).toFixed(1)}%`}
              </span>,
              fmtPct(item.next.precision),
              fmtNum(item.next.f1),
            ];
          })}
        />
        {regression ? (
          <p className="note">
            回归判定：{regression.detail} ·{" "}
            <b className={regression.pass ? "is-ok" : "is-danger"}>
              {regression.pass ? "通过" : "未通过"}
            </b>
          </p>
        ) : null}

        <h4 className="sub">逐样本预测对比</h4>
        <DataTable
          compact
          head={["样本", "组", "材种", "标签", "旧分", "新分", "新版判定", "对比"]}
          rows={evaluation.rows.map((row) => {
            const correct = (row.predNew === 1) === (row.label === 1);
            return [
              row.sampleId,
              row.groupId,
              row.material,
              row.label === 1 ? "有缺陷" : "正常",
              row.scoreOld.toFixed(2),
              row.scoreNew.toFixed(2),
              <StatusChip
                key={`v-${row.sampleId}`}
                text={correct ? "正确" : row.label === 1 ? "漏检" : "误报"}
                tone={correct ? "ok" : row.label === 1 ? "danger" : "warn"}
              />,
              <StatusChip
                key={`c-${row.sampleId}`}
                text={row.verdict}
                tone={row.verdict === "改善" ? "ok" : row.verdict === "退化" ? "danger" : "muted"}
              />,
            ];
          })}
        />

        <h4 className="sub">验收规则</h4>
        <ul className="acceptance">
          {evaluation.acceptance.map((item) => (
            <li key={item.key} className={item.pass ? "is-ok" : "is-bad"}>
              <b>{item.label}</b>
              <span>{item.detail}</span>
              <StatusChip text={item.pass ? "通过" : "未通过"} tone={item.pass ? "ok" : "danger"} />
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 更新交付
 * ------------------------------------------------------------------ */

export function DeliveryTab() {
  const { toast, pushEvent, can } = useMumai();
  const pkg = UPDATE_PACKAGE;

  return (
    <div className="adapt-grid">
      <Panel title="更新包清单" extra={<StatusChip text={pkg.artifactKind === "demo_nonflashable" ? "不可烧录演示包" : pkg.artifactKind} tone="warn" />}>
        <dl className="kv">
          <div>
            <dt>包编号</dt>
            <dd>{pkg.id}</dd>
          </div>
          <div>
            <dt>模型版本</dt>
            <dd>{pkg.modelVersion}</dd>
          </div>
          <div>
            <dt>预处理</dt>
            <dd>{pkg.preprocess}</dd>
          </div>
          <div>
            <dt>输入规格</dt>
            <dd>{pkg.inputSpec}</dd>
          </div>
          <div>
            <dt>输出规格</dt>
            <dd>{pkg.outputSpec}</dd>
          </div>
          <div>
            <dt>目标环境</dt>
            <dd>{pkg.targetEnv}</dd>
          </div>
          <div>
            <dt>包大小</dt>
            <dd>{pkg.sizeText}</dd>
          </div>
          <div>
            <dt>恢复版本</dt>
            <dd>{pkg.fallbackVersion}</dd>
          </div>
        </dl>
      </Panel>

      <Panel title="量化与兼容性">
        <h4 className="sub">量化</h4>
        <ul className="pkg-list">
          {pkg.quantization.map((item) => (
            <li key={item.key}>
              <b>{item.label}</b>
              <span>{item.detail}</span>
            </li>
          ))}
        </ul>
        <h4 className="sub">兼容性</h4>
        <ul className="pkg-list">
          {pkg.compatibility.map((item) => (
            <li key={item.key} className={item.pass ? "is-ok" : "is-bad"}>
              <b>{item.label}</b>
              <span>{item.detail}</span>
              <StatusChip text={item.pass ? "通过" : "未通过"} tone={item.pass ? "ok" : "danger"} />
            </li>
          ))}
        </ul>
      </Panel>

      <Panel title="交付步骤">
        <StepFlow
          steps={pkg.steps.map((step) => ({
            key: step.key,
            label: `${step.label}（${step.owner}）`,
            state: step.state,
            at: step.at,
            note: step.note,
          }))}
        />
        <div className="adapt-actions">
          {/* PRD 2.1：封装下发属于架构师；接收与回验属于全栈 */}
          <Btn
            tone="primary"
            disabled={!can("package:deliver")}
            title={can("package:deliver") ? "下发给接收人并产生交付记录" : permissionHint("package:deliver")}
            onClick={() => {
              toast(`更新包 ${pkg.id} 已下发，等待全栈接收`, "ok");
              pushEvent(`下发演示更新包 ${pkg.id}`, "ok");
            }}>
            下发更新包
          </Btn>
          <Btn
            disabled={!can("deployment:receive")}
            title={can("deployment:receive") ? "读取设备回报版本" : permissionHint("deployment:receive")}
            onClick={() => {
              toast(
                `设备回报版本 ${pkg.deviceVersion.demoReported}；实机版本 ${pkg.deviceVersion.liveReported} 未接入`,
                "info",
              );
            }}>
            读取设备版本
          </Btn>
          <PermNote permissions={["package:deliver", "deployment:receive"]} />
        </div>
        <StateBlock
          kind="empty"
          title="实机写入未接入"
          hint="本批次交付物为不可烧录演示包，实机写入未接入。"
        />
      </Panel>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 融合分析
 * ------------------------------------------------------------------ */

export function FusionTab() {
  const { toast } = useMumai();

  return (
    <div className="adapt-grid">
      <Panel title="数据完整性" extra={<SourceTag label={`规则 ${FUSION_RECORD.ruleVersion}`} />}>
        <DataTable
          head={["检查项", "结果", "说明"]}
          rows={FUSION_RECORD.completeness.map((item) => [
            item.label,
            <StatusChip key={item.label} text={item.ok ? "通过" : "不通过"} tone={item.ok ? "ok" : "danger"} />,
            item.note,
          ])}
        />
        <h4 className="sub">分支状态</h4>
        <ul className="pkg-list">
          {FUSION_RECORD.branches.map((branch) => (
            <li key={branch.key} className={branch.state === "合格" ? "is-ok" : "is-bad"}>
              <b>{branch.label}</b>
              <span>{branch.detail}</span>
              <StatusChip text={branch.state} tone={branch.state === "合格" ? "ok" : "danger"} />
            </li>
          ))}
        </ul>
      </Panel>

      <Panel title="图像标注">
        <DataTable
          head={["标注框", "图像", "标签", "置信度", "测区"]}
          rows={FUSION_RECORD.annotations.map((item) => [
            item.boxId,
            item.image,
            item.label,
            item.confidence.toFixed(2),
            item.zone,
          ])}
        />
        <h4 className="sub">测区匹配</h4>
        <DataTable
          head={["视觉测区", "雷达测区", "是否一致", "说明"]}
          rows={FUSION_RECORD.zoneMatch.map((item) => [
            item.visual,
            item.radar,
            <StatusChip key={item.visual} text={item.matched ? "一致" : "不一致"} tone={item.matched ? "ok" : "warn"} />,
            item.note,
          ])}
        />
      </Panel>

      <Panel title="雷达特征">
        <DataTable
          head={["响应段", "测区", "幅值", "质量"]}
          rows={FUSION_RECORD.radarFeatures.map((item) => [
            item.segment,
            item.zone,
            item.amplitude.toFixed(2),
            <StatusChip key={item.segment} text={item.quality} tone={item.quality === "合格" ? "ok" : "danger"} />,
          ])}
        />
      </Panel>

      {/* 规则条数是从种子现算的状态量；原来这里挂的
          「明确规则，非分数相加」是在向读者解释这套融合是怎么设计的（§5 判据） */}
      <Panel title="融合规则与结果" extra={<span className="muted">{FUSION_RULES.length} 条规则</span>}>
        <ul className="fusion-rules">
          {FUSION_RULES.map((rule) => (
            <li key={rule.key}>
              <b>{rule.label}</b>
              <StatusChip
                text={rule.result}
                tone={rule.result === "优先复核" ? "danger" : rule.result === "补充检测" ? "warn" : "info"}
              />
              <span>{rule.note}</span>
            </li>
          ))}
        </ul>

        <h4 className="sub">输出</h4>
        <DataTable
          head={["风险", "结论", "优先级", "规则", "下一步"]}
          rows={FUSION_RECORD.outputs.map((item) => [
            item.riskId,
            item.label,
            <StatusChip
              key={item.riskId}
              text={item.priority}
              tone={item.priority === "优先复核" ? "danger" : "warn"}
            />,
            item.rule,
            item.nextAction,
          ])}
        />

        <Btn
          tone="primary"
          onClick={() => {
            toast("融合结果已保存，规则版本一并记录", "ok");
          }}>
          保存融合结果
        </Btn>
      </Panel>
    </div>
  );
}
