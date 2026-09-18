/**
 * 内网多主机内容同步 · 小木回合的**广播**与**跟随**
 *
 * ── 用户口径（2026-09-23）──────────────────────────────────────────
 * 「实际上项目就是面向结果展示的，但得做到内网多主机内容同步」。
 * 实测确认了缺口（`tools/探-双机同步现状.mjs`）：
 *   · 业务数据同步 —— 任务卡 0→4 在第二台机器上读得到、投屏状态读得到；
 *   · **讲解过程不同步** —— 演示机上小木说了什么、页面跳到哪、弹了哪个窗，
 *     第二台机器上一点都看不到（agent store、路由、浮层全在浏览器本地）。
 *
 * ── 这一层怎么做 ────────────────────────────────────────────────────
 *   ① **演示机**（说话的那台）在每一轮开讲时调 `announceRound()`：
 *      往服务端写一条 `xiaomu.round`（轮次号 + 台词 + 页面落点 + 本机 hostId）；
 *   ② **跟随端**（同一局域网的其它机器）在 WS 事件流里收到这条事件后，
 *      在 `XiaomuDock` 里调 `applyRemoteRound()`：气泡显示同一句台词、
 *      页面按同一份 `nav` 走、揭示与浮层按同一轮触发；**但不出声**
 *      （多台机器同时放音会互相打架，而且展示机才是有人听的那一台）。
 *
 * ── 三条必须守住的边界 ──────────────────────────────────────────────
 *   1. **忽略自己的回声**：事件里带发起端 `hostId`，与本机相同就跳过 ——
 *      不跳过的后果是两台机器互相跟随，页面来回跳（死循环）；
 *   2. **只跟随新鲜的**：超过 `FRESH_MS` 的旧事件不处理（断线重连后会把历史事件
 *      按序补发，跟随端不该把十分钟前的台词再演一遍）；
 *   3. **可以关**：`mumai.follow.presenter` 存本地（默认**开** ——
 *      新机器打开就能跟着看，这正是"面向结果展示"要的），
 *      内网协同面板里能关掉（某台机器要自己演示时用）。
 */

import { useCallback, useEffect, useRef } from "react";
import type { StreamEvent } from "../api/client";
import { useSharedStore } from "../store/shared";

/** 跟随开关的本地键；**默认开**（读不到或坏值时按开处理） */
export const FOLLOW_KEY = "mumai.follow.presenter";

/** 本机（本标签页）的 id：跟随端靠它忽略自己的回声 */
const HOST_KEY = "mumai.hostId";

/** 超过这个时长的旧事件不跟随（断线重连补发历史事件时用） */
export const FRESH_MS = 30_000;

/** 本机 hostId：sessionStorage 里一份（每个标签页独立），拿不到就退回模块内生成的一个 */
let fallbackHostId = "";
export function hostIdOf(): string {
  if (typeof window === "undefined") return fallbackHostId || "host-unknown";
  try {
    const stored = window.sessionStorage.getItem(HOST_KEY);
    if (stored) return stored;
    const made = `host-${Math.random().toString(36).slice(2, 10)}`;
    window.sessionStorage.setItem(HOST_KEY, made);
    return made;
  } catch {
    /* 隐私模式 / 禁 sessionStorage：本次会话用模块内那一个，只要进程内稳定就够 */
    if (!fallbackHostId) fallbackHostId = `host-${Math.random().toString(36).slice(2, 10)}`;
    return fallbackHostId;
  }
}

/** 是否跟随演示机（默认开） */
export function followEnabled(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(FOLLOW_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setFollowEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem(FOLLOW_KEY, enabled ? "on" : "off");
  } catch {
    /* 写不进去只影响下次打开，本次会话的开关由调用方自己记 */
  }
}

/** 广播载荷：这一轮的轮次号、台词与页面落点 */
export type RoundAnnouncement = {
  roundNo: string;
  text: string;
  nav: Record<string, unknown> | null;
};

/**
 * 演示机开讲时广播一轮。
 *
 * **失败只记日志**：广播是"给别人看"的加分项，绝不能因为它失败而挡住宿主的播报与页面动作
 * （服务没起 / 令牌过期时，演示机自己要照常能用）。
 */
export async function announceRound(payload: RoundAnnouncement): Promise<void> {
  try {
    await useSharedStore.getState().send({
      action: "xiaomu.round",
      entityId: null,
      payload: { ...payload, hostId: hostIdOf() },
    });
  } catch (error) {
    console.warn("[roundSync] 回合广播失败（不影响本机播报）：", error);
  }
}

/** 一条"别的机器发起的"回合 */
export type RemoteRound = {
  roundNo: string;
  text: string;
  /** 发起端（用于界面上写"由另一台演示机发起"） */
  hostId: string | null;
  by: string | null;
  seq: number;
};

/**
 * 把一个 WS 事件判成"该跟随的远程回合"；不是就返回 null。
 *
 * 纯函数，便于单测：三条边界（事件名、忽略回声、只要新鲜的）都在这里，
 * 界面那边不再重复判断 —— 判据写两遍必然有一遍先过期。
 */
export function remoteRoundOf(
  event: StreamEvent | null,
  options: { selfHostId: string; now?: number; freshMs?: number },
): RemoteRound | null {
  if (!event || event.type !== "xiaomu.round") return null;
  const payload = event.payload ?? {};
  const roundNo = typeof payload.roundNo === "string" ? payload.roundNo : "";
  const text = typeof payload.text === "string" ? payload.text : "";
  if (!roundNo || !text) return null;
  const hostId = typeof payload.hostId === "string" ? payload.hostId : null;
  /* ① 自己的回声不跟（否则两台机器互相跟随 → 页面来回跳） */
  if (hostId && hostId === options.selfHostId) return null;
  /* ② 旧事件不跟（断线重连会按序补发历史事件） */
  const fresh = options.freshMs ?? FRESH_MS;
  const at = Date.parse(String(event.at ?? ""));
  const now = options.now ?? Date.now();
  if (Number.isFinite(at) && now - at > fresh) return null;
  return { roundNo, text, hostId, by: typeof event.actorId === "string" ? event.actorId : null, seq: event.seq };
}

/**
 * 跟随钩子：收到别的机器的回合就回调一次。
 *
 * 用 `lastEvent` 的 `seq` 去重（同一个事件不重复回调），并尊重跟随开关。
 * 开关是"每次事件现读"的：演示中途关掉立刻生效，不用刷新页面。
 */
export function useRoundFollow(onRound: (round: RemoteRound) => void): void {
  const lastEvent = useSharedStore((state) => state.lastEvent);
  const handledSeq = useRef(0);
  const handler = useCallback(onRound, [onRound]);

  useEffect(() => {
    if (!lastEvent || lastEvent.seq === handledSeq.current) return;
    handledSeq.current = lastEvent.seq;
    if (!followEnabled()) return;
    const round = remoteRoundOf(lastEvent, { selfHostId: hostIdOf() });
    if (round) handler(round);
  }, [lastEvent, handler]);
}
