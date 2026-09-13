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
import { Icon, type IconName } from "./icons";

export interface PanelProps {
  title: string;
  /**
   * 标题左侧的业务图标（UI 素材 v2.0，PRD §5「清洗、分组、适配、校验使用业务图标」）。
   *
   * 为什么做成 Panel 的属性而不是让页面自己塞：
   * 面板标题是「这个面板在做什么」的唯一入口，图标要和 "// 标题" 的基线一起排版
   * （PRD §5「统一大小、标签基线」），散在各页面里会出现四种间距。
   * 业务卡尺寸按 PRD §4 取 24px。
   *
   * 图标旁总有同义中文标题，因此对辅助技术隐藏。
   */
  icon?: IconName;
  extra?: ReactNode;
  className?: string;
}

export const Panel = forwardRef<HTMLElement, PropsWithChildren<PanelProps>>(function Panel(
  { title, icon, extra, children, className = "" },
  ref,
) {
  return (
    <section className={`tech-panel ${className}`} ref={ref}>
      <div className="tech-panel__inner">
        <header className="tech-panel__head">
          <h2>
            {icon ? <Icon name={icon} size={24} tone="secondary" aria-hidden /> : null}
            {title}
          </h2>
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
