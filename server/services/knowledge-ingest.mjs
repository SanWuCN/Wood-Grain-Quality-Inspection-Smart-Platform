/**
 * 业务事件 → 知识库资产：**工单归档自动登进知识库**
 *
 * 用户口径（2026-09-19）：「知识库查询的数据要动态拟真，我这边最后工单结束得能归档进去」。
 *
 * 两件事在这里落地：
 *   ① **动态**：这条记录不是预置语料，而是从**已归档工单实体的真实字段**现算出来的
 *      （单号 / 地点 / Z01–Z04 主体 ID / 环境读数 / 配置版本 / 校验判据 / 下发回执 /
 *      操作日志），所以现场"刚归档的那张单"当场就能被检索到，点开就是这一单的内容 ——
 *      检索命中的数字与工单页上看到的**同一个来源**，不存在对不上的第二份。
 *   ② **拟真**：文本按真实档案的写法分节（【工单】【委托】【检测主体】【环境记录】
 *      【配置版本】【校验判据】【下发记录】【操作日志】【归档】），一行一件事、
 *      每行都能单独当检索片段用；数字全部来自实体，没有一句是编的。
 *
 * 幂等：以工单的内部 id 作 `source_entity_id`。同一张单重复归档**不新建资产**，
 * 走 `reviseAsset` 递增内容版本（PRD §10.2：老版本继续服务，新版本发布后切换）。
 *
 * ⚠ 索引任务**不在这里跑**：本模块只登记资产并建立任务，推进交给 HTTP 层的
 * `knowledgeRunner`（与 `/api/commands` 同一条口径：命令只建任务，进度不在这里伪造）。
 */
import { nowIso } from "../storage/db.mjs";
import { registerAsset, reviseAsset } from "./knowledge-store.mjs";
import { createJob } from "./knowledge-jobs.mjs";

/** 工单记录资产的业务分类（页面上按类筛选能看到它） */
const BUSINESS_CATEGORIES = ["工单记录", "归档记录"];

/** 值缺失时统一写「—」：不要留空、也不要编一个值 */
const dash = (value) => {
  if (value === null || value === undefined) return "—";
  const text = String(value).trim();
  return text === "" ? "—" : text;
};

/** 数值 + 单位：非有限数一律「—」（不把 null 写成 0） */
function numberWithUnit(value, unit) {
  return typeof value === "number" && Number.isFinite(value) ? `${value} ${unit}` : "—";
}

/** 时间戳去掉 T，与人读的档案一致 */
const clock = (value) => dash(value).replace("T", " ").slice(0, 16);

/**
 * 把一张工单实体编成一段可检索的档案文本。
 *
 * @param detail   `workOrders.detailFor()` 的返回（order / commission / subjects /
 *                 environment / assignment / dispatches / logs）
 * @param options  archivedAt 归档时刻（默认取当前时间）、actorLabel 归档人岗位
 */
export function composeWorkOrderRecordText(detail, { archivedAt = null, actorLabel = null } = {}) {
  const { order, commission = {}, subjects = [], environment = {}, assignment = null, dispatches = [], logs = [] } = detail ?? {};
  if (!order) throw new Error("composeWorkOrderRecordText 需要工单详情（detail.order 缺失）");

  const lines = [];
  const window =
    order.plannedStart && order.plannedEnd && order.plannedStart !== order.plannedEnd
      ? `${order.plannedStart} 至 ${order.plannedEnd}`
      : dash(order.plannedStart);

  /* ---- 工单 ---- */
  lines.push(`【工单】编号 ${dash(order.orderNo)} ｜ 标题 ${dash(order.title)} ｜ 状态 ${dash(order.status)}`);
  lines.push(`【工单】地点 ${dash(order.location)} ｜ 计划作业时间 ${window} ｜ 平台创建时间 ${clock(order.createdAt)}`);
  lines.push(
    `【工单】负责人 ${dash(assignment?.leaderLabel ?? "未指派")} ｜ 交付内容 ${dash(order.deliveryText)} ｜ 来源 ${dash(order.source)}`,
  );

  /* ---- 委托（单位随单资料，不转写成平台结论）---- */
  lines.push(`【委托】委托单位 ${dash(commission.unit)} ｜ 委托日期 ${dash(commission.date)} ｜ 项目名称 ${dash(commission.projectName)}`);
  lines.push(
    `【委托】检测地点 ${dash(order.location)} ｜ 交付内容 ${dash(commission.deliveryText)} ｜ 现场对接 ${dash(
      commission.contact ? `${commission.contact.role} · ${commission.contact.channel}` : null,
    )}`,
  );
  if (order.requirementsText) lines.push(`【委托原文】${String(order.requirementsText).trim()}`);

  /* ---- 检测主体：Z01–Z04 与主体 ID 成对写，检索任一项都能定位到同一单 ---- */
  if (subjects.length) {
    lines.push(
      `【检测主体】共 ${subjects.length} 根：` +
        subjects
          .map((subject) => `${dash(subject.code)}（${dash(subject.name)} · ${dash(subject.subjectId)} · 现场位置 ${dash(subject.position)}）`)
          .join(" ｜ "),
    );
  }

  /* ---- 环境记录：读数、原始气压、测量位置与时间 ---- */
  const env = environment.inputs ?? {};
  const pressureRaw = environment.pressureInput
    ? `${environment.pressureInput.value} ${environment.pressureInput.unit}`
    : null;
  lines.push(
    `【环境记录】温度 ${numberWithUnit(env.airTempC, "℃")} ｜ 相对湿度 ${numberWithUnit(env.relativeHumidityPct, "%RH")} ｜ 风速 ${numberWithUnit(
      env.windSpeedMs,
      "m/s",
    )} ｜ 大气压 ${numberWithUnit(env.atmosphericPressureHpa, "hPa")}${pressureRaw ? `（原始录入 ${pressureRaw}）` : ""}`,
  );
  lines.push(
    `【环境记录】测量位置 ${dash(environment.position)} ｜ 测量时间 ${clock(environment.measuredAt)} ｜ 录入人岗位 ${dash(
      environment.updatedByLabel,
    )} ｜ 草稿版本 rev ${dash(environment.draftRevision)}`,
  );

  /* ---- 配置版本与校验判据：逐条写通过情况，检索"校验/量程"这类词能命中 ---- */
  const config = environment.config;
  if (config) {
    lines.push(
      `【配置版本】${dash(config.configVersion)} ｜ 校验时间 ${clock(config.validatedAt)} ｜ 校验人岗位 ${dash(
        config.validatedByLabel,
      )} ｜ 方法版本 ${dash(config.methodVersion)}`,
    );
    const checks = config.checks ?? [];
    if (checks.length) {
      const passed = checks.filter((check) => check.ok).length;
      lines.push(
        `【校验判据】共 ${checks.length} 项，通过 ${passed} 项：` +
          checks.map((check) => `${check.label}${check.ok ? "通过" : "未通过"}（${check.message}）`).join(" ｜ "),
      );
    }
  } else {
    lines.push("【配置版本】本单未生成配置版本");
  }

  /* ---- 下发记录：设备、状态、包与时间 ---- */
  if (dispatches.length) {
    for (const dispatch of dispatches) {
      lines.push(
        `【下发记录】目标设备 ${dash(dispatch.deviceId)} ｜ 状态 ${dash(dispatch.stateText ?? dispatch.state)} ｜ 配置版本 ${dash(
          dispatch.configVersion,
        )} ｜ 包 ${dash(dispatch.bundleId)} ｜ 下发时间 ${clock(dispatch.createdAt)} ｜ 设备接收 ${clock(dispatch.acceptedAt)} ｜ 应用 ${
          clock(dispatch.executedAt)
        }`,
      );
    }
  } else {
    lines.push("【下发记录】本单没有下发记录");
  }

  /* ---- 操作日志：一行一条，时间 + 人 + 事 ---- */
  for (const log of logs) {
    lines.push(`【操作日志】${clock(log.at)} ｜ ${dash(log.actorLabel)} ｜ ${dash(log.text)}`);
  }

  /* ---- 归档 ---- */
  lines.push(
    `【归档】归档时间 ${clock(archivedAt ?? nowIso())} ｜ 归档人岗位 ${dash(actorLabel)} ｜ 记录来源 平台工单实体 ${dash(order.orderNo)}`,
  );

  return lines.join("\n");
}

/** 资产标题：列表里一眼能认出是哪张单 */
export const workOrderAssetTitle = (order) => `工单记录 · ${dash(order.orderNo)}（${dash(order.title)}）`;

/**
 * 登记（或更新）一张已归档工单的知识库资产，并建立一个索引任务。
 *
 * @returns {{ assetId: string, created: boolean, revision: number, jobId: string|null, bytes: number }}
 *          `jobId` 交给调用方启动（没有可处理输入时为 null）。
 */
export function ingestArchivedWorkOrder(db, sessionId, { detail, actorId = null, actorLabel = null, archivedAt = null } = {}) {
  const order = detail?.order;
  if (!order) throw new Error("ingestArchivedWorkOrder 需要工单详情（detail.order 缺失）");

  const text = composeWorkOrderRecordText(detail, { archivedAt, actorLabel });
  const subjects = detail.subjects ?? [];
  const existing = db
    .prepare(
      `SELECT id, content_revision AS revision FROM knowledge_assets
        WHERE session_id=? AND source_entity_id=? AND deleted_at IS NULL
        ORDER BY updated_at DESC LIMIT 1`,
    )
    .get(sessionId, order.id);

  let assetId;
  let revision;
  let created;
  const summary = `${order.orderNo} · ${order.title} · ${order.location} · 归档于 ${clock(archivedAt ?? nowIso())}`;

  if (existing) {
    const revised = reviseAsset(db, sessionId, {
      assetId: existing.id,
      text,
      summary,
      actorId,
      label: `工单归档 · ${clock(archivedAt ?? nowIso())}`,
    });
    if (!revised.ok) throw new Error(`登记工单记录失败：${revised.message}`);
    assetId = existing.id;
    revision = revised.revision;
    created = false;
  } else {
    const registered = registerAsset(db, sessionId, {
      type: "workOrder",
      title: workOrderAssetTitle(order),
      format: "TXT",
      text,
      summary,
      /* 「数据来源」一栏显示成「工单归档（平台工单）」 */
      sourceSystem: "平台工单",
      mainSource: "工单归档",
      sourceEntityId: order.id,
      businessCategories: BUSINESS_CATEGORIES,
      /* 对象编号：单号 + 四根主体，检索任一项都能定位到这张单 */
      primaryObjectId: order.orderNo,
      objectIds: [order.orderNo, ...subjects.map((subject) => subject.code)],
      capturedAt: order.createdAt,
      owner: actorLabel ?? null,
      textMode: "uploaded",
      locatorKind: "record",
      extra: {
        orderNo: order.orderNo,
        orderId: order.id,
        status: order.status,
        location: order.location,
        subjectCodes: subjects.map((subject) => subject.code),
      },
    });
    /* ⚠ `registerAsset()` 返回的是 `{ assetId, indexState, availability }`，不是 id 本身 */
    assetId = registered.assetId;
    revision = 1;
    created = true;
  }

  /* 建立索引任务：scope=changed + 指定 assetId = 只处理这一条，
     不把整个 backlog 一起卷进来（归档一张单不该顺手重建别人的索引）。 */
  const { job } = createJob(db, {
    sessionId,
    actorId,
    scope: "changed",
    assetIds: [assetId],
    triggerSource: "工单归档",
  });

  return { assetId, created, revision, jobId: job?.id ?? null, bytes: Buffer.byteLength(text, "utf8") };
}
