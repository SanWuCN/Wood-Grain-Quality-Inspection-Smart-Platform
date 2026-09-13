/**
 * 唤醒浮层：右下角提示 + 流式字幕 + 中央对话框
 *
 * ── 为什么需要它（都是实际用起来才会发现的问题）────────────────────
 *
 * 1. **不知道它在不在听**。唤醒是"没有按钮的交互"，用户看不见任何状态，
 *    于是要么不敢喊，要么反复喊。右下角那块常驻提示就是为了回答
 *    "现在到底有没有在听"。
 *
 * 2. **唤醒之后到出字之间有一秒多的空档**。这段静默会被理解成"没反应"，
 *    用户会重复喊，反而把命令说乱。所以要把识别到的字**边说边显示**。
 *
 * 3. **说完之后不知道有没有被收到**。停一秒左右弹出中央对话框，
 *    把识别结果明确摆出来 —— 这是"我听到了，内容是这句"的回执。
 *
 * ── 为什么浮层不放在 React 组件树里 ──────────────────────────────
 *
 * 唤醒必须在**任何页面、控制台关着**的时候都能用；而应用里的 React 树
 * 会随路由变化挂载/卸载。所以挂载点由 wakeChannel 自己建（和 api.tsx
 * 挂 independent root 是同一个套路），浮层与页面结构解耦。
 */
import { useEffect, useState } from "react";
import NumberAnimation from "@/components/numberAnimation";
import { wakeChannel } from "./wakeChannel";
import type { WakeSnapshot } from "./wakeChannel";
import "./wakeOverlay.css";

/** 中央对话框自动收起的时间：够看清，又不挡着后面的操作 */
const DIALOG_AUTO_CLOSE_MS = 4000;

export default function WakeOverlay() {
  const [snap, setSnap] = useState<WakeSnapshot>(() => wakeChannel().snapshot());
  const [dialog, setDialog] = useState<{ text: string; raw: string } | null>(null);

  useEffect(() => wakeChannel().subscribe(setSnap), []);

  /**
   * 命令识别完成 → 弹中央对话框。
   *
   * 依赖 commandCount 而不是 lastCommand 对象：同一句话再喊一次时对象内容相同，
   * 用内容做依赖就不会再弹 —— 而用户的预期是"每次说完都要有回执"。
   */
  useEffect(() => {
    if (!snap.lastCommand || snap.commandCount === 0) return;
    setDialog({ text: snap.lastCommand.text, raw: snap.lastCommand.raw });
    const timer = window.setTimeout(() => setDialog(null), DIALOG_AUTO_CLOSE_MS);
    return () => window.clearTimeout(timer);
  }, [snap.commandCount, snap.lastCommand]);

  const listening = snap.state === "live";
  const busy = snap.state === "starting" || snap.state === "reconnecting";

  return (
    <>
      {/* 右下角：常驻状态。听的时候一直在，用户随时能确认"它在听" */}
      {(listening || busy) && (
        <div className={`wko${listening ? " is-live" : ""}`} role="status" aria-live="polite">
          <div className="wko__row">
            <span className="wko__dot" aria-hidden="true" />
            <b>{listening ? "小木在听" : snap.state === "starting" ? "正在开启麦克风…" : "连接中断，正在重连…"}</b>
          </div>
          <p className="wko__hint">
            {listening ? "说两遍「小木小木」，停一下，再说要做什么" : snap.note}
          </p>
          {/* 流式字幕：唤醒之后正在说的那句话，边说边出字 */}
          {listening && snap.partial ? (
            <p className="wko__partial">
              <span className="wko__partial-label">听到</span>
              {snap.partial}
              <i className="wko__caret" aria-hidden="true" />
            </p>
          ) : null}
          {listening && snap.wakeCount > 0 ? (
            <p className="wko__count">
              已唤醒 <NumberAnimation value={snap.wakeCount} /> 次
              {/*
                尾段原来是模板字符串（` · 上次判定滞后 ${ms}ms`），改成 JSX 才能把毫秒数
                交给 NumberAnimation。「 · 」与前面的「 次」都写在同一行结尾/开头，
                JSX 会保留这两个空格，渲染出来仍是「已唤醒 N 次 · 上次判定滞后 Xms」。
              */}
              {snap.lastWake ? (
                /* group=false：滞后毫秒是测量值，原来就没有千分位，保持逐字一致 */
                <> · 上次判定滞后 <NumberAnimation value={Math.round(snap.lastWake.decisionMs)} group={false} />ms</>
              ) : null}
            </p>
          ) : null}
        </div>
      )}

      {/* 中央对话框：说完之后的回执 */}
      {dialog ? (
        <div className="wkd" role="dialog" aria-modal="false" aria-label="小木听到的指令">
          <div className="wkd__card">
            <header>
              <span className="wkd__dot" aria-hidden="true" />
              <b>小木听到了</b>
              <button type="button" onClick={() => setDialog(null)} aria-label="关闭">
                ×
              </button>
            </header>
            <p className="wkd__text">{dialog.text || "（没听清要做什么）"}</p>
            {/*
              原始转写放在下面小字里：用户说对了而识别错了、和用户自己说错了，
              是两类完全不同的问题，看不到原始转写就没法区分。
            */}
            {dialog.raw && dialog.raw !== dialog.text ? (
              <p className="wkd__raw">原始转写：{dialog.raw}</p>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}
