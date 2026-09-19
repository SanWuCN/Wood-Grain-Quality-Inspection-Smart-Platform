/**
 * 多机协同 · 可见性底座
 *
 * ── 这个模块回答的三个现场问题 ──────────────────────────────────────────
 * 用户 2026-09-18 报的问题原话：「我这边添加工单，沈那边收不到；沈那边派发人员，
 * 我这边也同步不到。」——两边都不动，只有两种可能：**写的不是同一台服务器**，
 * 或者**有一台的实时通道断了**。这两种在现场都不可见：
 *   · 页面从 `localhost:8000` 打开时，"我这台"和"服务器那台"看起来一模一样；
 *   · 平台原来只报内网网段的地址，**虚拟局域网（Radmin 之类）的地址根本不列**，
 *     远程的同事拿不到能连的地址，只能自己去 ipconfig 里翻。
 *
 * 所以这里提供三件事，全部**只报事实、不做推断**：
 *   ① `usableAddresses()` —— 这台服务器到底能被哪些地址打开（含虚拟局域网），
 *      每条的网卡名与类别都是 `os.networkInterfaces()` 的原样读数；
 *   ② `normalizeClientAddress()` —— 把 TCP 对端地址归一成一行人读的字符串，
 *      这是"这条写入来自哪台机器"的唯一来源（不从页面自报的信息里取）；
 *   ③ `createWriteLog()` / `createProbeBook()` —— 「最近谁从哪台机器写了什么」
 *      与「一次写入几台端真收到了」两份现场读数。
 *
 * 不做的事：不猜端数、不猜地址、不合并两个客户端的时钟。地址一律来自服务端网卡
 * 枚举或 TCP 对端，时间一律来自服务端。
 */

/** 虚拟机的宿主网卡：只有宿主机自己能通，给别人反而是错地址 */
const VM_IFACE_RE = /vmware|virtualbox|vbox|hyper-?v|vethernet|docker|wsl|npcap|host-?only|virtual/i;
/** 虚拟局域网/隧道：同事在同一个虚拟网里就能连上（Radmin 是现场实际用的那一个） */
const VPN_LAN_IFACE_RE = /radmin|zerotier|tailscale|hamachi|netbird|wireguard|openvpn|softether|easyconnect|sangfor|tap|tun|vpn/i;
/** 只用来翻墙的代理网卡：给别人只会误导（198.18.x.x 这类），不进地址清单 */
const PROXY_IFACE_RE = /ikuuu|clash|surge|v2ray|shadowsocks|ss-?r|trojan|proxy/i;

export const IFACE_KIND_LABEL = {
  lan: "局域网",
  vpn: "虚拟局域网",
};

/**
 * 网卡名 → 类别。
 * 判定顺序是有讲究的：代理 > 虚拟机 > 虚拟局域网 > 局域网。
 * （iKuuu 这类名字里可能带 vpn，先按代理排除掉，否则会给同事一个连不上的地址。）
 */
export function classifyInterface(name) {
  const text = String(name ?? "");
  if (PROXY_IFACE_RE.test(text)) return "proxy";
  if (VM_IFACE_RE.test(text)) return "vm";
  if (VPN_LAN_IFACE_RE.test(text)) return "vpn";
  return "lan";
}

/** 私有网段（PRD 口径：只报内网地址，公网 IP 不列） */
export function isPrivateIpv4(address) {
  return (
    /^10\./.test(address) ||
    /^192\.168\./.test(address) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(address)
  );
}

export function isLoopbackAddress(address) {
  const text = String(address ?? "");
  return text === "::1" || text === "127.0.0.1" || text.startsWith("127.");
}

/**
 * TCP 对端地址归一化。
 *
 * Node 在双栈监听下给的是 `::ffff:192.168.31.150` 这种 IPv4 映射地址，
 * 直接显示给用户是"看不懂"，所以去掉前缀；`::1` 归成 `127.0.0.1`。
 * 拿不到地址（极少见）时回 `"未知"`，不编一个地址出来。
 */
export function normalizeClientAddress(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return "未知";
  const mapped = /^::ffff:(.+)$/i.exec(text);
  if (mapped) return mapped[1];
  if (text === "::1") return "127.0.0.1";
  return text;
}

/** 一行人的读法：本机 / 局域网地址 / 其它 */
export function addressLabel(address) {
  if (isLoopbackAddress(address)) return "本机";
  return address;
}

/**
 * 服务器能被哪些地址打开。
 *
 * 返回顺序 = 现场该念的顺序：先局域网（推荐第一条），再虚拟局域网。
 * 虚拟机的宿主网卡、只有本机能通的地址、代理网卡一律不进清单。
 */
export function usableAddresses(interfaces, port = null) {
  const suffix = port ? `:${port}` : "";
  const lan = [];
  const vpn = [];
  for (const [name, list] of Object.entries(interfaces ?? {})) {
    const kind = classifyInterface(name);
    if (kind === "vm" || kind === "proxy") continue;
    for (const item of list ?? []) {
      if (!item || item.family !== "IPv4" || item.internal) continue;
      const address = String(item.address ?? "");
      /* 169.254.x.x 是"没拿到 DHCP"的自分配地址，报出去只会让人白试 */
      if (!address || address.startsWith("169.254.")) continue;
      if (isLoopbackAddress(address)) continue;
      if (kind === "vpn") {
        vpn.push({ url: `http://${address}${suffix}`, address, iface: name, kind: "vpn", kindLabel: IFACE_KIND_LABEL.vpn });
        continue;
      }
      if (!isPrivateIpv4(address)) continue;
      lan.push({ url: `http://${address}${suffix}`, address, iface: name, kind: "lan", kindLabel: IFACE_KIND_LABEL.lan });
    }
  }
  const ordered = [...lan, ...vpn];
  return ordered.map((item, index) => ({ ...item, recommended: index === 0 }));
}

/**
 * 写入来源日志（内存环形，服务重启即清空）。
 *
 * 为什么不做持久化：它回答的是"刚刚那一下是谁从哪台机器写的"，
 * 属于现场排查的即时读数；真正要留痕的实体变更已经在事件流里了，
 * 而事件流不记客户端地址（那是传输层的事实，不适合写进业务事件）。
 *
 * 为什么要把设备上行排除掉（实测踩到）：树莓派每秒推一帧预览、
 * 每几秒报一次硬件读数，都是 POST。它们混进来之后，环形日志不到三分钟
 * 就被遥测灌满，真正要看的"谁在什么时候改了什么"全被挤出去了。
 */
const TELEMETRY_PATH_RE = /^\/api\/devices\/[^/]+\/(preview|hardware|events)(\/|$)/;
const TELEMETRY_EXACT_RE = /^\/api\/(capture\/screen|cart)\/[^/]+\/(stream|status)$/;

export function isTelemetryWrite(path) {
  const text = String(path ?? "");
  return TELEMETRY_PATH_RE.test(text) || TELEMETRY_EXACT_RE.test(text);
}

export function createWriteLog({ limit = 200, now = Date.now } = {}) {
  const entries = [];
  return {
    record(entry) {
      if (isTelemetryWrite(entry.path)) return false;
      entries.unshift({
        at: new Date(now()).toISOString(),
        atMs: now(),
        method: entry.method,
        path: entry.path,
        action: entry.action ?? null,
        actorId: entry.actorId ?? null,
        address: normalizeClientAddress(entry.address),
        status: entry.status ?? null,
        durationMs: entry.durationMs ?? null,
        note: entry.note ?? null,
      });
      if (entries.length > limit) entries.length = limit;
      return true;
    },
    list(count = 20) {
      return entries.slice(0, Math.max(0, Math.min(count, limit)));
    },
    size() {
      return entries.length;
    },
  };
}

/**
 * 同步实测簿。
 *
 * 一次实测 = 服务端**真写一条事件**（走 `appendEvent` + 广播，和工单事件同一条路），
 * 每个端收到后在实时通道上回一条 `sync-ack`。于是结论是三条读数拼出来的：
 *   `ends`   下发时房间里有几台端；
 *   `acked`  真回了执的端（地址 + 账号 + 用时）；
 *   `pending` 没回的端 —— 现场要盯的就是这几个。
 *
 * 时钟只用服务端自己的：客户端不回时间戳，避免两台电脑时钟不一样导致"用时为负"。
 */
export function createProbeBook({ ttlMs = 120_000, keep = 20, now = Date.now } = {}) {
  const probes = new Map();

  const prune = () => {
    const deadline = now() - ttlMs;
    for (const [id, probe] of probes) {
      if (probe.atMs < deadline) probes.delete(id);
    }
    while (probes.size > keep) {
      const oldest = [...probes.entries()].sort((a, b) => a[1].atMs - b[1].atMs)[0];
      if (!oldest) break;
      probes.delete(oldest[0]);
    }
  };

  const detail = (probe) => {
    const ackedIds = new Set(probe.acked.map((item) => item.endId));
    return {
      probeId: probe.probeId,
      sessionId: probe.sessionId,
      seq: probe.seq,
      at: new Date(probe.atMs).toISOString(),
      ageMs: now() - probe.atMs,
      from: { ...probe.from, addressLabel: addressLabel(probe.from?.address ?? "") },
      /** 下发时的端数（房间里真实连接数） */
      ends: probe.ends.length,
      /**
       * 房间里**已经没动静**的端数（半开连接：浏览器被强杀、笔记本休眠、切网之后
       * TCP 既不报错也不触发 close，于是它在名单里但永远不会回执）。
       * 这些端**不进分母** —— 否则现场念出来的是"只有 2/3 台收到"，而第三台其实早就没了。
       */
      stale: probe.stale ?? 0,
      acked: probe.acked.map((item) => ({ ...item, addressLabel: addressLabel(item.address) })),
      pending: probe.ends
        .filter((end) => !ackedIds.has(end.id))
        .map((end) => ({ ...end, addressLabel: addressLabel(end.address) })),
      /** 全部端都回了执才算通过；一台都没连上时不算通过 */
      ok: probe.ends.length > 0 && probe.acked.length === probe.ends.length,
      /** 最后一台端回执的时刻（现场读数："几秒内全网可见"） */
      lastAckMs: probe.acked.length ? Math.max(...probe.acked.map((item) => item.ms)) : null,
    };
  };

  return {
    /**
     * `ends` 由调用方从 hub 房间里取（本模块不认识 hub）；
     * `stale` 是"没动静、不计入分母"的端数（由调用方按 `idleMs` 判）。
     */
    open({ probeId, sessionId, seq = null, from = {}, ends = [], stale = 0 }) {
      probes.set(probeId, {
        probeId,
        sessionId,
        seq,
        atMs: now(),
        from: { ...from, address: normalizeClientAddress(from.address) },
        ends: ends.map((end) => ({ ...end, address: normalizeClientAddress(end.address) })),
        stale: Math.max(0, Number(stale) || 0),
        acked: [],
      });
      /* 先放进来再清：清完才算"只保留最近 keep 次"，先清后放会多留一次 */
      prune();
      return detail(probes.get(probeId));
    },
    ack(probeId, end) {
      const probe = probes.get(probeId);
      if (!probe) return null;
      if (probe.acked.some((item) => item.endId === end.endId)) return detail(probe);
      probe.acked.push({
        endId: end.endId,
        address: normalizeClientAddress(end.address),
        accountId: end.accountId ?? null,
        page: end.page ?? null,
        at: new Date(now()).toISOString(),
        ms: now() - probe.atMs,
      });
      return detail(probe);
    },
    get(probeId) {
      prune();
      const probe = probes.get(probeId);
      return probe ? detail(probe) : null;
    },
    latest() {
      prune();
      const newest = [...probes.values()].sort((a, b) => b.atMs - a.atMs)[0];
      return newest ? detail(newest) : null;
    },
    size() {
      return probes.size;
    },
  };
}
