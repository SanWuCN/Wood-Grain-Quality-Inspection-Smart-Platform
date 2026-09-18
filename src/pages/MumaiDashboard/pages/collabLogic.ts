/**
 * 多机协同 · 页面侧的纯逻辑（不碰网络、不碰 React）
 *
 * 用户 2026-09-18 报的问题：「我这边添加工单，沈那边收不到；沈那边派发人员，
 * 我这边也同步不到。」—— 现场要能用**一句话**说清是哪种情况：
 *
 *   · 「本机模式」：这一页是从 `localhost` / `127.0.0.1` 打开的，
 *     而服务器自己报出了对内地址 —— 那么同事如果也在自己电脑上开一份，
 *     他连的是**他自己那台**，两边数据永远不会互通。这是最容易犯、
 *     也最难自己发现的错（两边的界面长得一模一样）。
 *   · 「端列表里有没有他那台」：服务端报的是 TCP 对端地址，
 *     列表里没有他，就不是"收不到"，而是"没连上"。
 *
 * 这里只把这些事实翻译成人话；判断依据全部来自服务端读数，前端不猜。
 */

import type { CollabAddress, CollabEnd, CollabServer, LanPeers } from "../api/client";

/** 本机打开：localhost / 127.x / ::1 —— 这三种下"服务器"就是用户自己这台机器 */
export function isLocalHost(hostname: string): boolean {
  const text = String(hostname ?? "").trim().toLowerCase();
  if (!text) return false;
  if (text === "localhost" || text.endsWith(".localhost")) return true;
  if (text === "::1" || text === "[::1]") return true;
  return /^127\./.test(text);
}

/** 从 `location.host` / `location.origin` 里取主机名（带端口的一律去掉端口） */
export function hostOf(host: string): string {
  const text = String(host ?? "").trim();
  if (!text) return "";
  const withoutProtocol = text.replace(/^[a-z]+:\/\//i, "");
  const ipv6 = /^\[([^\]]+)\]/.exec(withoutProtocol);
  if (ipv6) return ipv6[1];
  return withoutProtocol.split("/")[0].split(":")[0];
}

export type CollabHeadline = {
  /** 顶栏那一格里显示的短词（越短越好，顶栏这一行窄） */
  text: string;
  tone: "ok" | "warn" | "danger" | "muted" | "info";
  /** 悬停说明：服务器是谁、从哪打开、同事该用哪个地址 */
  title: string;
};

/**
 * 顶栏「协同」那一格说什么。
 *
 * 三条口径：
 *   ① 没读到服务端读数 → 「—」（不编一个"正常"出来）；
 *   ② 本机模式 → 「本机 · N 台」并转黄：这一条是给**远程同事**看的，
 *      他照着念就能发现自己打开的不是同一台服务器；
 *   ③ 其余情况 → 「N 台」，两台以上才算真的多方在线。
 */
export function collabHeadline(peers: LanPeers | null, selfHost: string): CollabHeadline {
  if (!peers) {
    return { text: "—", tone: "muted", title: "还没读到协同读数（共享服务未连接？）" };
  }
  const local = isLocalHost(selfHost);
  const external = peers.addresses.filter((item) => item.kind === "lan" || item.kind === "vpn");
  const recommended = peers.addresses.find((item) => item.recommended) ?? external[0] ?? null;
  const server = `${peers.server.hostname}:${peers.server.port ?? "?"}`;
  const endsLine = peers.ends.length
    ? peers.ends
        .map((end) => `${end.accountId ?? "未登录"}@${end.address}${end.page ? `（${end.page}）` : ""}`)
        .join("\n")
    : "（还没有端连上来）";

  if (local) {
    return {
      text: `本机 · ${peers.peers} 台`,
      tone: "warn",
      title:
        `这一页是从 ${selfHost} 打开的 —— 对同事来说这不是一个能打开的地址。\n` +
        `服务器：${server}（数据 ${peers.server.dbFile ?? "—"}）\n` +
        (recommended
          ? `同事要用：${recommended.url}`
          : "这台服务器没读到对内地址（同事打不开这一台；先确认它连上了局域网或虚拟局域网）") +
        `\n现在连着的端：\n${endsLine}\n` +
        `同事若在自己电脑上另开一份，两边数据不互通 —— 这正是"我这边加单、他那边收不到"的常见原因。`,
    };
  }
  return {
    text: `${peers.peers} 台`,
    tone: peers.peers > 1 ? "ok" : "info",
    title: `服务器：${server}（数据 ${peers.server.dbFile ?? "—"}）\n本页地址：${selfHost}\n现在连着的端：\n${endsLine}`,
  };
}

/** 地址按类别分组（局域网在前、虚拟局域网在后），组内保持服务端给的顺序 */
export function addressGroups(addresses: CollabAddress[]): { lan: CollabAddress[]; vpn: CollabAddress[] } {
  return {
    lan: addresses.filter((item) => item.kind === "lan"),
    vpn: addresses.filter((item) => item.kind === "vpn"),
  };
}

/** 「多久以前」：现场读数用秒/分钟，别显示毫秒 */
export function idleText(ms: number | null | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 3_000) return "刚刚";
  if (ms < 60_000) return `${Math.floor(ms / 1000)} 秒前`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} 分钟前`;
  return `${Math.floor(ms / 3_600_000)} 小时前`;
}

/** 「开着多久了」：从打开到现在 */
export function openedText(ms: number | null | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 60_000) return `${Math.max(1, Math.floor(ms / 1000))} 秒`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} 分钟`;
  return `${Math.floor(ms / 3_600_000)} 小时 ${Math.floor((ms % 3_600_000) / 60_000)} 分钟`;
}

/**
 * 端列表的读法：一台端一行，把"谁 · 从哪台机器 · 在哪一页 · 还活着吗"说全。
 * 最近 10 秒内有动静才算"活着"（客户端心跳 15 秒一次，45 秒无消息就自己重连）。
 */
export const END_ALIVE_MS = 25_000;

export function endRows(ends: CollabEnd[]): { key: string; text: string; alive: boolean }[] {
  return ends.map((end) => ({
    key: end.id,
    alive: end.idleMs <= END_ALIVE_MS,
    text:
      `${end.accountName ?? end.accountId ?? "未登录"} · ${end.address}` +
      ` · ${end.page ?? "（未知页面）"} · 已开 ${openedText(end.openedMs)} · ${idleText(end.idleMs)}有动静`,
  }));
}

/**
 * 同步实测结论的读法。
 *
 * 「M/N 台端在 x 秒内收到」——没回执的端点名，因为现场要查的就是它。
 * 一台端都没连上时**不能算通过**（那只是"没人在听"，不是"同步好了"）。
 */
export function probeVerdict(probe: {
  ends: number;
  acked: { addressLabel: string; accountId: string | null }[];
  pending: { addressLabel: string; accountId: string | null }[];
  ok: boolean;
  lastAckMs: number | null;
}): { text: string; tone: "ok" | "warn" | "danger"; detail: string } {
  const who = (item: { addressLabel: string; accountId: string | null }) => `${item.accountId ?? "未登录"}@${item.addressLabel}`;
  if (probe.ends === 0) {
    return {
      text: "没有端在听",
      tone: "danger",
      detail: "这台服务器上一个页面都没连着 —— 别人那边当然收不到任何东西；先把内网地址发给同事，让他打开这一台。",
    };
  }
  const seconds = probe.lastAckMs === null ? null : (probe.lastAckMs / 1000).toFixed(1);
  if (probe.ok) {
    return {
      text: `写入→全网可见 ${probe.acked.length}/${probe.ends} 台${seconds ? `（${seconds} 秒）` : ""}`,
      tone: "ok",
      detail: `每一台连着的端都收到了这条写入：${probe.acked.map(who).join("、")}`,
    };
  }
  return {
    text: `只有 ${probe.acked.length}/${probe.ends} 台收到`,
    tone: "warn",
    detail: `没回执的端：${probe.pending.map(who).join("、")} —— 这一台的页面可能已经断了（刷新一下，或看它是不是被切到后台很久）。`,
  };
}

/** 服务器身份那一行 */
export function serverLine(server: CollabServer | null): string {
  if (!server) return "（未读取）";
  const started = server.startedAt?.slice(11, 19) ?? "—";
  return `${server.hostname}:${server.port ?? "?"} · 数据 ${server.dbFile ?? "—"} · 服务启动于 ${started}`;
}

/** 地址清单里推荐的那一条（没有就退回第一条内网地址） */
export function recommendedUrl(peers: LanPeers | null): string | null {
  if (!peers) return null;
  const hit = peers.addresses.find((item) => item.recommended);
  if (hit) return hit.url;
  return peers.addresses.find((item) => item.kind === "lan")?.url ?? null;
}
