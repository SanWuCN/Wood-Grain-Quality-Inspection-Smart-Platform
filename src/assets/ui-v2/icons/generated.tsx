/**
 * 本文件由脚本生成，请勿手工编辑。
 *
 * 来源：木脉智检 UI 视觉素材 v2.0（2026-09-13）
 *   icons/common   33 枚通用图标  → UI_V2_ICON_PATHS
 *   icons/business 11 枚业务图标  → UI_V2_ICON_PATHS
 *   icons/small    5 枚 16px 简化版    → UI_V2_SMALL_PATHS
 *
 * 公开图标名共 44 枚。16px 简化版**不占独立名字**：按 PRD §3.2，
 * 它们由 Icon 组件在 size=16 时自动选用，调用方仍写 nav-report 这类标准名。
 *
 * 重新生成：
 *   node tools/build-ui-v2-icons.mjs
 *
 * 生成规则（PRD §3.1）：只处理 path / circle / ellipse / rect / line / polyline /
 * polygon / g；属性转 React 命名；script、foreignObject、事件属性、外链、内嵌位图
 * 一律拒绝；白名单外的元素或属性直接报错，不静默丢路径。
 * 颜色不写死：描边与填充继承 currentColor，由 Icon 组件按 tone 提供。
 */

import type { ReactNode } from "react";

/** 素材包内的图标标识（通用图标与业务图标，等于 SVG 文件名去掉扩展名） */
export type UiV2IconName =
  | "action-close"
  | "action-download"
  | "action-expand"
  | "action-filter"
  | "action-pause"
  | "action-play"
  | "action-refresh"
  | "action-save"
  | "action-search"
  | "action-send"
  | "action-settings"
  | "action-upload"
  | "asset-file"
  | "asset-folder"
  | "asset-image"
  | "asset-video"
  | "identity-agent"
  | "identity-user"
  | "nav-capture"
  | "nav-knowledge"
  | "nav-mapping"
  | "nav-model"
  | "nav-orders"
  | "nav-overview"
  | "nav-report"
  | "nav-twin"
  | "status-device-offline"
  | "status-error"
  | "status-lock"
  | "status-offline"
  | "status-running"
  | "status-success"
  | "status-warning"
  | "biz-data-cleaning"
  | "biz-gaussian-scene"
  | "biz-handheld-scanner-alt"
  | "biz-handheld-scanner"
  | "biz-inspection-cart"
  | "biz-manual-mark"
  | "biz-material-adapt"
  | "biz-multimodal"
  | "biz-package-verify"
  | "biz-sample-group"
  | "biz-timber-column";

export const UI_V2_ICON_NAMES: readonly UiV2IconName[] = [
  "action-close",
  "action-download",
  "action-expand",
  "action-filter",
  "action-pause",
  "action-play",
  "action-refresh",
  "action-save",
  "action-search",
  "action-send",
  "action-settings",
  "action-upload",
  "asset-file",
  "asset-folder",
  "asset-image",
  "asset-video",
  "identity-agent",
  "identity-user",
  "nav-capture",
  "nav-knowledge",
  "nav-mapping",
  "nav-model",
  "nav-orders",
  "nav-overview",
  "nav-report",
  "nav-twin",
  "status-device-offline",
  "status-error",
  "status-lock",
  "status-offline",
  "status-running",
  "status-success",
  "status-warning",
  "biz-data-cleaning",
  "biz-gaussian-scene",
  "biz-handheld-scanner-alt",
  "biz-handheld-scanner",
  "biz-inspection-cart",
  "biz-manual-mark",
  "biz-material-adapt",
  "biz-multimodal",
  "biz-package-verify",
  "biz-sample-group",
  "biz-timber-column",
];

/** 素材包文件 → 来源路径（供清单核对与验收追溯） */
export const UI_V2_ICON_SOURCE: Readonly<Record<UiV2IconName, string>> = {
  "action-close": "icons/common/action-close.svg",
  "action-download": "icons/common/action-download.svg",
  "action-expand": "icons/common/action-expand.svg",
  "action-filter": "icons/common/action-filter.svg",
  "action-pause": "icons/common/action-pause.svg",
  "action-play": "icons/common/action-play.svg",
  "action-refresh": "icons/common/action-refresh.svg",
  "action-save": "icons/common/action-save.svg",
  "action-search": "icons/common/action-search.svg",
  "action-send": "icons/common/action-send.svg",
  "action-settings": "icons/common/action-settings.svg",
  "action-upload": "icons/common/action-upload.svg",
  "asset-file": "icons/common/asset-file.svg",
  "asset-folder": "icons/common/asset-folder.svg",
  "asset-image": "icons/common/asset-image.svg",
  "asset-video": "icons/common/asset-video.svg",
  "identity-agent": "icons/common/identity-agent.svg",
  "identity-user": "icons/common/identity-user.svg",
  "nav-capture": "icons/common/nav-capture.svg",
  "nav-knowledge": "icons/common/nav-knowledge.svg",
  "nav-mapping": "icons/common/nav-mapping.svg",
  "nav-model": "icons/common/nav-model.svg",
  "nav-orders": "icons/common/nav-orders.svg",
  "nav-overview": "icons/common/nav-overview.svg",
  "nav-report": "icons/common/nav-report.svg",
  "nav-twin": "icons/common/nav-twin.svg",
  "status-device-offline": "icons/common/status-device-offline.svg",
  "status-error": "icons/common/status-error.svg",
  "status-lock": "icons/common/status-lock.svg",
  "status-offline": "icons/common/status-offline.svg",
  "status-running": "icons/common/status-running.svg",
  "status-success": "icons/common/status-success.svg",
  "status-warning": "icons/common/status-warning.svg",
  "biz-data-cleaning": "icons/business/biz-data-cleaning.svg",
  "biz-gaussian-scene": "icons/business/biz-gaussian-scene.svg",
  "biz-handheld-scanner-alt": "icons/business/biz-handheld-scanner-alt.svg",
  "biz-handheld-scanner": "icons/business/biz-handheld-scanner.svg",
  "biz-inspection-cart": "icons/business/biz-inspection-cart.svg",
  "biz-manual-mark": "icons/business/biz-manual-mark.svg",
  "biz-material-adapt": "icons/business/biz-material-adapt.svg",
  "biz-multimodal": "icons/business/biz-multimodal.svg",
  "biz-package-verify": "icons/business/biz-package-verify.svg",
  "biz-sample-group": "icons/business/biz-sample-group.svg",
  "biz-timber-column": "icons/business/biz-timber-column.svg",
};

/**
 * 16px 专用简化版（PRD §3.2 点名的五枚）。
 *
 * 键是它服务的**标准图标名**，值是素材包里对应的简化版文件：
 *   action-expand ← icons/small/action-expand-small.svg
 *   biz-material-adapt ← icons/small/biz-material-adapt-small.svg
 *   biz-multimodal ← icons/small/biz-multimodal-small.svg
 *   biz-sample-group ← icons/small/biz-sample-group-small.svg
 *   nav-report ← icons/small/nav-report-small.svg
 *
 * 其余图标名在 size=16 时回退到标准版，不显示空白（PRD §3.2）。
 */
export const UI_V2_SMALL_SOURCE: Readonly<Record<string, string>> = {
  "action-expand": "icons/small/action-expand-small.svg",
  "biz-material-adapt": "icons/small/biz-material-adapt-small.svg",
  "biz-multimodal": "icons/small/biz-multimodal-small.svg",
  "biz-sample-group": "icons/small/biz-sample-group-small.svg",
  "nav-report": "icons/small/nav-report-small.svg",
};

export const UI_V2_SMALL_PATHS: Readonly<Record<string, ReactNode>> = {
  "action-expand": (
    <>
  <path d="M8 4H4v4m12-4h4v4M8 20H4v-4m12 4h4v-4" />
    </>
  ),
  "biz-material-adapt": (
    <>
  <rect x="3" y="5" width="8" height="14" rx="1" />
  <path d="M16 5v14m-3-6h6" />
  <circle cx="16" cy="13" r="1.5" />
    </>
  ),
  "biz-multimodal": (
    <>
  <rect x="3" y="5" width="7" height="6" rx="1" />
  <path d="M10 8h4l3 4" />
  <circle cx="19" cy="12" r="2" />
  <path d="M3 17h4l2-3 3 5" />
    </>
  ),
  "biz-sample-group": (
    <>
  <rect x="3" y="5" width="5" height="5" rx="1" />
  <rect x="9.5" y="14" width="5" height="5" rx="1" />
  <rect x="16" y="5" width="5" height="5" rx="1" />
    </>
  ),
  "nav-report": (
    <>
  <rect x="6" y="3" width="12" height="18" rx="1" />
  <path d="M9 17v-3m3 3V9m3 8v-5" />
    </>
  ),
};

export const UI_V2_ICON_PATHS: Readonly<Record<UiV2IconName, ReactNode>> = {
  "action-close": (
    <>
  <path d="M5 5l14 14M19 5 5 19" />
    </>
  ),
  "action-download": (
    <>
  <path d="M12 4v11m-4-4 4 4 4-4" />
  <path d="M5 18v2h14v-2" />
    </>
  ),
  "action-expand": (
    <>
  <path d="M9 4H4v5m11-5h5v5M9 20H4v-5m11 5h5v-5" />
  <path d="m4 4 5 5m11-5-5 5M4 20l5-5m11 5-5-5" />
    </>
  ),
  "action-filter": (
    <>
  <path d="M3 5h18l-7 8v6l-4 2v-8z" />
    </>
  ),
  "action-pause": (
    <>
  <path d="M8 5v14m8-14v14" />
    </>
  ),
  "action-play": (
    <>
  <path d="m8.5 5 11 7-11 7z" />
    </>
  ),
  "action-refresh": (
    <>
  <path d="M20 7v5h-5" />
  <path d="M19 12a7 7 0 1 0-2 5" />
  <path d="m20 7-3-3" />
    </>
  ),
  "action-save": (
    <>
  <path d="M5 3h12l2 2v16H5z" />
  <path d="M8 3v5h7V3" />
  <rect x="8" y="14" width="8" height="7" rx="1" />
    </>
  ),
  "action-search": (
    <>
  <circle cx="10.5" cy="10.5" r="6.5" />
  <path d="m15.5 15.5 5 5" />
    </>
  ),
  "action-send": (
    <>
  <path d="m3 11 18-8-7 18-3-7z" />
  <path d="m11 14 4-5" />
    </>
  ),
  "action-settings": (
    <>
  <circle cx="12" cy="12" r="3" />
  <path d="M9.5 3h5l.5 2 1.8 1 2-.6 2.5 4.3-1.5 1.4v1.8l1.5 1.4-2.5 4.3-2-.6-1.8 1-.5 2h-5l-.5-2-1.8-1-2 .6-2.5-4.3 1.5-1.4v-1.8L2.7 9.7l2.5-4.3 2 .6L9 5z" />
    </>
  ),
  "action-upload": (
    <>
  <path d="M12 15V4m-4 4 4-4 4 4" />
  <path d="M5 18v2h14v-2" />
    </>
  ),
  "asset-file": (
    <>
  <path d="M6 3h8l4 4v14H6z" />
  <path d="M14 3v5h4" />
    </>
  ),
  "asset-folder": (
    <>
  <path d="M3 5h7l2 2h9v13H3z" />
  <path d="M3 8h18" />
    </>
  ),
  "asset-image": (
    <>
  <rect x="3" y="4" width="18" height="16" rx="2" />
  <circle cx="9" cy="9" r="1.5" />
  <path d="m5 17 5-5 3 3 2-2 4 4" />
    </>
  ),
  "asset-video": (
    <>
  <rect x="3" y="5" width="18" height="14" rx="2" />
  <path d="m10 9 6 3-6 3z" />
    </>
  ),
  "identity-agent": (
    <>
  <rect x="5" y="5" width="14" height="14" rx="4" />
  <path d="M9 12h6" />
  <path d="M8 19v2m8-2v2" />
    </>
  ),
  "identity-user": (
    <>
  <circle cx="12" cy="8" r="4" />
  <path d="M4.5 21a7.5 7.5 0 0 1 15 0" />
    </>
  ),
  "nav-capture": (
    <>
  <path d="M4 9V5a1 1 0 0 1 1-1h4m6 0h4a1 1 0 0 1 1 1v4m0 6v4a1 1 0 0 1-1 1h-4m-6 0H5a1 1 0 0 1-1-1v-4" />
  <circle cx="12" cy="12" r="3" />
  <circle cx="12" cy="12" r=".5" />
    </>
  ),
  "nav-knowledge": (
    <>
  <path d="M4 5.5c2.7-.8 5-.2 8 1.8v12c-3-2-5.3-2.6-8-1.8z" />
  <path d="M20 5.5c-2.7-.8-5-.2-8 1.8v12c3-2 5.3-2.6 8-1.8z" />
  <circle cx="12" cy="4" r="1" />
    </>
  ),
  "nav-mapping": (
    <>
  <path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3z" />
  <path d="M9 3v15m6-12v15" />
  <circle cx="15" cy="11" r="2" />
  <path d="M15 13v2" />
    </>
  ),
  "nav-model": (
    <>
  <rect x="9" y="9" width="6" height="6" rx="1" />
  <circle cx="5" cy="6" r="2" />
  <circle cx="19" cy="6" r="2" />
  <circle cx="5" cy="18" r="2" />
  <circle cx="19" cy="18" r="2" />
  <path d="m6.5 7.5 2.5 2m6-1 2.5-1.5M6.5 16.5 9 14m6 0 2.5 2.5" />
    </>
  ),
  "nav-orders": (
    <>
  <path d="M9 4h6" />
  <path d="M9 3h6v3H9z" />
  <rect x="5" y="4" width="14" height="17" rx="2" />
  <path d="m8 11 1.5 1.5L12 10m-4 6h8" />
    </>
  ),
  "nav-overview": (
    <>
  <rect x="3" y="3" width="18" height="18" rx="2" />
  <path d="M7 16v-4m5 4V8m5 8v-6" />
  <path d="M6 7h4" />
    </>
  ),
  "nav-report": (
    <>
  <path d="M6 3h8l4 4v14H6z" />
  <path d="M14 3v5h4" />
  <path d="M9 17v-3m3 3v-6m3 6v-4" />
    </>
  ),
  "nav-twin": (
    <>
  <path d="m7 4 4 2.3v4.6L7 13l-4-2.1V6.3z" />
  <path d="m17 11 4 2.3v4.6L17 20l-4-2.1v-4.6z" />
  <path d="M10 11.5 14 13m-4-6 4-1.5" />
    </>
  ),
  "status-device-offline": (
    <>
  <path d="M8 8 5 5m11 11 3 3" />
  <path d="M9 5h3v4l3 3-3 3v4H9v-4H6v-6h3z" />
  <path d="M3 3l18 18" />
    </>
  ),
  "status-error": (
    <>
  <circle cx="12" cy="12" r="9" />
  <path d="m8 8 8 8m0-8-8 8" />
    </>
  ),
  "status-lock": (
    <>
  <rect x="5" y="10" width="14" height="11" rx="2" />
  <path d="M8 10V7a4 4 0 0 1 8 0v3" />
  <circle cx="12" cy="15" r="1" />
    </>
  ),
  "status-offline": (
    <>
  <path d="M5 17h12a4 4 0 0 0 1-7.9A6 6 0 0 0 7 7.4 4.5 4.5 0 0 0 5 17z" />
  <path d="M3 3l18 18" />
    </>
  ),
  "status-running": (
    <>
  <path d="M18.4 5.6A9 9 0 1 0 20.5 15" />
  <path d="M20 8V4h-4" />
    </>
  ),
  "status-success": (
    <>
  <circle cx="12" cy="12" r="9" />
  <path d="m7.5 12 3 3 6-7" />
    </>
  ),
  "status-warning": (
    <>
  <path d="M12 3 22 20H2z" />
  <path d="M12 9v5m0 3v.2" />
    </>
  ),
  "biz-data-cleaning": (
    <>
  <path d="M3 7h7m-7 4h7" />
  <path d="M10 5h11l-4 5v5l-3 2v-7z" />
  <path d="M14 20h7" />
    </>
  ),
  "biz-gaussian-scene": (
    <>
  <path d="m4 17 4-8 5-3 7 4v8H4z" />
  <path d="m8 9 5 4 7-3" />
  <circle cx="7" cy="15" r=".8" />
  <circle cx="13" cy="10" r=".8" />
  <circle cx="18" cy="15" r=".8" />
    </>
  ),
  "biz-handheld-scanner-alt": (
    <>
  <rect x="7" y="4" width="10" height="7" rx="1" />
  <circle cx="12" cy="7.5" r="1.5" />
  <path d="M12 11v7M8 21l4-3 4 3" />
  <path d="M7 13h10" />
    </>
  ),
  "biz-handheld-scanner": (
    <>
  <path d="M9 4h7v7H9z" />
  <path d="M10 11h5l1 9H9z" />
  <path d="M11 6h3" />
  <path d="M7 5H5v14h3" />
  <path d="M16 7h2v5" />
    </>
  ),
  "biz-inspection-cart": (
    <>
  <path d="M4 11h13l3 3v3H4z" />
  <circle cx="7" cy="19" r="2" />
  <circle cx="17" cy="19" r="2" />
  <path d="M12 11V6" />
  <rect x="10" y="4" width="4" height="2" rx="1" />
  <path d="M6 14h4" />
    </>
  ),
  "biz-manual-mark": (
    <>
  <path d="m5 19 1-4 9-9 3 3-9 9z" />
  <path d="m13.5 7.5 3 3M5 19l4-1" />
  <circle cx="18.5" cy="18.5" r="1.5" />
  <path d="M15 21h7v-7" />
    </>
  ),
  "biz-material-adapt": (
    <>
  <rect x="3" y="5" width="8" height="14" rx="1" />
  <path d="M6 8v3m2 2v3" />
  <path d="M15 6v12m5-12v12" />
  <circle cx="15" cy="10" r="1.5" />
  <circle cx="20" cy="14" r="1.5" />
    </>
  ),
  "biz-multimodal": (
    <>
  <rect x="3" y="5" width="7" height="6" rx="1" />
  <path d="m4.5 9 2-2 2 2" />
  <path d="M3 17h2l1-3 2 5 2-3h2" />
  <path d="M10 8c4 0 4 4 7 4m-5 5c2 0 2-5 5-5" />
  <circle cx="19" cy="12" r="2" />
    </>
  ),
  "biz-package-verify": (
    <>
  <path d="m4 7 8-4 8 4v9l-8 5-8-5z" />
  <path d="m4 7 8 5 8-5M12 12v9" />
  <path d="m14.5 16 1.5 1.5 3-3" />
    </>
  ),
  "biz-sample-group": (
    <>
  <rect x="3" y="5" width="5" height="5" rx="1" />
  <rect x="9.5" y="12" width="5" height="5" rx="1" />
  <rect x="16" y="5" width="5" height="5" rx="1" />
  <path d="M5.5 12v7h11v-7" />
    </>
  ),
  "biz-timber-column": (
    <>
  <path d="M8 4h8v14H8z" />
  <path d="M6 3h12v2H6z" />
  <path d="M6 18h12l1 3H5z" />
  <path d="M12 7c-1 2 1 3 0 6" />
    </>
  ),
};
