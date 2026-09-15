/**
 * 演示表面（工作清单 v1.0 §10 阶段 D）
 *
 * 把 §10-D 点名的 10 个表面（天气四分类、素材质检、异常帧、接收清单、清洗漏斗、
 * 模型对照、部署演习、三路融合、复盘、交付差异）**用一份数据驱动**渲染 ——
 * 表面之间的差异只在"展示哪些数据键"，渲染逻辑与样式是同一套。
 *
 * ── 三条约束（都由测试或结构保证）────────────────────────────────────
 *   1. **数字只从数据包来**：组件按 `action.dataKeys` 取值渲染
 *      （`scenarioValue`），自己不接受任何数值 props —— 于是 §11.5
 *      「同一指标在三个文件里手写三个数值」在结构上不可能发生；
 *   2. **标签必须齐**：每个键在 `FIELD_LABELS` 里都要有中文标签。
 *      缺标签时**显式显示"标签缺失"**而不是把 `weather.rain.totalMm` 抛给观众 ——
 *      那是当场出戏的东西；
 *   3. **按钮只改本地演习状态**：按钮点击只翻转组件内的本地状态并显示
 *      「已在本地演练中标记」，不调用任何接口、不改动真实设备。
 *
 * ── 为什么做成浮层而不是独立页面 ────────────────────────────────────
 * 演示时讲解人正盯着主页面，跳走会打断叙事；浮层可以边讲边看、
 * 关掉即回到原处（也符合 §4.7「重新进入/刷新后必须得到相同结果」——
 * 浮层状态不持久化，刷新就干净）。
 */
import { useEffect, useState } from "react";

import { actionFor } from "./demoActions";
import { hasDemoData, rowsOf } from "./demoSurfaceRows";
import "./demoSurface.css";

export type DemoSurfaceProps = {
  roundNo: string;
  /** 关闭浮层 */
  onClose: () => void;
};

/**
 * 渲染某一轮的演示表面。取不到该轮动作时**不渲染**（返回 null），
 * 而不是渲染一个空壳 —— 空壳会让"这轮没动作"看起来像"页面坏了"。
 */
export function DemoSurface({ roundNo, onClose }: DemoSurfaceProps) {
  const action = actionFor(roundNo);
  /** 本地演习状态：按钮点过没有（不持久化，刷新即清） */
  const [marked, setMarked] = useState(false);

  /* 换轮次时重置本地标记，避免上一轮的"已标记"串到这一轮 */
  useEffect(() => setMarked(false), [roundNo]);

  /* Esc 关闭：与红头委托预览保持同一套交互习惯 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!action) return null;
  const rows = rowsOf(action);
  const showDemoBadge = hasDemoData(action);

  return (
    <aside className="dsf" role="dialog" aria-label={action.title}>
      <header className="dsf__head">
        <span className="dsf__round">{roundNo}</span>
        <h3 className="dsf__title">{action.title}</h3>
        {/*
          §4.2/§4.3：本地演习数据必须标注来源性质，且不得显示第三方接口名或
          "实时联网成功"。这里只写"本地演习数据"，不写任何接口名。
        */}
        {showDemoBadge ? <span className="dsf__badge">本地演习数据</span> : null}
        <button type="button" className="dsf__close" onClick={onClose} aria-label="关闭">
          ×
        </button>
      </header>

      <dl className="dsf__rows">
        {rows.map((row) => (
          <div key={row.key} className={`dsf__row${row.missing ? " is-missing" : ""}`}>
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>

      {action.button ? (
        <footer className="dsf__foot">
          <button type="button" className="dsf__btn" onClick={() => setMarked(true)} disabled={marked}>
            {action.button}
          </button>
          {/*
            按钮只改本地状态。标注清楚"没有对真实设备做任何事" ——
            §11.10 要求面向观众的状态说清对象与数量，不能含糊。
          */}
          <span className="dsf__note">
            {marked ? "已在本地演练中标记（未对真实设备执行任何操作）" : "仅改变本地演习状态"}
          </span>
        </footer>
      ) : null}
    </aside>
  );
}
