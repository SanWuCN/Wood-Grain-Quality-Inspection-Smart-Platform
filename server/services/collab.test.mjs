/**
 * 多机协同底座 —— 单测（纯函数 + 内存簿，不起服务）
 *
 * 这一组盯的是"现场能不能照着一个读数把话说清楚"：
 *   · 地址清单里**必须有虚拟局域网那条**（用户实际的远程同事就靠 Radmin 连进来，
 *     原来它被"只要 192.168/10.x"的过滤条件丢掉了）；
 *   · 代理网卡与虚拟机宿主网卡**必须不在清单里** —— 给同事一个连不上的地址
 *     比不给更坏（他会以为平台坏了）；
 *   · "这条写入来自哪台机器"只认 TCP 对端地址，IPv4 映射地址要归一成人能读的样子；
 *   · 同步实测的回执要能数出"几台端回了、哪几台没回"。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

const {
  classifyInterface,
  isPrivateIpv4,
  normalizeClientAddress,
  addressLabel,
  usableAddresses,
  createWriteLog,
  createProbeBook,
} = await import("./collab.mjs");

/** 这台机器的真实网卡快照（2026-09-18 现场：8 条 IPv4，5 条是虚拟网卡） */
const MACHINE = {
  "Radmin VPN": [{ family: "IPv4", address: "26.206.74.187", internal: false }],
  "iKuuuVPN": [{ family: "IPv4", address: "198.18.0.1", internal: false }],
  "VMware Network Adapter VMnet8": [{ family: "IPv4", address: "192.168.75.1", internal: false }],
  "VirtualBox Host-Only Network": [{ family: "IPv4", address: "169.254.7.74", internal: false }],
  "WLAN": [{ family: "IPv4", address: "192.168.31.202", internal: false }],
  "以太网": [{ family: "IPv4", address: "192.168.2.109", internal: false }],
  "WLAN 4": [{ family: "IPv4", address: "169.254.68.190", internal: false }],
  "Loopback Pseudo-Interface 1": [{ family: "IPv4", address: "127.0.0.1", internal: true }],
};

test("网卡分类：代理 / 虚拟机 / 虚拟局域网 / 局域网各归各的", () => {
  assert.equal(classifyInterface("Radmin VPN"), "vpn");
  assert.equal(classifyInterface("Tailscale"), "vpn");
  assert.equal(classifyInterface("iKuuuVPN"), "proxy", "翻墙代理不能当虚拟局域网报出去");
  assert.equal(classifyInterface("VMware Network Adapter VMnet1"), "vm");
  assert.equal(classifyInterface("VirtualBox Host-Only Network"), "vm");
  assert.equal(classifyInterface("WLAN"), "lan");
  assert.equal(classifyInterface("以太网"), "lan");
  assert.equal(classifyInterface(undefined), "lan");
});

test("地址清单：内网两条 + Radmin 一条，虚拟机/代理/169.254 全部不进清单", () => {
  const list = usableAddresses(MACHINE, 8000);
  const urls = list.map((item) => item.url);
  assert.deepEqual(
    urls,
    ["http://192.168.31.202:8000", "http://192.168.2.109:8000", "http://26.206.74.187:8000"],
    `实得：${urls.join(" / ")}`,
  );
  assert.equal(list[0].recommended, true, "第一条是现场该念的地址");
  assert.equal(list.filter((item) => item.recommended).length, 1, "只能推荐一条，多了等于没推荐");
  assert.equal(list[2].kind, "vpn");
  assert.equal(list[2].kindLabel, "虚拟局域网");
  assert.equal(list[2].iface, "Radmin VPN");
  /* 反向断言：这几条**不能**出现 —— 出现了就会让同事白试 */
  for (const bad of ["192.168.75.1", "169.254.7.74", "198.18.0.1", "169.254.68.190", "127.0.0.1"]) {
    assert.ok(!urls.some((url) => url.includes(bad)), `${bad} 不该出现在地址清单里`);
  }
  /* 没有端口时不编一个端口出来 */
  assert.deepEqual(usableAddresses({ WLAN: MACHINE.WLAN }, null).map((item) => item.url), ["http://192.168.31.202"]);
  assert.deepEqual(usableAddresses({}, 8000), []);
});

test("内网网段判定与对端地址归一化", () => {
  assert.equal(isPrivateIpv4("192.168.2.109"), true);
  assert.equal(isPrivateIpv4("10.0.0.5"), true);
  assert.equal(isPrivateIpv4("172.20.1.1"), true);
  assert.equal(isPrivateIpv4("26.206.74.187"), false, "Radmin 的 26.x 不是内网网段，靠网卡名归类");
  assert.equal(isPrivateIpv4("198.18.0.1"), false);

  assert.equal(normalizeClientAddress("::ffff:192.168.31.150"), "192.168.31.150");
  assert.equal(normalizeClientAddress("::1"), "127.0.0.1");
  assert.equal(normalizeClientAddress("192.168.31.202"), "192.168.31.202");
  assert.equal(normalizeClientAddress(""), "未知");
  assert.equal(addressLabel("127.0.0.1"), "本机");
  assert.equal(addressLabel("192.168.31.150"), "192.168.31.150");
});

test("写入来源日志：最新的在最前、按上限截断、地址归一化", () => {
  let clock = 1_000;
  const log = createWriteLog({ limit: 3, now: () => (clock += 1_000) });
  log.record({ method: "POST", path: "/api/commands", actorId: "shi", address: "::ffff:192.168.31.202", status: 200 });
  log.record({ method: "PUT", path: "/api/work-orders/wo-1/assignment", actorId: "shen", address: "26.206.74.187", status: 200 });
  log.record({ method: "DELETE", path: "/api/work-orders/wo-1", actorId: "shen", address: "26.206.74.187", status: 200 });
  log.record({ method: "POST", path: "/api/work-orders/trigger", actorId: "shi", address: "192.168.31.202", status: 200 });
  const list = log.list(10);
  assert.equal(list.length, 3, "上限 3 条，第 4 条把最老的挤掉");
  assert.equal(list[0].path, "/api/work-orders/trigger");
  assert.equal(list[0].address, "192.168.31.202");
  assert.ok(!list.some((item) => item.path === "/api/commands"), "最老的一条已经被挤掉");
  assert.deepEqual(log.list(0), []);
});

test("写入来源日志：设备遥测不进日志（每秒一帧预览会把真写入挤出去）", () => {
  const log = createWriteLog({ limit: 5 });
  assert.equal(log.record({ method: "POST", path: "/api/devices/handheld-02/preview", address: "192.168.31.60", status: 200 }), false);
  assert.equal(log.record({ method: "POST", path: "/api/devices/handheld-02/hardware", address: "192.168.31.60", status: 200 }), false);
  assert.equal(log.record({ method: "POST", path: "/api/work-orders/wo-1/assignment", actorId: "shen", address: "26.206.74.187", status: 200 }), true);
  assert.equal(log.size(), 1);
  /* 设备域下的**人工动作**（下发命令）要留痕：它不是遥测 */
  assert.equal(log.record({ method: "POST", path: "/api/devices/handheld-02/commands", actorId: "shen", status: 200 }), true);
  assert.equal(log.size(), 2);
});

test("同步实测簿：几台端回了执、哪几台没回、用时多少", () => {
  let clock = 10_000;
  const book = createProbeBook({ now: () => clock });
  const ends = [
    { id: "end-1", address: "192.168.31.202", accountId: "shi", page: "#/orders" },
    { id: "end-2", address: "::ffff:26.206.74.187", accountId: "shen", page: "#/orders" },
  ];
  const opened = book.open({ probeId: "probe-1", sessionId: "demo-01", seq: 400, from: { address: "192.168.31.202" }, ends });
  assert.equal(opened.ends, 2);
  assert.equal(opened.ok, false, "一台都没回执时不算通过");
  assert.equal(opened.pending.length, 2);

  clock += 800;
  const half = book.ack("probe-1", { endId: "end-1", address: "192.168.31.202", accountId: "shi" });
  assert.equal(half.acked.length, 1);
  assert.equal(half.pending.length, 1);
  assert.equal(half.pending[0].address, "26.206.74.187", "没回的那台要报出它是谁");
  assert.equal(half.ok, false);

  clock += 400;
  const full = book.ack("probe-1", { endId: "end-2", address: "::ffff:26.206.74.187", accountId: "shen" });
  assert.equal(full.ok, true);
  assert.equal(full.acked.length, 2, "同一台端重复回执不重复计数");
  assert.equal(full.acked[0].addressLabel, "192.168.31.202", "地址原样保留，另给一个人读的标签");
  assert.equal(full.acked[0].address, "192.168.31.202");
  assert.equal(full.lastAckMs, 1200, "“几秒内全网可见”这句结论由服务端时钟算出来");
  assert.equal(book.ack("probe-1", { endId: "end-2", address: "26.206.74.187" }).acked.length, 2);

  assert.equal(book.ack("probe-不存在", { endId: "x" }), null);
  assert.equal(book.get("probe-不存在"), null);

  /* 过期之后不再当现场读数用（否则会拿着几分钟前的结论说事） */
  clock += 200_000;
  assert.equal(book.get("probe-1"), null);
  assert.equal(book.latest(), null);
});

test("同步实测簿：没动静的端不进分母，单独报 stale（否则现场读到「只有 2/3 台收到」）", () => {
  let clock = 1_000;
  const book = createProbeBook({ now: () => clock });
  /*
    现场场景：房间里有一台**半开连接**（浏览器被强杀/笔记本休眠/切网，TCP 不报错也不 close），
    它在名单里但永远不会回执。hub 侧按 idleMs 把它挡在分母外，只报 stale 计数。
  */
  const alive = [{ id: "end-1", address: "192.168.101.8", accountId: "shen", page: "#/mapping" }];
  const opened = book.open({ probeId: "probe-stale", sessionId: "demo-01", ends: alive, stale: 2 });
  assert.equal(opened.ends, 1, "分母只算活着的端");
  assert.equal(opened.stale, 2, "没动静的端单独报数，界面才能说明白");
  assert.equal(opened.ok, false);

  clock += 500;
  const done = book.ack("probe-stale", { endId: "end-1", address: "192.168.101.8", accountId: "shen" });
  assert.equal(done.ok, true, "活着的端都回了执就算通过（不再被死端拖成「只有 1/3」）");
  assert.equal(done.stale, 2, "结论里仍要带着「另有 2 台没动静」，不能假装房间里只有一台");
});

test("同步实测簿：只保留最近若干次，最新的那次能直接取到", () => {
  let clock = 0;
  const book = createProbeBook({ keep: 2, now: () => (clock += 1) });
  book.open({ probeId: "p1", sessionId: "demo-01", ends: [] });
  book.open({ probeId: "p2", sessionId: "demo-01", ends: [] });
  book.open({ probeId: "p3", sessionId: "demo-01", ends: [] });
  assert.equal(book.size(), 2);
  assert.equal(book.latest().probeId, "p3");
  assert.equal(book.get("p1"), null);
});
