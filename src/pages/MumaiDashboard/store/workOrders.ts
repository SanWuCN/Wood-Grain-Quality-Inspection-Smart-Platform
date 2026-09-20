/**
 * 木脉智检 · 工单域客户端 store
 *
 * 服务端（`server/services/work-orders.mjs`）是唯一权威：这里的每一次写都等服务端
 * 返回之后才更新本地，失败就把 `{code, message, fieldErrors}` 原样抛给页面 ——
 * 和共享状态 store 同一条规矩（写操作不本地先行）。
 *
 * 为什么单独一个 store 而不是塞进 `store/shared.ts`：工单是**按单**的业务实体，
 * 它的列表还要和演示回放的老工单并排显示；共享快照那条路是按会话拉全量的，
 * 把工单塞进去会让每次事件刷新都多搬一份与当前选中单无关的数据。
 */

import { create } from "zustand";
import {
  api,
  isApiError,
  type ApiError,
  type WorkOrderAction,
  type WorkOrderDetail,
  type WorkOrderFilter,
  type WorkOrderSummary,
  type WorkOrderTriggerResult,
} from "../api/client";

export type WorkOrderState = {
  orders: WorkOrderSummary[];
  detail: WorkOrderDetail | null;
  filter: WorkOrderFilter;
  query: string;
  loading: boolean;
  /** 触发建单正在进行：按住快捷键不放时不能重复提交（PRD §3.1） */
  triggering: boolean;
  error: ApiError | null;

  refresh: () => Promise<void>;
  select: (orderId: string) => Promise<void>;
  setFilter: (filter: WorkOrderFilter) => void;
  setQuery: (query: string) => void;
  trigger: (eventId: string) => Promise<WorkOrderTriggerResult | null>;
  assign: (
    orderId: string,
    body: { leaderAccountId: string; members: { accountId: string; duties: string[] }[]; expectedRevision: number },
  ) => Promise<WorkOrderDetail>;
  /** 返回整个响应：`knowledge` 是服务端顺带做的事（归档 → 登进知识库），没有就是 null */
  setStatus: (
    orderId: string,
    action: WorkOrderAction,
    expectedRevision?: number,
  ) => Promise<{
    detail: WorkOrderDetail;
    knowledge?: { assetId?: string; created?: boolean; revision?: number; jobId?: string | null; error?: string } | null;
  }>;
  saveEnvironment: (
    orderId: string,
    body: Parameters<typeof api.saveWorkOrderEnvironment>[1],
  ) => Promise<WorkOrderDetail>;
  validateEnvironment: (orderId: string, expectedRevision: number) => Promise<WorkOrderDetail>;
  dispatch: (orderId: string, body: { deviceId: string; configVersion?: string | null; idempotencyKey: string }) => Promise<WorkOrderDetail>;
  remove: (orderId: string) => Promise<void>;
  reset: () => void;
};

const toApiError = (error: unknown): ApiError =>
  isApiError(error)
    ? error
    : { status: 0, code: "UNKNOWN", message: error instanceof Error ? error.message : "操作失败", fieldErrors: [], retryable: false };

export const useWorkOrderStore = create<WorkOrderState>()((set, get) => ({
  orders: [],
  detail: null,
  filter: "all",
  query: "",
  loading: false,
  triggering: false,
  error: null,

  async refresh() {
    set({ loading: true });
    try {
      const { filter, query } = get();
      const result = await api.workOrders(filter, query);
      set({ orders: result.orders, loading: false, error: null });
    } catch (error) {
      set({ loading: false, error: toApiError(error) });
    }
  },

  async select(orderId) {
    if (!orderId) {
      set({ detail: null });
      return;
    }
    try {
      const detail = await api.workOrder(orderId);
      set({ detail, error: null });
    } catch (error) {
      set({ error: toApiError(error) });
    }
  },

  setFilter(filter) {
    // 只改状态：拉列表由页面的 effect 统一做（筛选与搜索是同一条路，不各写一遍）
    set({ filter });
  },

  setQuery(query) {
    set({ query });
  },

  /**
   * 触发建单。
   *
   * 同一个 `eventId` 重试会拿到同一张工单（服务端幂等），所以这里失败不换 ID ——
   * 换 ID 就等于把一次按键变成两张单。
   */
  async trigger(eventId) {
    if (get().triggering) return null;
    set({ triggering: true });
    try {
      const result = await api.triggerWorkOrder(eventId);
      await get().refresh();
      set({ detail: result.detail, triggering: false, error: null });
      return result;
    } catch (error) {
      set({ triggering: false, error: toApiError(error) });
      return null;
    }
  },

  async assign(orderId, body) {
    const result = await api.assignWorkOrder(orderId, body);
    set({ detail: result.detail });
    await get().refresh();
    return result.detail;
  },

  async setStatus(orderId, action, expectedRevision) {
    const result = await api.setWorkOrderStatus(orderId, action, expectedRevision);
    set({ detail: result.detail });
    await get().refresh();
    /* 整个响应都交回调用方：归档会顺带登进知识库，页面要能把这件事说出来 */
    return result;
  },

  async saveEnvironment(orderId, body) {
    await api.saveWorkOrderEnvironment(orderId, body);
    const detail = await api.workOrder(orderId);
    set({ detail });
    return detail;
  },

  async validateEnvironment(orderId, expectedRevision) {
    await api.validateWorkOrderEnvironment(orderId, expectedRevision);
    const detail = await api.workOrder(orderId);
    set({ detail });
    await get().refresh();
    return detail;
  },

  async dispatch(orderId, body) {
    await api.dispatchWorkOrder(orderId, body);
    const detail = await api.workOrder(orderId);
    set({ detail });
    await get().refresh();
    return detail;
  },

  /**
   * 删除工单。
   *
   * 删完必须**清掉详情并重拉列表**：留着已删工单的详情，页面会继续显示一张
   * 服务端已经查不到的工单，点任何按钮都是 404。
   */
  async remove(orderId) {
    await api.deleteWorkOrder(orderId);
    const wasSelected = get().detail?.order.id === orderId;
    if (wasSelected) set({ detail: null });
    await get().refresh();
  },

  reset() {
    set({ orders: [], detail: null, error: null, filter: "all", query: "" });
  },
}));

/** 工单事件（服务端广播）→ 需要刷新列表与当前详情 */
export function isWorkOrderEvent(type: string | undefined): boolean {
  return Boolean(type && type.startsWith("workOrder."));
}
