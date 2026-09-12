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
  Modal,
  SourceTag,
  StateBlock,
  StatusChip,
  StepFlow,
  Toolbar,
  WaveChart,
} from "../ui";
import { useMumai } from "../context";
import { fmtNum, fmtPct, runEvaluation } from "../lib";
import {
  DATA_PACKAGES,
  EXPERIMENT,
  FAILED_EXPERIMENT,
  IMPORTABLE_PACKAGES,
  TRAIN_NODE,
  WAVEFORMS,
} from "../seed/scenario";
import type {
  DataPackage,
  DataPackageCheck,
  DataPackageKind,
  Experiment,
  NodeMetric,
  TrainingConfigField,
} from "../seed/types";
import { buildDistillScript, buildTrainScript } from "./terminalScripts";

/** 毫秒 → 控制台时钟 mm:ss。脚本本身不打时间戳，用控制台自己的运行时钟补 */
function clockFromMs(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

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
      extra={<SourceTag label="归档实验包" />}
      className="fw-panel fw-panel--task">
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

/** 控制台一行的显示模型（两个脚本任务与归档包任务共用） */
type ConsoleLine = {
  /** 时间戳 mm:ss。脚本本身不打时间戳，用控制台自己的运行时钟补 */
  at: string;
  level: "CMD" | "INFO" | "WARN" | "ERROR" | "OK";
  text: string;
};

/** 播放计划里的一步 */
type PlaybackStep = {
  line: Omit<ConsoleLine, "at">;
  /** 这一步停留多久。归档包任务没有给节奏，用统一的逐行间隔 */
  dwellMs: number;
  /** true = 覆盖当前最后一行（脚本里 `\r` 原地刷新的进度条帧） */
  replace: boolean;
  /** 归档包任务的日志自带时间戳；两个脚本任务没有，用运行时钟 */
  at?: string;
};

/** 控制台可跑的三个任务 */
type JobKey = "archive" | "train" | "distill";

function ConsolePanel({
  job,
  jobs,
  onPickJob,
  lines,
  running,
  open,
  onToggle,
  progress,
  meta,
  onRun,
}: {
  job: JobKey;
  jobs: {
    key: JobKey;
    label: string;
    command: string;
    runId: string;
    meta: string;
    note: string;
  }[];
  onPickJob: (key: JobKey) => void;
  lines: ConsoleLine[];
  running: boolean;
  /** 日志是否展开（v1.1 §4.2：日志折叠）。折叠时只留表头与运行按钮 */
  open: boolean;
  onToggle: () => void;
  /** 0–100，播放进度 */
  progress: number;
  /** 右上角的两段元信息：任务号 / 节点与行数 */
  meta: { task: string; tail: string };
  onRun: () => void;
}) {
  const bodyRef = useRef<HTMLOListElement>(null);

  /** 运行时把视口跟到底部；静态铺满时不动，避免用户刚进页面就被滚走 */
  useEffect(() => {
    if (!running) return;
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length, running]);

  const counts = useMemo(() => {
    const warn = lines.filter((line) => line.level === "WARN").length;
    const error = lines.filter((line) => line.level === "ERROR").length;
    return { warn, error };
  }, [lines]);

  return (
    <Panel
      title="任务控制台"
      extra={
        <span className="fw-console__actions">
          {counts.error > 0 ? <StatusChip text={`${counts.error} 条错误`} tone="danger" dot /> : null}
          {counts.warn > 0 ? <StatusChip text={`${counts.warn} 条告警`} tone="warn" dot /> : null}
          {/* 日志折叠（v1.1 §4.2）：折叠时只收起日志体，运行按钮始终在 */}
          <Btn tone="ghost" onClick={onToggle} title={open ? "收起日志" : `展开日志（${lines.length} 行）`}>
            {open ? "收起日志" : `日志 ${lines.length} 行`}
          </Btn>
          <Btn tone="ghost" disabled={running} onClick={onRun}>
            {running ? `运行中 ${progress}%` : "运行"}
          </Btn>
        </span>
      }
      className="fw-panel fw-panel--console">
      {/*
        作业列表。三个作业本来就在同一台训练节点上，分成三个页面反而看不出关系。
        每张卡是**作业档案**的读法：作业号 / 提交人 / 提交时间 / 脚本 / 配置摘要 ——
        真实平台就是这么列训练任务的。
      */}
      <div className="fw-jobs">
        {jobs.map((item) => (
          <button
            key={item.key}
            type="button"
            className={job === item.key ? "is-active" : ""}
            disabled={running}
            onClick={() => onPickJob(item.key)}>
            <b>{item.label}</b>
            <span className="fw-jobs__run">
              {item.runId} · {item.meta}
            </span>
            <em>{item.command}</em>
            <i>{item.note}</i>
          </button>
        ))}
      </div>

      {open ? (
        <div className="fw-console">
          <div className="fw-console__bar">
            <span>task {meta.task}</span>
            <span className="muted">{meta.tail}</span>
          </div>
          <ol className="fw-console__body" ref={bodyRef}>
            {lines.map((line, index) => (
              <li key={`${line.at}-${index}`} className={`is-${line.level.toLowerCase()}`}>
                <time>{line.at}</time>
                <b>{line.level}</b>
                <span>{line.text}</span>
              </li>
            ))}
            {running ? <li className="fw-console__cursor" aria-hidden="true" /> : null}
          </ol>
          {/* 进度条钉在底部：脚本任务的节奏由 dwellMs 决定，看不出还剩多久会以为卡住了 */}
          {running ? (
            <div className="fw-console__progress">
              <i style={{ width: `${progress}%` }} />
            </div>
          ) : null}
        </div>
      ) : (
        <p className="fw-console__folded">
          日志已折叠（{lines.length} 行，{counts.error} 错误 / {counts.warn} 告警）。
          运行或点「日志 {lines.length} 行」展开 —— 首屏留给曲线与结论。
        </p>
      )}
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
      className="fw-panel fw-panel--node">
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

/**
 * 损失曲线。
 *
 * `drawn` 是当前画到第几轮：任务回放时跟着日志一起往前画，回放结束后画满整轮。
 * 曲线是这一页唯一的「过程」视图 —— 一条静态铺满的曲线看不出训练走到哪了，
 * 而「画到第 24 轮就早停了」本身就是结论的一部分。
 */
function LossPanel({ experiment, drawn, dominant = false }: { experiment: Experiment; drawn: number; /** 当前主视图：横跨整行 */ dominant?: boolean }) {
  const overfit = useMemo(
    () => detectOverfit(experiment.curveVal.points.map((point) => point.y)),
    [experiment],
  );

  const total = experiment.curveTrain.points.length;
  /**
   * 候选模型的两条曲线跟着回放长；**基线整条铺满**。
   *
   * 基线是上一版模型跑完的历史记录，本来就该是完整的 —— 留着它整条，
   * 候选曲线往上长的时候才有对照物（「现在降到基线下面了没有」）。
   * 三条一起截断反而看不出谁比谁好。
   */
  const growing = (points: { x: number; y: number }[]) =>
    points.slice(0, Math.max(1, Math.min(drawn, points.length)));

  return (
    <Panel
      title="损失曲线"
      extra={
        <span className="fw-console__actions">
          <span className="muted">
            epoch {Math.min(drawn, total)}/{total}
          </span>
          {overfit ? (
            <StatusChip text={`验证损失自第 ${overfit.minEpoch} 轮起抬升`} tone="danger" dot />
          ) : (
            <StatusChip text="训练 / 验证同向收敛" tone="ok" dot />
          )}
        </span>
      }
      className={`fw-panel ${dominant ? "fw-panel--wide" : "fw-panel--loss"}`}>
      <LineChart
        series={[
          {
            id: experiment.curveTrain.id,
            label: experiment.curveTrain.label,
            color: experiment.curveTrain.color,
            points: growing(experiment.curveTrain.points),
          },
          {
            id: experiment.curveVal.id,
            label: experiment.curveVal.label,
            color: experiment.curveVal.color,
            points: growing(experiment.curveVal.points),
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
        // 横轴按整轮（30）固定，纵轴按训练曲线的起点固定：
        // 回放时曲线从左往右长，而不是 3 个点铺满整幅假装跑完了
        xMax={total}
        yMax={experiment.curveTrain.points[0]?.y}
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
 * ⑤ 采集数据（训练要用到的数据源）
 * ------------------------------------------------------------------ */

/** 数据包类型 → 语义色。原始数据与成果数据要一眼分得开 */
const PKG_TONE: Record<DataPackageKind, "ok" | "info" | "muted" | "warn"> = {
  原始雷达数据: "ok",
  表面图像: "info",
  结果文件: "muted",
  混合包: "warn",
};

const PKG_STATE_TONE: Record<DataPackage["state"], "ok" | "warn" | "danger"> = {
  已入库: "ok",
  待审核: "warn",
  已驳回: "danger",
};

/** 只有原始级别能复算 —— 成果数据不能用来比较算法变化（剧本 S13） */
const RAW_LEVELS = ["ADC", "IQ", "spectrum", "features"];

/** 文件名里匹配到的小写级别 → 种子里的规范写法 */
const RAW_LEVEL_CANON: Record<string, string> = {
  adc: "ADC",
  iq: "IQ",
  spectrum: "spectrum",
  features: "features",
  result: "result_only",
};

const PKG_FILTERS: (DataPackageKind | "全部")[] = [
  "全部",
  "原始雷达数据",
  "表面图像",
  "结果文件",
  "混合包",
];

/**
 * 采集数据。
 *
 * 点开一行看这个包的校验结果，原始级别为 spectrum 的还能看到波形 ——
 * 「有数据」和「这批数据能拿来干什么」是两件事，校验项和波形就是后者。
 */
function DataPanel({
  packages,
  onImport,
}: {
  packages: DataPackage[];
  onImport: () => void;
}) {
  const [filter, setFilter] = useState<DataPackageKind | "全部">("全部");
  const [rawOnly, setRawOnly] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const rows = useMemo(
    () =>
      packages
        .filter((item) => (filter === "全部" ? true : item.kind === filter))
        .filter((item) => (rawOnly ? RAW_LEVELS.includes(item.rawLevel) : true)),
    [packages, filter, rawOnly],
  );

  const rawCount = packages.filter((item) => RAW_LEVELS.includes(item.rawLevel)).length;
  const pending = packages.filter((item) => item.state === "待审核").length;

  return (
    <Panel
      title="采集数据"
      extra={
        <span className="fw-console__actions">
          <SourceTag label="模拟采集" />
          {pending > 0 ? <StatusChip text={`${pending} 个待审核`} tone="warn" dot /> : null}
          <Btn tone="ghost" onClick={onImport}>
            导入数据包
          </Btn>
        </span>
      }
      className="fw-panel fw-panel--data">
      <Toolbar
        note={
          <span className="muted">
            原始级别 {rawCount}/{packages.length} · 可复算
          </span>
        }>
        {PKG_FILTERS.map((item) => (
          <Btn key={item} active={filter === item} onClick={() => setFilter(item)}>
            {item}
          </Btn>
        ))}
        <Btn active={rawOnly} onClick={() => setRawOnly((value) => !value)}>
          仅原始级别
        </Btn>
      </Toolbar>

      {rows.length > 0 ? (
        <ul className="pkg-list2">
          {rows.map((item) => {
            const expanded = openId === item.id;
            const waveform = WAVEFORMS.find((wave) => wave.batchId === item.batchId);
            const failed = item.checks.filter((check) => !check.pass);
            return (
              <li key={item.id} className={expanded ? "is-open" : ""}>
                <button type="button" onClick={() => setOpenId(expanded ? null : item.id)}>
                  <span className="pkg-list2__name">
                    <b>{item.name}</b>
                    <i>
                      {item.source}
                      {item.componentId ? ` · ${item.componentId}` : ""}
                    </i>
                  </span>
                  <StatusChip text={item.kind} tone={PKG_TONE[item.kind]} />
                  <span className="pkg-list2__level">{item.rawLevel}</span>
                  <span className="pkg-list2__num">
                    {item.frames === null ? "—" : item.frames}
                  </span>
                  <span className="pkg-list2__num">{item.sizeText}</span>
                  <span className="pkg-list2__date">{item.capturedAt.slice(5)}</span>
                  <StatusChip text={item.state} tone={PKG_STATE_TONE[item.state]} dot />
                </button>

                {expanded ? (
                  <div className="pkg-list2__detail">
                    <ul className="pkg-checks">
                      {item.checks.map((check) => (
                        <li key={check.key} className={check.pass ? "is-ok" : "is-bad"}>
                          <b>{check.label}</b>
                          <span>{check.detail}</span>
                        </li>
                      ))}
                    </ul>
                    {item.batchId ? (
                      <p className="note">
                        关联批次 {item.batchId}
                        {failed.length > 0
                          ? ` · ${failed.length} 项未通过，未通过项不进入监督训练`
                          : " · 校验通过"}
                      </p>
                    ) : (
                      <p className="note">未关联采集批次（外部导入）</p>
                    )}
                    {waveform ? (
                      <WaveChart
                        points={waveform.points}
                        unit={waveform.unit}
                        axisLabel={waveform.axisLabel}
                        markers={waveform.markers}
                      />
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <StateBlock kind="empty" title="该筛选条件下没有数据包" hint="换一个类型或关闭「仅原始级别」。" />
      )}
    </Panel>
  );
}

/* ------------------------------------------------------------------ *
 * ⑥ 导入数据包
 * ------------------------------------------------------------------ */

/** 允许的扩展名。列表外的格式一律在导入前拦下，不进待审核区 */
const ALLOWED_EXT = [".zip", ".tar", ".gz", ".csv", ".json"];

/**
 * 导入校验。
 *
 * 对**本地文件**跑的是真的检查：扩展名、大小、文件名里能不能解析出批次号与
 * 原始级别 —— 这三项都能从 File 对象本身算出来，不是编的。
 * 演示素材包走同一套函数，只是输入换成它的名称与大小。
 */
function validateImport(name: string, bytes: number): DataPackageCheck[] {
  const lower = name.toLowerCase();
  const ext = ALLOWED_EXT.find((item) => lower.endsWith(item));
  const batch = /(scan|ref)-[a-z0-9-]+/i.exec(name)?.[0] ?? null;
  const level = ["adc", "iq", "spectrum", "features", "result"].find((item) =>
    lower.includes(item),
  );

  return [
    {
      key: "ext",
      label: "文件格式",
      pass: Boolean(ext),
      detail: ext ? `识别为 ${ext}` : `不在允许列表（${ALLOWED_EXT.join(" / ")}）`,
    },
    {
      key: "size",
      label: "文件大小",
      pass: bytes > 0,
      detail: bytes > 0 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : "空文件，无法解析",
    },
    {
      key: "batch",
      label: "批次号可解析",
      pass: Boolean(batch),
      detail: batch ? `识别为 ${batch}` : "文件名里没有批次号，将按外部导入归档",
    },
    {
      key: "level",
      label: "原始级别可判定",
      pass: Boolean(level),
      detail: level
        ? `识别为 ${level}`
        : "无法判定，按 opaque 归档，不可用于复算算法变化",
    },
  ];
}

function ImportModal({
  onClose,
  onImport,
}: {
  onClose: () => void;
  onImport: (pkg: DataPackage) => void;
}) {
  const { toast } = useMumai();
  /** 已选中的候选：本地文件与预置素材包共用一份状态，二选一 */
  const [file, setFile] = useState<{ name: string; bytes: number } | null>(null);
  const [presetId, setPresetId] = useState<string | null>(null);

  const preset = IMPORTABLE_PACKAGES.find((item) => item.id === presetId) ?? null;

  const candidate = file
    ? { name: file.name, bytes: file.bytes }
    : preset
      ? { name: preset.name, bytes: Number.parseFloat(preset.sizeText) * 1024 * 1024 }
      : null;

  // 校验很轻（几次字符串判断），不值得 useMemo —— 而且 candidate 是每次渲染
  // 新建的对象，拿它当依赖会让 memo 每次都失效
  const checks = candidate ? validateImport(candidate.name, candidate.bytes) : [];

  const blocking = checks.filter((check) => !check.pass && (check.key === "ext" || check.key === "size"));

  const submit = () => {
    if (!candidate) return;
    const levelCheck = checks.find((check) => check.key === "level");
    // 规范化成种子里的大写口径：文件名是小写的，直接透传会得到 "adc"，
    // 和 DATA_PACKAGES 里的 "ADC" 混在一列里看着像两种东西
    const levelRaw = levelCheck?.pass ? levelCheck.detail.replace("识别为 ", "") : "";
    const rawLevel = (RAW_LEVEL_CANON[levelRaw] ?? "opaque") as DataPackage["rawLevel"];
    const kind: DataPackageKind = candidate.name.includes("image")
      ? "表面图像"
      : candidate.name.includes("result")
        ? "结果文件"
        : rawLevel === "opaque"
          ? "混合包"
          : "原始雷达数据";

    onImport({
      id: `pkg-import-${Date.now()}`,
      name: candidate.name,
      kind,
      rawLevel,
      source: file ? "本地导入" : "预置素材包",
      batchId: /(scan|ref)-[a-z0-9-]+/i.exec(candidate.name)?.[0] ?? null,
      componentId: /Z\d{2}/.exec(candidate.name)?.[0] ?? null,
      frames: null,
      sizeText: `${(candidate.bytes / 1024 / 1024).toFixed(1)} MB`,
      capturedAt: "2026-09-11 41:00",
      state: "待审核",
      checks,
    });
    toast(`${candidate.name} 已进入待审核区`, "ok");
    onClose();
  };

  return (
    <Modal
      wide
      title="导入数据包"
      subtitle={
        <>
          <span>格式校验 → 待审核 → 入库</span>
        </>
      }
      onClose={onClose}
      footer={
        <>
          <span className="muted">
            {blocking.length > 0 ? "存在阻断项，无法导入" : "导入后进入待审核区，不直接进入训练"}
          </span>
          <Btn onClick={onClose}>取消</Btn>
          <Btn tone="primary" disabled={!candidate || blocking.length > 0} onClick={submit}>
            导入
          </Btn>
        </>
      }>
      <h4 className="sub">选择本地文件</h4>
      <label className="pkg-drop">
        <input
          type="file"
          accept={ALLOWED_EXT.join(",")}
          onChange={(event) => {
            const picked = event.target.files?.[0];
            if (!picked) return;
            setFile({ name: picked.name, bytes: picked.size });
            setPresetId(null);
          }}
        />
        <span>
          <b>{file ? file.name : "点击选择数据包"}</b>
          <em>
            {file
              ? `${(file.bytes / 1024 / 1024).toFixed(1)} MB`
              : `支持 ${ALLOWED_EXT.join(" / ")}`}
          </em>
        </span>
      </label>

      <h4 className="sub">或从预置素材包导入</h4>
      <ul className="pkg-presets">
        {IMPORTABLE_PACKAGES.map((item) => (
          <li key={item.id} className={presetId === item.id ? "is-active" : ""}>
            <button
              type="button"
              onClick={() => {
                setPresetId(item.id);
                setFile(null);
              }}>
              <b>{item.name}</b>
              <span>
                {item.kind} · {item.rawLevel} · {item.sizeText}
              </span>
              <i>{item.detail}</i>
            </button>
          </li>
        ))}
      </ul>

      {candidate ? (
        <>
          <h4 className="sub">导入校验</h4>
          <ul className="pkg-checks">
            {checks.map((check) => (
              <li key={check.key} className={check.pass ? "is-ok" : "is-bad"}>
                <b>{check.label}</b>
                <span>{check.detail}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * ⑤ 独立测试集对比（沿用原有实现）
 * ------------------------------------------------------------------ */

function ComparisonPanel({ experiment, dominant = false }: { experiment: Experiment; /** 当前主视图：横跨整行 */ dominant?: boolean }) {
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
      className={`fw-panel ${dominant ? "fw-panel--wide" : "fw-panel--data"}`}>
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

  /**
   * 主视图：运行时看曲线，跑完看新旧对比。
   *
   * v1.1 §4.2 对这一页的要求是「运行时曲线为主，结束后对比为主；日志折叠」，
   * PRD §4.2 说法一致。原来曲线与对比各占一块、谁也不是主角，日志还占着一整块。
   * 现在两种视图各自让一个面板横跨整行成为主角，日志默认折叠。
   */
  const [view, setView] = useState<"curve" | "compare">("curve");
  /** 日志是否展开：运行中自动展开，跑完收回去 */
  const [logOpen, setLogOpen] = useState(false);

  /** 配置草稿：只存改动过的项，没改的跟着实验包走 */
  const [draft, setDraft] = useState<Record<string, number>>({});
  /** 已装载的日志行数。归档包默认整段铺满，不做「先隐藏再播放」 */
  const [visible, setVisible] = useState(experiment.log.length);
  const [running, setRunning] = useState(false);
  /**
   * 数据包清单。导入的包就地插到最前面并标为「待审核」——
   * 导入是个真的会改变页面状态的动作用户才看得出来。演示种子里的包
   * 也在同一份 state 里，所以筛选 / 展开 / 导入走的是同一条路径。
   */
  const [packages, setPackages] = useState<DataPackage[]>(DATA_PACKAGES);
  const [importOpen, setImportOpen] = useState(false);
  /** 控制台当前跑哪个任务。默认归档实验包（本轮适配的记录） */
  const [job, setJob] = useState<JobKey>("archive");
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

  /**
   * 曲线画到第几轮。
   *
   * 与执行节点占用、控制台日志共用同一个 epoch 轴：回放时跟着往前画，
   * 回放结束（或还没开始时）画满整轮。取 `Math.max(reached, 1)` 是因为
   * 第一行日志的 epoch 是 0，画 0 个点会让曲线整个消失。
   */
  const drawnEpochs = useMemo(() => Math.max(cursor, 1), [cursor]);

  const totalEpochs = experiment.curveTrain.points.length;

  const replay = () => {
    stopTimer();
    setVisible(0);
    setRunning(true);
    // 开跑就切回曲线视图并展开日志：这时候要看的是训练过程本身
    setView("curve");
    setLogOpen(true);
    let index = 0;
    window.setTimeout(() => {
      timer.current = window.setInterval(() => {
        index += 1;
        setVisible(index);
        if (index >= experiment.log.length) {
          stopTimer();
          setRunning(false);
          /*
           * 跑完自动切到新旧对比、把日志收起来。
           * 评审 §3.6 要的是「完成后自动切到新旧模型对比」——
           * 这一步不能靠用户自己想起去点页签。
           */
          setView("compare");
          setLogOpen(false);
        }
      }, LINE_INTERVAL_MS);
    }, QUEUE_DELAY_MS);
  };

  /* ---- 三个任务在同一个控制台里跑 ---------------------------------- */

  /** 两个终端脚本的步骤流。构建是纯函数，只算一次（里面会消费随机数序列） */
  const scripts = useMemo(
    () => ({ train: buildTrainScript(), distill: buildDistillScript() }),
    [],
  );

  const jobs = useMemo(
    () => [
      {
        key: "archive" as JobKey,
        label: "小样本适配",
        command: "compress_finetune.py",
        runId: experiment.id,
        meta: "史 · 09-11 34:20",
        note: experiment.datasetVersion,
      },
      {
        key: "train" as JobKey,
        label: scripts.train.label,
        command: scripts.train.command,
        runId: scripts.train.runId,
        meta: `${scripts.train.owner.split(" · ")[0]} · ${scripts.train.submittedAt.slice(5)}`,
        note: scripts.train.summary,
      },
      {
        key: "distill" as JobKey,
        label: scripts.distill.label,
        command: scripts.distill.command,
        runId: scripts.distill.runId,
        meta: `${scripts.distill.owner.split(" · ")[0]} · ${scripts.distill.submittedAt.slice(5)}`,
        note: scripts.distill.summary,
      },
    ],
    [experiment, scripts],
  );

  /**
   * 把任一任务统一成同一份「播放计划」。
   *
   * 归档实验包的日志是逐行静态输出（没有原地刷新的帧）；
   * 两个脚本有进度条帧（`replace: true`）与各自的节奏（`dwellMs`）。
   * 统一成计划之后，下面的播放器只有一套逻辑。
   */
  const plan: PlaybackStep[] = useMemo(() => {
    if (job === "train" || job === "distill") {
      const script = job === "train" ? scripts.train : scripts.distill;
      return script.steps.map((step) => ({
        line: { text: step.text, level: step.level },
        dwellMs: step.dwellMs,
        replace: Boolean(step.replace),
      }));
    }
    return experiment.log.map((line) => ({
      line: { text: line.text, level: line.level },
      dwellMs: LINE_INTERVAL_MS,
      replace: false,
      at: line.at,
    }));
  }, [job, scripts, experiment]);

  const totalMs = useMemo(() => plan.reduce((sum, step) => sum + step.dwellMs, 0), [plan]);

  /** 播放到第几步。`replace` 的帧不推进行列表，只换掉最后一行 */
  const [step, setStep] = useState(plan.length);
  const [lines, setLines] = useState<ConsoleLine[]>([]);

  /** 按计划重建到第 n 步的控制台内容（纯计算，便于重播与跳转） */
  const renderUpTo = (count: number): ConsoleLine[] => {
    const out: ConsoleLine[] = [];
    let elapsed = 0;
    for (let i = 0; i < count && i < plan.length; i += 1) {
      const item = plan[i];
      elapsed += item.dwellMs;
      const at = item.at ?? clockFromMs(elapsed);
      if (item.replace && out.length > 0) out[out.length - 1] = { at, ...item.line };
      else out.push({ at, ...item.line });
    }
    return out;
  };

  /** 切换任务：直接把该任务的输出铺满（与归档包任务一致，不做「先空后播」） */
  useEffect(() => {
    stopTimer();
    setRunning(false);
    setStep(plan.length);
    setLines(renderUpTo(plan.length));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan]);

  const runConsole = () => {
    if (running) return;
    stopTimer();
    setLines([]);
    setStep(0);
    setRunning(true);
    let index = 0;
    let acc = 0;
    const advance = () => {
      if (index >= plan.length) {
        stopTimer();
        setRunning(false);
        return;
      }
      const item = plan[index];
      acc += item.dwellMs;
      setLines((prev) => {
        const next = [...prev];
        const line: ConsoleLine = { at: item.at ?? clockFromMs(acc), ...item.line };
        if (item.replace && next.length > 0) next[next.length - 1] = line;
        else next.push(line);
        return next;
      });
      index += 1;
      setStep(index);
      // 脚本的快帧可能只有几毫秒，设一个下限免得 setInterval 空转
      timer.current = window.setTimeout(advance, Math.max(8, item.dwellMs));
    };
    timer.current = window.setTimeout(advance, QUEUE_DELAY_MS);
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
    /*
      12 栅格布局，按「配置 → 过程 → 结果」分三层：
        第一层 训练配置(4) | 任务控制台(5) | 执行节点(3)
        第二层 损失曲线(5) | 采集数据(7)
        第三层 独立测试集对比(12)
      上一层是操作与过程，中间是数据源，最后一层是结论 —— 结论最宽，
      因为它要放混淆矩阵、按材种回归、逐样本预测三张表。
    */
    <div className="fw-training">
      <div className="fw-training__mode">
        <span className="fw-training__mode-label">主视图</span>
        <Btn
          active={view === "curve"}
          disabled={running && view !== "curve"}
          onClick={() => setView("curve")}
          title="训练过程的损失曲线">
          训练曲线
        </Btn>
        <Btn
          active={view === "compare"}
          disabled={running}
          onClick={() => setView("compare")}
          title={running ? "训练进行中，跑完自动切到对比" : "同一测试集下的新旧模型对比"}>
          新旧对比
        </Btn>
        <span className="fw-training__mode-note">
          {running
            ? "训练进行中：曲线为主，日志已展开"
            : view === "compare"
              ? `测试集 ${experiment.datasetVersion} · 与基线同一口径`
              : "训练未运行：可先看上一轮的对比结果"}
        </span>
      </div>

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

      <ConsolePanel
        job={job}
        jobs={jobs}
        onPickJob={setJob}
        lines={lines}
        running={running}
        open={logOpen}
        onToggle={() => setLogOpen((value) => !value)}
        progress={totalMs > 0 ? Math.round((plan.slice(0, step).reduce((a, b) => a + b.dwellMs, 0) / totalMs) * 100) : 100}
        meta={{
          task: `${jobs.find((item) => item.key === job)?.runId ?? ""} · ${
            jobs.find((item) => item.key === job)?.command ?? ""
          }`,
          tail: `${TRAIN_NODE.host} · ${lines.length} 行`,
        }}
        onRun={runConsole}
      />

      <NodePanel node={experiment.node} cursor={drawnEpochs} totalEpochs={totalEpochs} />

      {/* 主视图：曲线或对比，谁在当前视图里谁横跨整行 */}
      {view === "curve" ? (
        <LossPanel experiment={experiment} drawn={drawnEpochs} dominant />
      ) : (
        <ComparisonPanel experiment={experiment} dominant />
      )}

      <DataPanel packages={packages} onImport={() => setImportOpen(true)} />

      <label className="twin-compare fw-training__switch">
        <input
          type="checkbox"
          checked={useFailed}
          disabled={running}
          onChange={(event) => setUseFailed(event.target.checked)}
        />
        切换到失败案例
      </label>

      {importOpen ? (
        <ImportModal
          onClose={() => setImportOpen(false)}
          onImport={(pkg) => setPackages((current) => [pkg, ...current])}
        />
      ) : null}
    </div>
  );
}

export default TrainingTab;
