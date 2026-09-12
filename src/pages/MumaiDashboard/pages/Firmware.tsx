/**
 * 固件及模型（`/firmware`）
 *
 * 由原「检测适配」页拆出：把**算法与版本侧**的四件事收在一页 ——
 *   1. 全局配置：平台使用的模型 / Agent / 小车程序 / 毫米波固件 / 采集配置 / 流水线版本
 *   2. 数据集：分组检查与冻结
 *   3. 训练验证：用新采集的数据重训练候选模型，并与基线对比
 *   4. 更新交付：封装、回验、下发硬件工程师
 *   5. 融合分析：雷达 / 视觉 / 融合三路按规则出优先级
 *
 * 后四个页签的实现原样复用 `adaptTabs.tsx`；「全局配置」是本页新增 ——
 * 用户明确要求「可以全局配置当前平台使用的模型、agent、小车程序版本、
 * 毫米波扫描枪的固件版本、模型版本等等，而且可以对采集来的数据重新训练模型
 * （流程要做的真实一些），也可以下发给硬件工程师」。
 *
 * 版本数据来自 `seed/versions.ts`，页面不硬编码任何版本号。
 */

import { useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { Panel } from "../Panel";
import { Btn, DataTable, SourceTag, StateBlock, StatusChip, StepFlow, Toolbar } from "../ui";
import { useMumai } from "../context";
import { DatasetTab, DeliveryTab, FusionTab, TrainingTab } from "./adaptTabs";
import { RETRAIN_STAGES, VERSION_ITEMS, type VersionItem } from "../seed/versions";
import { EXPERIMENT, SCAN_BATCHES, UPDATE_PACKAGE } from "../seed/scenario";

const TABS = [
  { key: "config", label: "全局配置" },
  { key: "dataset", label: "数据集" },
  { key: "training", label: "训练验证" },
  { key: "delivery", label: "更新交付" },
  { key: "fusion", label: "融合分析" },
] as const;

const GROUPS: VersionItem["group"][] = ["硬件", "算法", "平台"];

/** 重训练的一次执行记录：让「跑过一次」和「还没跑」在界面上可区分 */
type RunState = "idle" | "running" | "done";

/**
 * 全局配置
 *
 * 每个版本项都能看到：当前值 / 载体 / 为什么是这个值 / 能切到什么。
 * 「只能随更新包升级」的项（candidates 为空）不给下拉，说明原因而不是灰着不解释。
 */
function ConfigTab() {
  const { toast } = useMumai();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [run, setRun] = useState<RunState>("idle");
  const [stage, setStage] = useState(0);

  const pending = useMemo(
    () =>
      VERSION_ITEMS.filter((item) => draft[item.key] && draft[item.key] !== item.current),
    [draft],
  );

  const changed = pending.length > 0;

  /** 重训练：按 RETRAIN_STAGES 逐步推进，每步之间留可见停顿 */
  const startRetrain = () => {
    if (run === "running") return;
    setRun("running");
    setStage(0);
    let index = 0;
    const timer = window.setInterval(() => {
      index += 1;
      setStage(index);
      if (index >= RETRAIN_STAGES.length) {
        window.clearInterval(timer);
        setRun("done");
        toast("候选模型已封装，等待下发", "ok");
      }
    }, 900);
  };

  const steps = RETRAIN_STAGES.map((item, index) => ({
    key: item.key,
    label: item.label,
    note: item.detail,
    state:
      run === "idle"
        ? ("等待" as const)
        : index < stage || run === "done"
          ? ("已完成" as const)
          : index === stage
            ? ("进行中" as const)
            : ("等待" as const),
  }));

  return (
    <div className="fw-config">
      <Panel
        title="版本管理"
        extra={
          <span className="muted">
            {changed ? `${pending.length} 项待生效` : "已同步"}
          </span>
        }
        className="fw-panel">
        {GROUPS.map((group) => (
          <section key={group} className="fw-group">
            <h4 className="fw-group__title">{group}</h4>
            <ul className="fw-versions">
              {VERSION_ITEMS.filter((item) => item.group === group).map((item) => {
                const value = draft[item.key] ?? item.current;
                const dirty = value !== item.current;
                return (
                  <li key={item.key} className={dirty ? "is-dirty" : ""}>
                    <div className="fw-versions__head">
                      <span className="fw-versions__label">{item.label}</span>
                      <span className="fw-versions__value">{value}</span>
                      {dirty ? <StatusChip text="未生效" tone="warn" dot /> : null}
                    </div>
                    <p className="fw-versions__target" title={item.note}>{item.target}</p>
                    {item.candidates.length > 1 ? (
                      <div className="fw-versions__pick">
                        {item.candidates.map((candidate) => (
                          <Btn
                            key={candidate}
                            active={candidate === value}
                            onClick={() =>
                              setDraft((prev) => ({ ...prev, [item.key]: candidate }))
                            }>
                            {candidate}
                          </Btn>
                        ))}
                      </div>
                    ) : (
                      <p className="fw-versions__locked">随更新包整体升级，不支持单独切换</p>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}

        <div className="fw-actions">
          <Btn
            tone="primary"
            disabled={!changed}
            onClick={() => {
              setDraft({});
              toast(`已应用 ${pending.length} 项版本配置`, "ok");
            }}>
            应用
          </Btn>
          <Btn disabled={!changed} onClick={() => setDraft({})}>
            放弃改动
          </Btn>
          <span className="muted">改动对后续采集与推理生效</span>
        </div>
      </Panel>

      <Panel
        title="训练任务"
        extra={<SourceTag label="模拟训练" />}
        className="fw-panel">
        <DataTable
          head={["项目", "值"]}
          rows={[
            ["基线版本", EXPERIMENT.baselineVersion],
            ["候选版本", EXPERIMENT.candidateVersion],
            ["数据集版本", EXPERIMENT.datasetVersion],
            ["学习率", String(EXPERIMENT.learningRate)],
            ["停止条件", EXPERIMENT.stopCondition],
            ["判定阈值", String(EXPERIMENT.threshold)],
          ]}
          compact
        />
        <div className="fw-actions">
          <Btn tone="primary" disabled={run === "running"} onClick={startRetrain}>
            {run === "running" ? "训练中…" : run === "done" ? "重新训练" : "开始训练"}
          </Btn>
          <span className="muted">{SCAN_BATCHES.length} 个批次已入候选池</span>
        </div>
        <StepFlow steps={steps} />
      </Panel>

      <Panel title="更新包下发" className="fw-panel">
        {run === "done" ? (
          <>
            <DataTable
              head={["项", "值"]}
              rows={[
                ["更新包", UPDATE_PACKAGE.id],
                ["包类型", UPDATE_PACKAGE.artifactKind],
                ["模型版本", UPDATE_PACKAGE.modelVersion],
                ["目标环境", UPDATE_PACKAGE.targetEnv],
                ["SHA-256", UPDATE_PACKAGE.sha256],
                ["回退版本", UPDATE_PACKAGE.fallbackVersion],
              ]}
              compact
            />
            <div className="fw-actions">
              <Btn
                tone="primary"
                onClick={() => toast("更新包已下发给硬件工程师（饶 · 全栈开发工程师）", "ok")}>
                下发
              </Btn>
              <span className="muted">等待接收方确认</span>
            </div>
          </>
        ) : (
          <StateBlock
            kind="empty"
            title="暂无待下发更新包"
            hint="训练封装完成后在此下发。"
          />
        )}
      </Panel>
    </div>
  );
}

export default function Firmware() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? TABS[0].key;

  const setTab = (key: string) => {
    const next = new URLSearchParams(params);
    next.set("tab", key);
    setParams(next, { replace: true });
  };

  return (
    <div className="page page--adapt">
      <Toolbar
        note={
          <>
            <SourceTag label="演示回放" />
            <span>{VERSION_ITEMS.length} 个可配置项</span>
          </>
        }>
        {TABS.map((item) => (
          <Btn key={item.key} active={tab === item.key} onClick={() => setTab(item.key)}>
            {item.label}
          </Btn>
        ))}
      </Toolbar>

      <div className="adapt-body">
        {tab === "config" ? <ConfigTab /> : null}
        {tab === "dataset" ? <DatasetTab /> : null}
        {tab === "training" ? <TrainingTab /> : null}
        {tab === "delivery" ? <DeliveryTab /> : null}
        {tab === "fusion" ? <FusionTab /> : null}
      </div>
    </div>
  );
}
