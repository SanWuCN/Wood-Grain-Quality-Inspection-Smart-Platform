/**
 * 数据与知识中心 · 数据钩子
 *
 * 依据：PRD §7.3（同一快照成组更新）、§12.5（事件与客户端恢复）、
 *      §16.4（不启动高频计数刷新）。
 *
 * 与 store/shared.ts 的关系：那边管会话快照（环境 / 任务 / 场景这类个位数实体），
 * 这边管知识域（万级行）。两者共用同一条 WebSocket 与同一个 sessionId，
 * 但**不共用缓存** —— 知识域的数据量不能跟着每次事件重拉。
 *
 * 关键规则：
 *   · 事件只当「有变化」的通知，收到后按 seq 重拉总览；分页列表按需失效；
 *   · 合并刷新上限约 4 次/秒（PRD §16.4），避免一批事件打出一串请求；
 *   · 没有运行中任务时不轮询；有运行时按 1.2 秒看一次任务，任务终态即停。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSharedStore } from "../store/shared";
import { knowledgeApi } from "./api";
import type { AssetDetail, AssetFilters, AssetPage, IndexVersionRow, KnowledgeJob, Overview, RelationGraphData, SearchResult } from "./types";

/** 事件合并窗口：120ms 内的事件只触发一次重拉（PRD §16.4 上限约 4 次/秒） */
const COALESCE_MS = 260;
/** 运行中任务的观察间隔：终态即停，不做常驻轮询 */
const JOB_POLL_MS = 1200;

export type KnowledgeData = {
  overview: Overview | null;
  versions: IndexVersionRow[];
  jobs: KnowledgeJob[];
  loading: boolean;
  error: string | null;
  lastSeq: number;
  reload: () => Promise<void>;
  /** 任务运行期间由页面显式开启观察，终态自动关闭 */
  watchJob: (jobId: string) => void;
  watchingJobId: string | null;
  /** 事件序号：用于判断「索引已更新，是否重新检索」 */
  events: number;
};

export function useKnowledgeOverview(): KnowledgeData {
  const sessionId = useSharedStore((state) => state.sessionId);
  const lastEvent = useSharedStore((state) => state.lastEvent);

  const [overview, setOverview] = useState<Overview | null>(null);
  const [versions, setVersions] = useState<IndexVersionRow[]>([]);
  const [jobs, setJobs] = useState<KnowledgeJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [watchingJobId, setWatchingJobId] = useState<string | null>(null);
  const [events, setEvents] = useState(0);

  const timer = useRef(0);
  const inflight = useRef(false);

  const reload = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    try {
      const [next, jobList] = await Promise.all([
        knowledgeApi.overview(sessionId),
        knowledgeApi.jobs(sessionId),
      ]);
      setOverview(next);
      setVersions(next.versions);
      setJobs(jobList.jobs);
      setError(null);
    } catch (cause) {
      setError((cause as { message?: string })?.message ?? "读取知识中心失败");
    } finally {
      inflight.current = false;
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    setLoading(true);
    void reload();
  }, [reload]);

  /**
   * 事件驱动的重拉。
   *
   * 只认 knowledge.* 事件：别的领域（环境、任务、场景）动一下没必要重算 1,248 项资产。
   * 这一条是性能约束而不是功能约束 —— 平台其它页面共用同一条 ws。
   */
  useEffect(() => {
    if (!lastEvent) return;
    if (!String(lastEvent.type ?? "").startsWith("knowledge.")) return;
    setEvents((value) => value + 1);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      void reload();
    }, COALESCE_MS);
    return () => window.clearTimeout(timer.current);
  }, [lastEvent, reload]);

  // 任务运行期间短轮询；终态立刻停（PRD §16.4：无运行中任务时不启动高频刷新）
  useEffect(() => {
    if (!watchingJobId) return;
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      try {
        const detail = await knowledgeApi.job(sessionId, watchingJobId);
        if (cancelled) return;
        setJobs((list) => [detail.job, ...list.filter((item) => item.id !== detail.job.id)]);
        const settled = ["成功", "部分成功", "失败", "已取消"].includes(detail.job.status);
        if (settled) {
          setWatchingJobId(null);
          await reload();
          return;
        }
      } catch {
        /* 单次读取失败不终止观察，下一拍再试 */
      }
      window.setTimeout(tick, JOB_POLL_MS);
    };
    void tick();
    return () => {
      cancelled = true;
    };
  }, [watchingJobId, sessionId, reload]);

  const watchJob = useCallback((jobId: string) => setWatchingJobId(jobId), []);

  return useMemo(
    () => ({ overview, versions, jobs, loading, error, lastSeq: overview?.snapshotSeq ?? 0, reload, watchJob, watchingJobId, events }),
    [overview, versions, jobs, loading, error, reload, watchJob, watchingJobId, events],
  );
}

/* ------------------------------------------------------------------ *
 * 资产分页
 * ------------------------------------------------------------------ */

export type AssetListState = {
  page: AssetPage | null;
  loading: boolean;
  error: string | null;
  /** 追加下一页（游标分页）。重复调用会被忽略，不会拉出重复项。 */
  loadMore: () => Promise<void>;
  reload: () => Promise<void>;
  reset: (filters: AssetFilters) => void;
  filters: AssetFilters;
  setFilters: (filters: AssetFilters) => void;
};

export function useAssetList(initial: AssetFilters = {}): AssetListState {
  const sessionId = useSharedStore((state) => state.sessionId);
  const [filters, setFilters] = useState<AssetFilters>({ limit: 50, ...initial });
  const [page, setPage] = useState<AssetPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSeq = useRef(0);

  const fetchPage = useCallback(
    async (nextFilters: AssetFilters, append: boolean) => {
      const seq = requestSeq.current + 1;
      requestSeq.current = seq;
      setLoading(true);
      try {
        const result = await knowledgeApi.assets(sessionId, nextFilters);
        // 只接受最后一次请求的结果：快速切换筛选时旧响应不能盖掉新结果
        if (seq !== requestSeq.current) return;
        setPage((current) =>
          append && current
            ? { ...result, items: [...current.items, ...result.items] }
            : result,
        );
        setError(null);
      } catch (cause) {
        if (seq !== requestSeq.current) return;
        setError((cause as { message?: string })?.message ?? "读取资产列表失败");
      } finally {
        if (seq === requestSeq.current) setLoading(false);
      }
    },
    [sessionId],
  );

  useEffect(() => {
    void fetchPage({ ...filters, cursor: null }, false);
    // filters 变化即重新从第一页取；filters 是整体替换的对象，不需要深比较
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, JSON.stringify(filters)]);

  const loadMore = useCallback(async () => {
    if (!page?.nextCursor || loading) return;
    await fetchPage({ ...filters, cursor: page.nextCursor }, true);
  }, [page, loading, filters, fetchPage]);

  const reload = useCallback(async () => {
    await fetchPage({ ...filters, cursor: null }, false);
  }, [filters, fetchPage]);

  return { page, loading, error, loadMore, reload, reset: setFilters, filters, setFilters };
}

/* ------------------------------------------------------------------ *
 * 资产详情 / 关系图 / 检索
 * ------------------------------------------------------------------ */

export function useAssetDetail(assetId: string | null) {
  const sessionId = useSharedStore((state) => state.sessionId);
  const [detail, setDetail] = useState<AssetDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!assetId) {
      setDetail(null);
      return;
    }
    setLoading(true);
    try {
      setDetail(await knowledgeApi.asset(sessionId, assetId));
      setError(null);
    } catch (cause) {
      setDetail(null);
      setError((cause as { message?: string })?.message ?? "读取资产详情失败");
    } finally {
      setLoading(false);
    }
  }, [assetId, sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  return { detail, loading, error, reload: load };
}

export function useRelationGraph(view: "business" | "lineage", focusId: string | null, full: boolean) {
  const sessionId = useSharedStore((state) => state.sessionId);
  const [data, setData] = useState<RelationGraphData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    knowledgeApi
      .graph(sessionId, { view, focusId, full })
      .then((result) => {
        if (!cancelled) {
          setData(result);
          setError(null);
        }
      })
      .catch((cause) => {
        if (!cancelled) setError((cause as { message?: string })?.message ?? "读取关系图失败");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, view, focusId, full]);

  return { data, loading, error };
}

export type SearchState = {
  result: SearchResult | null;
  running: boolean;
  error: string | null;
  run: (query: string, options?: { topK?: number; filters?: Record<string, string> }) => Promise<void>;
  clear: () => void;
  /** 检索时绑定的服务版本；与当前不一致时要提示「索引已更新」（PRD §10.4） */
  resultVersion: string | null;
};

export function useKnowledgeSearch(): SearchState {
  const sessionId = useSharedStore((state) => state.sessionId);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (query: string, options: { topK?: number; filters?: Record<string, string> } = {}) => {
      const trimmed = query.trim();
      if (!trimmed) {
        setResult(null);
        return;
      }
      setRunning(true);
      try {
        setResult(await knowledgeApi.search(sessionId, trimmed, options));
        setError(null);
      } catch (cause) {
        setError((cause as { message?: string })?.message ?? "检索失败");
      } finally {
        setRunning(false);
      }
    },
    [sessionId],
  );

  const clear = useCallback(() => {
    setResult(null);
    setError(null);
  }, []);

  return { result, running, error, run, clear, resultVersion: result?.version ?? null };
}
