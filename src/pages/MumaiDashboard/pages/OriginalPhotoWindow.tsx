/**
 * 「打开你标记的原图」（剧本 ⑫ 的原图查看窗口）
 *
 * ── 它要回答的三句话 ────────────────────────────────────────────────
 *   史：「小木，打开你标记的原图，把疑点区域放大。」
 *   小木：「对应原图已打开，标注与构件编号一起显示。请核对这处表面缺损。」
 *   文档旁注：「小木根据分析结果中的**图片编号和标注框**调用原图查看工具；
 *             没有标注坐标时只打开原图，**不虚构放大定位**。」
 *
 * 所以这个窗口里三样东西同时出现，并且**都能核对出处**：
 *   ① **图片编号**：真实文件名（`IMG_0421.jpg`）+ 批次来源（照片处理批次 · 人工标注原片）；
 *   ② **标注框**：画在真图上的框，坐标是离线从**人工标注原片的红框**里检出来的
 *      （`tools-夜间/出-标注框坐标.py` → `annotatedPhotos.ts`），不是估的；
 *   ③ **放大**：放大范围 = 那个框本身（`object-view-box`/`transform` 缩放），
 *      框外的内容按原样保留 —— 有框才放大，**没有框就按剧本原文只打开原图**。
 *
 * ── 放大是怎么做的（以及为什么不用 `object-view-box`）──────────────────
 * 第一版用 CSS 的 `object-view-box` 裁切图片 —— 图能放大，但**平台叠的那个框是图片的
 * 兄弟节点**，裁切只作用于图片自身，框不会跟着走：放大后框还停在原位置，看起来像标错了地方。
 * 现在改成：`inner`（宽高比=原图的盒子）里放图片 + 框，放大是对**整个 inner** 做
 * `transform: scale(k)` 且 `transform-origin` 设在框中心 —— 框与画面一起缩放，
 * 永远贴在同一个木纹位置上，也不需要两套坐标换算。
 */
import { useEffect, useMemo, useState } from "react";

import { Btn, Modal, StatusChip } from "../ui";
import { annotatedPhotoFor } from "./annotatedPhotos";
import { zoomFactorFor } from "./originalPhotoZoom";
import type { AnnotationBox } from "../seed/scenario";
import "./originalPhoto.css";

export type OriginalPhotoWindowProps = {
  /** 构件号（Z01–Z04）：决定用哪一张原片 */
  componentId: string;
  /** 测区号（例如 Z04-lower），与构件号一起显示 */
  zoneId: string | null;
  /** 平台记录里的标注框（来自融合记录；可能没有） */
  annotation: AnnotationBox | null;
  onClose: () => void;
};

export function OriginalPhotoWindow({ componentId, zoneId, annotation, onClose }: OriginalPhotoWindowProps) {
  const photo = useMemo(() => annotatedPhotoFor(componentId), [componentId]);
  /** 默认用缩略图（宽 640）加载，点「看原尺寸」再换 2 MB 的大图 */
  const [fullSize, setFullSize] = useState(false);
  const [zoomed, setZoomed] = useState(true);

  /* 没有框就没什么可放大的 —— 按剧本原文："没有标注坐标时只打开原图" */
  const box = photo?.box ?? null;
  const zoom = zoomFactorFor(box);
  const innerStyle = useMemo<React.CSSProperties | undefined>(() => {
    if (!photo) return undefined;
    const style: React.CSSProperties = { aspectRatio: `${photo.width} / ${photo.height}` };
    if (zoomed && box) {
      style.transform = `scale(${zoom})`;
      /* 放大中心 = 框中心：这样"放大疑点区域"是字面意义上成立的 */
      style.transformOrigin = `${(box.x + box.w / 2) * 100}% ${(box.y + box.h / 2) * 100}%`;
    }
    return style;
  }, [photo, zoomed, box, zoom]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const src = photo ? (fullSize ? photo.url : photo.thumbUrl) : "";

  return (
    <Modal
      wide
      title={`原图查看 · ${componentId}${zoneId ? ` ${zoneId}` : ""}`}
      subtitle={
        photo
          ? `${photo.file} · ${photo.width}×${photo.height} · 照片处理批次 · 人工标注原片`
          : "该构件没有配到原片"
      }
      onClose={onClose}
      footer={
        <>
          {photo ? (
            <Btn onClick={() => setFullSize((value) => !value)} title="原尺寸 2 MB 级，看清纹理用">
              {fullSize ? "用缩略图" : "看原尺寸"}
            </Btn>
          ) : null}
          {box ? (
            <Btn
              tone={zoomed ? "primary" : "default"}
              active={zoomed}
              onClick={() => setZoomed((value) => !value)}
              title={`放大范围就是这个标注框（${zoom}×）`}>
              {zoomed ? `已放大疑点区域 ${zoom}×` : "放大疑点区域"}
            </Btn>
          ) : null}
          <Btn tone="primary" onClick={onClose}>
            关闭
          </Btn>
        </>
      }>
      {photo ? (
        <div className="opw">
          <figure className="opw__stage">
            <div className={`opw__frame${zoomed && box ? " is-zoomed" : ""}`}>
              {/* inner 的宽高比 = 原图比例；放大作用于它，所以框跟着画面一起缩放 */}
              <div className="opw__inner" style={innerStyle} data-zoomed={zoomed && box ? "1" : "0"}>
                <img className="opw__img" src={src} alt={`${componentId} 原始影像 ${photo.file}`} />
                {/*
                  平台自己画的那个框：与图片里**人工画的红框**是两回事 ——
                  一个是原片自带的（烧在像素里），一个是平台按记录叠的。
                  图例里分开写，免得被当成同一件事。
                */}
                {box ? (
                  <span
                    className="opw__box"
                    style={{
                      left: `${box.x * 100}%`,
                      top: `${box.y * 100}%`,
                      width: `${box.w * 100}%`,
                      height: `${box.h * 100}%`,
                    }}
                    aria-hidden="true"
                  />
                ) : null}
              </div>
            </div>
            <figcaption className="opw__legend">
              <span className="opw__chip opw__chip--human">原片自带的红框（人工标注）</span>
              <span className="opw__chip opw__chip--platform">平台按记录叠的框</span>
              {zoomed && box ? (
                <span className="muted">当前视图：以标注框为中心放大 {zoom}×</span>
              ) : (
                <span className="muted">
                  {box ? "当前视图：整张原图" : "该原片没有标注坐标 —— 按剧本只打开原图，不做放大定位"}
                </span>
              )}
            </figcaption>
          </figure>

          <aside className="opw__side">
            <h4 className="sub">这处疑点的记录</h4>
            <dl className="opw__facts">
              <div>
                <dt>构件</dt>
                <dd>
                  {componentId}
                  {zoneId ? ` · ${zoneId}` : ""}
                </dd>
              </div>
              <div>
                <dt>图片编号</dt>
                <dd>
                  <code>{photo.file}</code>
                </dd>
              </div>
              <div>
                <dt>标注框</dt>
                <dd>
                  {annotation ? (
                    <>
                      <code>{annotation.boxId}</code> · {annotation.label} · {annotation.confidence.toFixed(2)}
                    </>
                  ) : (
                    "未附带标注框记录"
                  )}
                </dd>
              </div>
              <div>
                <dt>框坐标</dt>
                <dd>
                  {box
                    ? `x ${(box.x * 100).toFixed(1)}% · y ${(box.y * 100).toFixed(1)}% · ${(box.w * 100).toFixed(1)}%×${(box.h * 100).toFixed(1)}%（离线从原片红框检出）`
                    : "无坐标"}
                </dd>
              </div>
              <div>
                <dt>文件摘要</dt>
                <dd>
                  <code>sha256:{photo.digest}</code>
                </dd>
              </div>
              <div>
                <dt>来源</dt>
                <dd>照片处理批次 · 人工标注原片（{photo.file}）</dd>
              </div>
            </dl>

            <p className="opw__note">
              {annotation
                ? `预置标注记录：${annotation.source}。真实视觉模型未接通，框的位置取自这批人工标注原片上的红框，` +
                  "平台只做叠加与放大，不新造疑点。"
                : "该原片没有标注坐标：按剧本原文只打开原图，不做放大定位。"}
            </p>

            {annotation ? <StatusChip text={`${annotation.label} · ${annotation.confidence.toFixed(2)}`} tone="warn" /> : null}
          </aside>
        </div>
      ) : (
        <p className="opd__empty">没有配到原片：请核对 `annotatedPhotos.ts` 的构件映射。</p>
      )}
    </Modal>
  );
}
