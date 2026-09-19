/**
 * 「打开你标记的原图」用的原片数据（**本文件由生成器写出，别手改**）
 *
 * 生成器：`tools-夜间/出-标注原片.mjs`；坐标来自 `出-标注框坐标.py` 在
 * **人工标注原片**上检出的红框（26/27 张有框，1 张没有 —— 那一张按剧本原文
 * 「没有标注坐标时只打开原图，不虚构放大定位」处理）。
 *
 * 照片不进仓库也不进 dist：它们是用户给的真素材（27 张 3024×4032，共 ~56 MB），
 * 留在工作区磁盘上由服务端 `/photos/*` 只读映射，见 `server/services/photo-set.mjs`。
 */

/** 一张原片：文件号、两个尺寸的 URL、真实像素尺寸、红框（归一化，可能没有）、文件摘要 */
export type AnnotatedPhoto = {
  /** 文件号（IMG_0421.jpg），界面上要显示它 —— 观众能核对是哪一张 */
  file: string;
  /** 原尺寸（3024×4032，2 MB 级）：看细节用 */
  url: string;
  /** 缩略图（宽 640）：默认加载的就是它，快 */
  thumbUrl: string;
  width: number;
  height: number;
  /** 人工标注框（归一化 0–1）；`null` = 这张原片没有标注框 */
  box: { x: number; y: number; w: number; h: number } | null;
  /** 文件 sha256 前 16 位：换图/改图时能看出来（与 `来源说明.txt` 的批次一致） */
  digest: string;
};

export const ANNOTATED_PHOTOS: readonly AnnotatedPhoto[] = [
  {
    file: "IMG_0421.jpg",
    url: "/photos/annotated/IMG_0421.jpg",
    thumbUrl: "/photos/thumb/annotated/IMG_0421.jpg",
    width: 3024,
    height: 4032,
    box: { x: 0.3797, y: 0.4783, w: 0.1562, h: 0.1219 },
    digest: "d31f9a6468241062",
  },
  {
    file: "IMG_0422.jpg",
    url: "/photos/annotated/IMG_0422.jpg",
    thumbUrl: "/photos/thumb/annotated/IMG_0422.jpg",
    width: 3024,
    height: 4032,
    box: { x: 0.3594, y: 0.4912, w: 0.1578, h: 0.1817 },
    digest: "bcd349f4bbf859f1",
  },
  {
    file: "IMG_0423.jpg",
    url: "/photos/annotated/IMG_0423.jpg",
    thumbUrl: "/photos/thumb/annotated/IMG_0423.jpg",
    width: 3024,
    height: 4032,
    box: { x: 0.3109, y: 0.3341, w: 0.2859, h: 0.3587 },
    digest: "93545a2b4d21fd01",
  },
  {
    file: "IMG_0424.jpg",
    url: "/photos/annotated/IMG_0424.jpg",
    thumbUrl: "/photos/thumb/annotated/IMG_0424.jpg",
    width: 3024,
    height: 4032,
    box: { x: 0.3672, y: 0.4713, w: 0.2031, h: 0.2087 },
    digest: "dc9ff16612d357f2",
  },
  {
    file: "IMG_0425.jpg",
    url: "/photos/annotated/IMG_0425.jpg",
    thumbUrl: "/photos/thumb/annotated/IMG_0425.jpg",
    width: 3024,
    height: 4032,
    box: { x: 0.2516, y: 0.4877, w: 0.4859, h: 0.2497 },
    digest: "fc470b33ef847c48",
  },
  {
    file: "IMG_0426.jpg",
    url: "/photos/annotated/IMG_0426.jpg",
    thumbUrl: "/photos/thumb/annotated/IMG_0426.jpg",
    width: 3024,
    height: 4032,
    box: { x: 0.4328, y: 0.3517, w: 0.1891, h: 0.2661 },
    digest: "673565ec94129647",
  },
  {
    file: "IMG_0427.jpg",
    url: "/photos/annotated/IMG_0427.jpg",
    thumbUrl: "/photos/thumb/annotated/IMG_0427.jpg",
    width: 3024,
    height: 4032,
    box: { x: 0.2047, y: 0.5358, w: 0.2766, h: 0.2837 },
    digest: "ef6c185eb0c0f2d6",
  },
  {
    file: "IMG_0428.jpg",
    url: "/photos/annotated/IMG_0428.jpg",
    thumbUrl: "/photos/thumb/annotated/IMG_0428.jpg",
    width: 3024,
    height: 4032,
    box: { x: 0.2938, y: 0.4314, w: 0.2297, h: 0.1993 },
    digest: "052c5be7e6010cb9",
  },
  {
    file: "IMG_0429.jpg",
    url: "/photos/annotated/IMG_0429.jpg",
    thumbUrl: "/photos/thumb/annotated/IMG_0429.jpg",
    width: 3024,
    height: 4032,
    box: { x: 0.1359, y: 0.2849, w: 0.4531, h: 0.4502 },
    digest: "09861d1522e1a5e0",
  },
  {
    file: "IMG_0430.jpg",
    url: "/photos/annotated/IMG_0430.jpg",
    thumbUrl: "/photos/thumb/annotated/IMG_0430.jpg",
    width: 3024,
    height: 4032,
    box: { x: 0.3172, y: 0.5826, w: 0.2062, h: 0.1325 },
    digest: "739272a9664a0062",
  },
  {
    file: "IMG_0431.jpg",
    url: "/photos/annotated/IMG_0431.jpg",
    thumbUrl: "/photos/thumb/annotated/IMG_0431.jpg",
    width: 3024,
    height: 4032,
    box: null,
    digest: "eace099fe2bd74ed",
  },
  {
    file: "IMG_0432.jpg",
    url: "/photos/annotated/IMG_0432.jpg",
    thumbUrl: "/photos/thumb/annotated/IMG_0432.jpg",
    width: 3024,
    height: 4032,
    box: { x: 0.3563, y: 0.3845, w: 0.15, h: 0.1395 },
    digest: "407f3e7b1ecc2a50",
  },
  {
    file: "IMG_0433.jpg",
    url: "/photos/annotated/IMG_0433.jpg",
    thumbUrl: "/photos/thumb/annotated/IMG_0433.jpg",
    width: 3024,
    height: 4032,
    box: { x: 0.3969, y: 0.5275, w: 0.1703, h: 0.1454 },
    digest: "9d59568c694d7bfc",
  },
  {
    file: "IMG_0434.jpg",
    url: "/photos/annotated/IMG_0434.jpg",
    thumbUrl: "/photos/thumb/annotated/IMG_0434.jpg",
    width: 3024,
    height: 4032,
    box: { x: 0.3609, y: 0.4314, w: 0.2547, h: 0.1547 },
    digest: "481d1571a883e54d",
  },
  {
    file: "IMG_0435.jpg",
    url: "/photos/annotated/IMG_0435.jpg",
    thumbUrl: "/photos/thumb/annotated/IMG_0435.jpg",
    width: 3024,
    height: 4032,
    box: { x: 0.4891, y: 0.5182, w: 0.1203, h: 0.1055 },
    digest: "21b4d371d9079ee2",
  },
  {
    file: "IMG_0436.jpg",
    url: "/photos/annotated/IMG_0436.jpg",
    thumbUrl: "/photos/thumb/annotated/IMG_0436.jpg",
    width: 3024,
    height: 4032,
    box: { x: 0.3375, y: 0.4338, w: 0.2578, h: 0.2063 },
    digest: "b690bdcae788e39b",
  },
  {
    file: "IMG_0437.jpg",
    url: "/photos/annotated/IMG_0437.jpg",
    thumbUrl: "/photos/thumb/annotated/IMG_0437.jpg",
    width: 3024,
    height: 4032,
    box: { x: 0.3891, y: 0.4912, w: 0.2078, h: 0.204 },
    digest: "ace56f179d2a978a",
  },
  {
    file: "IMG_0438.jpg",
    url: "/photos/annotated/IMG_0438.jpg",
    thumbUrl: "/photos/thumb/annotated/IMG_0438.jpg",
    width: 3024,
    height: 4032,
    box: { x: 0.3359, y: 0.2978, w: 0.1437, h: 0.1489 },
    digest: "323926815a068659",
  },
  {
    file: "IMG_0439.jpg",
    url: "/photos/annotated/IMG_0439.jpg",
    thumbUrl: "/photos/thumb/annotated/IMG_0439.jpg",
    width: 3024,
    height: 4032,
    box: { x: 0.2609, y: 0.449, w: 0.3609, h: 0.2462 },
    digest: "35bb968f267658b8",
  },
  {
    file: "IMG_0440.jpg",
    url: "/photos/annotated/IMG_0440.jpg",
    thumbUrl: "/photos/thumb/annotated/IMG_0440.jpg",
    width: 3024,
    height: 4032,
    box: { x: 0.3234, y: 0.4584, w: 0.3578, h: 0.1278 },
    digest: "e332cd30235aca20",
  },
  {
    file: "IMG_0441.jpg",
    url: "/photos/annotated/IMG_0441.jpg",
    thumbUrl: "/photos/thumb/annotated/IMG_0441.jpg",
    width: 3024,
    height: 4032,
    box: { x: 0.2812, y: 0.483, w: 0.4016, h: 0.1923 },
    digest: "09afb4a8f05d579d",
  },
  {
    file: "IMG_0442.jpg",
    url: "/photos/annotated/IMG_0442.jpg",
    thumbUrl: "/photos/thumb/annotated/IMG_0442.jpg",
    width: 4032,
    height: 3024,
    box: { x: 0.4359, y: 0.4083, w: 0.2672, h: 0.2146 },
    digest: "4e22dcb334d035be",
  },
  {
    file: "IMG_0443.jpg",
    url: "/photos/annotated/IMG_0443.jpg",
    thumbUrl: "/photos/thumb/annotated/IMG_0443.jpg",
    width: 4032,
    height: 3024,
    box: { x: 0.4984, y: 0.5208, w: 0.1625, h: 0.1312 },
    digest: "866750dc65ceeb2b",
  },
  {
    file: "IMG_0444.jpg",
    url: "/photos/annotated/IMG_0444.jpg",
    thumbUrl: "/photos/thumb/annotated/IMG_0444.jpg",
    width: 4032,
    height: 3024,
    box: { x: 0.3547, y: 0.4021, w: 0.2734, h: 0.25 },
    digest: "7ec6fa03daf9d8da",
  },
  {
    file: "IMG_0445.jpg",
    url: "/photos/annotated/IMG_0445.jpg",
    thumbUrl: "/photos/thumb/annotated/IMG_0445.jpg",
    width: 4032,
    height: 3024,
    box: { x: 0.2547, y: 0.4104, w: 0.2344, h: 0.2938 },
    digest: "b295bee98637fe30",
  },
  {
    file: "IMG_0446.jpg",
    url: "/photos/annotated/IMG_0446.jpg",
    thumbUrl: "/photos/thumb/annotated/IMG_0446.jpg",
    width: 4032,
    height: 3024,
    box: { x: 0.4531, y: 0.3208, w: 0.2125, h: 0.225 },
    digest: "53fff36a3a5480ca",
  },
  {
    file: "IMG_0447.jpg",
    url: "/photos/annotated/IMG_0447.jpg",
    thumbUrl: "/photos/thumb/annotated/IMG_0447.jpg",
    width: 4032,
    height: 3024,
    box: { x: 0.1578, y: 0.6479, w: 0.2797, h: 0.2854 },
    digest: "35d7955189217362",
  },
];

/**
 * 构件 → 用哪一张原片。
 *
 * ⚠ 这是**演示用的固定映射**，不是「这个构件真的拍了这一张」：平台的视觉模型未接通，
 *   剧本也明说这一轮按「预置标注记录」走。所以窗口里始终把**真实文件号与批次来源**
 *   写在屏幕上（`影像来源：照片处理批次 · 人工标注原片 IMG_0421`），观众能核对。
 */
export const EVIDENCE_PHOTO_BY_COMPONENT: Readonly<Record<string, string>> = {
  Z04: "IMG_0421.jpg",
  Z01: "IMG_0422.jpg",
  Z02: "IMG_0423.jpg",
  Z03: "IMG_0424.jpg",
};

/** 取某个构件的原片；没配到就返回 null（界面回退成「只显示标注框记录」） */
export function annotatedPhotoFor(componentId: string | null | undefined): AnnotatedPhoto | null {
  const file = EVIDENCE_PHOTO_BY_COMPONENT[String(componentId ?? "")];
  if (!file) return null;
  return ANNOTATED_PHOTOS.find((item) => item.file === file) ?? null;
}
