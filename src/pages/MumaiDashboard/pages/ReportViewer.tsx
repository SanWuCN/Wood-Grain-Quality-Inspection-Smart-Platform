/**
 * 报告阅览器 · 平台内窗口（用户口径 2026-10-02）
 *
 * 用户原话：「这个报告不是点击下载，直接展开在平台上的窗口，可以点开关闭，然后里面排版优化一下」。
 *
 * ── 为什么要单独一个组件，而不是复用 `Modal` ────────────────────────
 * 通用 `Modal` 是 620/880px 宽的卡片，塞一份 A4 报告进去只能看到半页；
 * 阅览器要的是「几乎占满屏幕 + 自己的一条工具条 + 关闭」。语义也不同：
 * 别的弹窗是"确认/填表"，这个是"读文件"。
 *
 * ── 关掉时把 iframe 卸掉（不是 CSS 藏起来）────────────────────────────
 * 用户要的是"可以点开关闭"。用 `visibility` / `display:none` 藏一个还活着的
 * PDF 视图，Chrome 那边仍占着 PDF 插件进程，而且**再打开时不会重新加载** ——
 * 现场会出现"关了再开还是上次那页/白屏"。所以关闭即卸载，再打开就是干净的一次。
 *
 * ── 为什么用 iframe 而不是把 PDF 转成 HTML ──────────────────────────
 * 这份报告的用户原件是**子集字体 PDF**，文字抽不出来（实测用 ToInline/CMap 解出来
 * 是乱码，没有 ToUnicode 反查表），OCR 也不在这台机器上。所以窗口里直接嵌原件 ——
 * 浏览器自带的 PDF 阅读器排版就是原件排版，不会因为"重排"把文档改样。
 */
import { useEffect, useState } from "react";
import { Btn } from "../ui";
import { GAUSSIAN_REPORT } from "./reportPack";

export function ReportViewer({ onClose }: { onClose: () => void }) {
  const [failed, setFailed] = useState(false);

  /* Esc 关闭（与通用弹窗同一口径：阅览器是最上面那层，Esc 归它） */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  return (
    <div className="report-viewer" role="dialog" aria-modal="true" aria-label={GAUSSIAN_REPORT.title}>
      <header className="report-viewer__head">
        <span className="report-viewer__title">
          <b>{GAUSSIAN_REPORT.title}</b>
          <i>
            {GAUSSIAN_REPORT.subtitle} · {GAUSSIAN_REPORT.sizeText} · {GAUSSIAN_REPORT.date}
          </i>
        </span>
        <span className="report-viewer__actions">
          {/* 保留一个"新标签打开"的出口：需要下载/打印/细读时用它 */}
          <a className="btn" href={GAUSSIAN_REPORT.href} target="_blank" rel="noreferrer">
            在新标签打开
          </a>
          <Btn tone="primary" onClick={onClose}>
            关闭
          </Btn>
        </span>
      </header>

      <div className="report-viewer__body">
        {failed ? (
          <div className="report-viewer__fallback">
            <p>这台机器的浏览器没有内嵌 PDF 阅读器，报告没能在窗口里展开。</p>
            <p className="muted">
              用上面的「在新标签打开」或直接访问
              <code>{GAUSSIAN_REPORT.href}</code>
              打开原件。
            </p>
          </div>
        ) : (
          <iframe
            className="report-viewer__frame"
            src={GAUSSIAN_REPORT.href}
            title={GAUSSIAN_REPORT.title}
            /*
              ⚠ 这里**不加 `sandbox`**：加了之后 Chrome 的 PDF 插件就不渲染了，
              窗口里是一片空白（实测踩到）。阅览器本来就是"读一份只读文件"，
              用 `src` 直连静态托管的 PDF，不再给它跳转页面的能力。
            */
            onError={() => setFailed(true)}
          />
        )}
      </div>
    </div>
  );
}
