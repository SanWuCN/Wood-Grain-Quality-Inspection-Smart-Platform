/**
 * 面板与指标块
 *
 * 规范 §4.1 / §4.2：
 *   - 背景 rgba(9,19,33,.86)，边框 1px rgba(78,168,255,.12)，普通 Panel 不发光
 *   - 全平台只保留一套斜切：右上 + 左下 8px（由 dashboard.css 的 clip-path 实现）
 *   - 标题统一 "// 标题"：// 用 --glow-cyan，标题 #DDEEFF / 16px / 600，标题栏 40px
 *
 * 这里不再画 SVG 折角边框（旧 demo2 做法）：双线 + 四角折角 + 发光描边
 * 都是规范 §10 要求砍掉的装饰。层级交给字号、字重、留白和背景差。
 */

import { forwardRef, type PropsWithChildren, type ReactNode } from "react";

export interface PanelProps {
  title: string;
  extra?: ReactNode;
  className?: string;
}

export const Panel = forwardRef<HTMLElement, PropsWithChildren<PanelProps>>(function Panel(
  { title, extra, children, className = "" },
  ref,
) {
  return (
    <section className={`tech-panel ${className}`} ref={ref}>
      <div className="tech-panel__inner">
        <header className="tech-panel__head">
          <h2>{title}</h2>
          {extra ? <div className="tech-panel__extra">{extra}</div> : null}
        </header>
        <div className="tech-panel__body">{children}</div>
      </div>
    </section>
  );
});

/**
 * 指标块（KPI）
 *
 * 规范 §4.3：不要「每个指标包一层亮框」，数字本身用字号与字重建立层级。
 * tone 只表达业务语义（正常 / 待处理 / 风险），不做装饰配色。
 */
export function Stat({
  icon,
  label,
  value,
  unit = "个",
  tone = "cyan",
  note,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  unit?: string;
  tone?: "cyan" | "red" | "amber";
  note?: string;
}) {
  return (
    <div className={`stat stat--${tone}`}>
      <div className="stat__icon">{icon}</div>
      <div className="stat__copy">
        <span>{label}</span>
        <strong>
          {value}
          <small>{unit}</small>
        </strong>
        {note ? <em>{note}</em> : null}
      </div>
    </div>
  );
}
