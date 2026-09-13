/**
 * 设备网关 · 手持终端（树莓派 Pi 5 / woodpulse）接入
 *
 * 为什么要有这个模块
 * ------------------
 * 平台的 34 条路由全是浏览器用的；手持扫描枪那一路（`woodpulse`）发的
 * `/api/devices/register`、`/api/device-events/batch`、`/api/devices/{id}/hardware`
 * 一条都不存在，所以终端一直显示「平台离线」，硬件页的四块数据也只能用种子。
 * 这个模块把终端已经实现的上行接口落成平台侧的一份实现。
 *
 * 契约以终端侧两份文档为准（`手持扫描仪/docs/`）：
 *   · `平台接入实施说明.md`   —— 握手、心跳、事件、命令、上传
 *   · `设备数据接口说明.md`   —— 硬件页的读数 / 通道 / 批次
 *
 * 三条口径，与终端文档一致、也和平台现有页面一致：
 *   1. **来源要能一眼看出来**：读数带 `source = real | derived | estimated`，
 *      页面照原样显示，不把估算值当实测值；
 *   2. **没有的字段就是没有**：终端不下发「电池电量」（本机没有电量计），
 *      平台也不补默认值 —— `0` 只表示有效的零值；
 *   3. **在线判定平台自己算一份**：终端那份（WS 通不通）由终端算，
 *      平台这份按「最近一次上报距今多久」算，两者不冲突。
 *
 * 落库：SQLite（与 sensortag 服务同样的做法，表在本模块内建，不改 db.mjs 的
 * 全局 SCHEMA —— 设备网关是可选的一路，不加它平台照常跑）。
 */

import { WebSocketServer } from "ws";
import { WorkflowError } from "./workflow.mjs";

/** 终端契约版本：主版本不匹配时终端会拒收平台消息（当前 1.x） */
const SCHEMA_VERSION = "1.0";
/** 最近 N 份硬件上报（终端 2 秒一份，300 份约 10 分钟；给趋势与断流判断用） */
const HARDWARE_KEEP = 300;
/** 事件保留条数：够页面看最近发生了什么，不至于把库撑大 */
const EVENT_KEEP = 800;
/** 预览图环形缓冲（1—2 fps 的低帧率监看图，不是归档图像） */
const PREVIEW_KEEP = 12;

const DEFAULT_HEARTBEAT_MS = 5000;
const DEFAULT_OFFLINE_MS = 15000;
/** 超过 3 × 上报周期（2 秒）没收到硬件数据就按 stale 显示（终端文档 §3） */
const DEFAULT_STALE_MS = 6000;

const DEVICE_ID_PATTERN = /^[\w.:-]{1,64}$/;

/**
 * 设备令牌表。
 *
 * 形如 `MUMAI_DEVICE_TOKENS="handheld-02:demo-token,other:xyz"`；
 * 只有令牌（没有 `deviceId:` 前缀）时表示**任意设备可用**。
 * 默认 `demo-token` 与终端 `deploy/config.pi5.json` 的出厂值一致，
 * 内网演示不需要额外配置就能连上。
 */
function parseTokens(raw) {
  const perDevice = new Map();
  const anyDevice = new Set();
  for (const entry of String(raw ?? "demo-token").split(",")) {
    const text = entry.trim();
    if (!text) continue;
    const at = text.indexOf(":");
    if (at > 0) {
      const deviceId = text.slice(0, at).trim();
      const token = text.slice(at + 1).trim();
      if (!token) continue;
      if (!perDevice.has(deviceId)) perDevice.set(deviceId, new Set());
      perDevice.get(deviceId).add(token);
    } else {
      anyDevice.add(text);
    }
  }
  return { perDevice, anyDevice };
}

const nowIso = () => new Date().toISOString();

/** 把 ISO 时间戳解析成毫秒；解析不了返回 null（不猜时间） */
function parseTime(value) {
  if (!value) return null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

function readJson(text, fallback = null) {
  if (text === null || text === undefined) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export function createDeviceGateway({
  db,
  sessionId = "demo-01",
  heartbeatIntervalMs = DEFAULT_HEARTBEAT_MS,
  offlineAfterMs = DEFAULT_OFFLINE_MS,
  staleAfterMs = DEFAULT_STALE_MS,
  tokens = parseTokens(process.env.MUMAI_DEVICE_TOKENS),
  configVersion = process.env.MUMAI_CONFIG_VERSION || "CFG-02",
} = {}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS device_registry (
      device_id        TEXT PRIMARY KEY,
      boot_id          TEXT,
      connection_state TEXT,
      last_seen_at     TEXT,
      registered_at    TEXT,
      app_version      TEXT,
      adapter_version  TEXT,
      model_version    TEXT,
      host             TEXT,
      capabilities     TEXT,
      updated_at       TEXT
    );

    CREATE TABLE IF NOT EXISTS device_hardware (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id   TEXT NOT NULL,
      received_at TEXT NOT NULL,
      sampled_at  TEXT,
      source_mode TEXT,
      payload     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS device_hardware_lookup ON device_hardware (device_id, id DESC);

    CREATE TABLE IF NOT EXISTS device_events (
      message_id  TEXT PRIMARY KEY,
      device_id   TEXT NOT NULL,
      type        TEXT NOT NULL,
      seq         INTEGER,
      sent_at     TEXT,
      received_at TEXT NOT NULL,
      payload     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS device_events_lookup ON device_events (device_id, received_at DESC);

    CREATE TABLE IF NOT EXISTS device_commands (
      command_id  TEXT PRIMARY KEY,
      device_id   TEXT NOT NULL,
      type        TEXT NOT NULL,
      args        TEXT,
      state       TEXT NOT NULL,
      scope       TEXT,
      created_at  TEXT NOT NULL,
      expires_at  TEXT,
      sent_at     TEXT,
      accepted_at TEXT,
      executed_at TEXT,
      failed_at   TEXT,
      reason      TEXT,
      error_code  TEXT,
      result      TEXT
    );
    CREATE INDEX IF NOT EXISTS device_commands_lookup ON device_commands (device_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS device_telemetry (
      device_id   TEXT PRIMARY KEY,
      received_at TEXT NOT NULL,
      payload     TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS device_config_acks (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id      TEXT NOT NULL,
      config_version TEXT NOT NULL,
      state          TEXT,
      boot_id        TEXT,
      applied_at     TEXT,
      received_at    TEXT NOT NULL,
      snapshot       TEXT,
      diff           TEXT
    );
    CREATE INDEX IF NOT EXISTS device_config_acks_lookup ON device_config_acks (device_id, id DESC);
  `);

  /** deviceId → Set<WebSocket>（同一台设备重连时旧的会被替换，不并存） */
  const sockets = new Map();
  /** deviceId → { index, jpeg, at }[] */
  const previews = new Map();
  /** 关服务时置位：socket 的 close 回调不能再碰已经关掉的库 */
  let shuttingDown = false;

  const registryRow = (deviceId) =>
    db.prepare("SELECT * FROM device_registry WHERE device_id = ?").get(deviceId) ?? null;

  /* ---------------- 身份与在线 ---------------- */

  function tokenAllowed(deviceId, token) {
    if (!token) return false;
    if (tokens.anyDevice.has(token)) return true;
    return tokens.perDevice.get(deviceId)?.has(token) ?? false;
  }

  function requireToken(req, deviceId) {
    const header = req?.headers ?? {};
    const token = header["x-device-token"] ?? header["x-device-token".toLowerCase()] ?? "";
    const headerDevice = header["x-device-id"];
    if (headerDevice && headerDevice !== deviceId) {
      throw new WorkflowError(403, "DEVICE_MISMATCH", `令牌与设备不符：${headerDevice} ≠ ${deviceId}`);
    }
    if (!tokenAllowed(deviceId, String(token))) {
      throw new WorkflowError(401, "BAD_DEVICE_TOKEN", "设备令牌无效，请核对平台侧 MUMAI_DEVICE_TOKENS 与终端配置");
    }
    return { deviceId, token: String(token) };
  }

  /** 在线状态：platform 侧口径（终端自己那份按 WS 判，见文档 §3.4） */
  function linkOf(deviceId, row = registryRow(deviceId)) {
    const lastSeenMs = parseTime(row?.last_seen_at);
    const ageSec = lastSeenMs === null ? null : Math.max(0, Math.round((Date.now() - lastSeenMs) / 1000));
    const live = (sockets.get(deviceId)?.size ?? 0) > 0;
    let state = "unknown";
    if (ageSec !== null) {
      /*
        判据取「最近一次上报距今多久」而不是「WS 在不在」：
        终端的硬件上报是 HTTP、心跳与命令走 WS，两者可能只断一条；
        数据还在两秒一份地来，页面就该显示在线（WS 状态另给 socketConnected）。
      */
      if (ageSec * 1000 <= staleAfterMs) state = "online";
      else if (ageSec * 1000 <= offlineAfterMs) state = "stale";
      else state = "offline";
    }
    return { state, ageSec, lastSeenAt: row?.last_seen_at ?? null, socketConnected: live };
  }

  function touch(deviceId, { bootId, connectionState } = {}) {
    const row = registryRow(deviceId);
    if (!row) {
      db.prepare(
        `INSERT INTO device_registry (device_id, boot_id, connection_state, last_seen_at, registered_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(deviceId, bootId ?? null, connectionState ?? "connecting", nowIso(), nowIso(), nowIso());
      return;
    }
    db.prepare(
      `UPDATE device_registry
         SET boot_id = COALESCE(?, boot_id),
             connection_state = COALESCE(?, connection_state),
             last_seen_at = ?,
             updated_at = ?
       WHERE device_id = ?`,
    ).run(bootId ?? null, connectionState ?? null, nowIso(), nowIso(), deviceId);
  }

  /* ---------------- 握手 ---------------- */

  function register(body, req) {
    const deviceId = String(body?.deviceId ?? req?.headers?.["x-device-id"] ?? "").trim();
    if (!DEVICE_ID_PATTERN.test(deviceId)) {
      throw new WorkflowError(422, "BAD_DEVICE_ID", "设备编号无效（只允许字母、数字与 . _ : -）");
    }
    requireToken(req, deviceId);
    const schema = String(body?.schemaVersion ?? SCHEMA_VERSION);
    if (!schema.startsWith("1.")) {
      throw new WorkflowError(422, "SCHEMA_MISMATCH", `平台只接受 schemaVersion 1.x，收到 ${schema}`);
    }

    const bootId = body?.bootId ? String(body.bootId) : null;
    const row = registryRow(deviceId);
    // 同一个 bootId 重复注册 = 终端重连重握手，按幂等处理（文档 §3.1）
    db.prepare(
      `INSERT INTO device_registry
         (device_id, boot_id, connection_state, last_seen_at, registered_at, app_version, adapter_version, model_version, host, capabilities, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(device_id) DO UPDATE SET
         boot_id = excluded.boot_id,
         connection_state = excluded.connection_state,
         last_seen_at = excluded.last_seen_at,
         app_version = excluded.app_version,
         adapter_version = excluded.adapter_version,
         model_version = excluded.model_version,
         host = excluded.host,
         capabilities = excluded.capabilities,
         updated_at = excluded.updated_at`,
    ).run(
      deviceId,
      bootId,
      "connecting",
      nowIso(),
      row?.registered_at ?? nowIso(),
      String(body?.appVersion ?? ""),
      String(body?.adapterVersion ?? ""),
      String(body?.modelVersion ?? ""),
      JSON.stringify(body?.host ?? {}),
      JSON.stringify(body?.capabilities ?? {}),
      nowIso(),
    );

    return {
      ok: true,
      schemaVersion: SCHEMA_VERSION,
      deviceId,
      bootId,
      registeredAt: nowIso(),
      // 终端拿它算「对工单时间基准」的时钟偏差（readings.clock），必须给
      platformTime: new Date().toISOString(),
      heartbeatIntervalMs,
      offlineAfterMs,
      configVersion,
      demoSessionId: sessionId,
      pendingCommandCount: pendingCommands(deviceId).length,
      restarted: Boolean(row?.boot_id && bootId && row.boot_id !== bootId),
    };
  }

  /* ---------------- 硬件上报（硬件页四块） ---------------- */

  function ingestHardware(deviceId, body, req) {
    if (!DEVICE_ID_PATTERN.test(String(deviceId))) {
      throw new WorkflowError(422, "BAD_DEVICE_ID", "设备编号无效");
    }
    if (req) requireToken(req, deviceId);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new WorkflowError(422, "BAD_HARDWARE_BODY", "设备数据必须是 JSON 对象");
    }
    if (body.deviceId && String(body.deviceId) !== deviceId) {
      throw new WorkflowError(422, "DEVICE_MISMATCH", `上报体里的 deviceId（${body.deviceId}）与路径不一致`);
    }
    const receivedAt = nowIso();
    db.prepare(
      "INSERT INTO device_hardware (device_id, received_at, sampled_at, source_mode, payload) VALUES (?, ?, ?, ?, ?)",
    ).run(
      deviceId,
      receivedAt,
      body.sampledAt ? String(body.sampledAt) : null,
      body.sourceMode ? String(body.sourceMode) : null,
      JSON.stringify(body),
    );
    // 只保留最近 N 份；老的一份份删，避免 IN 子查询在演示机上变慢
    const extra = db
      .prepare("SELECT COUNT(*) AS n FROM device_hardware WHERE device_id = ?")
      .get(deviceId)?.n ?? 0;
    if (extra > HARDWARE_KEEP) {
      db.prepare(
        `DELETE FROM device_hardware
          WHERE device_id = ?
            AND id <= (SELECT id FROM device_hardware WHERE device_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?)`,
      ).run(deviceId, deviceId, HARDWARE_KEEP - 1);
    }

    if (!registryRow(deviceId)) {
      // 没见过 register 就直接推数据：建一条台账，别把数据丢掉
      touch(deviceId, { bootId: body.bootId ? String(body.bootId) : null, connectionState: "connecting" });
    }
    touch(deviceId, { bootId: body.bootId ? String(body.bootId) : null });
    // 终端只在启动时注册一次；设备数据里带的版本可以补上台账（重启前也能看清是哪一版）
    if (body.versions && typeof body.versions === "object") {
      db.prepare(
        `UPDATE device_registry
            SET app_version = COALESCE(NULLIF(app_version, ''), ?),
                adapter_version = COALESCE(NULLIF(adapter_version, ''), ?),
                model_version = COALESCE(NULLIF(model_version, ''), ?)
          WHERE device_id = ?`,
      ).run(
        body.versions.app ? String(body.versions.app) : "",
        body.versions.adapter ? String(body.versions.adapter) : "",
        body.versions.model ? String(body.versions.model) : "",
        deviceId,
      );
    }
    if (body.capabilities && typeof body.capabilities === "object") {
      db.prepare("UPDATE device_registry SET capabilities = ? WHERE device_id = ? AND (capabilities IS NULL OR capabilities = '{}')").run(
        JSON.stringify(body.capabilities),
        deviceId,
      );
    }

    const readings = Array.isArray(body.readings) ? body.readings : [];
    const estimated = readings.filter((item) => item?.source === "estimated").length;
    const derived = readings.filter((item) => item?.source === "derived").length;
    return {
      ok: true,
      deviceId,
      receivedAt,
      stored: true,
      summary: {
        readings: readings.length,
        channels: Array.isArray(body.channels) ? body.channels.length : 0,
        batches: Array.isArray(body.batches) ? body.batches.length : 0,
        estimated,
        derived,
      },
      note: body.note ?? null,
    };
  }

  function latestHardwareRow(deviceId) {
    return (
      db
        .prepare("SELECT * FROM device_hardware WHERE device_id = ? ORDER BY id DESC LIMIT 1")
        .get(deviceId) ?? null
    );
  }

  function telemetryOf(deviceId) {
    const row = db.prepare("SELECT received_at, payload FROM device_telemetry WHERE device_id = ?").get(deviceId);
    if (!row) return null;
    const payload = readJson(row.payload, {});
    return { receivedAt: row.received_at, ageSec: ageSeconds(row.received_at), ...payload };
  }

  function ageSeconds(iso) {
    const ms = parseTime(iso);
    return ms === null ? null : Math.max(0, Math.round((Date.now() - ms) / 1000));
  }

  function lastEvent(deviceId) {
    const row = db
      .prepare("SELECT type, sent_at, received_at, seq, payload FROM device_events WHERE device_id = ? ORDER BY rowid DESC LIMIT 1")
      .get(deviceId);
    if (!row) return null;
    return {
      type: row.type,
      seq: row.seq,
      sentAt: row.sent_at,
      receivedAt: row.received_at,
      ageSec: ageSeconds(row.received_at),
      payload: readJson(row.payload, {}),
    };
  }

  function configAckOf(deviceId) {
    const row = db
      .prepare("SELECT * FROM device_config_acks WHERE device_id = ? ORDER BY id DESC LIMIT 1")
      .get(deviceId);
    if (!row) return null;
    return {
      configVersion: row.config_version,
      state: row.state,
      appliedAt: row.applied_at,
      receivedAt: row.received_at,
      diff: readJson(row.diff, []),
      snapshot: readJson(row.snapshot, null),
    };
  }

  /**
   * 硬件页要的整份数据。
   *
   * `report` 是终端最后一次上报的原样载荷（页面直接当数据源用），
   * 其余字段是平台自己算的链路状态 —— 页面不该从 `report` 里猜「这份数据还新不新」。
   */
  function hardwareView(deviceId) {
    const row = latestHardwareRow(deviceId);
    const registry = registryRow(deviceId);
    const report = row ? readJson(row.payload, null) : null;
    const link = linkOf(deviceId, registry);
    return {
      ok: true,
      deviceId,
      receivedAt: row?.received_at ?? null,
      // 终端还没上报过时 report = null，页面显示「等待设备上报」而不是空白（文档 §3）
      report,
      stale: link.state === "stale" || link.state === "offline",
      ageSec: row ? ageSeconds(row.received_at) : null,
      link,
      ledger: ledgerEntry(deviceId, registry, row),
      telemetry: telemetryOf(deviceId),
      lastEvent: lastEvent(deviceId),
      configAck: configAckOf(deviceId),
      recentCommands: commands(deviceId, 5),
      serverTime: new Date().toISOString(),
    };
  }

  /** 硬件上报的轻量历史（趋势 / CSV 导出用，页面暂时只取最近若干份） */
  function hardwareHistory(deviceId, limit = 120) {
    const rows = db
      .prepare("SELECT received_at, sampled_at, payload FROM device_hardware WHERE device_id = ? ORDER BY id DESC LIMIT ?")
      .all(deviceId, Math.min(Math.max(Number(limit) || 60, 1), HARDWARE_KEEP));
    return rows
      .map((row) => ({
        receivedAt: row.received_at,
        sampledAt: row.sampled_at,
        readings: readJson(row.payload, {})?.readings ?? [],
      }))
      .reverse();
  }

  /* ---------------- 事件（含命令回执） ---------------- */

  function ingestEvents(list, req) {
    if (!Array.isArray(list)) {
      throw new WorkflowError(422, "BAD_EVENTS_BODY", "请求体需要 events 数组");
    }
    // 平台自己设上限；超了返回 413 让终端拆小，不静默截断（文档 §3.5）
    if (list.length > 500) {
      throw new WorkflowError(413, "TOO_MANY_EVENTS", "每批事件上限 500 条，请拆小后重试");
    }
    const accepted = [];
    const duplicated = [];
    const rejected = [];
    const insert = db.prepare(
      `INSERT OR IGNORE INTO device_events (message_id, device_id, type, seq, sent_at, received_at, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    for (const envelope of list) {
      const messageId = String(envelope?.messageId ?? "");
      const deviceId = String(envelope?.deviceId ?? "");
      const type = String(envelope?.type ?? "");
      if (!messageId) {
        rejected.push({ messageId, reason: "缺少 messageId（平台按它去重）", code: "bad_envelope", retryable: false });
        continue;
      }
      if (!type || !deviceId) {
        rejected.push({ messageId, reason: "缺少 type 或 deviceId", code: "bad_envelope", retryable: false });
        continue;
      }
      if (req && !tokenAllowed(deviceId, String(req.headers["x-device-token"] ?? ""))) {
        rejected.push({ messageId, reason: "设备令牌无效", code: "bad_token", retryable: false });
        continue;
      }
      if (envelope.schemaVersion && !String(envelope.schemaVersion).startsWith("1.")) {
        rejected.push({ messageId, reason: "契约版本不匹配", code: "schema_mismatch", retryable: false });
        continue;
      }

      const payload = envelope.payload && typeof envelope.payload === "object" ? envelope.payload : {};

      /*
        心跳（5 秒）与遥测（1 秒）不走事件表：
        它们每秒都在来，存进 `device_events` 会把采集、批次、回执这些**真正要留痕**
        的事件冲掉（保留窗口只有几百条）。这两类只留最新一份 + 更新 last_seen。
        终端仍然拿到 accepted —— 它要的只是「这条 messageId 平台收到了」。
      */
      if (type === "device.telemetry") {
        db.prepare(
          `INSERT INTO device_telemetry (device_id, received_at, payload) VALUES (?, ?, ?)
           ON CONFLICT(device_id) DO UPDATE SET received_at = excluded.received_at, payload = excluded.payload`,
        ).run(deviceId, nowIso(), JSON.stringify(payload));
        if (!registryRow(deviceId)) touch(deviceId, { bootId: envelope.bootId ? String(envelope.bootId) : null });
        touch(deviceId, { bootId: envelope.bootId ? String(envelope.bootId) : null });
        accepted.push(messageId);
        continue;
      }
      if (type === "device.health") {
        if (!registryRow(deviceId)) touch(deviceId, { bootId: envelope.bootId ? String(envelope.bootId) : null });
        touch(deviceId, { bootId: envelope.bootId ? String(envelope.bootId) : null });
        accepted.push(messageId);
        continue;
      }

      const info = insert.run(
        messageId,
        deviceId,
        type,
        Number.isSafeInteger(envelope.seq) ? envelope.seq : null,
        envelope.sentAt ? String(envelope.sentAt) : null,
        nowIso(),
        JSON.stringify(payload),
      );
      if (info.changes === 0) duplicated.push(messageId);
      else accepted.push(messageId);

      if (!registryRow(deviceId)) touch(deviceId, { bootId: envelope.bootId ? String(envelope.bootId) : null });
      touch(deviceId, { bootId: envelope.bootId ? String(envelope.bootId) : null });
      if (type.startsWith("command.")) applyReceipt(payload, type);
    }

    // 保留最近 EVENT_KEEP 条
    const total = db.prepare("SELECT COUNT(*) AS n FROM device_events").get()?.n ?? 0;
    if (total > EVENT_KEEP) {
      db.prepare(
        "DELETE FROM device_events WHERE rowid <= (SELECT rowid FROM device_events ORDER BY rowid DESC LIMIT 1 OFFSET ?)",
      ).run(EVENT_KEEP - 1);
    }
    return { accepted, duplicated, rejected };
  }

  function applyReceipt(payload, type) {
    const commandId = String(payload?.commandId ?? payload?.command_id ?? "");
    if (!commandId) return;
    const state = type === "command.accepted" ? "accepted" : type === "command.executed" ? "executed" : "failed";
    const column = state === "accepted" ? "accepted_at" : state === "executed" ? "executed_at" : "failed_at";
    db.prepare(
      `UPDATE device_commands
          SET state = ?, ${column} = ?, reason = ?, error_code = ?, result = ?, scope = COALESCE(?, scope)
        WHERE command_id = ?`,
    ).run(
      state,
      nowIso(),
      payload?.reason ? String(payload.reason) : null,
      payload?.errorCode ? String(payload.errorCode) : null,
      JSON.stringify(payload?.result ?? {}),
      payload?.scope ? String(payload.scope) : null,
      commandId,
    );
  }

  function events(deviceId, limit = 40) {
    const rows = db
      .prepare("SELECT message_id, type, seq, sent_at, received_at, payload FROM device_events WHERE device_id = ? ORDER BY rowid DESC LIMIT ?")
      .all(deviceId, Math.min(Math.max(Number(limit) || 40, 1), 200));
    return rows.map((row) => ({
      messageId: row.message_id,
      type: row.type,
      seq: row.seq,
      sentAt: row.sent_at,
      receivedAt: row.received_at,
      ageSec: ageSeconds(row.received_at),
      payload: readJson(row.payload, {}),
    }));
  }

  /* ---------------- 下行命令 ---------------- */

  function pendingCommands(deviceId) {
    return db
      .prepare("SELECT * FROM device_commands WHERE device_id = ? AND state IN ('queued','sent') ORDER BY created_at ASC")
      .all(deviceId);
  }

  function commands(deviceId, limit = 10) {
    return db
      .prepare("SELECT * FROM device_commands WHERE device_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(deviceId, limit)
      .map((row) => ({
        commandId: row.command_id,
        action: row.type,
        state: row.state,
        args: readJson(row.args, {}),
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        sentAt: row.sent_at,
        acceptedAt: row.accepted_at,
        executedAt: row.executed_at,
        failedAt: row.failed_at,
        reason: row.reason,
        errorCode: row.error_code,
        result: readJson(row.result, {}),
        scope: row.scope,
      }));
  }

  function pushCommand(row) {
    const socket = [...(sockets.get(row.device_id) ?? [])].find((item) => item.readyState === 1);
    if (!socket) return false;
    // 终端只认这个壳（缺 type / deviceId / bootId / seq / sentAt 会整条丢掉）
    socket.send(
      JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        type: "command",
        deviceId: row.device_id,
        bootId: registryRow(row.device_id)?.boot_id ?? null,
        demoSessionId: sessionId,
        messageId: `msg-${row.command_id}`,
        seq: Date.now() % 2147483647,
        sentAt: nowIso(),
        payload: {
          commandId: row.command_id,
          type: row.type,
          action: row.type,
          expiresAt: row.expires_at,
          args: readJson(row.args, {}),
        },
      }),
    );
    db.prepare("UPDATE device_commands SET state = 'sent', sent_at = ? WHERE command_id = ?").run(nowIso(), row.command_id);
    return true;
  }

  function issueCommand(deviceId, { type, args = {}, ttlMs = 300000 } = {}) {
    const allowed = ["assign_task", "apply_config", "pause_capture", "request_upload", "prepare_update", "query_status"];
    if (!allowed.includes(String(type))) {
      throw new WorkflowError(422, "BAD_COMMAND", `终端不认这条命令：${type}（白名单：${allowed.join(" / ")}）`);
    }
    const commandId = `cmd-${Math.random().toString(16).slice(2, 14)}`;
    const createdAt = nowIso();
    const expiresAt = new Date(Date.now() + Math.max(1000, Number(ttlMs) || 300000)).toISOString();
    db.prepare(
      `INSERT INTO device_commands (command_id, device_id, type, args, state, created_at, expires_at)
       VALUES (?, ?, ?, ?, 'queued', ?, ?)`,
    ).run(commandId, deviceId, String(type), JSON.stringify(args ?? {}), createdAt, expiresAt);
    const row = db.prepare("SELECT * FROM device_commands WHERE command_id = ?").get(commandId);
    const pushed = pushCommand(row);
    return {
      command: commands(deviceId, 1)[0],
      pushed,
      // accepted ≠ executed（文档 §3.6）：页面上要说清现在只是「已下发」
      hint: pushed
        ? "命令已下发到设备通道，等待设备回执（accepted → executed）"
        : "设备当前不在线，命令已排队，设备上线后会收到",
    };
  }

  /* ---------------- 预览图（低帧率监看，不是归档图像） ---------------- */

  function ingestPreview(deviceId, jpeg, frameIndex) {
    if (!Buffer.isBuffer(jpeg) || jpeg.length === 0) {
      throw new WorkflowError(422, "BAD_PREVIEW", "预览图内容为空");
    }
    if (jpeg.length > 2 * 1024 * 1024) {
      throw new WorkflowError(413, "PREVIEW_TOO_LARGE", "预览图超过 2 MB");
    }
    const ring = previews.get(deviceId) ?? [];
    ring.push({ index: Number(frameIndex) || ring.length, jpeg, at: Date.now() });
    while (ring.length > PREVIEW_KEEP) ring.shift();
    previews.set(deviceId, ring);
    touch(deviceId, {});
    return { ok: true, deviceId, frames: ring.length };
  }

  function latestPreview(deviceId) {
    const ring = previews.get(deviceId);
    if (!ring?.length) return null;
    const frame = ring[ring.length - 1];
    return { jpeg: frame.jpeg, index: frame.index, at: frame.at, frames: ring.length };
  }

  /* ---------------- 现场调参回写（文档 §6.1） ---------------- */

  function configAck(configVersion, body, req) {
    const deviceId = String(body?.deviceId ?? req?.headers?.["x-device-id"] ?? "");
    if (!DEVICE_ID_PATTERN.test(deviceId)) {
      throw new WorkflowError(422, "BAD_DEVICE_ID", "设备编号无效");
    }
    if (req) requireToken(req, deviceId);
    db.prepare(
      `INSERT INTO device_config_acks (device_id, config_version, state, boot_id, applied_at, received_at, snapshot, diff)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      deviceId,
      String(body?.configVersion ?? configVersion),
      String(body?.state ?? "local-tuned"),
      body?.bootId ? String(body.bootId) : null,
      body?.appliedAt ? String(body.appliedAt) : null,
      nowIso(),
      JSON.stringify(body?.snapshot ?? null),
      JSON.stringify(body?.diff ?? []),
    );
    return { ok: true, deviceId, configVersion: String(body?.configVersion ?? configVersion), state: String(body?.state ?? "local-tuned") };
  }

  /* ---------------- 设备台账 ---------------- */

  function ledgerEntry(deviceId, registry = registryRow(deviceId), hardwareRow = latestHardwareRow(deviceId)) {
    if (!registry) return null;
    const report = hardwareRow ? readJson(hardwareRow.payload, null) : null;
    return {
      deviceId,
      bootId: registry.boot_id,
      connectionState: registry.connection_state,
      link: linkOf(deviceId, registry),
      registeredAt: registry.registered_at,
      lastSeenAt: registry.last_seen_at,
      appVersion: registry.app_version,
      adapterVersion: registry.adapter_version,
      modelVersion: registry.model_version,
      host: readJson(registry.host, {}),
      capabilities: readJson(registry.capabilities, {}),
      hardware: report?.hardware ?? null,
      state: report?.state ?? null,
      sampledAt: report?.sampled_at ?? report?.sampledAt ?? null,
      receivedAt: hardwareRow?.received_at ?? null,
      pendingCommands: pendingCommands(deviceId).length,
      previewFrames: previews.get(deviceId)?.length ?? 0,
    };
  }

  function devices() {
    const rows = db.prepare("SELECT * FROM device_registry ORDER BY updated_at DESC").all();
    return rows.map((row) => ledgerEntry(row.device_id, row));
  }

  /* ---------------- WebSocket 通道 /ws/devices/{deviceId} ---------------- */

  const wss = new WebSocketServer({ noServer: true });

  function handleUpgrade(req, socket, head) {
    const url = new URL(req.url, "http://localhost");
    if (!url.pathname.startsWith("/ws/devices/")) return false;
    const deviceId = decodeURIComponent(url.pathname.slice("/ws/devices/".length).split("/")[0] ?? "");
    if (!DEVICE_ID_PATTERN.test(deviceId)) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return true;
    }
    const token = url.searchParams.get("deviceToken") ?? url.searchParams.get("token") ?? "";
    if (!tokenAllowed(deviceId, token)) {
      // 文档 §3.10：令牌不对就拒绝升级，不静默接受
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return true;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req, { deviceId, url });
    });
    return true;
  }

  wss.on("connection", (socket, request, extra) => {
    const deviceId = extra?.deviceId ?? "";
    const bootId = extra?.url?.searchParams.get("bootId") ?? null;
    const set = sockets.get(deviceId) ?? new Set();
    // 同一台设备只保留最新一条通道：旧连接（比如重启前的半死连接）先关掉，
    // 否则平台会往两条通道里推命令，设备收到重复命令。
    for (const old of set) {
      try {
        old.close(4001, "replaced by a newer device connection");
      } catch {
        /* 已经断了 */
      }
    }
    sockets.set(deviceId, new Set([socket]));
    touch(deviceId, { bootId, connectionState: "online" });

    socket.send(
      JSON.stringify({
        kind: "hello",
        type: "device.welcome",
        schemaVersion: SCHEMA_VERSION,
        deviceId,
        platformTime: new Date().toISOString(),
        heartbeatIntervalMs,
        offlineAfterMs,
        configVersion,
        demoSessionId: sessionId,
        pendingCommandCount: pendingCommands(deviceId).length,
      }),
    );
    for (const row of pendingCommands(deviceId)) pushCommand(row);

    socket.isAlive = true;
    socket.on("pong", () => {
      socket.isAlive = true;
    });
    socket.on("message", (raw) => {
      let message = null;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!message || typeof message !== "object") return;
      const type = String(message.type ?? message.kind ?? "");
      const payload = message.payload && typeof message.payload === "object" ? message.payload : message;
      touch(deviceId, { bootId: message.bootId ? String(message.bootId) : bootId });
      if (message.messageId) {
        // 走 WS 的事件同样按 messageId 去重入库（文档 §3.5：两条路都会发）
        ingestEvents(
          [
            {
              schemaVersion: message.schemaVersion ?? SCHEMA_VERSION,
              type,
              deviceId,
              bootId: message.bootId ?? bootId,
              messageId: String(message.messageId),
              seq: message.seq,
              sentAt: message.sentAt,
              payload,
            },
          ],
          null,
        );
      } else if (type === "device.telemetry") {
        db.prepare(
          `INSERT INTO device_telemetry (device_id, received_at, payload) VALUES (?, ?, ?)
           ON CONFLICT(device_id) DO UPDATE SET received_at = excluded.received_at, payload = excluded.payload`,
        ).run(deviceId, nowIso(), JSON.stringify(payload));
      }
      // 终端只要「收到过平台任何消息」就算在线（文档 §3.4），回一个最轻的 pong
      socket.send(JSON.stringify({ kind: "pong", type: "platform.pong", at: Date.now() }));
    });
    socket.on("close", () => {
      if (shuttingDown) return;
      const current = sockets.get(deviceId);
      current?.delete(socket);
      if (!current?.size) {
        sockets.delete(deviceId);
        const row = registryRow(deviceId);
        if (row?.boot_id === bootId || !bootId) {
          db.prepare("UPDATE device_registry SET connection_state = 'offline', updated_at = ? WHERE device_id = ?").run(
            nowIso(),
            deviceId,
          );
        }
      }
    });
    socket.on("error", () => {
      /* close 会跟上，这里不重复处理 */
    });
  });

  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (socket.isAlive === false) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      try {
        socket.ping();
      } catch {
        /* 下一轮 terminate */
      }
    }
  }, 20000);
  heartbeat.unref?.();

  return {
    register,
    ingestHardware,
    hardwareView,
    hardwareHistory,
    ingestEvents,
    events,
    issueCommand,
    commands,
    devices,
    ledger: (deviceId) => ledgerEntry(deviceId),
    ingestPreview,
    latestPreview,
    configAck,
    handleUpgrade,
    tokenAllowed,
    status: () => ({
      devices: db.prepare("SELECT COUNT(*) AS n FROM device_registry").get()?.n ?? 0,
      online: [...sockets.keys()].length,
      tokens: tokens.anyDevice.size + tokens.perDevice.size,
      heartbeatIntervalMs,
      offlineAfterMs,
      staleAfterMs,
    }),
    close() {
      shuttingDown = true;
      clearInterval(heartbeat);
      for (const socket of wss.clients) socket.terminate();
      wss.close();
      sockets.clear();
    },
  };
}

export { parseTokens as parseDeviceTokens };
