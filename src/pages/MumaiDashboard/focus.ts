/**
 * 展示焦点 · 大屏当前演示对象与视图（PRD 2.2 / 评审 F13）
 *
 * 评审的原文是「展示窗口始终是全国地图与统计卡，没有同步当前场景、曲线或训练页」，
 * 要求「投屏传递 viewType 和对象 ID，展示窗口渲染对应业务视图」。
 *
 * 这一版把焦点从 localStorage 搬到服务端：
 *   - 原来用 localStorage + BroadcastChannel，PRD §5.3 明确说它**只管同一个浏览器
 *     存储分区内的窗口**，四台电脑之间传不过去；而投屏恰恰是跨电脑的动作。
 *   - 现在写 `projection.set` 命令、读会话快照里的 projection，与配置、场景、产物
 *     走同一条命令总线与事件流，任何一台电脑上的 /present 看到的都是同一份。
 *   - 持有人规则由服务端执行：非持有人切换会被 409 拒掉，页面据此说明「当前由谁持有」。
 *
 * 只存「当前展示什么」的标识，不复制业务数据 —— 工单、构件、批次、场景的完整内容
 * 仍由各自的页面与 seed 提供。
 */

import { isApiError } from "./api/client";
import { actorName } from "./api/accounts";
import { useSharedStore } from "./store/shared";
import { COMPONENTS, SCAN_BATCHES, WORK_ORDER } from "./seed/scenario";

/** 展示视图类型（评审 §3.10 点名的六种 + 一个工作区兜底） */
export type PresentViewType = "map" | "scene" | "capture" | "training" | "delivery" | "report" | "workspace";

export const VIEW_LABEL: Record<PresentViewType, string> = {
  map: "全国总览",
  scene: "数字孪生场景",
  capture: "采集作业",
  training: "训练验证",
  delivery: "更新交付",
  report: "报告归档",
  workspace: "当前工作区",
};

export type PresentFocus = {
  viewType: PresentViewType;
  /** 展示控制权持有人（账号 id）；null 表示还没人持有 */
  holderId: string | null;
  orderId: string;
  componentId: string;
  batchId: string;
  sceneId: string | null;
  /** 最近一次投放时间（服务端时间戳，ISO） */
  deliveredAt: string;
};

/** 路由 → 展示视图。投屏按钮按当前所在页面决定大屏显示什么 */
export function viewTypeForPath(pathname: string): PresentViewType {
  switch (pathname) {
    case "/":
      return "map";
    case "/twin":
      return "scene";
    case "/hardware":
      return "capture";
    case "/firmware":
      return "training";
    case "/archive":
      return "report";
    default:
      // 工单 / 建图 / 知识库没有对应的展示形态，用工作区视图把当前焦点讲清楚
      return "workspace";
  }
}

/** 控制权持有人显示名（账号表是唯一来源） */
export function holderLabel(holderId: string | null): string {
  return holderId ? actorName(holderId) : "尚未指定";
}

export function defaultFocus(): PresentFocus {
  return {
    viewType: "map",
    holderId: null,
    orderId: WORK_ORDER.id,
    componentId: WORK_ORDER.componentIds[0] ?? COMPONENTS[0].id,
    batchId: SCAN_BATCHES[0]?.batchId ?? "",
    sceneId: null,
    deliveredAt: "",
  };
}

/*
 * focusIds 是 PRD §6 给的 `string[]`，这里用带标签的短串承载结构化焦点。
 * 不改成对象数组是为了不动服务端契约（Projection 的字段已经在 PRD 里写死）；
 * 带标签也让日志与事件里的内容自解释，不用回头查是哪一位。
 */
function encodeFocus(focus: PresentFocus): string[] {
  const entries = [
    `order:${focus.orderId}`,
    `component:${focus.componentId}`,
    `batch:${focus.batchId}`,
  ];
  if (focus.sceneId) entries.push(`scene:${focus.sceneId}`);
  return entries.filter((entry) => !entry.endsWith(":"));
}

function decodeFocus(ids: readonly string[], fallback: PresentFocus): PresentFocus {
  const next = { ...fallback };
  for (const entry of ids) {
    const separator = entry.indexOf(":");
    if (separator <= 0) continue;
    const tag = entry.slice(0, separator);
    const value = entry.slice(separator + 1);
    if (tag === "order") next.orderId = value;
    else if (tag === "component") next.componentId = value;
    else if (tag === "batch") next.batchId = value;
    else if (tag === "scene") next.sceneId = value;
  }
  return next;
}

/** 本端大屏当前的完整焦点：服务端 projection + 本地补齐的默认值 */
export function currentFocus(state = useSharedStore.getState()): PresentFocus {
  const projection = state.projection;
  return decodeFocus(projection.focusIds ?? [], {
    ...defaultFocus(),
    viewType: (projection.viewType as PresentViewType) ?? "map",
    holderId: projection.holderId,
    deliveredAt: projection.updatedAt ?? "",
  });
}

/**
 * 投放：把「显示什么 + 看哪个对象」写到服务端。
 *
 * 返回 null 表示失败（例如不是持有人），错误信息由调用方展示 ——
 * 这里不吞异常，也不假装成功：评审明确要求「成功反馈与实际动作一致」。
 */
export async function writeFocus(
  patch: Partial<PresentFocus> & { holderId: string; hold?: boolean },
): Promise<{ ok: true; focus: PresentFocus } | { ok: false; message: string; holderId?: string }> {
  const store = useSharedStore.getState();
  const next: PresentFocus = { ...currentFocus(store), ...patch };
  try {
    await store.setProjection(next.viewType, encodeFocus(next), patch.hold === true);
    return { ok: true, focus: currentFocus() };
  } catch (error) {
    if (isApiError(error)) {
      const holderId = typeof error.holderId === "string" ? error.holderId : undefined;
      return { ok: false, message: error.message, holderId };
    }
    return { ok: false, message: "投放失败：连接不上共享服务" };
  }
}

/** 大屏端订阅：读服务端 projection，事件到达时 store 会自动重拉 */
export function usePresentFocus(): PresentFocus {
  const projection = useSharedStore((state) => state.projection);
  return decodeFocus(projection.focusIds ?? [], {
    ...defaultFocus(),
    viewType: (projection.viewType as PresentViewType) ?? "map",
    holderId: projection.holderId,
    deliveredAt: projection.updatedAt ?? "",
  });
}

export function usePresentOnline(): boolean {
  return useSharedStore((state) => state.status === "online");
}
