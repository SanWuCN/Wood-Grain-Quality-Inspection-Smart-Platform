/**
 * 检测适配的中段页签组件（共享模块）
 *
 * 原「检测适配」单页已经拆开，本文件只剩三个页签的内容：
 *   - DatasetTab   数据集      → `/firmware?tab=dataset`
 *   - FusionTab    融合分析    → `/firmware?tab=fusion`
 *
 * 首尾三段各自独立成文件了，因为它们的形态与剩下这几个差别太大：
 *   - CaptureRun.tsx   采集作业 → `/hardware?tab=capture`
 *     启动前逐条确认并签署的设备启动检查 + 采集端屏幕推流位
 *   - TriageLog.tsx    异常排查 → `/hardware?tab=triage`
 *     异常事件列表 + 详情弹窗 + 设备日志
 *   - TrainingRun.tsx  训练验证 → `/firmware?tab=training`
 *     训练配置、任务控制台、执行节点占用
 *   - DeliveryCenter.tsx 更新交付 → `/firmware?tab=delivery`
 *     产物提交与分发（待提交 / 提交前校验 / 已发布可下载）
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
import { useMumai } from "../context";
import { Modal } from "../ui";
import { DatasetCleanFlow } from "./DatasetCleanFlow";
import { Panel } from "../Panel";
import {
  Btn,
  DataTable,
  SourceTag,
  StatusChip,
} from "../ui";
import { checkGrouping } from "../lib";
import {
  CLEAN_STEPS,
  DATASET,
  FUSION_RECORD,
  FUSION_RULES,
  SAMPLES,
} from "../seed/scenario";
import type { SplitGroup } from "../seed/types";


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
  /** 清洗流程产出的新版本号；为空表示本轮还没生成过 */
  const [datasetVersion, setDatasetVersion] = useState<string | null>(null);

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
    <div className="adapt-grid adapt-grid--dataset">
      {/*
        清洗不再是一张「一进来就全部完成」的静态表（用户原话：「不是拿文字在那里
        糊弄」）。这里挂真实的分段流程：选数据集 → 配置 → 预检查 → 执行 →
        人工核验 → 生成版本；每步都要点，结果由规则在当前样本上真算。
      */}
      <DatasetCleanFlow onVersioned={(label) => setDatasetVersion(label)} />

      <Panel
        title="本轮版本"
        extra={
          <StatusChip
            text={datasetVersion ? datasetVersion : DATASET.frozen ? `已冻结 ${DATASET.frozenAt}` : "未冻结"}
            tone={datasetVersion || DATASET.frozen ? "ok" : "warn"}
          />
        }>
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
        /* PRD §5：物理样本分组用 biz-sample-group（不是二维码似的九点结构） */
        icon="biz-sample-group"
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
 * 融合分析
 * ------------------------------------------------------------------ */

export function FusionTab() {
  const { toast } = useMumai();
  /** 保存是一次会写版本的正式动作，先弹二级确认（一级页面不直接落库） */
  const [saveOpen, setSaveOpen] = useState(false);

  return (
    /*
      两列，不按「一模块一卡片」自动铺。

      原来用 `auto-fit minmax(340px, 1fr)`，1920 下铺成三列：数据完整性、图像标注、
      雷达特征都在左中，融合规则与结果又高又宽 —— 前三个早早结束、底下空一大片，
      第四个还在往下长，看上去「有的长有的短」。
      现在前三块（输入与校验）竖着排在一列，融合规则与结果（结论）单独一列，
      两列底部齐平，同级面板的标题高度与间距本来就统一（都走 .tech-panel）。
    */
    <div className="adapt-grid adapt-grid--fusion">
      <div className="adapt-col">
        <Panel
          title="数据完整性"
          /* 融合前的输入校验：PRD §5「校验使用业务图标」 */
          icon="biz-package-verify"
          extra={<SourceTag label={`规则 ${FUSION_RECORD.ruleVersion}`} />}>
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
      </div>

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

        <Btn tone="primary" onClick={() => setSaveOpen(true)}>
          保存融合结果
        </Btn>
      </Panel>

      {saveOpen ? (
        <Modal
          title="保存融合结果"
          subtitle={`规则版本 ${FUSION_RECORD.ruleVersion}`}
          onClose={() => setSaveOpen(false)}
          footer={
            <>
              <Btn onClick={() => setSaveOpen(false)}>取消</Btn>
              <Btn
                tone="primary"
                onClick={() => {
                  setSaveOpen(false);
                  toast("融合结果已保存，规则版本一并记录", "ok");
                }}>
                确认保存
              </Btn>
            </>
          }>
          {/*
            确认弹窗要让人**看清将写下什么**，而不是只问一句「确定吗」：
            规则版本、参与的分支、输出的条目数、以及哪几条要优先复核。
          */}
          <dl className="kv">
            <div>
              <dt>规则版本</dt>
              <dd>{FUSION_RECORD.ruleVersion}</dd>
            </div>
            <div>
              <dt>参与分支</dt>
              <dd>{FUSION_RECORD.branches.map((item) => item.label).join(" / ")}</dd>
            </div>
            <div>
              <dt>输出条目</dt>
              <dd>{FUSION_RECORD.outputs.length} 条</dd>
            </div>
            <div>
              <dt>需优先复核</dt>
              <dd>{FUSION_RECORD.outputs.filter((item) => item.priority === "优先复核").length} 条</dd>
            </div>
          </dl>
          <ul className="pkg-list">
            {FUSION_RECORD.outputs.map((item) => (
              <li key={item.riskId} className={item.priority === "优先复核" ? "is-bad" : ""}>
                <b>{item.riskId}</b>
                <span>
                  {item.label} · {item.rule}
                </span>
                <StatusChip
                  text={item.priority}
                  tone={item.priority === "优先复核" ? "danger" : "warn"}
                />
              </li>
            ))}
          </ul>
          <p className="note">
            保存后按该规则版本归档；两路分数不做平均，结论由规则矩阵给出。
          </p>
        </Modal>
      ) : null}
    </div>
  );
}
