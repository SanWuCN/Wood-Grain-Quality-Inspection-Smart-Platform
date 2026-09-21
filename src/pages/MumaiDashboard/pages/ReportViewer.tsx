/**
 * 报告阅览器 · 平台内窗口（用户口径 2026-10-02）
 *
 * 用户原话：「这个报告不是点击下载，直接展开在平台上的窗口，可以点开关闭，
 * 然后里面排版优化一下」；随后实测报「报告点击怎么又弹下载，弹出来的界面还是全白」。
 *
 * ── 为什么现在是**页图**，不是嵌 PDF ────────────────────────────────
 * 原来用 `<iframe src=…pdf>`：在用户那台机器上浏览器把 `application/pdf` 当**下载**
 * 处理，窗口里一片白（无头 Chrome 上同样复现：`fetch()` 204、iframe 停在 `about:blank`）。
 * 现在展示的是**服务端渲染好的页图**（`reportPack.pages`，由 Windows 的
 * `PdfDocument` 逐页渲染 → 缩到 1240 宽），用 `<img>` 排出来 —— 不依赖 PDF 插件，
 * 也不会触发下载。原件 PDF 仍在右上角留一个出口。
 *
 * ── 排版上做了什么（"里面排版优化一下"）────────────────────────────
 *   · 页图按**列宽居中**排（A4 比例固定，不拉伸），页与页之间留白 + 一条分隔；
 *   · 每页左上角一个 `第 N 页 / 共 M 页 · 这一页讲什么` 的页签（照原件小标题抄的），
 *     读的人不用猜这一页是什么；
 *   · `loading="lazy"`：翻到哪页加载哪页，1.8 MB 的报告不会一次性拉满；
 *   · 第一页上的"任务名/照片数/耗时"这类**关键数字**在工具条里再复述一遍，
 *     项目经理不用放大图就能看到结论（数字照原件抄，不另算）。
 *
 * ── 关掉时把内容卸掉（不是 CSS 藏起来）────────────────────────────
 * 用户要的是"可以点开关闭"。藏起来的图仍占内存、滚动位置还留着，
 * 再打开会停在半截；关闭即卸载，再打开就是干净的一次。
 */
import { useEffect, useState } from "react";
import { Btn } from "../ui";
import { GAUSSIAN_REPORT } from "./reportPack";

export function ReportViewer({ onClose }: { onClose: () => void }) {
  const [failed, setFailed] = useState<string | null>(null);

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

  const total = GAUSSIAN_REPORT.pages.length;

  return (
    <div className="report-viewer" role="dialog" aria-modal="true" aria-label={GAUSSIAN_REPORT.title}>
      <header className="report-viewer__head">
        <span className="report-viewer__title">
          <b>{GAUSSIAN_REPORT.title}</b>
          <i>
            {GAUSSIAN_REPORT.subtitle} · 共 {total} 页 · {GAUSSIAN_REPORT.date}
          </i>
          {/*
            结论摘要：**照原件抄的关键数字**（页 1 / 页 2 / 页 5）。
            为什么要在这里复述：报告是给项目经理看的，他先要的是这几个数，
            不该逼着他把 1 万多像素高的页图放大去找。
          */}
          <span className="report-viewer__facts">
            {GAUSSIAN_REPORT.summary.map((item) => (
              <span key={item.label} className="report-viewer__fact">
                <em>{item.label}</em>
                <b>{item.value}</b>
              </span>
            ))}
          </span>
        </span>
        <span className="report-viewer__actions">
          {/* 原件出口：页图是给人读的，凭据仍是原件 */}
          <a className="btn" href={GAUSSIAN_REPORT.pdfHref} target="_blank" rel="noreferrer" title="打开原件 PDF（可下载 / 打印 / 放大细看）">
            原件 PDF
          </a>
          <Btn tone="primary" onClick={onClose}>
            关闭
          </Btn>
        </span>
      </header>

      <div className="report-viewer__body">
        {failed ? (
          <div className="report-viewer__fallback">
            <p>报告页图没能加载：{failed}</p>
            <p className="muted">
              用右上角「原件 PDF」直接看原件，或访问
              <code>{GAUSSIAN_REPORT.pdfHref}</code>
            </p>
          </div>
        ) : (
          <ol className="report-pages">
            {GAUSSIAN_REPORT.pages.map((page) => (
              <li key={page.index} className="report-pages__item">
                <div className="report-pages__meta">
                  <span className="report-pages__no">
                    第 {page.index} 页 / 共 {total} 页
                  </span>
                  <span className="report-pages__title">{page.title}</span>
                </div>
                <img
                  className="report-pages__img"
                  src={page.src}
                  alt={`${GAUSSIAN_REPORT.title} 第 ${page.index} 页：${page.title}`}
                  loading="lazy"
                  onError={() => setFailed(`第 ${page.index} 页（${page.src}）`)}
                />
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
