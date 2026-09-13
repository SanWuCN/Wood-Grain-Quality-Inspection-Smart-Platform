/**
 * 数据与知识中心 · 写操作集合
 *
 * 页面里所有按钮都通过这一处执行，而不是各自 import 命令封装：
 *   · 权限在**一处**判定（缺权限时按钮置灰并给出原因，PRD §13）；
 *   · 失败在**一处**翻译成中文提示（服务端的 errorCode 留在任务详情里，PRD §12.4）；
 *   · 成功后的「谁该刷新」也在**一处**决定，避免有的按钮刷新了有的没刷新。
 *
 * 依据：PRD §10（核心交互流程）、§13（权限与操作责任）。
 */

import { useCallback, useMemo, useRef, useState } from "react";
import { useMumai } from "../../context";
import { api } from "../../api/client";
import { useSharedStore } from "../../store/shared";
import { knowledgeCommands, isApiError } from "../api";

export type KnowledgeApiActions = {
  canRead: boolean;
  canSearch: boolean;
  canManage: boolean;
  canIndex: boolean;
  /** 是否有写操作正在进行：所有写按钮共用，避免同一时刻点两次 */
  busy: boolean;
  sync: (payload?: { scope?: string; assetIds?: string[]; kind?: string; triggerSource?: string }) => Promise<{ jobId: string | null; inputs: number }>;
  syncAsset: (assetId: string) => Promise<string | null>;
  retryErrors: () => Promise<string | null>;
  cancelJob: (jobId: string) => Promise<boolean>;
  activateVersion: (version: string) => Promise<boolean>;
  configure: (patch: Record<string, unknown>) => Promise<boolean>;
  setInclusion: (assetId: string, include: boolean) => Promise<boolean>;
  remove: (assetId: string) => Promise<boolean>;
  register: (payload: Record<string, unknown>) => Promise<{ assetId: string | null; indexState: string | null }>;
  revise: (assetId: string, payload: Record<string, unknown>) => Promise<boolean>;
  download: (fileId: string, name: string) => Promise<void>;
  refresh: () => Promise<void>;
};

export function useKnowledgeActions(onChanged?: () => void): KnowledgeApiActions {
  const { can, toast } = useMumai();
  const refreshShared = useSharedStore((state) => state.refresh);
  const sessionId = useSharedStore((state) => state.sessionId);
  const [busy, setBusy] = useState(false);
  // 命令回调里要读最新的刷新函数，用 ref 存住避免把依赖数组撑爆
  const changedRef = useRef(onChanged);
  changedRef.current = onChanged;

  const canRead = can("knowledge:read");
  const canSearch = can("knowledge:search");
  const canManage = can("knowledge:manage");
  const canIndex = can("knowledge:index");

  const after = useCallback(async () => {
    // 写操作之后拉一次共享快照：知识域的事件会推动页面自己的重拉，
    // 这里顺带刷新会话序号，保证「事件 → 快照」这条链在两端一致（PRD §12.5）
    await refreshShared();
    changedRef.current?.();
  }, [refreshShared]);

  const guard = useCallback(
    async <T,>(permission: boolean, label: string, run: () => Promise<T>, fallback: T): Promise<T> => {
      if (!permission) {
        toast(`当前角色没有「${label}」权限`, "warn");
        return fallback;
      }
      setBusy(true);
      try {
        const result = await run();
        await after();
        return result;
      } catch (error) {
        // 服务端不给「成功」以外的答案：失败一律照实说，不静默吞掉
        toast(isApiError(error) ? error.message : `${label}失败`, "danger");
        return fallback;
      } finally {
        setBusy(false);
      }
    },
    [after, toast],
  );

  const sync = useCallback(
    (payload: { scope?: string; assetIds?: string[]; kind?: string; triggerSource?: string } = {}) =>
      guard(
        canIndex,
        "启动索引更新",
        async () => {
          const outcome = await knowledgeCommands.sync(sessionId, payload);
          if (outcome.result?.started === false) {
            toast(outcome.result?.reason ?? "没有需要处理的资产", "info");
            return { jobId: null, inputs: 0 };
          }
          toast(`已启动更新任务，目标版本 ${outcome.result.targetVersion}`, "info");
          return { jobId: outcome.result.jobId ?? null, inputs: Number(outcome.result.inputs ?? 0) };
        },
        { jobId: null, inputs: 0 },
      ),
    [canIndex, guard, sessionId, toast],
  );

  const syncAsset = useCallback(
    async (assetId: string) => {
      const result = await sync({ scope: "changed", assetIds: [assetId], triggerSource: "资产详情" });
      return result.jobId;
    },
    [sync],
  );

  const retryErrors = useCallback(
    () =>
      guard(
        canIndex,
        "重试失败项",
        async () => {
          const outcome = await knowledgeCommands.retry(sessionId);
          if (outcome.result?.started === false) {
            toast(outcome.result?.reason ?? "没有需要重试的失败项", "info");
            return null;
          }
          toast(`已重试 ${outcome.result.inputs ?? 0} 项失败资产`, "info");
          return outcome.result.jobId ?? null;
        },
        null,
      ),
    [canIndex, guard, sessionId, toast],
  );

  const cancelJob = useCallback(
    (jobId: string) =>
      guard(
        canIndex,
        "取消任务",
        async () => {
          await knowledgeCommands.cancel(sessionId, jobId);
          toast("任务已取消，未发布结果不会进入检索", "info");
          return true;
        },
        false,
      ),
    [canIndex, guard, sessionId, toast],
  );

  const activateVersion = useCallback(
    (version: string) =>
      guard(
        canIndex,
        "切换服务版本",
        async () => {
          const outcome = await knowledgeCommands.activateVersion(sessionId, version);
          if (outcome.result?.unchanged) {
            toast(`${version} 已经是当前服务版本`, "info");
            return true;
          }
          toast(`检索已切到 ${version}，原始资产库不回滚`, "info");
          return true;
        },
        false,
      ),
    [canIndex, guard, sessionId, toast],
  );

  const configure = useCallback(
    (patch: Record<string, unknown>) =>
      guard(
        canIndex,
        "修改索引配置",
        async () => {
          const outcome = await knowledgeCommands.configure(sessionId, patch);
          toast(
            `已生成配置版本 ${outcome.result.revision}${outcome.result.rebuildRequired ? "，需要重建索引" : ""}`,
            "info",
          );
          return true;
        },
        false,
      ),
    [canIndex, guard, sessionId, toast],
  );

  const setInclusion = useCallback(
    (assetId: string, include: boolean) =>
      guard(
        canIndex,
        include ? "纳入索引" : "移出索引",
        async () => {
          await knowledgeCommands.setInclusion(sessionId, assetId, include);
          toast(include ? "已纳入索引范围，等待下一次更新" : "已移出索引范围，检索将不再返回它", "info");
          return true;
        },
        false,
      ),
    [canIndex, guard, sessionId, toast],
  );

  const remove = useCallback(
    (assetId: string) =>
      guard(
        canManage,
        "删除资产",
        async () => {
          await knowledgeCommands.remove(sessionId, assetId);
          toast("资产已删除，检索即时屏蔽，随后发布清理版本", "info");
          return true;
        },
        false,
      ),
    [canManage, guard, sessionId, toast],
  );

  const register = useCallback(
    (payload: Record<string, unknown>) =>
      guard(
        canManage,
        "导入资产",
        async () => {
          const outcome = await knowledgeCommands.register(sessionId, payload);
          return {
            assetId: (outcome.result.assetId as string | undefined) ?? null,
            indexState: (outcome.entity?.data?.indexState as string | undefined) ?? null,
          };
        },
        { assetId: null, indexState: null },
      ),
    [canManage, guard, sessionId],
  );

  const revise = useCallback(
    (assetId: string, payload: Record<string, unknown>) =>
      guard(
        canManage,
        "上传新版本",
        async () => {
          await knowledgeCommands.revise(sessionId, assetId, payload);
          toast("已登记新版本，旧索引继续服务，发布后自动切换", "info");
          return true;
        },
        false,
      ),
    [canManage, guard, sessionId, toast],
  );

  const download = useCallback(
    async (fileId: string, name: string) => {
      try {
        await api.download(fileId, name);
      } catch (error) {
        toast(isApiError(error) ? error.message : "下载失败", "danger");
      }
    },
    [toast],
  );

  return useMemo(
    () => ({
      canRead,
      canSearch,
      canManage,
      canIndex,
      busy,
      sync,
      syncAsset,
      retryErrors,
      cancelJob,
      activateVersion,
      configure,
      setInclusion,
      remove,
      register,
      revise,
      download,
      refresh: after,
    }),
    [
      canRead, canSearch, canManage, canIndex, busy, sync, syncAsset, retryErrors, cancelJob,
      activateVersion, configure, setInclusion, remove, register, revise, download, after,
    ],
  );
}
