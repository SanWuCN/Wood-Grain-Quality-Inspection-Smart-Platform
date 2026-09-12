/**
 * 木脉智检 · 会话状态（跨页面共享的演示状态）
 *
 * PRD 7.1 要求「所有页面使用同一组项目、构件、批次和版本数据」，
 * 因此账号、当前工单、事件订阅、巡检任务、环境配置等状态统一放在这里，
 * 由 AppShell 提供 Provider，各路由页面通过 useMumai() 读取。
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from "react";
import type { ChannelStatus, EnvRecord, Mission, Order, StageKey } from "./seed/types";
import {
  ACCOUNT_LOGIN,
  DEFAULT_ACCOUNT_ID,
  actionsOf,
  allows,
  clearSession,
  readSession,
  writeSession,
  type Permission,
} from "./auth";
import {
  CHANNELS,
  COMPONENTS,
  DRAFT_ORDER,
  ENV_RECORD,
  HISTORIC_ORDERS,
  MISSION,
  STAGES,
  WORK_ORDER,
} from "./seed/scenario";
import { clockStamp } from "./lib";
import { isOnline, useSharedStore, type ConnectionStatus } from "./store/shared";

export type NavKey = "overview" | "orders" | "mapping" | "twin" | "adapt" | "knowledge" | "archive";

export type SessionEvent = {
  id: number;
  at: string;
  text: string;
  tone: "ok" | "warn" | "danger" | "info" | "muted";
};

export type Toast = { id: number; text: string; tone: SessionEvent["tone"] };

export type MumaiState = {
  sessionId: string;
  stage: StageKey;
  stageLabel: string;
  setStage: (stage: StageKey) => void;
  /** 当前登录账号（PRD 2.1 四个账号），初值取自 localStorage 里的会话 */
  accountId: string;
  setAccountId: (id: string) => void;
  /** 当前账号的拼音登录名 */
  accountLogin: string;
  /** 当前账号的可执行操作集合（来源：auth.ts 的角色权限表） */
  permissions: readonly Permission[];
  /** 页面内按钮的权限判断：无权限时置灰并说明原因 */
  can: (permission: Permission) => boolean;
  /** 退出登录：清会话 + 重置演示状态 + 回登录页 */
  logout: () => void;
  /** 一级导航折叠为图标栏，给内容区留宽 */
  navCollapsed: boolean;
  toggleNav: () => void;
  /** 小木右侧可展开面板 */
  assistantOpen: boolean;
  setAssistantOpen: (open: boolean) => void;
  assistantSeed: string;
  askAssistant: (text: string) => void;

  orders: Order[];
  currentOrder: Order;
  archivedOrders: Order[];
  draftOrder: Order;
  /** 按构件编号取档案（Z01–Z04），所有页面共用同一份 */
  componentById: (id: string) => (typeof COMPONENTS)[number] | undefined;
  confirmDraftOrder: () => void;
  setOrderStatus: (id: string, status: Order["status"]) => void;

  envRecord: EnvRecord;
  setEnvRecord: (record: EnvRecord) => void;
  /** 已校验的不可变配置版本；null 表示尚未校验通过 */
  publishedConfig: string | null;
  publishConfig: (version: string) => void;
  deviceAck: boolean;
  setDeviceAck: (ack: boolean) => void;

  channels: ChannelStatus[];
  deviceSource: "demo" | "real";
  setDeviceSource: (source: "demo" | "real") => void;

  mission: Mission;
  patchMission: (patch: Partial<Mission>) => void;

  events: SessionEvent[];
  pushEvent: (text: string, tone?: SessionEvent["tone"]) => void;
  toasts: Toast[];
  toast: (text: string, tone?: SessionEvent["tone"]) => void;
  dismissToast: (id: number) => void;

  /** 演示控制：适用域待核验时冻结该批诊断输出（PRD 3.4） */
  domainPending: boolean;
  setDomainPending: (value: boolean) => void;
  presetAnnotation: boolean;
  setPresetAnnotation: (value: boolean) => void;

  /**
   * 共享服务的连接状态。
   *
   * 配置、地图、场景、产物这类**跨端共享**的记录一律以服务端为准，
   * 页面通过 useSharedStore 的选择器读取；这里只暴露连接状态，
   * 让顶栏与各页能把「连不上」说清楚，而不是继续显示本地默认值装成正常。
   */
  sharedStatus: ConnectionStatus;
  sharedOnline: boolean;
  sharedError: string | null;
  /** 当前共享演示会话 id（四端加入的是同一场） */
  sharedSessionId: string;

  resetDemo: () => void;
};

const MumaiContext = createContext<MumaiState | null>(null);

let seq = 1;
const nextId = () => {
  seq += 1;
  return seq;
};

export function MumaiProvider({ children }: PropsWithChildren) {
  const [stage, setStage] = useState<StageKey>("fusion");
  // 会话是登录页写进 localStorage 的，刷新后从这里恢复；脏数据由守卫拦在登录页
  const [accountId, setAccountId] = useState(
    () => readSession()?.accountId ?? DEFAULT_ACCOUNT_ID,
  );
  // 默认收起为窄图标栏：顶栏已有完整导航，主视觉（地图 / 三维）优先占宽
  const [navCollapsed, setNavCollapsed] = useState(true);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [assistantSeed, setAssistantSeed] = useState("");

  const [orders, setOrders] = useState<Order[]>([WORK_ORDER, ...HISTORIC_ORDERS]);
  const [draftOrder, setDraftOrder] = useState<Order>(DRAFT_ORDER);

  const [envRecord, setEnvRecord] = useState<EnvRecord>(ENV_RECORD);
  const [publishedConfig, setPublishedConfig] = useState<string | null>(ENV_RECORD.configVersion);
  const [deviceAck, setDeviceAck] = useState(true);

  const [channels] = useState<ChannelStatus[]>(CHANNELS);
  const [deviceSource, setDeviceSource] = useState<"demo" | "real">("demo");

  const [mission, setMission] = useState<Mission>(MISSION);

  const [domainPending, setDomainPending] = useState(true);
  const [presetAnnotation, setPresetAnnotation] = useState(true);

  const [events, setEvents] = useState<SessionEvent[]>([
    { id: 0, at: clockStamp(), text: "会话 session-A 已建立，装载阶段快照 fusion", tone: "info" },
  ]);
  const [toasts, setToasts] = useState<Toast[]>([]);

  /* ---- 共享服务：登录后连一次，切账号重连 ---- */
  const sharedStatus = useSharedStore((state) => state.status);
  const sharedError = useSharedStore((state) => state.connectionError);
  const sharedOnline = useSharedStore(isOnline);
  const sharedSessionId = useSharedStore((state) => state.sessionId);

  useEffect(() => {
    void useSharedStore.getState().init(accountId);
  }, [accountId]);

  const pushEvent = useCallback((text: string, tone: SessionEvent["tone"] = "info") => {
    setEvents((list) => [{ id: nextId(), at: clockStamp(), text, tone }, ...list].slice(0, 40));
  }, []);

  const toast = useCallback((text: string, tone: SessionEvent["tone"] = "info") => {
    const id = nextId();
    setToasts((list) => [...list, { id, text, tone }]);
    window.setTimeout(() => setToasts((list) => list.filter((item) => item.id !== id)), 3200);
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((list) => list.filter((item) => item.id !== id));
  }, []);

  const askAssistant = useCallback((text: string) => {
    setAssistantSeed(text);
    setAssistantOpen(true);
  }, []);

  const patchMission = useCallback((patch: Partial<Mission>) => {
    setMission((current) => ({ ...current, ...patch }));
  }, []);

  const confirmDraftOrder = useCallback(() => {
    setDraftOrder((draft) => ({ ...draft, status: "待复核" }));
    setOrders((list) => {
      const exists = list.some((item) => item.id === DRAFT_ORDER.id);
      if (exists) return list.map((item) => (item.id === DRAFT_ORDER.id ? { ...item, status: "待复核" } : item));
      return [...list, { ...DRAFT_ORDER, status: "待复核" }];
    });
  }, []);

  const setOrderStatus = useCallback((id: string, status: Order["status"]) => {
    setOrders((list) => list.map((item) => (item.id === id ? { ...item, status } : item)));
  }, []);

  const publishConfig = useCallback((version: string) => {
    setPublishedConfig(version);
    setDeviceAck(false);
  }, []);

  const resetDemo = useCallback(() => {
    setOrders([WORK_ORDER, ...HISTORIC_ORDERS]);
    setDraftOrder(DRAFT_ORDER);
    setEnvRecord(ENV_RECORD);
    setPublishedConfig(ENV_RECORD.configVersion);
    setDeviceAck(true);
    setMission(MISSION);
    setDomainPending(true);
    setPresetAnnotation(true);
    setStage("fusion");
    pushEvent("装载阶段快照 fusion：工单、环境、巡检、数据集与更新记录同步回退", "warn");
  }, [pushEvent]);
  /* ---- 角色权限（auth.ts 的角色权限表是唯一来源） ---- */

  const permissions = useMemo(() => actionsOf(accountId), [accountId]);

  const can = useCallback(
    (permission: Permission) => allows(accountId, permission),
    [accountId],
  );

  const accountLogin = ACCOUNT_LOGIN[accountId] ?? accountId;

  /** 退出登录：清会话、断开共享服务、把演示状态退回快照 */
  const logout = useCallback(() => {
    clearSession();
    useSharedStore.getState().reset();
    resetDemo();
  }, [resetDemo]);

  const changeAccount = useCallback((id: string) => {
    setAccountId(id);
    writeSession(id, new Date().toISOString());
  }, []);

  const value = useMemo<MumaiState>(() => {
    const stageDef = STAGES.find((item) => item.key === stage) ?? STAGES[STAGES.length - 1];
    return {
      sessionId: "session-A",
      stage,
      stageLabel: stageDef.label,
      setStage,
      accountId,
      setAccountId: changeAccount,
      accountLogin,
      permissions,
      can,
      logout,
      navCollapsed,
      toggleNav: () => setNavCollapsed((collapsed) => !collapsed),
      assistantOpen,
      setAssistantOpen,
      assistantSeed,
      askAssistant,
      orders,
      currentOrder: orders.find((item) => item.current) ?? WORK_ORDER,
      archivedOrders: orders.filter((item) => !item.current),
      draftOrder,
      componentById: (id: string) => COMPONENTS.find((item) => item.id === id || item.name === id),
      confirmDraftOrder,
      setOrderStatus,
      envRecord,
      setEnvRecord,
      publishedConfig,
      publishConfig,
      deviceAck,
      setDeviceAck,
      channels,
      deviceSource,
      setDeviceSource,
      mission,
      patchMission,
      events,
      pushEvent,
      toasts,
      toast,
      dismissToast,
      domainPending,
      setDomainPending,
      presetAnnotation,
      setPresetAnnotation,
      sharedStatus,
      sharedOnline,
      sharedError,
      sharedSessionId,
      resetDemo,
    };
  }, [
    accountId, accountLogin, askAssistant, assistantOpen, assistantSeed, can, changeAccount, channels,
    confirmDraftOrder, deviceAck, deviceSource, dismissToast, domainPending, draftOrder, envRecord,
    events, logout, mission, navCollapsed, orders, patchMission, permissions, presetAnnotation,
    publishConfig, publishedConfig, pushEvent, resetDemo, setOrderStatus, sharedError, sharedOnline,
    sharedSessionId, sharedStatus, stage, toast, toasts,
  ]);

  return <MumaiContext.Provider value={value}>{children}</MumaiContext.Provider>;
}

export function useMumai(): MumaiState {
  const context = useContext(MumaiContext);
  if (!context) throw new Error("useMumai 必须在 MumaiProvider 内使用");
  return context;
}
