/**
 * 数据与知识中心 · 局部 UI 原子
 *
 * 只放**这个页面自己**的零件：面板、抽屉、状态标签、指标卡、覆盖条、空状态。
 * 平台通用的按钮 / 模态 / 键值行仍然用 `../ui`，不在这里重复一份。
 *
 * 依据：PRD §5.2（布局规格）、§6.1（视觉与文案规范）。
 * 有意的取舍：面板不做切角、不发光、不加装饰图标 —— 规范 §10 要求砍掉的
 * 正是「到处蓝框 + 彩色 Badge + 折角发光」那一类噪声。
 */

import { useEffect, type ReactNode } from "react";
import type { Tone } from "../selectors";

/* ------------------------------------------------------------------ *
 * 面板
 * ------------------------------------------------------------------ */

export function KbPanel({
  title,
  note,
  actions,
  children,
  className = "",
  scroll = true,
}: {
  title: string;
  note?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  /** 面板主体是否自己滚动。卡片内嵌列表要独立滚动，PRD §5.2 */
  scroll?: boolean;
}) {
  return (
    <section className={`kb-panel ${className}`}>
      <header className="kb-panel-head">
        <h2>
          <span className="kb-prefix" aria-hidden>
            //
          </span>
          {title}
        </h2>
        <div className="kb-panel-note">
          {note}
          {actions}
        </div>
      </header>
      <div className={scroll ? "kb-panel-body" : "kb-panel-body kb-panel-body--static"}>{children}</div>
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * 状态标签（彩色圆点 + 文本 + 细边框；状态同时有文字，不只靠颜色）
 * ------------------------------------------------------------------ */

export function KbState({ text, tone = "muted", title }: { text: string; tone?: Tone; title?: string }) {
  return (
    <span className={`kb-state kb-state--${tone}`} title={title}>
      <i aria-hidden />
      {text}
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * 指标卡（六项统一指标）
 * ------------------------------------------------------------------ */

export function KbMetric({
  label,
  value,
  unit,
  hint,
  tone = "default",
  onClick,
}: {
  label: string;
  value: string;
  unit?: string;
  hint?: string;
  tone?: "default" | "accent" | "warn" | "danger";
  onClick?: () => void;
}) {
  const interactive = Boolean(onClick);
  const content = (
    <>
      <span className="kb-metric-label">{label}</span>
      <span className={`kb-metric-value kb-metric-value--${tone}`}>
        {value}
        {unit ? <em className="kb-metric-unit">{unit}</em> : null}
      </span>
      {hint ? <span className="kb-metric-hint">{hint}</span> : null}
    </>
  );
  if (!interactive) return <div className="kb-metric">{content}</div>;
  return (
    <button type="button" className="kb-metric kb-metric--link" onClick={onClick}>
      {content}
    </button>
  );
}

/* ------------------------------------------------------------------ *
 * 抽屉（详情 / 导入 / 数据说明 / 任务详情共用一套）
 * ------------------------------------------------------------------ */

export function KbDrawer({
  open,
  title,
  subtitle,
  onClose,
  footer,
  children,
  wide = false,
}: {
  open: boolean;
  title: string;
  subtitle?: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
  wide?: boolean;
}) {
  // Escape 关抽屉：与平台其它弹层一致，也让键盘用户不必去找关闭按钮
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="kb-scrim" role="presentation" onClick={onClose}>
      <aside
        className={`kb-drawer ${wide ? "kb-drawer--wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="kb-drawer-head">
          <div>
            <h2>{title}</h2>
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
          <button type="button" className="kb-drawer-close" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </header>
        <div className="kb-drawer-body">{children}</div>
        {footer ? <footer className="kb-drawer-foot">{footer}</footer> : null}
      </aside>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 空状态（最多两行：一句说状态，一句说下一步）
 * ------------------------------------------------------------------ */

export function KbEmpty({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="kb-empty">
      <strong>{title}</strong>
      {hint ? <em>{hint}</em> : null}
      {action ? <div className="kb-empty-action">{action}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 覆盖堆叠条（已覆盖 / 待更新 / 异常 / 未纳入）
 * ------------------------------------------------------------------ */

export function KbCoverageBar({
  pct,
  label,
  onSelect,
}: {
  pct: { covered: number; pending: number; error: number; excluded: number; processing: number };
  label: string;
  onSelect?: (segment: "covered" | "pending" | "error" | "excluded") => void;
}) {
  const segments: { key: keyof typeof pct; className: string; title: string; selectable: boolean }[] = [
    { key: "covered", className: "is-covered", title: "已覆盖", selectable: true },
    { key: "processing", className: "is-processing", title: "处理中", selectable: false },
    { key: "pending", className: "is-pending", title: "待更新", selectable: true },
    { key: "error", className: "is-error", title: "更新失败", selectable: true },
    { key: "excluded", className: "is-excluded", title: "未纳入", selectable: true },
  ];
  const pick = (key: keyof typeof pct) => {
    if (key === "processing") return;
    onSelect?.(key);
  };
  return (
    <div className="kb-progress" aria-label={`${label} 覆盖分布`}>
      {segments.map((segment) =>
        pct[segment.key] > 0 ? (
          <span
            key={segment.key}
            className={segment.className}
            style={{ ["--n" as string]: `${pct[segment.key]}%` }}
            title={`${segment.title} ${pct[segment.key].toFixed(1)}%`}
            onClick={segment.selectable ? () => pick(segment.key) : undefined}
            role={segment.selectable ? "button" : undefined}
            tabIndex={segment.selectable ? 0 : undefined}
            onKeyDown={(event) => {
              if (!segment.selectable) return;
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                pick(segment.key);
              }
            }}
          />
        ) : null,
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 折叠区（算法参数、检索详情默认收起；PRD §5.5 / §6.2）
 * ------------------------------------------------------------------ */

export function KbCollapse({
  summary,
  children,
  defaultOpen = false,
}: {
  summary: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details className="kb-collapse" open={defaultOpen}>
      <summary>
        {summary}
        <span className="kb-collapse-caret" aria-hidden>
          ▾
        </span>
      </summary>
      <div className="kb-collapse-body">{children}</div>
    </details>
  );
}

/* ------------------------------------------------------------------ *
 * 键值行（用排版建立层级，不额外加框）
 * ------------------------------------------------------------------ */

export function KbKV({ items, columns = 2 }: { items: { k: string; v: ReactNode }[]; columns?: number }) {
  return (
    <dl className="kb-kv" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
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
 * 行内提示
 * ------------------------------------------------------------------ */

export function KbToastLine({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <p className={`kb-toast kb-toast--${tone}`}>{children}</p>;
}
