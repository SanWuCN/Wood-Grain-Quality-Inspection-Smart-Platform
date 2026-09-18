/**
 * 多机协同读数（顶栏「协同」那一格与排练控制台面板共用）
 *
 * 数据来自服务端 `/api/sessions/:id/peers`：端数、每台端的对端地址与账号、
 * 服务器身份、可达地址清单。**全部在服务端算**，前端只负责显示。
 *
 * 为什么要轮询：端数是"别人开关页面"这件事的读数 —— 不轮询就永远是打开本页
 * 那一刻的快照，而它恰恰是多机演示里最需要眼见为实的一格。间隔取 15 秒
 * （后台 60 秒）：这是一个极小的 GET，但它必须够快，好让"他连上了没有"
 * 这件事在十几秒内就能看到变化。
 */

import { useEffect, useState } from "react";

import { api, type LanPeers } from "../api/client";
import { useSharedStore } from "../store/shared";

const POLL_MS = 15_000;
const HIDDEN_POLL_MS = 60_000;
/** 读失败时的重试间隔：登录前后、服务刚重启这类"马上就好的"情况不该让顶栏空 15 秒 */
const RETRY_MS = 2_500;

export type CollabPeersState = {
  peers: LanPeers | null;
  /** 读不到时的说明（顶栏与面板都要能说"为什么没有数"，而不是显示 0 台） */
  error: string;
};

export function useCollabPeers(active = true, pollMs = POLL_MS): CollabPeersState {
  const sessionId = useSharedStore((state) => state.sessionId);
  const [state, setState] = useState<CollabPeersState>({ peers: null, error: "" });

  useEffect(() => {
    if (!active) {
      setState({ peers: null, error: "" });
      return undefined;
    }
    let disposed = false;
    let timer = 0;

    /*
      轮询而不是"读一次"：端数是"别人开关页面"这件事的读数。
      失败要**快**重试（2.5 秒）：页面刚打开时会话还没建好、服务刚重启时令牌刚换，
      这两种都会先失败一次，按 15 秒等下一次的话，顶栏会空着 —— 而它恰恰是现场
      第一眼要看的那一格。
    */
    const schedule = (delay: number) => {
      window.clearInterval(timer);
      timer = window.setInterval(() => void load(), delay);
    };

    const load = async () => {
      try {
        const peers = await api.sessionPeers(sessionId);
        if (disposed) return;
        setState({ peers, error: "" });
        schedule(pollMs);
      } catch (error) {
        if (disposed) return;
        const message = (error as { message?: string })?.message ?? "读不到协同读数";
        setState((previous) => ({ peers: previous.peers, error: message }));
        schedule(RETRY_MS);
      }
    };

    void load();

    /* 回到前台立刻刷一次：切出去这段时间里"谁连上来了"正是要立刻看到的 */
    const onVisibility = () => {
      if (document.hidden) {
        window.clearInterval(timer);
        timer = window.setInterval(() => void load(), HIDDEN_POLL_MS);
      } else {
        void load();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [active, pollMs, sessionId]);

  return state;
}
