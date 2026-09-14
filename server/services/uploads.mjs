/**
 * 交付平台 · 文件分片上传与批次清单（《交付平台-新增接口清单》批次 B）
 *
 * 终端侧已经把这三步调通了（`POST /api/files/uploads` → `PUT .../chunks` →
 * `POST .../complete`，再 `POST /api/batches` 提交清单），平台侧要按同一份契约落路由：
 *
 *   · `sha256` 为空要挡住（终端「最后一个文件永远传不上去」就是这里放过去的）；
 *   · 断点续传：`batchId + name` 已有上传单时必须返回**同一个 uploadId 与 receivedOffset**，
 *     每次新建单就永远续不上；
 *   · 重复 offset 的分片按幂等处理（返回 200，不报错）；
 *   · 完成时平台**自己重算整文件摘要**并与声明值比对（`match` 是终端判定链路的平台侧一半）；
 *   · 批次清单里 `datasetHash` 要校验并回显，未知字段原样收下。
 *
 * 存储：上传单与分片进度落在本模块自建的表里，字节写到 `server/assets/uploads/`；
 * 不修改 `services/assets.mjs`（那是平台自己的文件资产域，两边语义不同）。
 *
 * ── 身份 ────────────────────────────────────────────────────────────────
 * 两条身份都要认（终端的 `HttpClient` 两个头都带）：
 *   · 设备上行：`X-Device-Token`（+ 可选的 `X-Device-Id`）；
 *   · 页面读取：`Authorization: Bearer <登录令牌>`。
 * 所以这 5 条路由按 `auth: false` 注册，由本模块自己判身份 —— 用框架的 `auth: true`
 * 会在进处理器之前就把设备令牌按「未登录」拒掉（终端表现是「平台离线」），
 * 而设备令牌是自校验的登录令牌之外的**另一条链路**，两边都要通。
 *
 * ── 几个刻意的取舍（都有终端侧代码为证） ──────────────────────────────
 * 1. **offset 对不上回 409，不是 422**：终端的 `upload_file` 把 409 当作
 *    「平台侧进度丢了，重开一张上传单」（`needs_recreate=result.status == 409`），
 *    而 4xx 里其它码它只报错不重开。所以「进度不一致」用 409 语义最准、终端也能自愈。
 * 2. **`complete` 时摘要不符仍回 200**：契约要的是把 `match:false` 报出来让终端
 *    把该文件标失败；回 4xx 会被终端的退避重试当成「没传完」，把整个文件重传一遍
 *    再失败一次，白跑流量。
 * 3. **同 `batchId + name` 但 `size/sha256` 变了要 409**：这时续传没有意义
 *    （磁盘上那段字节不属于新文件），必须让终端重开单，不能静默接着写。
 */

import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { ASSETS_ROOT } from "./assets.mjs";
import { verifyToken } from "./auth.mjs";
import { WorkflowError } from "./workflow.mjs";

/* ------------------------------------------------------------------ *
 * 上限（都返回 413 / 422，不静默截断）
 * ------------------------------------------------------------------ */

/**
 * 单片上限 64 MiB。终端固定按 512 KiB 切片（`platform_client.upload_file`
 * 的 `chunk_size` 默认值），64 MiB 是它的 128 倍：正常的网络抖动导致的重传、
 * 或将来终端调大到几 MB 都够用，而超过这个量级的「单片」一定是调用方搞错了
 * （比如把整个文件当一片发），这时要明确拒绝而不是让内存和写盘 IO 失去约束。
 */
const MAX_CHUNK_BYTES = 64 * 1024 * 1024;

/**
 * 单个文件上限 8 GiB。批次里最大的是 `frames.csv` 与图像包，实际都在百 MB 级；
 * 8 GiB 只用来兜住「size 字段被写成天文数字」这种脏输入（否则一个 typo 就能把
 * 磁盘配额吃干），同时不至于挡住任何真实交付物。
 */
const MAX_FILE_BYTES = 8 * 1024 * 1024 * 1024;

/**
 * 一份 manifest 最多 4096 个文件。图像按帧交付时条目数最多，一帧一行；
 * 4096 覆盖单批次规模，同时保证 `missing` 校验的 O(n) 扫描不会拖慢接口
 * （平台侧对每个条目都要查一次上传单）。
 */
const MAX_BATCH_FILES = 4096;

/** 批次台账一次最多回 200 条（页面翻台账用，不提供全量导出） */
const BATCH_LIMIT = 200;

/** 单个上传单同一时刻只允许一个写者（见 `withUploadLock`） */
const uploadLocks = new Map();

/** 契约里的 role 枚举；不在表里也接受（终端可能扩），只做记录不做拒绝 */
const KNOWN_ROLES = new Set([
  "frames",
  "segments",
  "marks",
  "marks_csv",
  "quality",
  "result",
  "config",
  "dataset",
  "plan",
  "events",
  "image",
  "image_index",
  "batch",
]);

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
/** offset 只接受十进制非负整数（`+1` / `1.0` / `1e3` 一律拒，避免各端解析口径不同） */
const UNSIGNED_INT_PATTERN = /^\d+$/;

const nowIso = () => new Date().toISOString();

function readJson(text, fallback = null) {
  if (text === null || text === undefined) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/** 规范化声明摘要：去空白 + 小写，便于和平台重算值直接比较 */
function normalizeSha256(value) {
  return String(value ?? "").trim().toLowerCase();
}

/**
 * 设备令牌表。与 `device-gateway.parseTokens` 同一口径（形如
 * `MUMAI_DEVICE_TOKENS="handheld-02:demo-token,other:xyz"`，只有令牌表示任意设备可用），
 * 默认 `demo-token` 与终端 `deploy/config.pi5.json` 的出厂值一致。
 * 这里重新读一遍环境变量而不是从网关借实例：uploads 在 `server/index.mjs` 里只拿 db，
 * 不该为了一个令牌判断把设备网关也拖成它的构造依赖。
 */
function parseDeviceTokens(raw) {
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

function tokenAllowed(tokens, deviceId, token) {
  if (!token) return false;
  if (tokens.anyDevice.has(token)) return true;
  return tokens.perDevice.get(deviceId)?.has(token) ?? false;
}

function fieldError(field, message) {
  return { field, message };
}

function firstFieldErrors(pairs) {
  return pairs.filter(Boolean);
}

/** 流式算文件摘要：不把大文件读进内存（与 assets.mjs 的同一手法，这里自己留一份避免耦合） */
function sha256OfFile(path) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolvePromise(hash.digest("hex")));
  });
}

/** 分片摘要一律按字节算，和终端 `hashlib.sha256(chunk).hexdigest()` 对得上 */
function sha256OfBuffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/** 路径归一：manifest 里写的是相对路径（`images/frame_00001.png`），去掉 `./` 前缀再比 */
function normalizePath(value) {
  return String(value ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "");
}

/**
 * 创建上传/批次服务。
 *
 * 表在本模块内自建（与 `device-gateway.mjs` 同样做法），不动 `db.mjs` 的全局 SCHEMA：
 * 批次 B 是可选的终端链路，不加它平台照常跑。
 */
export function createUploadService({ db, logger = console } = {}) {
  const tokens = parseDeviceTokens(process.env.MUMAI_DEVICE_TOKENS);
  const uploadDir = join(ASSETS_ROOT, "uploads");

  db.exec(`
    CREATE TABLE IF NOT EXISTS upload_orders (
      upload_id       TEXT PRIMARY KEY,
      batch_id        TEXT NOT NULL,
      name            TEXT NOT NULL,
      size            INTEGER NOT NULL DEFAULT 0,
      role            TEXT,
      schema_version  TEXT,
      declared_sha256 TEXT NOT NULL DEFAULT '',
      stored_sha256   TEXT,
      received_offset INTEGER NOT NULL DEFAULT 0,
      storage_path    TEXT NOT NULL,
      completed_at    TEXT,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL,
      -- batchId + name 唯一：断点续传的落点。少了这条唯一约束，
      -- 同一文件每次重连都会新建一单，进度永远是 0（终端「永远续不上」）。
      UNIQUE (batch_id, name)
    );
    CREATE INDEX IF NOT EXISTS upload_orders_batch ON upload_orders (batch_id, name);

    CREATE TABLE IF NOT EXISTS upload_chunks (
      upload_id  TEXT NOT NULL,
      offset     INTEGER NOT NULL,
      length     INTEGER NOT NULL,
      sha256     TEXT NOT NULL,
      received_at TEXT NOT NULL,
      -- 同一 (上传单, offset) 只留一条：重复 offset 靠它判幂等，
      -- 不用去磁盘上重读那一段字节。
      PRIMARY KEY (upload_id, offset)
    );

    CREATE TABLE IF NOT EXISTS upload_batches (
      batch_id          TEXT PRIMARY KEY,
      order_id          TEXT,
      component_id      TEXT,
      zone_id           TEXT,
      config_version    TEXT,
      model_version     TEXT,
      scenario_id       TEXT,
      dataset_hash      TEXT,
      manifest_json     TEXT NOT NULL,
      -- 未知字段不丢：整份 manifest 原样存这里，上面这些列只是便于筛选的冗余
      file_count        INTEGER NOT NULL DEFAULT 0,
      byte_count        INTEGER NOT NULL DEFAULT 0,
      missing_json      TEXT,
      dataset_match     INTEGER,
      computed_hash     TEXT,
      result_json       TEXT,
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS upload_batches_time ON upload_batches (created_at DESC);
  `);

  /* ---------------- 身份 ---------------- */

  /**
   * 两条身份都认，且**至少要有一条**：
   * 页面读取（`/api/batches`）走登录令牌，设备上行（建单 / 分片 / 完成 / 提交清单）
   * 走设备令牌。两条都没有 → 401。
   */
  function requireIdentity(req) {
    const headers = req?.headers ?? {};
    const deviceToken = String(headers["x-device-token"] ?? "");
    const headerDevice = String(headers["x-device-id"] ?? "").trim();
    /*
      先判登录令牌（页面读取走这条），再判设备令牌（终端上行走这条）。
      `verifyToken` 只认平台自己的 HMAC 登录令牌，终端把设备令牌同时填进
      Authorization 也不会被它误判成某个账号 —— 两条链路因此互不串味。
    */
    const actor = actorFromRequestLoose(req);
    if (actor) return { kind: "actor", id: actor };

    if (deviceToken) {
      // 带了 X-Device-Id 就要求与令牌匹配（终端会带，两边不一致说明串了设备）
      const deviceId = headerDevice || "unknown";
      if (!tokenAllowed(tokens, deviceId, deviceToken)) {
        throw new WorkflowError(401, "BAD_DEVICE_TOKEN", "设备令牌无效，请核对平台侧 MUMAI_DEVICE_TOKENS 与终端配置");
      }
      return { kind: "device", id: deviceId };
    }
    throw new WorkflowError(401, "UNAUTHORIZED", "未登录或设备令牌无效");
  }

  /** 从 Authorization 头解析登录令牌；无效/缺失返回 null（不抛异常，好让调用方接着判设备令牌） */
  function actorFromRequestLoose(req) {
    const header = String(req?.headers?.authorization ?? "");
    if (!header.startsWith("Bearer ")) return null;
    return verifyToken(header.slice(7));
  }

  /* ---------------- 上传单 ---------------- */

  const uploadRow = (uploadId) =>
    db.prepare("SELECT * FROM upload_orders WHERE upload_id = ?").get(String(uploadId)) ?? null;

  const uploadByName = (batchId, name) =>
    db.prepare("SELECT * FROM upload_orders WHERE batch_id = ? AND name = ?").get(String(batchId), String(name)) ?? null;

  function viewOf(row) {
    if (!row) return null;
    return {
      uploadId: row.upload_id,
      batchId: row.batch_id,
      name: row.name,
      size: row.size,
      role: row.role,
      schemaVersion: row.schema_version,
      sha256: row.declared_sha256,
      storedSha256: row.stored_sha256,
      receivedOffset: row.received_offset,
      completedAt: row.completed_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * 同一个上传单的写操作串行化。
   *
   * `node:sqlite` 是同步 API，但一次分片请求里「读进度 → 写字节 → 更新进度」中间有
   * `await`（写盘），两片并发到达时就会双双读到旧 offset 然后互相覆盖。
   * 终端是单线程顺序发片的，但网络重试会并发；真实文件一旦被并发写坏，
   * 只有到 `complete` 重算摘要时才发现，那时已经说不清是哪一片写坏的。
   */
  function withUploadLock(uploadId, task) {
    const key = String(uploadId);
    const previous = uploadLocks.get(key) ?? Promise.resolve();
    // 前一个任务无论是成功还是失败都要接着跑：一次 4xx 不能把后面的请求永久卡住
    const queued = previous.then(task, task);
    const settled = queued.then(
      () => releaseUploadLock(key, settled),
      () => releaseUploadLock(key, settled),
    );
    uploadLocks.set(key, settled);
    return queued;
  }

  /** 链尾已经跑完就删掉 key，别让 Map 随着上传单数量无限长 */
  function releaseUploadLock(key, settled) {
    if (uploadLocks.get(key) === settled) uploadLocks.delete(key);
  }

  /**
   * 读原始分片字节。
   *
   * 这里**超限不 destroy**：`req.destroy()` 会把连接一起掐掉，终端看到的是
   * 「网络错误」而不是 413，于是按网络故障退避重试，永远学不会「片太大了」。
   * 所以照读到底再回 413，让调用方拿到明确原因。
   */
  function readChunkBody(req, limit = MAX_CHUNK_BYTES) {
    return new Promise((resolvePromise, reject) => {
      const chunks = [];
      let size = 0;
      let over = false;
      req.on("data", (chunk) => {
        size += chunk.length;
        if (size > limit) {
          over = true;
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (over) {
          reject(new WorkflowError(413, "CHUNK_TOO_LARGE", `单片上限 ${limit} 字节（${Math.floor(limit / 1024 / 1024)} MiB），请拆小后重试`, { retryable: false, limit }));
          return;
        }
        resolvePromise(Buffer.concat(chunks));
      });
      req.on("error", (error) => reject(error));
    });
  }

  /** B1 创建上传单（可断点续传） */
  async function createUpload({ body = {}, req = null, actorId = null, identity = null } = {}) {
    // 路由已经把身份判过了；直接调 service（测试 / 脚本）时才在这里补判
    const who = identity ?? (req ? requireIdentity(req) : { kind: "actor", id: actorId });
    void who;
    const name = String(body.name ?? "").trim();
    const batchId = String(body.batchId ?? "").trim();
    const declared = normalizeSha256(body.sha256);
    const role = body.role === undefined || body.role === null ? null : String(body.role).trim();
    const schemaVersion = body.schemaVersion === undefined || body.schemaVersion === null ? null : String(body.schemaVersion);

    const errors = firstFieldErrors([
      name ? null : fieldError("name", "缺少文件名"),
      batchId ? null : fieldError("batchId", "缺少 batchId（断点续传按 batchId + name 定位上传单）"),
      // 「最后一个文件永远传不上去」的根因：空摘要放过去了，complete 时无从比对
      declared ? null : fieldError("sha256", "缺少文件摘要，请在本机先算一遍 sha256 再建单"),
      SHA256_PATTERN.test(declared) ? null : fieldError("sha256", "sha256 需要 64 位十六进制字符串"),
    ]);
    if (errors.length) {
      throw new WorkflowError(422, "BAD_UPLOAD_REQUEST", errors[0].message, { fieldErrors: errors, retryable: false });
    }

    const size = Number(body.size);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new WorkflowError(422, "BAD_SIZE", "size 必须是不小于 0 的整数", {
        fieldErrors: [fieldError("size", "size 必须是不小于 0 的整数")],
        retryable: false,
      });
    }
    if (size > MAX_FILE_BYTES) {
      throw new WorkflowError(413, "FILE_TOO_LARGE", `单文件上限 ${MAX_FILE_BYTES} 字节，超出请拆分批次`, {
        retryable: false,
        limit: MAX_FILE_BYTES,
      });
    }
    if (role && !KNOWN_ROLES.has(role)) {
      // 只提示不拒绝：契约里的枚举是「终端会用的」，终端以后扩枚举不该被平台卡住
      logger.warn?.(`[uploads] 未知 role「${role}」，按原样记录（契约枚举：${[...KNOWN_ROLES].join(" / ")}）`);
    }

    const existing = uploadByName(batchId, name);
    if (existing) {
      /*
        断点续传的**核心**：同一个 batchId + name 必须回同一张单。
        但声明变了就不能接着写 —— 磁盘上已收到的那段字节属于**上一个文件**
        （大小或摘要都不同），静默续下去会把两个文件拼成一个，
        最后 complete 的摘要必然不符，还查不出是哪一段脏了。
      */
      if (existing.size !== size || existing.declared_sha256 !== declared) {
        throw new WorkflowError(409, "UPLOAD_METADATA_CHANGED", "同名文件已有一张上传单且 size/sha256 与本次不一致，请用新的 batchId 或先作废旧单", {
          retryable: false,
          uploadId: existing.upload_id,
          receivedOffset: existing.received_offset,
          declared: { size: existing.size, sha256: existing.declared_sha256 },
        });
      }
      const row = existing;
      logger.log?.(`[uploads] 续传 ${batchId}/${name} → ${row.upload_id}（已收 ${row.received_offset} 字节）`);
      return {
        uploadId: row.upload_id,
        receivedOffset: row.received_offset,
        completed: Boolean(row.completed_at),
        resumed: true,
        size: row.size,
        role: row.role,
      };
    }

    if (!existsSync(uploadDir)) mkdirSync(uploadDir, { recursive: true });
    const uploadId = `up-${randomUUID().replace(/-/g, "")}`;
    const storagePath = join(uploadDir, `${uploadId}.bin`);
    const at = nowIso();

    try {
      db.prepare(
        `INSERT INTO upload_orders
           (upload_id, batch_id, name, size, role, schema_version, declared_sha256, received_offset, storage_path, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      ).run(uploadId, batchId, name, size, role, schemaVersion, declared, storagePath, at, at);
    } catch (error) {
      /*
        并发建单：两个请求同时发现「没有旧单」，其中一个会撞上 UNIQUE(batch_id, name)。
        这不是错误，回到续传语义 —— 把赢的那张单返回去，两端最终指向同一个 uploadId。
      */
      const raced = uploadByName(batchId, name);
      if (raced) {
        return {
          uploadId: raced.upload_id,
          receivedOffset: raced.received_offset,
          completed: Boolean(raced.completed_at),
          resumed: true,
          size: raced.size,
          role: raced.role,
        };
      }
      throw error;
    }

    return { uploadId, receivedOffset: 0, completed: false, resumed: false, size, role };
  }

  /* ---------------- 分片 ---------------- */

  /** B2 追加分片（按 offset 记进度） */
  async function appendChunk({ uploadId, req, body = null, actorId = null, identity = null } = {}) {
    identity ?? requireIdentity(req);
    void actorId;
    const row = uploadRow(uploadId);
    if (!row) {
      // 404：终端据此重开上传单（`needs_recreate=status in (404,409,410)`）
      throw new WorkflowError(404, "NO_UPLOAD", `上传单 ${uploadId} 不存在，请重新创建`, { retryable: false });
    }

    const rawOffset = req.headers["x-chunk-offset"];
    const rawSha = req.headers["x-chunk-sha256"];
    const offsetText = String(rawOffset ?? "").trim();
    const sha = normalizeSha256(rawSha);
    const errors = firstFieldErrors([
      UNSIGNED_INT_PATTERN.test(offsetText) ? null : fieldError("X-Chunk-Offset", "缺少或非法的分片起始偏移（需十进制非负整数）"),
      SHA256_PATTERN.test(sha) ? null : fieldError("X-Chunk-Sha256", "缺少或非法的分片摘要（需 64 位十六进制）"),
    ]);
    if (errors.length) {
      throw new WorkflowError(422, "BAD_CHUNK_HEADERS", errors[0].message, { fieldErrors: errors, retryable: false });
    }
    const offset = Number(offsetText);
    if (!Number.isSafeInteger(offset)) {
      throw new WorkflowError(422, "BAD_CHUNK_OFFSET", "分片起始偏移超出可表示范围", {
        fieldErrors: [fieldError("X-Chunk-Offset", "偏移过大")],
        retryable: false,
      });
    }

    const buffer = body === null || body === undefined ? await readChunkBody(req) : Buffer.from(body);
    if (buffer.length === 0) {
      throw new WorkflowError(422, "EMPTY_CHUNK", "分片内容为空", { retryable: false });
    }
    if (buffer.length > MAX_CHUNK_BYTES) {
      throw new WorkflowError(413, "CHUNK_TOO_LARGE", `单片上限 ${MAX_CHUNK_BYTES} 字节`, { retryable: false });
    }
    // 摘要先算：对不上就不落盘，磁盘上永远只有「已验证过的字节」
    const actual = sha256OfBuffer(buffer);
    if (actual !== sha) {
      throw new WorkflowError(422, "CHUNK_SHA_MISMATCH", `第 ${offset} 字节起的分片摘要不符：平台算得 ${actual.slice(0, 16)}…，声明 ${sha.slice(0, 16)}…`, {
        retryable: true,
        offset,
        expected: sha,
        actual,
      });
    }

    return withUploadLock(row.upload_id, () => writeChunk(row.upload_id, offset, buffer, sha));
  }

  /**
   * 落一片字节并推进进度（调用方已持锁）。
   *
   * offset 的四种情形分开处理，一条都不能含糊：
   *   1. 已完成 —— 字节已经被摘要确认过，不再改写；同一片的重复投递仍按幂等回 200，
   *      否则终端重试最后一片时会拿到 409，白白把整个文件重传一遍；
   *   2. `offset === 已收进度` —— 正常追加；
   *   3. `offset < 已收进度` —— 重复分片，**必须回 200 幂等**（终端重试会重发同一片）；
   *   4. `offset > 已收进度` —— 中间缺了一段，回 409 并把平台当前进度报回去，
   *      终端会从那个 offset 继续，而不是把整份文件重传。
   */
  function writeChunk(uploadId, offset, buffer, sha) {
    const current = uploadRow(uploadId);
    if (!current) throw new WorkflowError(404, "NO_UPLOAD", `上传单 ${uploadId} 不存在，请重新创建`, { retryable: false });

    const known = db.prepare("SELECT * FROM upload_chunks WHERE upload_id = ? AND offset = ?").get(uploadId, offset) ?? null;
    const sameChunk = Boolean(known) && known.length === buffer.length && known.sha256 === sha;

    if (current.completed_at) {
      if (sameChunk) return { receivedOffset: current.received_offset, duplicated: true, uploadId };
      throw new WorkflowError(409, "UPLOAD_COMPLETED", `上传单 ${uploadId} 已完成，如需重传请新建批次`, {
        retryable: false,
        uploadId,
        receivedOffset: current.received_offset,
      });
    }

    if (offset < current.received_offset) {
      // 重复 offset：内容一致就是幂等成功；不一致说明客户端在改写已确认的区间，必须拒绝
      if (sameChunk) {
        return { receivedOffset: current.received_offset, duplicated: true, uploadId };
      }
      throw new WorkflowError(409, "CHUNK_CONFLICT", `偏移 ${offset} 处的分片已接收且内容不同，请从 ${current.received_offset} 继续`, {
        retryable: false,
        uploadId,
        receivedOffset: current.received_offset,
      });
    }

    if (offset > current.received_offset) {
      throw new WorkflowError(409, "OFFSET_GAP", `平台当前已收到 ${current.received_offset} 字节，与本次偏移 ${offset} 不一致（中间缺片）`, {
        retryable: true,
        uploadId,
        receivedOffset: current.received_offset,
        expectedOffset: current.received_offset,
      });
    }

    const path = current.storage_path;
    if (!existsSync(uploadDir)) mkdirSync(uploadDir, { recursive: true });

    /*
      先写字节再记进度，且这一步是同步的：
      node:sqlite 也是同步的，两者之间不会插入别的请求，
      所以不会出现「库里说收到了、磁盘上其实没有」的窗口。
    */
    appendFileSync(path, buffer);
    const nextOffset = offset + buffer.length;
    const at = nowIso();
    db.prepare(
      `INSERT INTO upload_chunks (upload_id, offset, length, sha256, received_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(upload_id, offset) DO UPDATE SET length = excluded.length, sha256 = excluded.sha256, received_at = excluded.received_at`,
    ).run(uploadId, offset, buffer.length, sha, at);
    db.prepare("UPDATE upload_orders SET received_offset = ?, updated_at = ? WHERE upload_id = ?").run(nextOffset, at, uploadId);

    return { receivedOffset: nextOffset, duplicated: false, uploadId };
  }

  /* ---------------- 完成 ---------------- */

  /** B3 完成并校验整文件摘要 */
  async function completeUpload({ uploadId, body = {}, req = null, actorId = null, identity = null } = {}) {
    const who = identity ?? (req ? requireIdentity(req) : { kind: "actor", id: actorId });
    void who;
    const row = uploadRow(uploadId);
    if (!row) throw new WorkflowError(404, "NO_UPLOAD", `上传单 ${uploadId} 不存在，请重新创建`, { retryable: false });

    const declared = normalizeSha256(body.sha256) || row.declared_sha256;
    if (!SHA256_PATTERN.test(declared)) {
      throw new WorkflowError(422, "BAD_SHA256", "缺少或非法的 sha256（需 64 位十六进制）", {
        fieldErrors: [fieldError("sha256", "需 64 位十六进制")],
        retryable: false,
      });
    }
    const declaredSize = body.size === undefined || body.size === null ? row.size : Number(body.size);
    if (!Number.isSafeInteger(declaredSize) || declaredSize < 0) {
      throw new WorkflowError(422, "BAD_SIZE", "size 必须是不小于 0 的整数", { retryable: false });
    }

    return withUploadLock(row.upload_id, async () => {
      const current = uploadRow(uploadId);
      if (current.received_offset < declaredSize) {
        // 未传完就 complete：不回「摘要不符」，那会把「没传完」误报成「内容被改过」
        throw new WorkflowError(409, "UPLOAD_INCOMPLETE", `文件未传完：已收到 ${current.received_offset} / ${declaredSize} 字节`, {
          retryable: true,
          uploadId,
          receivedOffset: current.received_offset,
          expectedBytes: declaredSize,
        });
      }
      if (current.received_offset > declaredSize) {
        /*
          收多了：要么 size 声明少了，要么中间有重复写入。
          这是**声明与字节不一致**，不是「传输没完成」，重试解决不了 —— 回 422 让终端重开单。
        */
        throw new WorkflowError(422, "SIZE_MISMATCH", `已收到 ${current.received_offset} 字节，多于声明的 ${declaredSize} 字节`, {
          retryable: false,
          uploadId,
          receivedOffset: current.received_offset,
          expectedBytes: declaredSize,
        });
      }
      if (current.completed_at) {
        /*
          同一张单重复 complete 是正常路径（终端收不到响应会重发）。
          这里仍然**重新读盘重算**，不回放上一次的结果：`match` 的语义是
          「此刻磁盘上的字节与这份声明摘要是否一致」，万一字节在两次 complete
          之间被动过（或被人工修复过），回放就会给出一个已经不成立的结论。
          重算的代价是一次顺序读，换来的是这个结论永远当真。
        */
        logger.log?.(`[uploads] ${current.batch_id}/${current.name} 重复 complete，重算摘要`);
      }

      if (!existsSync(current.storage_path)) {
        throw new WorkflowError(409, "STORAGE_MISSING", "平台侧字节已丢失（服务可能重启过），请重新创建上传单", {
          retryable: false,
          uploadId,
        });
      }
      /*
        契约的硬要求：**平台自己流式读盘重算整文件摘要**，不能把声明值回显。
        回显等于自己跟自己比 —— 字节在传输里被改、被截断，结论都一样是 match:true，
        终端的「摘要校验」链路就只剩一半。这里 node:crypto 边读边喂，
        8 GiB 的文件也不会把内存顶穿。
      */
      const actual = await sha256OfFile(current.storage_path);
      const onDisk = statSync(current.storage_path).size;
      const match = actual === declared && onDisk === declaredSize;
      const at = nowIso();
      db.prepare(
        `UPDATE upload_orders
            SET received_offset = ?, stored_sha256 = ?, completed_at = ?, updated_at = ?
          WHERE upload_id = ?`,
      ).run(onDisk, actual, at, at, uploadId);
      if (!match) {
        logger.warn?.(`[uploads] ${current.batch_id}/${current.name} 摘要不符：平台重算 ${actual.slice(0, 16)}… vs 声明 ${declared.slice(0, 16)}…`);
      }

      return {
        ok: true,
        uploadId,
        // 回的是**平台重算的结果**，不是请求里那个声明值
        sha256: actual,
        match,
        size: onDisk,
        declaredSha256: declared,
        declaredSize,
        batchId: current.batch_id,
        name: current.name,
        role: current.role,
        replayed: Boolean(current.completed_at),
      };
    });
  }

  /* ---------------- 批次清单 ---------------- */

  /**
   * 把 manifest 的 `files[]` 归一成「应当交付」的清单。
   *
   * 终端的 manifest 里 `path` 是相对路径（`images/frame_00001.png`），而上传时
   * 建单用的 `name` 是 basename（`frame_00001.png`，见 `app.upload_files`），
   * 所以匹配要同时按「相对路径」和「basename」找上传单。
   * 没带 `files[]` 的旧 manifest 退回 `fileIds[]`（它同样带 path/role/sha256/bytes）。
   */
  function declaredFiles(manifest) {
    const list = Array.isArray(manifest.files) && manifest.files.length
      ? manifest.files
      : Array.isArray(manifest.fileIds)
        ? manifest.fileIds
        : [];
    const out = [];
    for (const entry of list) {
      if (entry === null || entry === undefined) continue;
      const source = typeof entry === "object" ? entry : { path: String(entry) };
      const path = normalizePath(source.path ?? source.name ?? source.relPath ?? source.fileName);
      if (!path) continue;
      out.push({
        path,
        name: basename(path),
        role: source.role === undefined || source.role === null ? null : String(source.role),
        sha256: normalizeSha256(source.sha256 ?? source.hash),
        bytes: Number.isSafeInteger(Number(source.bytes ?? source.size)) ? Number(source.bytes ?? source.size) : null,
      });
    }
    // 目录条目（`images/`）不是文件，别算进 missing
    return out.filter((item) => !item.path.endsWith("/"));
  }

  /**
   * datasetHash 的重算口径与终端 `storage.commit_manifest` 完全一致：
   * 按路径字典序拼接 `path\0sha256\n` 再取 sha256，且**不含 `manifest.json`**。
   * 两端各算一次才能确认「平台收到的就是终端封存的那一份」。
   */
  function computeDatasetHash(entries) {
    const usable = entries
      .filter((item) => item.path !== "manifest.json" && !item.path.endsWith(".tmp") && SHA256_PATTERN.test(item.sha256))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    if (!usable.length) return null;
    const hash = createHash("sha256");
    for (const item of usable) {
      hash.update(item.path, "utf8");
      hash.update(Buffer.from([0]));
      hash.update(item.sha256, "utf8");
      hash.update("\n");
    }
    return hash.digest("hex");
  }

  /**
   * 逐个核对一个清单条目：建单了没、传完没、平台重算的摘要与清单声明的是不是同一份。
   *
   * `missing` 只回文件名（终端靠这个字符串数组判「完整 / 部分接收」），
   * 具体原因放在 `state` 里，页面不必去猜「缺件」和「摘要不符」是不是同一件事。
   */
  function reconcileUpload(view, item) {
    if (!view) return { accepted: false, size: 0, state: "not_uploaded" };
    // 只有一个上传单「收满且已通过平台重算」才算这一件交付成功：
    // 只看 receivedOffset 会把「传完了但摘要不符」误判成已收到。
    if (!view.completedAt || !view.storedSha256) {
      return { accepted: false, size: 0, state: "incomplete" };
    }
    if (view.size !== view.receivedOffset) {
      return { accepted: false, size: 0, state: "incomplete" };
    }
    if (item.bytes !== null && item.bytes !== view.size) {
      return { accepted: false, size: 0, state: "size_mismatch" };
    }
    if (item.sha256 && item.sha256 !== view.storedSha256) {
      return { accepted: false, size: 0, state: "sha_mismatch" };
    }
    return { accepted: true, size: view.size, state: "verified" };
  }

  /** B4 提交批次清单 */
  async function submitBatch({ manifest = {}, req = null, actorId = null, identity = null } = {}) {
    identity ?? (req ? requireIdentity(req) : { kind: "actor", id: actorId });
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
      throw new WorkflowError(422, "BAD_MANIFEST", "批次清单必须是 JSON 对象", { retryable: false });
    }
    const batchId = String(manifest.batchId ?? "").trim();
    if (!batchId) {
      throw new WorkflowError(422, "NO_BATCH_ID", "缺少 batchId", {
        fieldErrors: [fieldError("batchId", "缺少 batchId")],
        retryable: false,
      });
    }
    const declaredList = declaredFiles(manifest);
    if (declaredList.length > MAX_BATCH_FILES) {
      throw new WorkflowError(413, "TOO_MANY_FILES", `一份批次清单最多 ${MAX_BATCH_FILES} 个文件，请分批交付`, {
        retryable: false,
        limit: MAX_BATCH_FILES,
      });
    }

    const declaredHash = normalizeSha256(manifest.datasetHash);
    const computedHash = computeDatasetHash(declaredList);

    // 逐个核对：建单了没、传完没、平台重算的摘要与清单声明的是不是同一份
    const received = [];
    const missing = [];
    const entries = [];
    let bytes = 0;
    for (const item of declaredList) {
      const direct = uploadByName(batchId, item.path);
      const byName = direct ?? uploadByName(batchId, item.name);
      const row = byName ? viewOf(byName) : null;
      const reconciled = reconcileUpload(viewOf(byName), item);
      if (reconciled.accepted) {
        received.push(item.path);
        bytes += reconciled.size;
      } else {
        /*
          终端只读 `missing` 这个字符串数组来决定「完整 / 部分接收」，
          所以这里放的是**文件名**，原因另放在下面 entries 的 `state` 里 ——
          不改变契约形状，也不让页面去猜「缺了」和「摘要不符」是不是一件事。
        */
        missing.push(item.path);
      }
      entries.push({
        path: item.path,
        name: item.name,
        role: item.role,
        declaredSha256: item.sha256 || null,
        uploadId: row?.uploadId ?? null,
        receivedOffset: row?.receivedOffset ?? 0,
        size: row?.size ?? item.bytes ?? null,
        storedSha256: row?.storedSha256 ?? null,
        state: reconciled.state,
      });
    }

    const datasetMatch = declaredHash ? computedHash === declaredHash : null;
    const complete = missing.length === 0 && datasetMatch !== false;

    const result = {
      ok: true,
      batchId,
      received: { files: received.length, bytes },
      missing,
      // 声明值 + 平台重算值 + 比对结论三件套都给，终端与页面各取所需
      datasetHash: declaredHash || null,
      computedDatasetHash: computedHash,
      datasetHashMatch: datasetMatch,
      complete,
      fileCount: declaredList.length,
      entries,
      receivedFiles: received,
      submittedAt: nowIso(),
      replayed: false,
    };

    /*
      重复提交的判据用**原样 manifest 字符串**而不是再算一个摘要：
      要比的就是「这一次收下的字节和上一次是不是同一份」，字符串直接比最贴近这个语义，
      也不用担心两端 JSON 序列化顺序不同带来的假冲突。
    */
    const manifestJson = JSON.stringify(manifest);
    const previous = db.prepare("SELECT * FROM upload_batches WHERE batch_id = ?").get(batchId) ?? null;
    if (previous) {
      /*
        同一份 manifest 重发是正常的（终端退避重试），按幂等回放上次结论；
        但内容真的变了就必须拦：批次是「封存后交付」的语义，允许原地改写
        等于平台收下的清单和终端封存的那一份可以不是同一份，
        datasetHash 校验也就白做了。
      */
      const sameSubmission = previous.manifest_json === manifestJson;
      if (!sameSubmission) {
        throw new WorkflowError(409, "BATCH_CONFLICT", `批次 ${batchId} 已提交且清单内容不同，不允许原地改写`, {
          retryable: false,
          batchId,
          submittedAt: previous.created_at,
        });
      }
      logger.log?.(`[uploads] 批次 ${batchId} 的清单重复提交，按幂等回放`);
      return { ...readJson(previous.result_json, result), replayed: true };
    }

    const at = result.submittedAt;
    try {
      db.prepare(
        `INSERT INTO upload_batches
           (batch_id, order_id, component_id, zone_id, config_version, model_version, scenario_id,
            dataset_hash, manifest_json, file_count, byte_count, missing_json, dataset_match, computed_hash, result_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        batchId,
        textOrNull(manifest.orderId),
        textOrNull(manifest.componentId),
        textOrNull(manifest.zoneId),
        textOrNull(manifest.configVersion),
        textOrNull(manifest.modelVersion),
        textOrNull(manifest.scenarioId),
        declaredHash || null,
        manifestJson,
        result.received.files,
        result.received.bytes,
        JSON.stringify(missing),
        datasetMatch === null ? null : datasetMatch ? 1 : 0,
        computedHash,
        JSON.stringify(result),
        at,
        at,
      );
    } catch (error) {
      // 并发提交同一批次：另一个请求先落库了，回到幂等语义（内容一致才会走到这里）
      const raced = db.prepare("SELECT * FROM upload_batches WHERE batch_id = ?").get(batchId) ?? null;
      if (raced && raced.manifest_json === manifestJson) return { ...readJson(raced.result_json, result), replayed: true };
      throw error;
    }

    if (!complete) {
      logger.log?.(`[uploads] 批次 ${batchId} 部分接收：缺 ${missing.length} 个文件，datasetHashMatch=${datasetMatch}`);
    }
    return result;
  }

  /** 批次台账（`GET /api/batches`） */
  function listBatches() {
    return db
      .prepare("SELECT * FROM upload_batches ORDER BY created_at DESC, batch_id DESC LIMIT ?")
      .all(BATCH_LIMIT)
      .map((row) => {
        const stored = readJson(row.result_json, null);
        return {
          // result 是当初回给终端的那一份，原样带出来，台账与回执不会出现两套口径
          ...(stored ?? {}),
          batchId: row.batch_id,
          orderId: row.order_id,
          componentId: row.component_id,
          zoneId: row.zone_id,
          configVersion: row.config_version,
          modelVersion: row.model_version,
          scenarioId: row.scenario_id,
          datasetHash: row.dataset_hash,
          computedDatasetHash: row.computed_hash,
          datasetHashMatch: row.dataset_match === null || row.dataset_match === undefined ? null : row.dataset_match === 1,
          manifest: readJson(row.manifest_json, {}),
          submittedAt: row.created_at,
          updatedAt: row.updated_at,
        };
      });
  }

  return {
    createUpload,
    appendChunk,
    completeUpload,
    submitBatch,
    listBatches,
    /**
     * 判身份并返回 `{kind, id}`（判不过就抛 401）。
     * 路由在调处理器前先判一次，是为了让**建单的 201 响应**能在业务跑之前就确定
     * 调用方有身份；业务方法内部也会兜底再判一次，直接调 service 时同样安全。
     */
    resolveIdentity: requireIdentity,
    /** 诊断用：上传单与批次的规模（`/api/health` 之类以后想看时直接调） */
    status: () => ({
      uploads: db.prepare("SELECT COUNT(*) AS n FROM upload_orders").get()?.n ?? 0,
      completed: db.prepare("SELECT COUNT(*) AS n FROM upload_orders WHERE completed_at IS NOT NULL").get()?.n ?? 0,
      chunks: db.prepare("SELECT COUNT(*) AS n FROM upload_chunks").get()?.n ?? 0,
      batches: db.prepare("SELECT COUNT(*) AS n FROM upload_batches").get()?.n ?? 0,
      uploadDir,
      limits: { maxChunkBytes: MAX_CHUNK_BYTES, maxFileBytes: MAX_FILE_BYTES, maxBatchFiles: MAX_BATCH_FILES },
    }),
  };
}

function textOrNull(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

/**
 * 路由注册：由 `server/api/http.mjs` 在 `createApi` 里调用一次。
 *
 * `route(method, pattern, handler, { auth, rawBody })` 是 http.mjs 内部的路由助手；
 * 分片上传那条必须带 `rawBody: true`（请求体是二进制，不能被先当成 JSON 读掉）。
 *
 * 5 条路由都带 `auth: false`，身份改由服务内部判（见文件头「身份」一节）：
 * 这里同时要服务设备上行（`X-Device-Token`）与页面读取（`Authorization: Bearer`），
 * 而 `auth: true` 只认后者，会在设备建单时先回一个 401。
 */
export function registerUploadRoutes(route, { service }) {
  if (!service) return;
  route(
    "POST",
    "/api/files/uploads",
    async (ctx) => {
      const identity = service.resolveIdentity(ctx.req);
      const created = await service.createUpload({ body: ctx.body ?? {}, actorId: ctx.actor, identity });
      /*
        建单要回 201。框架对「处理器返回的对象」固定写 200，所以这一条自己写响应 ——
        与预览图 / 包下载那几条同样的做法，路由的签名与路径都没变。
        `sendJson` 返回 undefined，分发处看到 null/undefined 就不会再写一次。
      */
      return sendJson(ctx.res, 201, created);
    },
    { auth: false },
  );
  route(
    "PUT",
    "/api/files/uploads/:uploadId/chunks",
    async (ctx) => {
      const identity = service.resolveIdentity(ctx.req);
      return service.appendChunk({ uploadId: ctx.params.uploadId, req: ctx.req, actorId: ctx.actor, identity });
    },
    { rawBody: true, auth: false },
  );
  route(
    "POST",
    "/api/files/uploads/:uploadId/complete",
    async (ctx) => {
      const identity = service.resolveIdentity(ctx.req);
      return service.completeUpload({ uploadId: ctx.params.uploadId, body: ctx.body ?? {}, actorId: ctx.actor, identity });
    },
    { auth: false },
  );
  route(
    "POST",
    "/api/batches",
    async (ctx) => {
      const identity = service.resolveIdentity(ctx.req);
      return service.submitBatch({ manifest: ctx.body ?? {}, actorId: ctx.actor, identity });
    },
    { auth: false },
  );
  route(
    "GET",
    "/api/batches",
    async (ctx) => {
      service.resolveIdentity(ctx.req);
      return { batches: service.listBatches() };
    },
    { auth: false },
  );
}

/**
 * 自己写 JSON 响应（建单的 201 用）。
 *
 * CORS 头照 `http.mjs` 的 `corsHeaders()` 抄一份而不是 import：那是 http.mjs 的私有函数，
 * 没有导出，而 `registerUploadRoutes` 只拿到 `route` 助手，拿不到 cors 助手。
 * 开发阶段页面走 Vite（另一个端口），少了这几个头浏览器会直接拦掉响应。
 */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, content-type, x-device-token, x-device-id, x-chunk-offset, x-chunk-sha256",
    "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
    "access-control-expose-headers": "x-file-sha256",
  });
  res.end(payload);
}
