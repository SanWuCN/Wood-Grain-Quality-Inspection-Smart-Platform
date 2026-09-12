/**
 * 木脉智检 · 共享状态 store
 *
 * 这一层是评审 F01/F02/F03/F06 的落点：把「配置、地图、场景、产物、任务」
 * 从各页面的局部 useState 挪到**服务端**，四端读同一份快照、写同一条命令总线。
 *
 * 为什么用 zustand：项目里已经有它（mapDemo/stores.ts），而这里的诉求正好是
 * 「一个模块级快照 + 选择器订阅」，不需要再引一套。
 *
 * 两条硬规则：
 *   1. **写操作不本地先行**。命令返回之后才按服务端结果改本地状态；
 *      失败就把错误原样交给页面。以前 `publishConfig()` 先改本地再谈其它，
 *      于是沈看到 CFG-05、史那边还是 CFG-02 —— 成功反馈和真实结果脱节。
 *   2. **事件只驱动一次快照重拉**。事件体不带完整实体，本地拼装容易和服务端
 *      算出的 revision 不一致；一条会话只有个位数实体，重拉一次最省心也最准。
 */

import { create } from "zustand";
import {
  api,
  isApiError,
  subscribe,
  writeToken,
  type Actor,
  type ApiError,
  type ArtifactEntity,
  type CommandResult,
  type EnvironmentEntity,
  type MapVersionEntity,
  type MissionEntity,
  type SceneEntity,
  type SharedEntity,
  type Snapshot,
  type StreamEvent,
  type StreamHandle,
} from "../api/client";

export type ConnectionStatus = "idle" | "connecting" | "online" | "offline";

export type SharedState = {
  status: ConnectionStatus;
  /** 最近一次连接失败的说明，直接显示在顶栏与状态块里 */
  connectionError: string | null;
  actor: Actor | null;
  allowedActions: string[];
  sessionId: string;
  session: Snapshot["session"] | null;
  entities: Record<string, SharedEntity[]>;
  projection: Snapshot["projection"];
  lastSeq: number;
  /** 最近一条事件，供页面做「有人动了这条记录」的提示 */
  lastEvent: StreamEvent | null;

  init: (accountId: string) => Promise<void>;
  refresh: () => Promise<void>;
  send: (command: Omit<Parameters<typeof api.command>[0], "sessionId">) => Promise<CommandResult>;
  setProjection: (viewType: string, focusIds?: string[], hold?: boolean) => Promise<void>;
  reset: () => void;
};

const DEFAULT_SESSION = "demo-01";
/** 演示口令：与 auth.ts 的 DEMO_PASSWORD 同源，登录页已经校验过一次 */
const DEMO_PASSWORD = "123456";

let stream: StreamHandle | null = null;
let refreshTimer = 0;

export const useSharedStore = create<SharedState>()((set, get) => ({
  status: "idle",
  connectionError: null,
  actor: null,
  allowedActions: [],
  sessionId: DEFAULT_SESSION,
  session: null,
  entities: {},
  projection: { holderId: null, viewType: "map", focusIds: [], updatedAt: null },
  lastSeq: 0,
  lastEvent: null,

  async init(accountId) {
    if (get().status === "connecting" || get().status === "online") return;
    set({ status: "connecting", connectionError: null });

    try {
      const me = await api.ensureSession(accountId, DEMO_PASSWORD);
      set({ actor: me.actor, allowedActions: me.allowedActions });
      await get().refresh();
    } catch (error) {
      const apiError = isApiError(error) ? error : null;
      set({
        status: "offline",
        connectionError: apiError?.message ?? "连接不上共享服务",
        session: null,
        entities: {},
      });
      return;
    }

    stream?.close();
    stream = subscribe(DEFAULT_SESSION, {
      onStatus: (next) => {
        if (next === "open") set({ status: "online", connectionError: null });
        else if (next === "closed" && get().status === "online") set({ status: "connecting" });
      },
      onHello: ({ lastSeq }) => set({ lastSeq }),
      onEvent: (event) => {
        set({ lastEvent: event });
        scheduleRefresh(get);
      },
    });
    set({ status: "online" });
  },

  async refresh() {
    try {
      const snapshot = await api.snapshot(get().sessionId);
      set({
        session: snapshot.session,
        entities: snapshot.entities,
        projection: snapshot.projection,
        lastSeq: Math.max(get().lastSeq, snapshot.session.lastSeq),
        status: "online",
        connectionError: null,
      });
    } catch (error) {
      const apiError = error as ApiError;
      if (apiError?.code === "UNAUTHORIZED") writeToken(null);
      set({ status: "offline", connectionError: apiError?.message ?? "读取共享状态失败" });
    }
  },

  async send(command) {
    const result = await api.command({ sessionId: get().sessionId, ...command });
    // 命令成功后立刻重拉：不等事件回环，避免页面上出现「已经成功但状态还是旧的」一帧
    await get().refresh();
    return result;
  },

  async setProjection(viewType, focusIds = [], hold = false) {
    await get().send({ action: "projection.set", payload: { viewType, focusIds, hold } });
  },

  reset() {
    stream?.close();
    stream = null;
    window.clearTimeout(refreshTimer);
    set({
      status: "idle",
      connectionError: null,
      actor: null,
      allowedActions: [],
      session: null,
      entities: {},
      lastSeq: 0,
      lastEvent: null,
    });
  },
}));

/** 事件合并重拉：一次命令会产生 1–2 条事件，别让它们各拉一次快照 */
function scheduleRefresh(get: () => SharedState) {
  window.clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => {
    void get().refresh();
  }, 90);
}

/* ------------------------------------------------------------------ *
 * 选择器（页面只用这些，不直接翻 entities）
 * ------------------------------------------------------------------ */

/**
 * 按 kind 取实体列表。
 *
 * 快照里的 `entities` 是 `Record<string, SharedEntity[]>`（服务端按 kind 分组，
 * 每种的字段不同），这里在唯一一处把它收窄成具体类型 —— 页面拿到的就是
 * 有字段提示的对象，而不是到处 `as` 一遍。
 *
 * **空列表必须复用同一个常量**：这些函数会直接交给 `useSyncExternalStore`
 * 当选择器，每次 `?? []` 返回新数组的话，React 会判定快照一直在变，
 * 抛出 "The result of getSnapshot should be cached to avoid an infinite loop"
 * 并进入无限重渲染。
 */
const EMPTY: readonly never[] = Object.freeze([]);

function entitiesOf<T>(state: SharedState, kind: string): SharedEntity<T>[] {
  return (state.entities[kind] ?? EMPTY) as unknown as SharedEntity<T>[];
}

/** 最新一版环境配置：列表按更新时间倒序，第一条就是当前版本 */
export function latestEnvironment(state: SharedState): SharedEntity<EnvironmentEntity> | null {
  return entitiesOf<EnvironmentEntity>(state, "environment")[0] ?? null;
}

export function environmentHistory(state: SharedState): SharedEntity<EnvironmentEntity>[] {
  return entitiesOf<EnvironmentEntity>(state, "environment");
}

/** 当前任务 = 最新一条；终态任务仍然返回，页面据此显示「已取消」而不是空 */
export function currentMission(state: SharedState): SharedEntity<MissionEntity> | null {
  return entitiesOf<MissionEntity>(state, "mission")[0] ?? null;
}

export function mapVersions(state: SharedState): SharedEntity<MapVersionEntity>[] {
  return entitiesOf<MapVersionEntity>(state, "mapVersion");
}

export function scenes(state: SharedState): SharedEntity<SceneEntity>[] {
  return entitiesOf<SceneEntity>(state, "scene");
}

export function publishedScene(state: SharedState): SharedEntity<SceneEntity> | null {
  return entitiesOf<SceneEntity>(state, "scene").find((item) => item.data.state === "已发布") ?? null;
}

export function artifacts(state: SharedState): SharedEntity<ArtifactEntity>[] {
  return entitiesOf<ArtifactEntity>(state, "artifact");
}

/** 当前产物 = 最新一条；发布状态来自服务端，切页与刷新都不会回退 */
export function currentArtifact(state: SharedState): SharedEntity<ArtifactEntity> | null {
  return entitiesOf<ArtifactEntity>(state, "artifact")[0] ?? null;
}

/** 是否连得上共享服务：连不上时所有写操作都要禁用并说明原因 */
export function isOnline(state: SharedState): boolean {
  return state.status === "online";
}
