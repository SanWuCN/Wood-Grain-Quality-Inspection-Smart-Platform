/**
 * 数据与知识中心 · 接口封装
 *
 * 依据：PRD §12.4（接口表）、§12.5（事务、事件与客户端恢复）。
 *
 * 三条与平台其它页面一致的约定，这里**不重新发明**：
 *   1. 读接口走 /api/knowledge/*，写操作一律走命令总线（带 commandId 幂等）；
 *   2. 事件只当变化通知：收到 knowledge.* 事件后按同一 seq 重拉总览快照，
 *      不做「本地总数 +1」（PRD §12.5 明确禁止）；
 *   3. 错误原样抛出，页面负责显示服务端给的 code / message。
 */

import { api as baseApi, isApiError, type ApiError } from "../api/client";
import type {
  AssetDetail,
  AssetFilters,
  AssetPage,
  FixtureReport,
  GraphView,
  IndexConfig,
  IndexVersionRow,
  JobDetail,
  KnowledgeJob,
  Overview,
  RelationGraphData,
  SearchHit,
  SearchResult,
} from "./types";

/* ------------------------------------------------------------------ *
 * 请求（复用 client.ts 的 request，不另开一条链路）
 * ------------------------------------------------------------------ */

/** 与 client.ts 内部同构的最小请求器：只补 knowledge 前缀与查询串 */
async function kbRequest<T>(path: string, init?: RequestInit): Promise<T> {
  // baseApi 没有暴露泛型 request，这里用它的 health() 同款走法：直接 fetch + 同源相对路径。
  const { readToken } = await import("../api/client");
  const token = readToken();
  const headers = new Headers(init?.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (init?.body && !headers.has("content-type")) headers.set("content-type", "application/json");

  let response: Response;
  try {
    response = await fetch(path, { ...init, headers });
  } catch (error) {
    throw {
      status: 0,
      code: "OFFLINE",
      message: "连接不上共享服务，请确认服务已启动",
      fieldErrors: [],
      retryable: true,
      cause: error instanceof Error ? error.message : String(error),
    } satisfies ApiError;
  }
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { message: text };
    }
  }
  if (!response.ok) {
    const record = (body ?? {}) as Record<string, unknown>;
    throw {
      status: response.status,
      code: typeof record.code === "string" ? record.code : "UNKNOWN",
      message: typeof record.message === "string" ? record.message : `请求失败（HTTP ${response.status}）`,
      fieldErrors: Array.isArray(record.fieldErrors) ? (record.fieldErrors as ApiError["fieldErrors"]) : [],
      retryable: record.retryable === true,
      ...record,
    } satisfies ApiError;
  }
  return body as T;
}

function qs(params: Record<string, string | number | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === "") continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

export const knowledgeApi = {
  overview(sessionId: string, projectId?: string) {
    return kbRequest<Overview>(`/api/knowledge/overview${qs({ sessionId, projectId })}`);
  },

  assets(sessionId: string, filters: AssetFilters = {}, projectId?: string) {
    return kbRequest<AssetPage>(
      `/api/knowledge/assets${qs({
        sessionId,
        projectId,
        type: filters.type ?? undefined,
        q: filters.query,
        objectId: filters.objectId ?? undefined,
        source: filters.source ?? undefined,
        category: filters.category ?? undefined,
        state: filters.indexState ?? undefined,
        from: filters.timeFrom ?? undefined,
        to: filters.timeTo ?? undefined,
        cursor: filters.cursor ?? undefined,
        limit: filters.limit ?? 50,
      })}`,
    );
  },

  asset(sessionId: string, assetId: string) {
    return kbRequest<AssetDetail>(`/api/knowledge/assets/${encodeURIComponent(assetId)}${qs({ sessionId })}`);
  },

  graph(
    sessionId: string,
    options: { view?: GraphView; focusId?: string | null; depth?: number; full?: boolean; projectId?: string } = {},
  ) {
    return kbRequest<RelationGraphData>(
      `/api/knowledge/graph${qs({
        sessionId,
        projectId: options.projectId,
        view: options.view ?? "business",
        focusId: options.focusId ?? undefined,
        depth: options.depth ?? 1,
        full: options.full ? 1 : undefined,
      })}`,
    );
  },

  indexes(sessionId: string, projectId?: string) {
    return kbRequest<{
      servingVersion: string | null;
      configRevision: string;
      adapterMode: string;
      dimensionConfig: number;
      status: Overview["indexStatus"];
      versions: IndexVersionRow[];
      config: IndexConfig | null;
      configs: { revision: string; createdBy: string | null; createdAt: string }[];
      coverage: Overview["coverage"];
      chunksByType: { type: string; label: string; chunks: number }[];
      vectorCount: number;
    }>(`/api/knowledge/indexes${qs({ sessionId, projectId })}`);
  },

  jobs(sessionId: string, status?: string) {
    return kbRequest<{ jobs: KnowledgeJob[] }>(`/api/knowledge/jobs${qs({ sessionId, status })}`);
  },

  job(sessionId: string, jobId: string) {
    return kbRequest<JobDetail>(`/api/knowledge/jobs/${encodeURIComponent(jobId)}${qs({ sessionId })}`);
  },

  search(
    sessionId: string,
    query: string,
    options: { filters?: Record<string, string>; topK?: number; version?: string | null; projectId?: string } = {},
  ) {
    return kbRequest<SearchResult>("/api/knowledge/search", {
      method: "POST",
      body: JSON.stringify({
        sessionId,
        query,
        filters: options.filters ?? {},
        topK: options.topK ?? null,
        version: options.version ?? null,
        projectId: options.projectId,
      }),
    });
  },

  fixture(sessionId: string) {
    return kbRequest<FixtureReport>(`/api/knowledge/fixture${qs({ sessionId })}`);
  },
};

/* ------------------------------------------------------------------ *
 * 写操作（全部走命令总线，保持 commandId 幂等）
 * ------------------------------------------------------------------ */

let commandSeq = 0;
function commandId(action: string, entityId: string | null): string {
  commandSeq += 1;
  return `cmd-${action}-${entityId ?? "none"}-${Date.now().toString(36)}-${commandSeq}`;
}

type CommandBody = {
  action: string;
  sessionId: string;
  entityId?: string | null;
  expectedRevision?: number | null;
  payload?: Record<string, unknown>;
  commandId?: string;
};

export type KnowledgeCommandResult<T = Record<string, unknown>> = {
  replayed: boolean;
  action: string;
  result: T & { started?: boolean; jobId?: string; assetId?: string; reason?: string };
  entityKind: string;
  entity: { id: string; revision: number; data: Record<string, unknown>; updatedAt: string } | null;
  eventSeq: number;
};

export const knowledgeCommands = {
  send<T = Record<string, unknown>>(body: CommandBody) {
    return baseApi.command<KnowledgeCommandResult<T>>({
      action: body.action,
      sessionId: body.sessionId,
      entityId: body.entityId ?? null,
      expectedRevision: body.expectedRevision ?? null,
      payload: body.payload ?? {},
      commandId: body.commandId ?? commandId(body.action, body.entityId ?? null),
    });
  },

  register(sessionId: string, payload: Record<string, unknown>) {
    return knowledgeCommands.send({ action: "asset.register", sessionId, payload });
  },

  revise(sessionId: string, assetId: string, payload: Record<string, unknown>) {
    return knowledgeCommands.send({ action: "asset.revise", sessionId, entityId: assetId, payload });
  },

  updateMetadata(sessionId: string, assetId: string, payload: Record<string, unknown>) {
    return knowledgeCommands.send({ action: "asset.updateMetadata", sessionId, entityId: assetId, payload });
  },

  setInclusion(sessionId: string, assetId: string, include: boolean) {
    return knowledgeCommands.send({ action: "asset.setInclusion", sessionId, entityId: assetId, payload: { include } });
  },

  remove(sessionId: string, assetId: string) {
    return knowledgeCommands.send({ action: "asset.delete", sessionId, entityId: assetId, payload: {} });
  },

  /** 更新索引：scope = backlog（积压）/ errors（失败重试）/ all（全量重建）/ changed（指定资产） */
  sync(sessionId: string, payload: { scope?: string; assetIds?: string[]; triggerSource?: string; kind?: string } = {}) {
    return knowledgeCommands.send({ action: "knowledge.sync", sessionId, payload });
  },

  retry(sessionId: string) {
    return knowledgeCommands.send({ action: "knowledge.retry", sessionId, payload: {} });
  },

  cancel(sessionId: string, jobId: string) {
    return knowledgeCommands.send({ action: "knowledge.cancel", sessionId, entityId: jobId, payload: {} });
  },

  activateVersion(sessionId: string, version: string) {
    return knowledgeCommands.send({ action: "knowledge.activateVersion", sessionId, payload: { version } });
  },

  configure(sessionId: string, patch: Record<string, unknown>) {
    return knowledgeCommands.send({ action: "knowledge.configure", sessionId, payload: patch });
  },
};

export { isApiError };
export type { SearchHit };
