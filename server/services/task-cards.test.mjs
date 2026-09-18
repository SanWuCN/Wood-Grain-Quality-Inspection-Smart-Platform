/**
 * 执行工作台 · 任务卡 —— 服务端行为验收（真起服务、走 HTTP 命令总线）
 *
 * 剧本依据：⑥「我已把工单任务同步到工作台」/ ⑭⑮「生成补充数据和模型适配的任务清单」
 * + 夹注「小木创建任务草稿，按本轮岗位分工预填执行人；史核对后保存，**不直接把任务标成已完成**」。
 *
 * 这一组盯的是这条链路在服务端是不是真的成立：
 *   ① 权限闸门：`task.create/save` 要 `task:manage`（饶/马没有 → 403），
 *      回执 `task.ack` 要 `task:execute`（沈/史/饶/马都有）；
 *   ② 卡片编号按工单来：`TK-<工单号日期段>-<两位流水>`，四张连号；
 *   ③ **幂等**：同一张工单的同一个批次只生成一次（连按两次快捷键不会变成八张）；
 *   ④ 状态机只有三步：草稿 → 已保存 → 已回执；**没有"已完成"**，
 *      跳步（草稿直接回执）给 409，已回执再动也给 409；
 *   ⑤ revision 冲突给 409 —— 两台电脑同时点只有一台成功；
 *   ⑥ 另一台机器（饶）读同一份快照：四张卡都在，且带着执行人与回执人；
 *   ⑦ 删工单要把这一单的卡片一起清掉，不留孤儿卡。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

test("执行工作台任务卡：批次幂等、编号按工单、权限与状态机都拦得住", async () => {
  const { startService } = await import("../index.mjs");
  const service = await startService({ port: 18096, host: "127.0.0.1", dbFile: ":memory:", quiet: true });
  const base = service.url;

  const login = async (account) => {
    const response = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ account, password: "123456" }),
    });
    assert.equal(response.status, 200, `${account} 登录失败`);
    return (await response.json()).token;
  };
  const call = async (token, method, path, body) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: response.status, json };
  };
  const command = (token, body) =>
    call(token, "POST", "/api/commands", { sessionId: "demo-01", commandId: `cmd-${Math.random().toString(36).slice(2)}`, ...body });
  const cardsIn = async (token) => (await call(token, "GET", "/api/sessions/demo-01/snapshot")).json?.entities?.taskCard ?? [];
  const cardOf = async (token, cardId) => (await cardsIn(token)).find((item) => item.id === cardId) ?? null;

  /** 与页面上 `cardsFor("startup")` 同形的四张卡（内容归前端，服务端只存） */
  const startupCards = [
    { title: "现场建档", ownerAccountId: "ma", ownerLabel: "马", ownerRole: "具身智能工程师", inputs: ["四根木柱影像采集批次"], doneCondition: "影像与地图版本按本工单归档", source: "小木" },
    { title: "风险初筛", ownerAccountId: "shi", ownerLabel: "史", ownerRole: "人工智能架构师", inputs: ["Z01–Z04 原始关键帧"], doneCondition: "出具四柱优先复核顺序并标注疑点测区", source: "小木" },
    { title: "重点精扫", ownerAccountId: "rao", ownerLabel: "饶", ownerRole: "全栈开发工程师", inputs: ["Z04 下部测区与扫描方向"], doneCondition: "原始回波与表面图像按测区回传并入库", source: "小木" },
    { title: "复核交付", ownerAccountId: "shen", ownerLabel: "沈", ownerRole: "项目经理", inputs: ["交付清单"], doneCondition: "交付清单校验通过，复盘草稿纳入报告", source: "小木" },
  ];

  try {
    const shi = await login("shi");
    const rao = await login("rao");
    const ma = await login("ma");

    const created = await call(shi, "POST", "/api/work-orders/trigger", { eventId: `e2e-tasks-${Date.now().toString(36)}` });
    assert.equal(created.status, 200, `建单失败：${JSON.stringify(created.json)}`);
    const orderId = created.json.orderId;
    const orderNo = created.json.orderNo;
    const day = /^WO-(\d{8})-\d+$/.exec(orderNo)?.[1];
    assert.ok(day, `工单号形状不对：${orderNo}`);

    const payload = { orderId, orderNo, batchKey: "startup", cards: startupCards };

    /* ---------- ① 权限闸门（服务端拦，不靠前端置灰） ---------- */
    const raoCreate = await command(rao, { action: "task.create", payload });
    assert.equal(raoCreate.status, 403, "饶没有 task:manage，不该能生成任务卡");
    assert.equal(raoCreate.json.code, "FORBIDDEN");

    /* ---------- ② 缺工单 / 缺批次 / 卡片不完整都拦得住 ---------- */
    for (const [bad, code] of [
      [{ ...payload, orderId: null }, "NO_ORDER"],
      [{ ...payload, batchKey: "" }, "NO_BATCH_KEY"],
      [{ ...payload, cards: [{ title: "没写执行人" }] }, "BAD_CARD"],
    ]) {
      const response = await command(shi, { action: "task.create", payload: bad });
      assert.equal(response.status, 422, `${code} 应该被拦下`);
      assert.equal(response.json.code, code);
    }

    /* ---------- ③ 生成：四张连号草稿，编号按工单日期段 ---------- */
    const first = await command(shi, { action: "task.create", payload });
    assert.equal(first.status, 200, `生成失败：${JSON.stringify(first.json)}`);
    assert.equal(first.json.result.created, true);
    assert.equal(first.json.result.batchKey, "startup");
    assert.deepEqual(
      first.json.result.cardIds,
      [`TK-${day}-01`, `TK-${day}-02`, `TK-${day}-03`, `TK-${day}-04`],
    );
    assert.equal(first.json.entity.data.state, "draft", "生成的必须是草稿（剧本：不直接把任务标成已完成）");
    assert.equal(first.json.entity.data.ownerLabel, "马");
    assert.equal(first.json.entity.data.ownerRole, "具身智能工程师");
    assert.equal(first.json.entity.data.createdBy, "shi");
    assert.equal(first.json.entity.data.savedAt, null);
    assert.equal(first.json.entity.data.ackedAt, null);

    const events = await call(shi, "GET", "/api/events?sessionId=demo-01&afterSeq=0");
    const createdEvent = events.json.events.filter((item) => item.type === "task.created").at(-1);
    assert.equal(createdEvent.payload.orderId, orderId);
    assert.equal(createdEvent.payload.batchKey, "startup");
    assert.equal(createdEvent.payload.count, 4);
    assert.equal(createdEvent.actorId, "shi");

    /* ---------- ④ 幂等：同一批再生成一次，还是那四张（不新增、不改动） ---------- */
    const again = await command(shi, { action: "task.create", payload });
    assert.equal(again.status, 200);
    assert.equal(again.json.result.created, false, "同一张工单的同一批只生成一次");
    assert.deepEqual(again.json.result.cardIds, first.json.result.cardIds);
    assert.equal((await cardsIn(shi)).length, 4, "库里仍应只有四张卡");
    /* 换一批（异常适配）就应当新生成 —— 幂等是按批次算的，不是按工单算的 */
    const adapt = await command(shi, {
      action: "task.create",
      payload: {
        orderId,
        orderNo,
        batchKey: "adapt",
        cards: [{ title: "补充参考样本", ownerAccountId: "rao", ownerLabel: "饶", inputs: ["采样计划"], doneCondition: "两条路径采集完成并登记来源", source: "小木" }],
      },
    });
    assert.equal(adapt.status, 200);
    assert.equal(adapt.json.result.created, true);
    assert.equal(adapt.json.result.cardIds[0], `TK-${day}-05`, "流水是全局连号的，不是按批次从 01 重来");
    assert.equal((await cardsIn(shi)).length, 5);

    /* ---------- ⑤ 跳步不行：草稿直接回执给 409 ---------- */
    const cardId = `TK-${day}-01`;
    const skip = await command(ma, { action: "task.ack", entityId: cardId, expectedRevision: 1, payload: {} });
    assert.equal(skip.status, 409, "没核对保存就回执，服务端要拦");
    assert.equal(skip.json.code, "BAD_TASK_STATE");

    /* ---------- ⑥ 保存：核对人保存，记下是谁 ---------- */
    const draft = await cardOf(shi, cardId);
    const saved = await command(shi, { action: "task.save", entityId: cardId, expectedRevision: draft.revision, payload: {} });
    assert.equal(saved.status, 200, `保存失败：${JSON.stringify(saved.json)}`);
    assert.equal(saved.json.entity.data.state, "saved");
    assert.equal(saved.json.entity.data.savedBy, "shi");
    assert.ok(String(saved.json.entity.data.savedAt).length > 10, "保存时刻要落在实体上");

    /* ---------- ⑦ 回执：执行人（这里用饶，他有 task:execute）回执，记下是谁、什么时候 ---------- */
    const ack = await command(rao, { action: "task.ack", entityId: cardId, expectedRevision: saved.json.entity.revision, payload: {} });
    assert.equal(ack.status, 200, `回执失败：${JSON.stringify(ack.json)}`);
    assert.equal(ack.json.entity.data.state, "accepted");
    assert.equal(ack.json.entity.data.ackedBy, "rao");
    assert.ok(String(ack.json.entity.data.ackedAt).length > 10, "回执时刻要落在实体上");
    /* 没有 done 这个状态：再推一次只能是 409（终态） */
    const afterAck = await command(rao, { action: "task.ack", entityId: cardId, expectedRevision: ack.json.entity.revision, payload: {} });
    assert.equal(afterAck.status, 409);
    assert.equal(afterAck.json.code, "BAD_TASK_STATE");

    /* ---------- ⑧ 两台电脑同时点保存：后到的那台拿 409 ---------- */
    const otherId = `TK-${day}-02`;
    const otherDraft = await cardOf(shi, otherId);
    const conflict = await command(shi, { action: "task.save", entityId: otherId, expectedRevision: otherDraft.revision - 1, payload: {} });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.json.code, "REVISION_CONFLICT");

    /* ---------- ⑨ 另一台机器（马）读同一份快照：五张卡都在，状态与回执人一致 ---------- */
    const seenByMa = await cardsIn(ma);
    assert.equal(seenByMa.length, 5, "内网另一台机器要看到同一份卡片");
    const seenFirst = seenByMa.find((item) => item.id === cardId);
    assert.equal(seenFirst.data.state, "accepted");
    assert.equal(seenFirst.data.ackedBy, "rao");
    assert.equal(seenFirst.data.ownerAccountId, "ma", "回执人是饶，但卡的执行人仍是马（两者不同，不能混）");

    /* ---------- ⑩ 删工单：这一单的卡片一起清掉 ---------- */
    const removed = await call(shi, "DELETE", `/api/work-orders/${orderId}`);
    assert.equal(removed.status, 200, `删单失败：${JSON.stringify(removed.json)}`);
    assert.deepEqual(await cardsIn(shi), [], "工单删了，本单的任务卡也要清掉");
  } finally {
    await service.close?.();
  }
});
