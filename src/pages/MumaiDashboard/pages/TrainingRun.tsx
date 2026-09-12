/**
 * 训练验证（`/firmware?tab=training`）
 *
 * 由 `adaptTabs.tsx` 的 TrainingTab 拆出来单独成文件，因为这一页在
 * 「固件及模型」里承担的是**训练过程本身**，内容量已经不适合再挤在共享页签里。
 *
 * 设计依据：
 *   PRD 3.6   训练页展示基线版本、数据集、更新范围、学习率、停止条件及输入规格。
 *             点击提交生成后台 job，依次呈现排队 / 数据准备 / 适配 / 验证 / 完成。
 *   PRD 11.2  实验包预置 config.json / epochs.csv / predictions_*.csv / 日志；
 *             任务逐步读取这些文件，形成可点击的真实记录；不同页面必须来自
 *             同一实验 ID，禁止各用随机数。**训练状态结束只代表演示产物已装载。**
 *   剧本 S15  小样本适配的关键是控制需要更新的参数数量；训练配置记录数据版本、
 *             学习率、更新范围和停止条件。
 *   剧本 S16  两条曲线分别是训练损失和验证损失；训练误差下降而验证误差持续上升
 *             说明开始过拟合，据此选择候选版本。
 *
 * 三块内容按「真做过训练的人会想看什么」组织，而不是按「页面上该有几个卡片」：
 *   ① 任务提交与训练配置 —— 参数可调、越界拦住、只读项说明为什么不能改；
 *   ② 任务控制台       —— 终端形态的日志，按阶段分行、可回放；
 *   ③ 执行节点占用     —— GPU / 显存 / 温度 / 风扇 / CPU / 内存，跟着日志走。
 *
 * ⚠️ 诚实性约束（PRD 11.2 / 11.4，不能破）：
 *   这里的读数全部来自**归档实验包的一次录制运行**，不是现场训练。
 *   执行节点占用与损失曲线共用同一个 epoch 轴、同一个实验 ID。
 *   界面上不出现「正在训练真实模型」这类表述，来源标识常驻「演示记录」。
 *   PRD 明确把「真实训练服务」列为 P1，首版不得假装已经接上。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Panel } from "../Panel";
import {
  Btn,
  ConfusionMatrix,
  DataTable,
  LineChart,
  SourceTag,
  StatusChip,
  StepFlow,
} from "../ui";
import { useMumai } from "../context";
import { fmtNum, fmtPct, runEvaluation } from "../lib";
import { EXPERIMENT, FAILED_EXPERIMENT, TRAIN_NODE } from "../seed/scenario";
import type { Experiment, JobLogLine, NodeMetric, TrainingConfigField } from "../seed/types";

/** 回放一行日志的间隔。太快看不清，太慢演示时坐不住 */
const LINE_INTERVAL_MS = 260;
/** 装载前的排队停顿：让「提交 → 开始出日志」之间有可感知的等待 */
const QUEUE_DELAY_MS = 520;

/* ------------------------------------------------------------------ *
 * 小件
 * ------------------------------------------------------------------ */

/** 迷你趋势线：把整轮序列画成一条线，标出当前回放位置 */
function Spark({
  series,
  cursor,
  warn,
}: {
  series: number[];
  cursor: number;
  warn: boolean;
}) {
  const path = useMemo(() => {
    const max = Math.max(...series, 0.0001);
    const min = Math.min(...series);
    const span = Math.max(max - min, 0.0001);
    return series
      .map((value, index) => {
        const x = (index / Math.max(series.length - 1, 1)) * 100;
        const y = 22 - ((value - min) / span) * 20;
        return `${index === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(" ");
  }, [series]);

  const cursorX = (Math.min(cursor, series.length - 1) / Math.max(series.length - 1, 1)) * 100;

  return (
    <svg className={`fw-spark${warn ? " is-warn" : ""}`} viewBox="0 0 100 24" preserveAspectRatio="none">
      <path d={path} fill="none" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
      <line x1={cursorX} x2={cursorX} y1="0" y2="24" className="fw-spark__cursor" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** 读数格式化：小数位由种子给，同一列不出现 97 与 15.4 的位数跳变 */
const fmtMetric = (metric: NodeMetric, value: number) =>
  metric.digits === undefined ? String(Math.round(value)) : value.toFixed(metric.digits);

/* ------------------------------------------------------------------ *
 * ① 训练任务与配置
 * ------------------------------------------------------------------ */

/**
 * 训练配置。
 *
 * 可调项带范围，越界立刻标红并拦住提交 —— 「调整模型参数」如果没有约束，
 * 就只是几个可以随便敲的数字框。只读项要写清楚为什么不能改：
 * 可训练参数占比由模型结构决定，数据集版本由冻结状态决定，
 * 这两项不是操作员能随手填的。
 */
function ConfigPanel({
  experiment,
  draft,
  onChange,
  dirty,
  invalid,
  running,
  progress,
  onSubmit,
  onReset,
}: {
  experiment: Experiment;
  draft: Record<string, number>;
  onChange: (key: string, value: number) => void;
  dirty: boolean;
  invalid: string[];
  running: boolean;
  progress: number;
  onSubmit: () => void;
  onReset: () => void;
}) {
  return (
    <Panel
      title="训练任务"
      extra={<SourceTag label="演示记录（归档实验包）" />}
      className="fw-panel">
      <dl className="kv">
        <div>
          <dt>实验</dt>
          <dd>{experiment.title}</dd>
        </div>
        <div>
          <dt>更新范围</dt>
          <dd>{experiment.updateScope}</dd>
        </div>
        <div>
          <dt>输入规格</dt>
          <dd>{experiment.inputSpec}</dd>
        </div>
        <div>
          <dt>停止条件</dt>
          <dd>{experiment.stopCondition}</dd>
        </div>
      </dl>

      <h4 className="sub">训练配置</h4>
      <ul className="fw-params">
        {experiment.config.map((field) => (
          <ParamRow
            key={field.key}
            field={field}
            value={draft[field.key] ?? field.value}
            invalid={invalid.includes(field.key)}
            disabled={running}
            onChange={(value) => onChange(field.key, value)}
          />
        ))}
      </ul>

      <div className="fw-actions">
        <Btn tone="primary" disabled={running || invalid.length > 0} onClick={onSubmit}>
          {running ? `装载中 ${progress}%` : "提交训练任务"}
        </Btn>
        <Btn disabled={!dirty || running} onClick={onReset}>
          恢复实验包配置
        </Btn>
        {invalid.length > 0 ? (
          <span className="fw-params__error">{invalid.length} 项超出范围，无法提交</span>
        ) : dirty ? (
          <span className="muted">配置已改动，提交后随本次 job 一起记录</span>
        ) : (
          <span className="muted">当前为实验包原始配置</span>
        )}
      </div>

      <StepFlow steps={experiment.jobSteps} />
    </Panel>
  );
}

function ParamRow({
  field,
  value,
  invalid,
  disabled,
  onChange,
}: {
  field: TrainingConfigField;
  value: number;
  invalid: boolean;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <li className={`${field.readonly ? "is-readonly" : ""}${invalid ? " is-invalid" : ""}`}>
      <span className="fw-params__label" title={field.note}>
        {field.label}
        {field.readonly ? <i>固定</i> : null}
      </span>
      {field.readonly ? (
        <b className="fw-params__static">
          {field.unit ? `${fmtField(field, value)} ${field.unit}` : fmtField(field, value)}
        </b>
      ) : (
        <span className="fw-params__input">
          <input
            type="number"
            value={value}
            min={field.min}
            max={field.max}
            step={field.step}
            disabled={disabled}
            onChange={(event) => onChange(Number(event.target.value))}
          />
          {field.unit ? <em>{field.unit}</em> : null}
        </span>
      )}
      <small>
        {field.readonly ? field.note : `${rangeText(field)} · ${field.note}`}
      </small>
    </li>
  );
}

/** 只读数值项的显示：学习率这类不该显示成 0.0005 后面跟一串补零 */
function fmtField(field: TrainingConfigField, value: number) {
  if (field.digits !== undefined) return value.toFixed(field.digits);
  if (field.key === "baseline") return EXPERIMENT.baselineVersion;
  if (field.key === "dataset") return EXPERIMENT.datasetVersion;
  return String(value);
}

function rangeText(field: TrainingConfigField) {
  if (field.min === undefined || field.max === undefined) return "";
  const digits = field.digits ?? 0;
  return `范围 ${field.min.toFixed(digits)} – ${field.max.toFixed(digits)}`;
}

/* ------------------------------------------------------------------ *
 * ② 任务控制台
 * ------------------------------------------------------------------ */

function ConsolePanel({
  log,
  visible,
  running,
  experimentId,
  onReplay,
}: {
  log: JobLogLine[];
  visible: number;
  running: boolean;
  experimentId: string;
  onReplay: () => void;
}) {
  const bodyRef = useRef<HTMLOListElement>(null);
  const shown = log.slice(0, visible);

  /** 回放时把视口跟到底部；一次性铺满时不动，避免用户刚进页面就被滚走 */
  useEffect(() => {
    if (!running) return;
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visible, running]);

  const counts = useMemo(() => {
    const warn = shown.filter((line) => line.level === "WARN").length;
    const error = shown.filter((line) => line.level === "ERROR").length;
    return { warn, error };
  }, [shown]);

  return (
    <Panel
      title="任务控制台"
      extra={
        <span className="fw-console__actions">
          {counts.error > 0 ? <StatusChip text={`${counts.error} 条错误`} tone="danger" dot /> : null}
          {counts.warn > 0 ? <StatusChip text={`${counts.warn} 条告警`} tone="warn" dot /> : null}
          <Btn tone="ghost" disabled={running} onClick={onReplay}>
            回放
          </Btn>
        </span>
      }
      className="fw-panel fw-panel--console">
      <div className="fw-console">
        <div className="fw-console__bar">
          <span>task {experimentId}</span>
          <span className="muted">
            {TRAIN_NODE.host} · {shown.length}/{log.length} 行
          </span>
        </div>
        <ol className="fw-console__body" ref={bodyRef}>
          {shown.map((line, index) => (
            <li key={`${line.at}-${index}`} className={`is-${line.level.toLowerCase()}`}>
              <time>{line.at}</time>
              <b>{line.level}</b>
              <span>{line.text}</span>
            </li>
          ))}
          {running ? <li className="fw-console__cursor" aria-hidden="true" /> : null}
        </ol>
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------ *
 * ③ 执行节点占用
 * ------------------------------------------------------------------ */

/**
 * 执行节点占用。
 *
 * 读的是 `TRAIN_NODE` 的档案 + `experiment.node` 的按轮采样序列，
 * `cursor` 是当前回放到的轮次 —— 所以拖日志的时候这些条会跟着动，
 * 而不是六根各跳各的进度条。
 *
 * 每个指标给三段信息：当前值、本轮采样在整轮里的位置（bar）、整轮趋势（spark）。
 * 只有当前值的话看不出「这一轮是刚开始还是在收敛」。
 */
function NodePanel({
  node,
  cursor,
  totalEpochs,
}: {
  node: NodeMetric[];
  cursor: number;
  totalEpochs: number;
}) {
  const peak = useMemo(
    () =>
      node.reduce<Record<string, number>>((acc, metric) => {
        acc[metric.key] = Math.max(...metric.series);
        return acc;
      }, {}),
    [node],
  );

  return (
    <Panel
      title="执行节点"
      extra={<span className="muted">{TRAIN_NODE.host}</span>}
      className="fw-panel">
      <dl className="kv fw-node__spec">
        <div>
          <dt>加速卡</dt>
          <dd>{TRAIN_NODE.accelerator}</dd>
        </div>
        <div>
          <dt>CPU</dt>
          <dd>{TRAIN_NODE.cpu}</dd>
        </div>
        <div>
          <dt>内存</dt>
          <dd>{TRAIN_NODE.ram}</dd>
        </div>
        <div>
          <dt>运行环境</dt>
          <dd>{TRAIN_NODE.runtime}</dd>
        </div>
        <div>
          <dt>驱动</dt>
          <dd>{TRAIN_NODE.driver}</dd>
        </div>
        <div>
          <dt>队列</dt>
          <dd>{TRAIN_NODE.queue}</dd>
        </div>
      </dl>

      <h4 className="sub">
        本轮占用
        <span className="muted">
          epoch {Math.max(1, cursor)}/{totalEpochs}
        </span>
      </h4>
      <ul className="fw-node">
        {node.map((metric) => {
          const index = Math.min(Math.max(cursor - 1, 0), metric.series.length - 1);
          const value = metric.series[index];
          const ratio = Math.min(100, Math.max(0, (value / metric.scale) * 100));
          const warn = metric.warnAbove !== undefined && value >= metric.warnAbove;
          return (
            <li key={metric.key} className={warn ? "is-warn" : ""}>
              <span className="fw-node__label">{metric.label}</span>
              <b>
                {fmtMetric(metric, value)}
                <em>{metric.unit}</em>
              </b>
              <span className="fw-node__bar">
                <i style={{ width: `${ratio}%` }} />
              </span>
              <Spark series={metric.series} cursor={index} warn={warn} />
              <small title="整轮峰值">
                峰值 {fmtMetric(metric, peak[metric.key])}
              </small>
            </li>
          );
        })}
      </ul>
      <p className="note">按轮采样记录，与损失曲线同来自归档实验包 {TRAIN_NODE.host}。</p>
    </Panel>
  );
}

/* ------------------------------------------------------------------ *
 * ④ 损失曲线（训练 / 验证 / 基线）
 * ------------------------------------------------------------------ */

/**
 * 从验证损失序列里找出发散点。
 *
 * 剧本 S16 让架构师口播「训练误差下降、验证误差却持续上升，说明开始过拟合」——
 * 这句话要能从曲线上直接读出来，所以这里把最低点之后是否持续抬升算出来，
 * 而不是把结论写死在页面上：换成成功案例时这个提示自然就不出现。
 */
function detectOverfit(val: number[]): { minEpoch: number; rise: number } | null {
  let minIndex = 0;
  val.forEach((value, index) => {
    if (value < val[minIndex]) minIndex = index;
  });
  const rise = val[val.length - 1] - val[minIndex];
  // 抬升不足 0.02 视为正常波动，不报发散
  if (minIndex >= val.length - 2 || rise < 0.02) return null;
  return { minEpoch: minIndex + 1, rise };
}

function LossPanel({ experiment }: { experiment: Experiment }) {
  const overfit = useMemo(
    () => detectOverfit(experiment.curveVal.points.map((point) => point.y)),
    [experiment],
  );

  return (
    <Panel
      title="损失曲线"
      extra={
        overfit ? (
          <StatusChip text={`验证损失自第 ${overfit.minEpoch} 轮起抬升`} tone="danger" dot />
        ) : (
          <StatusChip text="训练 / 验证同向收敛" tone="ok" dot />
        )
      }
      className="fw-panel">
      <LineChart
        series={[
          {
            id: experiment.curveTrain.id,
            label: experiment.curveTrain.label,
            color: experiment.curveTrain.color,
            points: experiment.curveTrain.points,
          },
          {
            id: experiment.curveVal.id,
            label: experiment.curveVal.label,
            color: experiment.curveVal.color,
            points: experiment.curveVal.points,
          },
          {
            id: experiment.curveOld.id,
            label: experiment.curveOld.label,
            color: experiment.curveOld.color,
            points: experiment.curveOld.points,
          },
        ]}
        xLabel="轮次"
        yLabel="损失"
      />
      <p className="note">
        {overfit
          ? `验证损失自第 ${overfit.minEpoch} 轮起回升 ${overfit.rise.toFixed(3)}，训练损失仍在下降；该候选版本按验证表现评估，不按训练表现。`
          : "训练损失与验证损失同向收敛，未出现分叉。"}
      </p>
    </Panel>
  );
}

/* ------------------------------------------------------------------ *
 * ⑤ 独立测试集对比（沿用原有实现）
 * ------------------------------------------------------------------ */

function ComparisonPanel({ experiment }: { experiment: Experiment }) {
  /** PRD 3.6 / 12：比较程序读归档预测表真算精确率 / 召回率 / F1，页面不再自己数 TP/FP */
  const evaluation = useMemo(() => runEvaluation(experiment), [experiment]);
  const fnDelta = evaluation.overall.next.fn - evaluation.overall.old.fn;
  const fpDelta = evaluation.overall.next.fp - evaluation.overall.old.fp;
  const regression = evaluation.acceptance.find((item) => item.key === "regression");

  return (
    <Panel
      title="独立测试集对比"
      extra={
        <StatusChip
          text={`同一测试集 ${evaluation.testSetIds.length} 条`}
          tone={evaluation.testSetConsistent ? "ok" : "danger"}
        />
      }
      className="fw-panel fw-panel--wide">
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
          逐样本{" "}
          <b>
            {evaluation.summary.improved} 改善 / {evaluation.summary.regressed} 退化 /{" "}
            {evaluation.summary.same} 不变
          </b>
        </span>
      </div>

      <h4 className="sub">按材种回归</h4>
      <DataTable
        compact
        head={["材种", "测试样本", "旧版召回", "新版召回", "召回变化", "新版精确率", "新版 F1"]}
        rows={evaluation.perMaterial.map((item) => {
          const size = item.next.tp + item.next.fp + item.next.tn + item.next.fn;
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
  );
}

/* ------------------------------------------------------------------ *
 * 页签
 * ------------------------------------------------------------------ */

export function TrainingTab() {
  const { toast } = useMumai();
  const [useFailed, setUseFailed] = useState(false);
  const experiment = useFailed ? FAILED_EXPERIMENT : EXPERIMENT;

  /** 配置草稿：只存改动过的项，没改的跟着实验包走 */
  const [draft, setDraft] = useState<Record<string, number>>({});
  /** 已装载的日志行数。归档包默认整段铺满，不做「先隐藏再播放」 */
  const [visible, setVisible] = useState(experiment.log.length);
  const [running, setRunning] = useState(false);
  const timer = useRef<number | null>(null);

  const stopTimer = () => {
    if (timer.current !== null) {
      window.clearInterval(timer.current);
      timer.current = null;
    }
  };
  useEffect(() => stopTimer, []);

  /** 切换案例时整页回到「已装载」状态：日志铺满、无回放、配置恢复 */
  useEffect(() => {
    stopTimer();
    setVisible(experiment.log.length);
    setRunning(false);
    setDraft({});
  }, [experiment]);

  const dirty = useMemo(
    () => experiment.config.some((field) => draft[field.key] !== undefined && draft[field.key] !== field.value),
    [draft, experiment],
  );

  const invalid = useMemo(
    () =>
      experiment.config
        .filter((field) => !field.readonly)
        .filter((field) => {
          const value = draft[field.key];
          if (value === undefined) return false;
          if (Number.isNaN(value)) return true;
          if (field.min !== undefined && value < field.min) return true;
          if (field.max !== undefined && value > field.max) return true;
          return false;
        })
        .map((field) => field.key),
    [draft, experiment],
  );

  const progress = Math.round((visible / Math.max(experiment.log.length, 1)) * 100);

  /** 当前回放到的轮次：取已显示日志里最后一个带 epoch 的行 */
  const cursor = useMemo(() => {
    let epoch = 0;
    for (const line of experiment.log.slice(0, visible)) {
      if (line.epoch !== undefined) epoch = line.epoch;
    }
    return epoch;
  }, [experiment, visible]);

  const totalEpochs = experiment.config.find((field) => field.key === "epochs")?.value ?? 40;

  const replay = () => {
    stopTimer();
    setVisible(0);
    setRunning(true);
    let index = 0;
    window.setTimeout(() => {
      timer.current = window.setInterval(() => {
        index += 1;
        setVisible(index);
        if (index >= experiment.log.length) {
          stopTimer();
          setRunning(false);
        }
      }, LINE_INTERVAL_MS);
    }, QUEUE_DELAY_MS);
  };

  const submit = () => {
    if (invalid.length > 0) return;
    replay();
    const changed = experiment.config.filter(
      (field) => draft[field.key] !== undefined && draft[field.key] !== field.value,
    ).length;
    toast(
      changed > 0
        ? `任务已提交，${changed} 项配置改动随本次 job 记录`
        : "任务已提交，使用实验包原始配置",
      "ok",
    );
  };

  return (
    <div className="fw-training">
      <ConfigPanel
        experiment={experiment}
        draft={draft}
        onChange={(key, value) => setDraft((prev) => ({ ...prev, [key]: value }))}
        dirty={dirty}
        invalid={invalid}
        running={running}
        progress={progress}
        onSubmit={submit}
        onReset={() => setDraft({})}
      />

      <NodePanel node={experiment.node} cursor={cursor} totalEpochs={totalEpochs} />

      <ConsolePanel
        log={experiment.log}
        visible={visible}
        running={running}
        experimentId={experiment.id}
        onReplay={replay}
      />

      <LossPanel experiment={experiment} />

      <ComparisonPanel experiment={experiment} />

      <label className="twin-compare fw-training__switch">
        <input
          type="checkbox"
          checked={useFailed}
          disabled={running}
          onChange={(event) => setUseFailed(event.target.checked)}
        />
        切换到失败案例
      </label>
    </div>
  );
}

export default TrainingTab;
