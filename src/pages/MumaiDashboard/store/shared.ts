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
  type ArchiveItemEntity,
  type AgentTurnEntity,
  type ArtifactEntity,
  type CommandResult,
  type EnvironmentEntity,
  type TaskCardEntity,
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
      /*
        端自报身份：服务端的「这台服务器上有哪几台端」要靠它把端对上人
        （地址是服务端从 TCP 取的，账号与页面只能由页面自报；权限仍然只认 HTTP 令牌）。
      */
      onIdentify: () => {
        const actor = get().actor;
        return actor ? { accountId: actor.id, accountName: actor.name } : null;
      },
      onEvent: (event) => {
        set({ lastEvent: event });
        /*
          同步实测回执：服务端真写了一条 `sync.probe` 事件并广播，
          每台端收到就在这里回一条 —— 于是"这条写入几台端真收到了"成了服务端算得出的数。
          页面**不做任何判断**，只回执；结论由服务端给（`/api/console/sync-probe/:id`）。
        */
        if (event.type === "sync.probe") {
          const probeId = event.payload?.probeId;
          if (typeof probeId === "string") stream?.send({ kind: "sync-ack", probeId });
        }
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
    // 走 PRD §12 单列的 /api/projection，不走命令总线：投屏的前置条件是「持有人」
    // 而不是实体 revision，而且换人要有显式的接管动作（hold）。
    await api.setProjection(get().sessionId, { viewType, focusIds, hold });
    await get().refresh();
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

/**
 * 任务实体（`mission`）：自主巡航任务与通用任务都在这里。
 *
 * 快照里 `entities` 是按 kind 分组的 `Record<string, SharedEntity[]>`，data 的类型是
 * `Record<string, unknown>` —— **收窄只在这一个地方做**（页面不各自 `as` 一遍），
 * 与上面几个选择器同源。数组引用在快照不变时是稳定的，可以直接交给
 * `useSyncExternalStore` 当选择器；派生（filter/sort）要放进 `useMemo`。
 */
export function missions(state: SharedState): SharedEntity<MissionEntity>[] {
  return entitiesOf<MissionEntity>(state, "mission");
}

/** 归档清单：服务端持有登记摘要与真实文件，页面只读它 */
export function archiveItems(state: SharedState): SharedEntity<ArchiveItemEntity>[] {
  return entitiesOf<ArchiveItemEntity>(state, "archiveItem");
}

/**
 * 执行工作台的任务卡（`taskCard`）：服务端留存，内网各端看到的是同一份。
 *
 * 与 `missions` 同一条口径：数组引用在快照不变时稳定，可以直接交给
 * `useSyncExternalStore` 当选择器；按工单/批次派生要放进 `useMemo`。
 */
export function taskCards(state: SharedState): SharedEntity<TaskCardEntity>[] {
  return entitiesOf<TaskCardEntity>(state, "taskCard");
}

/**
 * 小木回合留痕（`agentTurn`）：哪台机器在第几轮讲了什么。
 *
 * 内网多主机内容同步靠它留痕，页面（内网协同面板）可以列出"最近几轮是谁讲的"。
 */
export function agentTurns(state: SharedState): SharedEntity<AgentTurnEntity>[] {
  return entitiesOf<AgentTurnEntity>(state, "agentTurn");
}

/** 是否连得上共享服务：连不上时所有写操作都要禁用并说明原因 */
export function isOnline(state: SharedState): boolean {
  return state.status === "online";
}
