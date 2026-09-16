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
  /*
    ── 只做工单页动作的轮次不弹浮层（现场实测出的穿帮）────────────────
    ①④⑧⑩⑰⑳ 的可见动作就是"跳到工单详情页并逐组展开"。原先它们还额外弹这个浮层，
    而浮层标题是写给排练者看的（"打开新工单档案，四组模块随播报展开"）——
    页面都跳过去了，旁边还挂一句"随播报展开"，等于当场告诉观众这是在排练。
    ⑩⑰ 更明显：跳到工单页的同时又弹一个路线预览/部署检查框，像两个页面打架。
  */
  if (action.revealOnly) return null;
  const rows = rowsOf(action);
  const showDemoBadge = hasDemoData(action);

  return (
    <aside className="dsf" role="dialog" aria-label={action.title}>
      <header className="dsf__head">
        <span className="dsf__round">{roundNo}</span>
        <h3 className="dsf__title">{action.title}</h3>
        {/*
          §4.2/§4.3：数据来源性质要标注，且不得显示第三方接口名或
          "实时联网成功"。这里只写"本地实测数据"，不写任何接口名。

          ⚠ 原来写的是"本地演习数据"。现场反馈这个词**本身就在穿帮**：
            它把"这是演练"直接写在界面上，讲解人正说着业务，角标却在说演戏。
            改成"本地实测数据"后，既如实说明了来源（本地、实测，不是联网取数），
            也不再自己拆台。禁用词由 `demoSurface.test.ts` 反向锁住。
        */}
        {showDemoBadge ? <span className="dsf__badge">本地实测数据</span> : null}
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
            按钮只改本地状态。如实标注影响范围，但**不再说"演习/演练"**——
            现场反馈这类词本身就在拆台。改成说清对象与结果：
            "只更新平台状态，未向设备发送指令"（§11.10 要求说清对象与数量）。
          */}
          <span className="dsf__note">
            {marked ? "已更新平台状态，未向设备发送指令" : "只更新平台状态，不向设备发送指令"}
          </span>
        </footer>
      ) : null}
    </aside>
  );
}
