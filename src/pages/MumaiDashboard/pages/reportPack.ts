/**
 * 数字孪生 · 「成果质量报告」（用户口径 2026-10-02）
 *
 * 用户原话：「作为高斯泼溅的报告，是给项目经理看的，放在数字孪生那块」，
 * 随后两条：「这个报告不是点击下载，直接展开在平台上的窗口，可以点开关闭，
 * 然后里面排版优化一下」→「报告点击怎么又弹下载，弹出来的界面还是全白」。
 *
 * ── 为什么窗口里展示的是**页图**而不是把 PDF 嵌进去 ──────────────────
 * 原来用 `<iframe src=…pdf>` 嵌原件，在用户那台机器上**一片白**：
 * 浏览器把 `application/pdf` 当**下载**处理（同样的现象在无头 Chrome 上复现过 ——
 * `fetch()` 拿到 204、iframe 停在 `about:blank`），所以窗口里什么都没有。
 * 现在改成**服务端渲染好的页图**（Windows 自带 WinRT `PdfDocument` 逐页渲染，
 * 脚本 `tools-夜间/render-report-pages.ps1` → `tools-夜间/压报告页.mjs` 缩到 1240 宽），
 * 平台用 `<img>` 排版展示：不依赖浏览器 PDF 插件、不会触发下载、缩放清晰。
 *
 * ── 原件还在 ────────────────────────────────────────────────────────
 * PDF 原件同时入平台（`pdfHref`），阅览窗口右上角留「原件 PDF」出口，
 * 需要下载/打印/放大细看时用它 —— 页图是给人读的，原件是凭据。
 *
 * ── 为什么地址写在这里而不是 JSX 里 ────────────────────────────────
 * 一条 URL 要在三处用到（页面、静态托管、验收工装），写三份必然漂移。
 * 这里给**唯一一份**注册表，`reportPack.test.ts` 会核对"页图真的都在、
 * 张数与 `pages` 对得上、每页都有标题"。
 */

export type ReportPage = {
  /** 第几页（1 起，与原件页码一致） */
  index: number;
  /** 这一页讲什么（**照原件的小标题抄的**，不是另起的名字） */
  title: string;
  /** 页图地址（渲染自原件，静态托管） */
  src: string;
};

export type DeliveryReport = {
  /** 列表里给人看的名字（中文） */
  title: string;
  /** 一句话说明这是什么 */
  subtitle: string;
  /** 原件 PDF 地址（**已编码**，可直接放进 href / fetch） */
  pdfHref: string;
  /** 原件文件名（与 public 目录里的文件逐字一致，便于人去找文件） */
  fileName: string;
  /** 原件字节数文案 */
  sizeText: string;
  /** 报告日期（文件名里的那一段） */
  date: string;
  /**
   * 结论摘要：**照原件抄的关键数字**（项目经理不放大图就能看到结论）。
   *
   * ⚠ 这几个数是**从原件上读下来的**（页 1「任务概览 / 耗时统计」、页 2「测区概况及覆盖度」、
   *   页 5「重建参数」），不是平台算的 —— 原件换了必须跟着换，`reportPack.test.ts`
   *   只核对"有摘要且不是空话"，数字口径以原件为准。
   */
  summary: readonly { label: string; value: string }[];
  /** 逐页的图与标题（窗口按它排版） */
  pages: readonly ReportPage[];
};

/** 逐页标题：照原件的小标题写（第 1 页是封面，标题即报告名） */
const PAGE_TITLES: readonly string[] = [
  "任务概览 · 耗时统计",
  "空三质量报告 · 测区概况及覆盖度",
  "相机校正 · 相机 1",
  "相机校正 · 相机 2",
  "重建质量报告 · 运行环境与重建参数",
];

export const GAUSSIAN_REPORT: DeliveryReport = {
  title: "成果质量报告",
  subtitle: "重建（MipMap）成果 · 空三 / 相机校正 / 重建质量",
  pdfHref: `/reports/${encodeURIComponent("成果质量报告-text-20260914.pdf")}`,
  fileName: "成果质量报告-text-20260914.pdf",
  sizeText: "1.75 MB",
  date: "2026-09-14",
  /* 照原件抄的结论（页 1 / 页 2 / 页 5）：任务名、照片数、总耗时、入网率、测区面积、重建参数 */
  summary: [
    { label: "任务名称", value: "text-20260914" },
    { label: "照片数量", value: "452 张" },
    { label: "总耗时", value: "4 小时 31 分 43 秒" },
    { label: "入网率", value: "99.56%（450 / 452）" },
    { label: "测区面积", value: "1257.2 m²" },
    { label: "重建质量", value: "超高精度 · 分块 8" },
  ],
  pages: PAGE_TITLES.map((title, index) => ({
    index: index + 1,
    title,
    src: `/reports/report-page-${String(index + 1).padStart(2, "0")}.jpg`,
  })),
};

/** 这一屏要列出的报告（目前只有一份；将来加报告只往这里加） */
export const DELIVERY_REPORTS: readonly DeliveryReport[] = [GAUSSIAN_REPORT];
