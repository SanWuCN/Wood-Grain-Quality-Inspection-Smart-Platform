/**
 * 多机协同页面逻辑 —— 单测
 *
 * 盯的是"现场能不能照着一句话把问题说清楚"：本机模式要转黄并给出该发给同事的地址；
 * 实测结论不能把"没人在听"说成"同步正常"；端列表要把"谁 · 从哪台机器 · 还活着吗"说全。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  addressGroups,
  collabHeadline,
  endRows,
  hostOf,
  idleText,
  isLocalHost,
  openedText,
  probeVerdict,
  recommendedUrl,
  serverLine,
} from "./collabLogic";
import type { LanPeers } from "../api/client";

const PEERS: LanPeers = {
  sessionId: "demo-01",
  peers: 2,
  clients: 2,
  lanUrls: ["http://192.168.31.202:8000"],
  ends: [
    {
      id: "end-1",
      address: "192.168.31.202",
      sessionId: "demo-01",
      accountId: "shi",
      accountName: "史",
      page: "#/orders",
      openedAt: "2026-09-18T03:00:00.000Z",
      lastSeenAt: "2026-09-18T03:10:00.000Z",
      openedMs: 600_000,
      idleMs: 1_200,
    },
    {
      id: "end-2",
      address: "26.206.74.187",
      sessionId: "demo-01",
      accountId: "shen",
      accountName: "沈",
      page: "#/work-orders/SH-2026-0901",
      openedAt: "2026-09-18T03:05:00.000Z",
      lastSeenAt: "2026-09-18T03:09:00.000Z",
      openedMs: 300_000,
      idleMs: 90_000,
    },
  ],
  server: {
    hostname: "MUMAI-PC",
    port: 8000,
    dbFile: "D:\\平台\\server\\data\\mumai.db",
    startedAt: "2026-09-18T02:00:00.000Z",
    serverTime: "2026-09-18T03:10:01.000Z",
  },
  addresses: [
    { url: "http://192.168.31.202:8000", address: "192.168.31.202", iface: "WLAN", kind: "lan", kindLabel: "局域网", recommended: true },
    { url: "http://192.168.2.109:8000", address: "192.168.2.109", iface: "以太网", kind: "lan", kindLabel: "局域网", recommended: false },
    { url: "http://26.206.74.187:8000", address: "26.206.74.187", iface: "Radmin VPN", kind: "vpn", kindLabel: "虚拟局域网", recommended: false },
  ],
  port: 8000,
  serverTime: "2026-09-18T03:10:01.000Z",
};

test("本机模式判定与主机名解析", () => {
  assert.equal(isLocalHost("localhost"), true);
  assert.equal(isLocalHost("127.0.0.1"), true);
  assert.equal(isLocalHost("127.1.2.3"), true);
  assert.equal(isLocalHost("::1"), true);
  assert.equal(isLocalHost("192.168.31.202"), false);
  assert.equal(isLocalHost("MUMAI-PC"), false);
  assert.equal(isLocalHost(""), false);

  assert.equal(hostOf("192.168.31.202:8000"), "192.168.31.202");
  assert.equal(hostOf("http://192.168.31.202:8000/"), "192.168.31.202");
  assert.equal(hostOf("localhost:5173"), "localhost");
  assert.equal(hostOf("[::1]:8000"), "::1");
  assert.equal(hostOf(""), "");
});

test("顶栏「协同」：本机模式要转黄，并把该发给同事的地址写进说明", () => {
  const local = collabHeadline(PEERS, "127.0.0.1:8000");
  assert.equal(local.text, "本机 · 2 台");
  assert.equal(local.tone, "warn");
  assert.match(local.title, /http:\/\/192\.168\.31\.202:8000/, "要说清同事该用哪个地址");
  assert.match(local.title, /MUMAI-PC:8000/);
  assert.match(local.title, /mumai\.db/);
  assert.match(local.title, /shen@26\.206\.74\.187/, "端列表要写进说明里");

  const remote = collabHeadline(PEERS, "192.168.31.150");
  assert.equal(remote.text, "2 台");
  assert.equal(remote.tone, "ok");
  assert.doesNotMatch(remote.title, /两边数据不互通/);

  const single = collabHeadline({ ...PEERS, peers: 1, ends: [PEERS.ends[0]] }, "192.168.31.150");
  assert.equal(single.text, "1 台");
  assert.equal(single.tone, "info", "只有一台在线不算「多方在线」，但也不是问题");

  const unknown = collabHeadline(null, "192.168.31.202");
  assert.equal(unknown.text, "—");
  assert.equal(unknown.tone, "muted");

  /* 服务器没有对内地址时也要说清（"同事打不开这一台"），而不是安静地当成正常 */
  const noAddress = collabHeadline({ ...PEERS, addresses: [] }, "127.0.0.1");
  assert.equal(noAddress.tone, "warn");
  assert.equal(noAddress.text, "本机 · 2 台");
  assert.match(noAddress.title, /没读到对内地址/);
});

test("地址分组与推荐地址：局域网在前、虚拟局域网在后", () => {
  const groups = addressGroups(PEERS.addresses);
  assert.deepEqual(groups.lan.map((item) => item.address), ["192.168.31.202", "192.168.2.109"]);
  assert.deepEqual(groups.vpn.map((item) => item.address), ["26.206.74.187"]);
  assert.equal(recommendedUrl(PEERS), "http://192.168.31.202:8000");
  /* 服务端没标推荐时退回第一条内网地址，而不是虚拟局域网那条 */
  const noFlag = { ...PEERS, addresses: PEERS.addresses.map((item) => ({ ...item, recommended: false })) };
  assert.equal(recommendedUrl(noFlag), "http://192.168.31.202:8000");
  const onlyVpn = { ...PEERS, addresses: PEERS.addresses.filter((item) => item.kind === "vpn") };
  assert.equal(recommendedUrl(onlyVpn), null, "只有虚拟局域网时不给「推荐」，页面照实说明");
  assert.equal(recommendedUrl(null), null);
});

test("时间读数：秒 / 分钟 / 小时，负数与空值不编数", () => {
  assert.equal(idleText(1_200), "刚刚");
  assert.equal(idleText(9_000), "9 秒前");
  assert.equal(idleText(90_000), "1 分钟前");
  assert.equal(idleText(7_200_000), "2 小时前");
  assert.equal(idleText(null), "—");
  assert.equal(idleText(-1), "—");
  assert.equal(openedText(20_000), "20 秒");
  assert.equal(openedText(600_000), "10 分钟");
  assert.equal(openedText(5_400_000), "1 小时 30 分钟");
  assert.equal(openedText(undefined), "—");
});

test("端列表：一台一行，把账号 / 地址 / 页面 / 活着吗说全", () => {
  const rows = endRows(PEERS.ends);
  assert.equal(rows.length, 2);
  assert.match(rows[0].text, /史 · 192\.168\.31\.202 · #\/orders · 已开 10 分钟 · 刚刚有动静/);
  assert.equal(rows[0].alive, true);
  assert.equal(rows[1].alive, false, "90 秒没动静就是「这条通道可能断了」");
  assert.deepEqual(endRows([]), []);
});

test("实测结论：没人在听 / 全网可见 / 只到一部分，三种说法不能混", () => {
  const none = probeVerdict({ ends: 0, acked: [], pending: [], ok: false, lastAckMs: null });
  assert.equal(none.tone, "danger");
  assert.equal(none.text, "没有端在听");
  assert.match(none.detail, /一个页面都没连着/);

  const all = probeVerdict({
    ends: 2,
    acked: [
      { addressLabel: "192.168.31.202", accountId: "shi" },
      { addressLabel: "26.206.74.187", accountId: "shen" },
    ],
    pending: [],
    ok: true,
    lastAckMs: 1200,
  });
  assert.equal(all.tone, "ok");
  assert.match(all.text, /写入→全网可见 2\/2 台（1\.2 秒）/);
  assert.match(all.detail, /shen@26\.206\.74\.187/);

  const partial = probeVerdict({
    ends: 2,
    acked: [{ addressLabel: "192.168.31.202", accountId: "shi" }],
    pending: [{ addressLabel: "26.206.74.187", accountId: "shen" }],
    ok: false,
    lastAckMs: 800,
  });
  assert.equal(partial.tone, "warn");
  assert.match(partial.text, /只有 1\/2 台收到/);
  assert.match(partial.detail, /shen@26\.206\.74\.187/);
});

test("服务器身份那一行：主机 / 端口 / 库文件 / 启动时刻", () => {
  assert.equal(serverLine(PEERS.server), "MUMAI-PC:8000 · 数据 D:\\平台\\server\\data\\mumai.db · 服务启动于 02:00:00");
  assert.equal(serverLine(null), "（未读取）");
});
