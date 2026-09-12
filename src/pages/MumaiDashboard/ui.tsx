/**
 * 木脉智检 · 页面通用小组件
 *
 * 只放「跨页面复用」的小件：空状态 / 加载 / 错误 / 断线、指标块、步骤流程、
 * 键值行、状态标签、波形与折线。
 *
 * 视觉一律走设计系统（规范 §4 / §5）：
 *   - 颜色只从 design.ts（= src/styles/tokens.css）取，组件里不写死色值
 *   - 图表默认系列只用蓝 + 青，绿 / 黄 / 红只在语义需要时出现
 *   - 状态标签是「彩色圆点 + 文本 + 细边框」，不做整块高饱和 Badge
 */

import type { ReactNode } from "react";
import { CHART, COLORS } from "./design";
import { permissionHint, type Permission } from "./auth";
import { useMumai } from "./context";
import { fmtNum } from "./lib";
import type { Metrics, Tone } from "./lib";

/* ------------------------------------------------------------------ *
 * 状态占位：加载 / 空数据 / 错误 / 断线 / 部分完成 / 成功
 * PRD 15：所有页有加载、空数据、错误、断线、部分完成和成功状态
 * ------------------------------------------------------------------ */

export type StateKind = "loading" | "empty" | "error" | "offline" | "partial" | "success";

/**
 * 默认空态 / 加载 / 错误文案。
 *
 * 只陈述「现在是什么状态」，不解释系统内部怎么运作（§5 文案判据）。
 * 各调用方通常会覆盖 title/hint 给出具体对象，这里只是兜底。
 */
const STATE_COPY: Record<StateKind, { title: string; hint: string; tone: Tone }> = {
  loading: { title: "正在加载", hint: "正在读取本地数据。", tone: "info" },
  empty: { title: "暂无数据", hint: "该对象暂无记录。", tone: "muted" },
  error: { title: "读取失败", hint: "数据校验未通过，请重试或切换数据来源。", tone: "danger" },
  offline: { title: "通道已断开", hint: "该通道已断开，其余通道正常。", tone: "danger" },
  partial: { title: "部分完成", hint: "整批校验未通过，暂不进入后续分析。", tone: "warn" },
  success: { title: "已完成", hint: "结果已保存并可追溯。", tone: "ok" },
};

export function StateBlock({
  kind,
  title,
  hint,
  action,
}: {
  kind: StateKind;
  title?: string;
  hint?: string;
  action?: ReactNode;
}) {
  const copy = STATE_COPY[kind];
  return (
    <div className={`state-block state-block--${copy.tone}`}>
      <span className="state-block__dot" />
      <strong>{title ?? copy.title}</strong>
      <em>{hint ?? copy.hint}</em>
      {kind === "loading" ? <div className="state-block__bar"><i /></div> : null}
      {action ? <div className="state-block__action">{action}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 状态标签（规范 §4.6）：彩色圆点 + 文本 + 细边框，颜色只表达业务状态
 * ------------------------------------------------------------------ */

export function StatusChip({
  text,
  tone = "info",
  dot = true,
}: {
  text: string;
  tone?: Tone;
  dot?: boolean;
}) {
  return (
    <span className={`chip chip--${tone}`}>
      {dot ? <i /> : null}
      {text}
    </span>
  );
}

export function SourceTag({ label = "演示回放" }: { label?: string }) {
  return (
    <span className="source-tag" title="数据来源">
      <i />
      {label}
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * 指标块
 * ------------------------------------------------------------------ */

export function Metric({
  label,
  value,
  unit,
  note,
  tone = "info",
  /** 未检测时显示「未采集」而不是 0 */
  collected = true,
}: {
  label: string;
  value: string;
  unit?: string;
  note?: string;
  tone?: Tone;
  collected?: boolean;
}) {
  return (
    <div className={`metric metric--${collected ? tone : "muted"}`}>
      <small>{label}</small>
      <strong>
        {collected ? value : "未采集"}
        {collected && unit ? <em>{unit}</em> : null}
      </strong>
      {note ? <span>{note}</span> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 键值行
 * ------------------------------------------------------------------ */

export function KV({ items, columns = 2 }: { items: { k: string; v: ReactNode }[]; columns?: number }) {
  return (
    <dl className="kv" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
      {items.map((item) => (
        <div key={item.k}>
          <dt>{item.k}</dt>
          <dd>{item.v}</dd>
        </div>
      ))}
    </dl>
  );
}

/* ------------------------------------------------------------------ *
 * 工具栏
 * ------------------------------------------------------------------ */

export function Toolbar({ children, note }: { children: ReactNode; note?: ReactNode }) {
  return (
    <div className="toolbar">
      <div className="toolbar__actions">{children}</div>
      {note ? <div className="toolbar__note">{note}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 按钮
 * ------------------------------------------------------------------ */

export function Btn({
  children,
  onClick,
  tone = "default",
  disabled,
  active,
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  tone?: "default" | "primary" | "ghost" | "danger";
  disabled?: boolean;
  active?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      className={`btn btn--${tone} ${active ? "is-active" : ""}`}
      onClick={onClick}
      disabled={disabled}
      title={title}>
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------ *
 * 权限说明（PRD 2.1）：按钮置灰后，在同一行用中性小字说明原因，
 * 不让用户只看到「点不动」，也不写感叹号。
 * ------------------------------------------------------------------ */

/**
 * 列出当前角色缺少的权限说明；全部具备时返回 null。
 *
 * 例如 `<PermNote permissions={["env:validate", "env:ack"]} />`：
 * 项目经理只会看到「当前角色无「环境配置接收并返回 ack」权限」。
 */
export function PermNote({ permissions }: { permissions: Permission[] }) {
  const { can } = useMumai();
  const denied = permissions.filter((permission) => !can(permission));
  if (denied.length === 0) return null;
  return <small className="muted">{denied.map((item) => permissionHint(item)).join("；")}</small>;
}

/* ------------------------------------------------------------------ *
 * 步骤流程（PRD 3.6：排队 → 数据准备 → 适配 → 验证 → 完成）
 * ------------------------------------------------------------------ */

export function StepFlow({
  steps,
  compact,
}: {
  steps: { key: string; label: string; state: "等待" | "进行中" | "已完成" | "失败"; at?: string | null; note?: string }[];
  compact?: boolean;
}) {
  return (
    <ol className={`step-flow ${compact ? "is-compact" : ""}`}>
      {steps.map((step) => {
        const tone: Tone =
          step.state === "已完成" ? "ok" : step.state === "进行中" ? "info" : step.state === "失败" ? "danger" : "muted";
        return (
          <li key={step.key} className={`step step--${tone}`}>
            <i />
            <div>
              <b>{step.label}</b>
              <em>{step.state}{step.at ? ` · ${step.at}` : ""}</em>
              {step.note ? <span>{step.note}</span> : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/* ------------------------------------------------------------------ *
 * 时间线
 * ------------------------------------------------------------------ */

export function Timeline({
  items,
  limit,
}: {
  items: { at: string; text: string; tone?: Tone; actor?: string }[];
  limit?: number;
}) {
  const list = limit ? items.slice(0, limit) : items;
  return (
    <ol className="timeline2">
      {list.map((item, index) => (
        <li key={`${item.at}-${index}`} className={`timeline2__item timeline2__item--${item.tone ?? "muted"}`}>
          <span className="timeline2__dot" />
          <time>{item.at}</time>
          <p>
            {item.actor ? <b>{item.actor}</b> : null}
            {item.text}
          </p>
        </li>
      ))}
    </ol>
  );
}

/* ------------------------------------------------------------------ *
 * 数据表
 * ------------------------------------------------------------------ */

export function DataTable({
  head,
  rows,
  empty = "暂无记录",
  compact,
}: {
  head: string[];
  rows: ReactNode[][];
  empty?: string;
  compact?: boolean;
}) {
  if (rows.length === 0) return <StateBlock kind="empty" title={empty} hint="完成对应步骤后记录会出现在这里。" />;
  return (
    <div className={`dtable ${compact ? "is-compact" : ""}`}>
      <table>
        <thead>
          <tr>{head.map((cell) => <th key={cell}>{cell}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 折线（自绘 SVG，避免为每页引入 ECharts 实例）
 * ------------------------------------------------------------------ */

export function LineChart({
  series,
  height = 150,
  yLabel,
  xLabel,
  showAxis = true,
  threshold,
}: {
  series: { id: string; label: string; color: string; points: { x: number; y: number }[] }[];
  height?: number;
  yLabel?: string;
  xLabel?: string;
  showAxis?: boolean;
  threshold?: number;
}) {
  const width = 420;
  const pad = { left: 34, right: 10, top: 12, bottom: 22 };
  const allPoints = series.flatMap((item) => item.points);
  if (allPoints.length === 0) return <StateBlock kind="empty" title="暂无曲线数据" hint="该任务还没有产生损失曲线或预测表。" />;
  const maxX = Math.max(...allPoints.map((point) => point.x));
  const minX = Math.min(...allPoints.map((point) => point.x));
  const maxY = Math.max(...allPoints.map((point) => point.y));
  const minY = Math.min(...allPoints.map((point) => point.y));
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  const sx = (x: number) => pad.left + ((x - minX) / spanX) * (width - pad.left - pad.right);
  const sy = (y: number) => pad.top + (1 - (y - minY) / spanY) * (height - pad.top - pad.bottom);
  return (
    <div className="linechart">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={series.map((item) => item.label).join("、")}>
        {showAxis
          ? [0, 1, 2, 3].map((line) => (
              <line
                key={line}
                x1={pad.left}
                x2={width - pad.right}
                y1={pad.top + (line * (height - pad.top - pad.bottom)) / 3}
                y2={pad.top + (line * (height - pad.top - pad.bottom)) / 3}
                stroke={CHART.grid}
                strokeDasharray="3 4"
              />
            ))
          : null}
        {threshold !== undefined && threshold >= minY && threshold <= maxY ? (
          <line x1={pad.left} x2={width - pad.right} y1={sy(threshold)} y2={sy(threshold)} stroke={COLORS.warn} strokeDasharray="5 4" strokeWidth="1" />
        ) : null}
        {series.map((item) => (
          <polyline
            key={item.id}
            fill="none"
            stroke={item.color}
            strokeWidth="2"
            points={item.points.map((point) => `${sx(point.x).toFixed(1)},${sy(point.y).toFixed(1)}`).join(" ")}
          />
        ))}
        {yLabel ? <text x={6} y={pad.top + 8} className="axis">{yLabel}</text> : null}
        {xLabel ? <text x={width - pad.right} y={height - 6} className="axis" textAnchor="end">{xLabel}</text> : null}
        {showAxis ? (
          <>
            <text x={pad.left} y={height - 6} className="axis">{minX}</text>
            <text x={width - pad.right} y={height - 6} className="axis" textAnchor="end">{maxX}</text>
          </>
        ) : null}
      </svg>
      <div className="linechart__legend">
        {series.map((item) => (
          <span key={item.id}>
            <i style={{ background: item.color }} />
            {item.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 波形（频谱按数据绘制；横轴为频点索引，不写作深度）
 * ------------------------------------------------------------------ */

export function WaveChart({
  points,
  height = 132,
  unit,
  axisLabel,
  markers = [],
  highlight,
}: {
  points: { x: number; y: number }[];
  height?: number;
  unit?: string;
  axisLabel?: string;
  markers?: { x: number; label: string; tone: "red" | "amber" | "cyan" }[];
  highlight?: [number, number] | null;
}) {
  const width = 460;
  if (points.length === 0) return <StateBlock kind="empty" title="暂无波形数据" hint="采集完成并落盘后可按批次绘制。" />;
  const pad = { left: 8, right: 8, top: 10, bottom: 16 };
  const sx = (x: number) => pad.left + x * (width - pad.left - pad.right);
  const sy = (y: number) => pad.top + (1 - y) * (height - pad.top - pad.bottom);
  const path = points.map((point, index) => `${index === 0 ? "M" : "L"}${sx(point.x).toFixed(1)} ${sy(point.y).toFixed(1)}`).join(" ");
  const area = `${path} L${sx(points[points.length - 1].x).toFixed(1)} ${height - pad.bottom} L${sx(points[0].x).toFixed(1)} ${height - pad.bottom} Z`;
  const toneColor: Record<string, string> = { red: COLORS.danger, amber: COLORS.warn, cyan: COLORS.glow };
  return (
    <div className="wavechart">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="雷达回波频谱">
        <defs>
          <linearGradient id="waveFill" x1="0" y1="0" x2="0" y2="1">
            {/* 默认数据主系列 = BLUE（§5.1），青色只留给扫描 / 科技强调 */}
            <stop offset="0" stopColor={COLORS.primary} stopOpacity="0.28" />
            <stop offset="1" stopColor={COLORS.primary} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill="url(#waveFill)" />
        <path d={path} fill="none" stroke={COLORS.primary} strokeWidth="1.6" />
        {highlight ? (
          <rect
            x={sx(highlight[0])}
            y={pad.top}
            width={Math.max(2, sx(highlight[1]) - sx(highlight[0]))}
            height={height - pad.top - pad.bottom}
            fill={CHART.dangerFill}
            stroke={CHART.dangerStroke}
          />
        ) : null}
        {markers.map((marker) => (
          <g key={marker.label}>
            <line x1={sx(marker.x)} x2={sx(marker.x)} y1={pad.top} y2={height - pad.bottom} stroke={toneColor[marker.tone]} strokeDasharray="3 3" />
            <text x={sx(marker.x) + 3} y={pad.top + 10} className="axis" fill={toneColor[marker.tone]}>{marker.label}</text>
          </g>
        ))}
        <line x1={pad.left} x2={width - pad.right} y1={height - pad.bottom} y2={height - pad.bottom} stroke={CHART.axisLine} />
        {axisLabel ? <text x={pad.left} y={height - 3} className="axis">{axisLabel}</text> : null}
        {unit ? <text x={width - pad.right} y={pad.top + 8} className="axis" textAnchor="end">{unit}</text> : null}
      </svg>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 混淆矩阵（PRD 3.6：比较程序从归档预测表算统计值；
 * 分母为零时返回「不适用」，不显示 NaN 或 0）
 * ------------------------------------------------------------------ */

export function ConfusionMatrix({ title, metrics }: { title: string; metrics: Metrics }) {
  const cells = [
    { key: "TP", label: "真阳性 TP", value: metrics.tp, tone: "ok" as Tone },
    { key: "FP", label: "假阳性 FP（误报）", value: metrics.fp, tone: "warn" as Tone },
    { key: "FN", label: "假阴性 FN（漏检）", value: metrics.fn, tone: "danger" as Tone },
    { key: "TN", label: "真阴性 TN", value: metrics.tn, tone: "info" as Tone },
  ];
  const ratios = [
    { key: "precision", label: "精确率", value: fmtNum(metrics.precision) },
    { key: "recall", label: "召回率", value: fmtNum(metrics.recall) },
    { key: "f1", label: "F1", value: fmtNum(metrics.f1) },
  ];
  return (
    <div className="matrix">
      <h4>{title}</h4>
      <div className="matrix__grid">
        {cells.map((cell) => (
          <div key={cell.key} className={`matrix__cell matrix__cell--${cell.tone}`}>
            <strong>{cell.value}</strong>
            <small>{cell.label}</small>
          </div>
        ))}
      </div>
      <div className="delta-row">
        {ratios.map((item) => (
          <span key={item.key}>
            {item.label} <b>{item.value}</b>
          </span>
        ))}
      </div>
      {metrics.naReason ? <p className="note">{metrics.naReason}</p> : null}
    </div>
  );
}
