/**
 * 红头委托文件预览（演示样例照）
 *
 * ── 用法 ────────────────────────────────────────────────────────────
 *   import CommissionPreview from "./CommissionPreview";
 *
 *   {previewOpen ? (
 *     <CommissionPreview detail={detail} onClose={() => setPreviewOpen(false)} />
 *   ) : null}
 *
 * `detail` 是**唯一事实源**：组件里每一个可读字符都来自它（经 `commissionView.ts`
 * 推导），不存在第二份静态文案副本。打开期间**不改路由**：本文件不引用
 * react-router、不写 `location`、不碰 history。
 *
 * ── 防幻觉口径（与 docs/新工单红头委托与小木联动-AI交接文档-v1.0.md 对齐）──
 *   · 背景图只负责纸张质感 / 透视 / 折痕 / 阴影 / 红头底纹 / 不可识别印章；
 *     所有文字由 React + CSS 叠加，图片缺失或加载失败时纯 CSS 纸张版式照常显示全文；
 *   · 不做 OCR、不解析图片文字，图片不是数据源；
 *   · 印章固定写「演示样例」，不使用真实机关名称、国徽或真实公章样式；
 *   · 服务端 `restricted` 为真时只渲染摘要与说明，正文与附件在推导阶段就不产出。
 */
import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";

import { Icon } from "../../icons";
import type { WorkOrderDetail } from "../../api/client";
import { buildCommissionView, ATTACHMENT_UNKNOWN, DEMO_LABEL } from "./commissionView";
import "./commission-preview.css";

/** 纸张质感底图的默认位置；由图像生成工具产出，规格见 public/commission/README.md */
const DEFAULT_PAPER_SRC = "/commission/paper.jpg";

export type CommissionPreviewProps = {
  /** 当前工单详情（唯一事实源）。组件内所有可读文字都必须来自它 */
  detail: WorkOrderDetail;
  /** 关闭预览（用户按 Esc / 点关闭按钮 / 点遮罩） */
  onClose: () => void;
  /**
   * 可选：纸张质感底图。默认 `/commission/paper.jpg`。
   * 只承担质感，不承担任何信息；加载失败静默降级到纯 CSS 纸张。
   */
  paperSrc?: string;
};

export function CommissionPreview({ detail, onClose, paperSrc = DEFAULT_PAPER_SRC }: CommissionPreviewProps) {
  const view = buildCommissionView(detail);
  /** 底图加载失败即摘掉这一层：纸纹没了，文字一个不少 */
  const [paperFailed, setPaperFailed] = useState(false);
  const paperId = useId();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    // 预览是页面级浮层：打开期间锁住背景滚动，关掉时还原原有值（不写死 ""）
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  /**
   * 挂到 `document.body`：`.appshell` 带 `isolation: isolate`，
   * 留在原地会被面板的层叠上下文裁掉（同 ui.tsx 的 Modal 处理）。
   */
  return createPortal(
    <div
      className="cpr"
      role="presentation"
      /* 遮罩上按下才关：在纸面里选字拖到外面松手不误关（同 ui.tsx Modal） */
      onMouseDown={onClose}>
      <div
        className="cpr__sheet"
        role="dialog"
        aria-modal="true"
        aria-label={`委托文件预览（${DEMO_LABEL}）：${view.title}`}
        onMouseDown={(event) => event.stopPropagation()}>
        <header className="cpr__bar">
          <span className="cpr__badge">{DEMO_LABEL}</span>
          <span className="cpr__bar-note">虚构样例 · 非真实行政公文 · 仅用于演示</span>
          <button type="button" className="cpr__close" onClick={onClose} autoFocus>
            <Icon name="action-close" size={16} aria-hidden />
            <span>关闭</span>
          </button>
        </header>

        <div className="cpr__scroll">
          <article className="cpr__paper" aria-labelledby={paperId}>
            {/*
              纸张质感层：纯装饰。失败时 `paperFailed` 为真，这一层整块不渲染，
              底下 .cpr__paper 的米白纸底 + 红头分隔线继续承担版式。
            */}
            {paperFailed ? null : (
              <img
                className="cpr__paper-photo"
                src={paperSrc}
                alt=""
                aria-hidden
                draggable={false}
                onError={() => setPaperFailed(true)}
              />
            )}

            <div className="cpr__paper-body">
              <div className="cpr__head">
                <p className="cpr__head-unit">{view.headUnit}</p>
                <p className="cpr__head-rule" aria-hidden />
              </div>

              <h3 className="cpr__title" id={paperId}>
                {view.title}
              </h3>

              {view.restricted ? (
                /* 权限边界：受限账号只给摘要 + 说明，正文与附件一条都不渲染 */
                <section className="cpr__restricted" aria-label="受限摘要">
                  <ul className="cpr__summary">
                    {view.summary.map((item) => (
                      <li key={item.k}>
                        <span>{item.k}</span>
                        <b>{item.v}</b>
                      </li>
                    ))}
                  </ul>
                  <p className="cpr__note">{view.restrictedNote}</p>
                </section>
              ) : (
                <>
                  <div className="cpr__body">
                    {view.paragraphs.map((paragraph, index) => (
                      <p key={`${index}-${paragraph.slice(0, 8)}`}>{paragraph}</p>
                    ))}
                  </div>

                  <div className="cpr__sign">
                    <p className="cpr__sign-unit">{view.signUnit}</p>
                    <p className="cpr__sign-date">{view.signDate}</p>
                  </div>

                  {/* 印章质感：CSS 画的红色圆形，字样固定为样例标记，不做任何真实公章样式 */}
                  <div className="cpr__stamp" aria-hidden>
                    <span className="cpr__stamp-text">{DEMO_LABEL}</span>
                  </div>

                  <section className="cpr__attachments" aria-label="随单附件">
                    <h4>随单附件</h4>
                    {view.attachments.length ? (
                      <ul>
                        {view.attachments.map((item, index) => (
                          <li key={`${index}-${item.name}`}>
                            <b>{item.name}</b>
                            <em>
                              {item.kind} · {item.sizeText}
                            </em>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      /* 与推导层同一个常量：附件为空时的固定措辞，不在这里另写一句 */
                      <p className="cpr__note">{ATTACHMENT_UNKNOWN}</p>
                    )}
                  </section>

                  {view.placeholders.length ? (
                    <section className="cpr__pending" aria-label="附件未明确的信息">
                      <h4>附件未明确的信息</h4>
                      <ul>
                        {view.placeholders.map((item) => (
                          <li key={item}>{item}</li>
                        ))}
                      </ul>
                    </section>
                  ) : null}
                </>
              )}
            </div>
          </article>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** 具名 + 默认双导出：现场两种引入写法都能用 */
export default CommissionPreview;
