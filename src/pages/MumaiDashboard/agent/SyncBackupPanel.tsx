/**
 * 同步备份小窗（数据与时长见 `syncBackup.ts`）
 *
 * ── 位置为什么在右上角 ──────────────────────────────────────────
 * 左下角被「演示表面」占着（`demoSurface.css`）、右下角是小木气泡，
 * 右上角空着且不压主内容区 —— 三个浮层同时在屏幕上时互不遮挡。
 *
 * ── 「过一会儿自动消失」怎么实现 ────────────────────────────────
 * 时长由条数推出（`buildSyncBackupStream().autoCloseMs`），到点自动收起；
 * 同时保留关闭按钮与 Esc —— 讲解人要提前收掉时不用等。
 *
 * ── 科技感靠什么（不是靠假数据）──────────────────────────────────
 *   · 逐条**错峰浮现**（CSS 动画延迟 = 序号 × 每拍时长），像数据一条条落盘；
 *   · 左侧一条竖向"数据流"轨迹 + 流动光点；
 *   · 头部有实时计数（`已同步 n/N`），这个数字是真的在涨。
 * 没有假进度条、没有假速度、没有"联网/云端"字样（穿帮点，见 syncBackup.ts 的说明）。
 */
import { useEffect, useRef, useState } from "react";

import { SYNC_PER_ENTRY_MS, SYNC_SOURCE_NOTE, type SyncBackupStream } from "./syncBackup";
import "./syncBackup.css";

export type SyncBackupPanelProps = {
  stream: SyncBackupStream;
  onClose: () => void;
  /**
   * 每条的错峰间隔。默认取 `SYNC_PER_ENTRY_MS` —— 与自动收起时长**同一个来源**，
   * 保证"最后一条浮现完"一定早于"窗关掉"（两者用不同的数字就会翻车）。
   */
  perEntryMs?: number;
};

export function SyncBackupPanel({ stream, onClose, perEntryMs = SYNC_PER_ENTRY_MS }: SyncBackupPanelProps) {
  /* 到点自动收起；时长由数据推出，不写死在这里 */
  /**
   * ⚠ `onClose` 必须走 ref，**不能**进下面那个 effect 的依赖数组。
   *
   * 踩过的坑（真机上"永不自动消失"）：父组件 `Shell` 传的是内联箭头函数
   * `onClose={() => setSyncBackup(null)}`，每次父组件重渲染都会换一个新引用；
   * 而小木播报、面板逐条浮现都会引起重渲染 —— 于是 effect 不断被清理重建，
   * 计时器**每次都从零开始**，到点那一刻永远等不到。注入事件那条测试路径
   * 因为父组件不重渲染，反而"碰巧通过"，把问题掩盖了一轮。
   *
   * 用 ref 保存最新回调：计时器只依赖"时长"这一个真变量。
   */
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const timer = window.setTimeout(() => onCloseRef.current(), stream.autoCloseMs);
    return () => window.clearTimeout(timer);
  }, [stream.autoCloseMs]);

  /* Esc 关闭：与演示表面、红头委托预览同一套习惯 */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const total = stream.entries.length;
  /**
   * 头部计数**跟着逐条浮现一起涨**，一上来就写 "7/7" 会有两个问题：
   *   · 数字跑在内容前面 —— 屏幕上只看到 4 行却写着 7/7，一眼就是假的；
   *   · 现场实测截图确认了这一点（第 5~7 行还在透明度 0 的状态）。
   * 按同一节拍递增，读完正好是 n/n；`prefers-reduced-motion` 下 CSS 已关掉动画，
   * 这里也直接跳到满值，避免"内容全在、计数还在慢慢爬"。
   */
  const reduceMotion =
    typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const [shown, setShown] = useState(reduceMotion ? total + 1 : 1);
  useEffect(() => {
    if (reduceMotion) {
      setShown(total + 1);
      return undefined;
    }
    const timers = [
      ...stream.entries.map((_, index) =>
        window.setTimeout(() => setShown(index + 2), (index + 1) * perEntryMs),
      ),
    ];
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [stream, perEntryMs, reduceMotion, total]);

  return (
    <aside className="sxb" role="dialog" aria-label={stream.title} aria-live="polite">
      <header className="sxb__head">
        <span className="sxb__dot" aria-hidden="true" />
        <h3 className="sxb__title">{stream.title}</h3>
        <span className="sxb__count">
          已同步 {Math.min(shown, total + 1)}/{total + 1}
        </span>
        <button type="button" className="sxb__close" onClick={onClose} aria-label="关闭">
          ×
        </button>
      </header>

      <div className="sxb__stream" aria-hidden="true">
        <span className="sxb__rail" />
        <span className="sxb__pulse" />
      </div>

      <ul className="sxb__list">
        {stream.entries.map((entry, index) => (
          <li
            key={`${entry.name}-${index}`}
            className="sxb__row"
            /* 错峰浮现：第 n 条在第 n 拍出现，与"数据一条条落盘"的观感一致 */
            style={{ animationDelay: `${index * perEntryMs}ms` }}
          >
            <span className="sxb__name">{entry.name}</span>
            <span className="sxb__size">{entry.size}</span>
            <span className="sxb__state">{entry.state}</span>
          </li>
        ))}
        <li className="sxb__row is-tail" style={{ animationDelay: `${(total + 1) * perEntryMs}ms` }}>
          <span className="sxb__name">{stream.voiceLine.name}</span>
          <span className="sxb__size">{stream.voiceLine.size}</span>
          <span className="sxb__state">已同步</span>
        </li>
      </ul>

      <footer className="sxb__foot">
        <p className="sxb__summary">{stream.summary}</p>
        <p className="sxb__source">{SYNC_SOURCE_NOTE}</p>
      </footer>
    </aside>
  );
}
