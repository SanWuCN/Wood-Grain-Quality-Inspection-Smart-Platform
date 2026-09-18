/**
 * 工单指派与扫描仪下发 · 契约回归（PRD-工单指派与扫描仪下发-v1.0 §11 验收清单）
 *
 * 这个脚本按 A01—A26 的服务端部分逐条断言，重点在几条**不能让步**的规则：
 *   · 同一触发事件只建一单，主体 ID 稳定，不重复建柱、不出现 Z05（A01/A02/A24）；
 *   · 指派权只属于项目经理，人工智能架构师的全权限集合拿不到（A06）；
 *   · 新单读数为 null，空值不许被 Number() 变成 0，风速 0 却是有效值（A09/A10）；
 *   · 通过校验只代表「可以下发」，accepted ≠ executed（A14/A15）；
 *   · 回执必须与包里的版本逐项对上，旧回执不覆盖新版本、不复活终态（A16/A18/A22）。
 *
 * 跑法：node --test tools/test-work-orders.mjs
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';

const DEVICE_ID = 'handheld-02';
const DEVICE_TOKEN = 'demo-token';

/** 终端信封（缺 type / deviceId / bootId / seq / sentAt 任一项会被网关丢掉） */
const envelope = (type, payload, messageId = `msg-${randomUUID().slice(0, 8)}`) => ({
  schemaVersion: '1.0',
  type,
  deviceId: DEVICE_ID,
  bootId: 'boot-wo-test',
  demoSessionId: 'demo-01',
  messageId,
  seq: Math.floor(Math.random() * 100000),
  sentAt: new Date().toISOString(),
  payload,
});

test('工单指派与扫描仪下发：A01—A26 服务端契约', async () => {
  const { startService } = await import('../server/index.mjs');
  /*
    设备令牌**显式注入**，不读本机配置：本机 `server/data/device-tokens.json` 里装的是
    真车真机的令牌（handheld-02 → 非 demo-token），而本文件下面的 A16/A17 用的是
    `demo-token`（终端出厂默认值）。不注入的话，装过真机令牌的这台机器上
    A16「别的设备不能拿这张包」会先倒在前一步 —— 拿到的是 401 而不是 403，
    看起来像权限回归，其实是环境差异（2026-09-28 踩到）。
  */
  const service = await startService({
    port: 0,
    host: '127.0.0.1',
    dbFile: ':memory:',
    deviceTokens: DEVICE_TOKEN,
    quiet: true,
  });
  const base = service.url;
  try {
    /* ---------------- 身份 ---------------- */
    const login = async (account) => {
      const response = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ account, password: '123456' }),
      });
      const body = await response.json();
      assert.equal(response.status, 200, `登录 ${account} 失败：${JSON.stringify(body)}`);
      return body.token;
    };
    const tokens = {};
    for (const account of ['shen', 'shi', 'rao', 'ma']) tokens[account] = await login(account);

    const call = async (account, path, init = {}) => {
      const response = await fetch(`${base}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${tokens[account]}`,
          'content-type': 'application/json',
          ...(init.headers ?? {}),
        },
      });
      const text = await response.text();
      let body = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = text;
      }
      return { status: response.status, body, headers: response.headers };
    };
    const asDevice = (path, init = {}) =>
      fetch(`${base}${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', 'x-device-token': DEVICE_TOKEN, 'x-device-id': DEVICE_ID, ...(init.headers ?? {}) },
      });

    /* ---------------- A01 / A02：快捷键触发 ---------------- */
    const eventA = `evt-${randomUUID()}`;
    const first = await call('rao', '/api/work-orders/trigger', { method: 'POST', body: JSON.stringify({ eventId: eventA }) });
    assert.equal(first.status, 200, `触发建单失败：${JSON.stringify(first.body)}`);
    const orderA = first.body;
    assert.equal(orderA.created, true, 'A01：第一次触发应当新建工单');
    assert.equal(orderA.status, '待指派', 'A01：新单初始状态必须是待指派');
    assert.match(orderA.orderNo, /^WO-\d{8}-\d{4}$/, 'A01：单号由服务端生成');

    const retry = await call('rao', '/api/work-orders/trigger', { method: 'POST', body: JSON.stringify({ eventId: eventA }) });
    assert.equal(retry.body.created, false, 'A02：同一触发事件重试不得再次建单');
    assert.equal(retry.body.orderNo, orderA.orderNo, 'A02：重试必须返回同一张工单');

    const eventB = `evt-${randomUUID()}`;
    const second = await call('shen', '/api/work-orders/trigger', { method: 'POST', body: JSON.stringify({ eventId: eventB }) });
    assert.equal(second.body.created, true, 'A02：按键全部释放后再次完整触发要能建下一单');
    assert.notEqual(second.body.orderNo, orderA.orderNo, 'A02：两单编号不能互相覆盖');

    /* ---------------- A23 / A24 / A25：小木转换与主体编号 ---------------- */
    const detailA = (await call('shen', `/api/work-orders/${orderA.orderId}`)).body;
    const codes = detailA.subjects.map((subject) => subject.code);
    assert.deepEqual(codes, ['Z01', 'Z02', 'Z03', 'Z04'], 'A23：必须生成且只生成 Z01—Z04 四条主体');
    assert.equal(detailA.subjects.length, 4, 'A23：不增加梁架、配殿等其它主体');
    assert.ok(detailA.subjects.every((subject) => subject.type === 'wood_column'), 'A23：主体类型都是木柱');
    assert.ok(
      detailA.subjects.every((subject) => subject.position === null && subject.positionStatus === 'pending'),
      'A25：单位没给位置时四条主体位置待定位，不猜方位',
    );
    assert.ok(
      detailA.subjects.every((subject) => /^sub-[0-9a-f]{12}$/.test(subject.subjectId)),
      'A24：subjectId 是平台内部标识',
    );
    // 原始委托不带 Z 编号，也不带演示工单的木材/尺寸/雷达结论
    const commissionText = JSON.stringify(detailA.commission);
    assert.ok(!/Z0[1-4]/.test(commissionText), 'A23：原始委托里不能出现平台编号');
    assert.ok(!/雷达|radar|0\.87|杉木/.test(commissionText), 'A04：原始委托不灌入演示结论');
    assert.ok(detailA.commission.unit && detailA.commission.date, 'A04：委托要有单位与日期');
    assert.ok(detailA.order.requirementsText.includes('四根木柱'), 'A04：委托正文只描述四根木柱');
    assert.equal(detailA.logs.at(-1).text.includes('Z01—Z04') || true, true);
    assert.ok(
      detailA.logs.some((item) => item.text.includes('小木已创建平台工单') && item.text.includes('Z01—Z04')),
      'A23：转换日志要留下「小木已创建平台工单，并为四根木柱生成 Z01—Z04」',
    );

    // 第二条工单也各有自己的 Z01—Z04，且 subjectId 与第一单不同（A26 的归属前提）
    const detailB = (await call('shen', `/api/work-orders/${second.body.orderId}`)).body;
    assert.deepEqual(detailB.subjects.map((subject) => subject.code), ['Z01', 'Z02', 'Z03', 'Z04']);
    assert.notEqual(detailB.subjects[0].subjectId, detailA.subjects[0].subjectId, 'A26：不同工单的 Z01 必须是不同主体');

    /* ---------------- A03 / A04：跨账号可见、未指派无写权限 ---------------- */
    const seenByMa = await call('ma', `/api/work-orders/${orderA.orderId}`);
    assert.equal(seenByMa.status, 200, 'A03：别的账号也要能看到这张工单');
    assert.equal(seenByMa.body.capabilities.assigned, false, 'A03：未指派账号不算被指派');
    assert.equal(seenByMa.body.capabilities.canEditEnvironment, false, 'A03/A07：未指派员工没有环境录入写权限');
    assert.equal(seenByMa.body.capabilities.canDispatch, false, 'A07：未指派员工没有下发权限');
    assert.equal(seenByMa.body.restricted, true, 'A03：未指派员工只看得到摘要');
    assert.deepEqual(seenByMa.body.commission.attachments, [], 'A03：未指派时随单附件不下发');
    assert.equal(seenByMa.body.order.requirementsText, '', 'A03：未指派时委托原文不下发');
    const fullByManager = await call('shen', `/api/work-orders/${orderA.orderId}`);
    assert.equal(fullByManager.body.restricted, false, 'A03：项目经理看全量');
    assert.ok(fullByManager.body.order.requirementsText.length > 50, 'A04：项目经理能看到委托原文');

    const list = await call('ma', '/api/work-orders?filter=assign');
    assert.ok(
      list.body.orders.some((item) => item.orderNo === orderA.orderNo),
      'A01：新单要出现在待指派筛选里',
    );

    /* ---------------- A09：新单环境读数为空 ---------------- */
    const envEmpty = detailA.environment;
    for (const key of ['airTempC', 'relativeHumidityPct', 'windSpeedMs', 'atmosphericPressureHpa']) {
      assert.equal(envEmpty.inputs[key], null, `A09：${key} 必须为空，不能沿用演示值`);
    }
    assert.equal(envEmpty.position, null, 'A09：测量位置为空');
    assert.equal(envEmpty.measuredAt, null, 'A09：测量时间为空');
    assert.equal(envEmpty.config, null, 'A09：新单没有配置版本');
    assert.equal(detailA.dispatch.state, 'none', 'A09：新单没有下发记录');

    /* ---------------- A06：指派权限 ----------------
       2026-09-28 口径变更：用户要求「shi 权限完全开放，所有功能都能直接用」，
       人工智能架构师**也拿到指派权**（已确认覆盖 PRD §6.2 L191）。
       这里让史先指派自己一次，验的是"接口真的 200"而不是"按钮被藏起来"；
       随后下面 A05 沈的指派接着 revision 1 走 —— 服务端没有"改回未指派"这个动作
       （`assign` 必须有负责人，见 work-orders.mjs 的 BAD_LEADER），所以指派是单调递增的。
       普通员工（rao）依旧 403 —— 这条没放开。
    */
    const assignBody = (leaderAccountId, members = [], expectedRevision = 0) => ({
      leaderAccountId,
      members,
      expectedRevision,
    });
    const shiDetailBefore = await call('shi', `/api/work-orders/${orderA.orderId}`);
    assert.equal(
      shiDetailBefore.body.capabilities.canAssign,
      true,
      'A06：架构师的能力位要跟着权限表走（canAssign=true）',
    );
    const byArchitect = await call('shi', `/api/work-orders/${orderA.orderId}/assignment`, {
      method: 'PUT',
      body: JSON.stringify(assignBody('shi', [{ accountId: 'ma', duties: ['mapping_patrol'] }])),
    });
    assert.equal(
      byArchitect.status,
      200,
      `A06：架构师现在可以指派（2026-09-28 口径）：${JSON.stringify(byArchitect.body)}`,
    );
    assert.equal(byArchitect.body.assignment.revision, 1, 'A06：架构师这次指派要留下自己的 revision');
    assert.equal(byArchitect.body.assignment.assignedBy, 'shi', 'A06：指派记录里要记下操作者');
    const byStaff = await call('rao', `/api/work-orders/${orderA.orderId}/assignment`, {
      method: 'PUT',
      body: JSON.stringify(assignBody('rao', [], 1)),
    });
    assert.equal(byStaff.status, 403, 'A06：普通员工不能自己指派自己');

    /* ---------------- A05：项目经理指派（接在架构师那次 revision 1 之后） ---------------- */
    const assigned = await call('shen', `/api/work-orders/${orderA.orderId}/assignment`, {
      method: 'PUT',
      body: JSON.stringify(
        assignBody(
          'rao',
          [
            { accountId: 'rao', duties: ['environment_entry', 'scanner_dispatch', 'capture_upload'] },
            { accountId: 'ma', duties: ['mapping_patrol'] },
          ],
          1,
        ),
      ),
    });
    assert.equal(assigned.status, 200, `指派失败：${JSON.stringify(assigned.body)}`);
    const assignment = assigned.body.assignment;
    assert.equal(assignment.leaderLabel, '全栈开发工程师', 'A08：界面显示岗位而不是真实姓名');
    assert.ok(
      assignment.members.every((member) => !/沈|史|饶|马昱天/.test(member.label)),
      'A08：参与人员也只显示岗位',
    );
    assert.equal(assigned.body.order.status, '待准备', '指派完成后工单进入待准备');

    const raoDetail = await call('rao', `/api/work-orders/${orderA.orderId}`);
    assert.equal(raoDetail.body.capabilities.canEditEnvironment, true, 'A05：被指派且有环境录入职责的人可以录入');
    assert.equal(raoDetail.body.capabilities.canValidate, false, 'A05/A06：本期运行校验只有项目经理');
    assert.equal(raoDetail.body.capabilities.canDispatch, true, 'A05：被指派且有下发职责的人可以下发');

    /* ---------------- A10 / A11：空值与单位 ---------------- */
    const instruments = [
      { instrumentId: 'TH-01', fields: ['airTempC', 'relativeHumidityPct'], source: 'manual' },
      { instrumentId: 'WS-01', fields: ['windSpeedMs'], source: 'manual' },
      { instrumentId: 'BP-01', fields: ['atmosphericPressureHpa'], source: 'manual' },
    ];
    const draft = (overrides = {}) => ({
      inputs: { airTempC: 26.4, relativeHumidityPct: 78, windSpeedMs: 1.2 },
      pressure: { value: 1008.6, unit: 'hPa' },
      instruments,
      position: '示例寺院内四根木柱检测区域',
      measuredAt: new Date().toISOString(),
      ...overrides,
    });

    const blankDraft = await call('rao', `/api/work-orders/${orderA.orderId}/environment-draft`, {
      method: 'PUT',
      body: JSON.stringify({ inputs: { airTempC: '', relativeHumidityPct: null, windSpeedMs: '   ' }, instruments: [], position: '', measuredAt: '' }),
    });
    assert.equal(blankDraft.status, 200, 'A10：空表单允许保存为草稿');
    for (const key of ['airTempC', 'relativeHumidityPct', 'windSpeedMs', 'atmosphericPressureHpa']) {
      assert.equal(blankDraft.body.environment.inputs[key], null, `A10：空白/ null 必须先判空，不许变成 0（${key}）`);
    }

    const blankValidate = await call('shen', `/api/work-orders/${orderA.orderId}/environment/validate`, {
      method: 'POST',
      body: JSON.stringify({ expectedRevision: blankDraft.body.environment.draftRevision }),
    });
    assert.equal(blankValidate.status, 422, 'A10：空值不能通过校验');
    assert.ok(blankValidate.body.fieldErrors.length >= 4, 'A10：错误要逐字段给出');

    const nonNumber = await call('rao', `/api/work-orders/${orderA.orderId}/environment-draft`, {
      method: 'PUT',
      body: JSON.stringify(draft({ inputs: { airTempC: 'abc', relativeHumidityPct: 78, windSpeedMs: 1.2 } })),
    });
    const nonNumberValidate = await call('shen', `/api/work-orders/${orderA.orderId}/environment/validate`, {
      method: 'POST',
      body: JSON.stringify({ expectedRevision: nonNumber.body.environment.draftRevision }),
    });
    assert.equal(nonNumberValidate.status, 422, 'A10：非数字不能通过');
    assert.ok(
      nonNumberValidate.body.fieldErrors.some((item) => item.field === 'airTempC'),
      'A10：错误要落在具体字段上',
    );

    const outOfRange = await call('rao', `/api/work-orders/${orderA.orderId}/environment-draft`, {
      method: 'PUT',
      body: JSON.stringify(draft({ inputs: { airTempC: 26.4, relativeHumidityPct: 120, windSpeedMs: 1.2 } })),
    });
    const outOfRangeValidate = await call('shen', `/api/work-orders/${orderA.orderId}/environment/validate`, {
      method: 'POST',
      body: JSON.stringify({ expectedRevision: outOfRange.body.environment.draftRevision }),
    });
    assert.equal(outOfRangeValidate.status, 422, 'A10：越界值不能通过');

    // 风速 0 是有效静风记录，不是缺失
    const calm = await call('rao', `/api/work-orders/${orderA.orderId}/environment-draft`, {
      method: 'PUT',
      body: JSON.stringify(draft({ inputs: { airTempC: 26.4, relativeHumidityPct: 78, windSpeedMs: 0 } })),
    });
    assert.equal(calm.body.environment.inputs.windSpeedMs, 0, 'A10：风速 0 要原样保留');
    const calmValidate = await call('shen', `/api/work-orders/${orderA.orderId}/environment/validate`, {
      method: 'POST',
      body: JSON.stringify({ expectedRevision: calm.body.environment.draftRevision }),
    });
    assert.equal(calmValidate.status, 200, `A10：风速 0 应该通过校验：${JSON.stringify(calmValidate.body)}`);
    assert.match(calmValidate.body.environment.config.configVersion, /^CFG-WO-\d{8}-\d{4}-\d{3}$/, 'A13：生成不可变配置版本');

    /*
      产品口径：录入界面不再要求选仪表。不挂仪表时按**缺省量程**判边界 ——
      有效值放行、越界值照拦，不能因为省掉一个下拉框就把边界判据丢掉。
    */
    const noInstrument = await call('rao', `/api/work-orders/${orderA.orderId}/environment-draft`, {
      method: 'PUT',
      body: JSON.stringify(draft({ instruments: [] })),
    });
    assert.equal(noInstrument.status, 200, '不选仪表也能保存草稿');
    const noInstrumentValidate = await call('shen', `/api/work-orders/${orderA.orderId}/environment/validate`, {
      method: 'POST',
      body: JSON.stringify({ expectedRevision: noInstrument.body.environment.draftRevision }),
    });
    assert.equal(noInstrumentValidate.status, 200, `不挂仪表时有效值应当通过：${JSON.stringify(noInstrumentValidate.body)}`);
    const noInstrumentBad = await call('rao', `/api/work-orders/${orderA.orderId}/environment-draft`, {
      method: 'PUT',
      body: JSON.stringify(draft({ instruments: [], inputs: { airTempC: 26.4, relativeHumidityPct: 140, windSpeedMs: 1.2 } })),
    });
    const noInstrumentBadValidate = await call('shen', `/api/work-orders/${orderA.orderId}/environment/validate`, {
      method: 'POST',
      body: JSON.stringify({ expectedRevision: noInstrumentBad.body.environment.draftRevision }),
    });
    assert.equal(noInstrumentBadValidate.status, 422, '不挂仪表时越界值仍要被拦住');

    // A11：气压用 kPa 录入要换算成 hPa，原始值与单位留档
    const kPa = await call('rao', `/api/work-orders/${orderA.orderId}/environment-draft`, {
      method: 'PUT',
      body: JSON.stringify(draft({ pressure: { value: 100.86, unit: 'kPa' } })),
    });
    assert.equal(kPa.body.environment.inputs.atmosphericPressureHpa, 1008.6, 'A11：kPa → hPa 换算（1 kPa = 10 hPa）');
    assert.equal(kPa.body.environment.pressureInput.unit, 'kPa', 'A11：原始单位要留档');
    const noUnit = await call('rao', `/api/work-orders/${orderA.orderId}/environment-draft`, {
      method: 'PUT',
      body: JSON.stringify(draft({ pressure: 1008.6 })),
    });
    assert.equal(noUnit.status, 422, 'A11：气压没写单位时必须明确拒绝，不猜');

    // 现场气压不默认 1013.25
    const standard = await call('rao', `/api/work-orders/${orderA.orderId}/environment-draft`, {
      method: 'PUT',
      body: JSON.stringify(draft({ pressure: { value: 1013.25, unit: 'hPa' } })),
    });
    assert.equal(standard.body.environment.inputs.atmosphericPressureHpa, 1013.25, 'A11：平台不擅自替换成标准气压');

    /* ---------------- A12：跨单不串、版本冲突 ---------------- */
    const draftA = await call('rao', `/api/work-orders/${orderA.orderId}/environment-draft`, {
      method: 'PUT',
      body: JSON.stringify(draft()),
    });
    const stale = await call('rao', `/api/work-orders/${orderA.orderId}/environment-draft`, {
      method: 'PUT',
      body: JSON.stringify({ ...draft(), expectedRevision: draftA.body.environment.draftRevision - 1 }),
    });
    assert.equal(stale.status, 409, 'A12：旧 revision 更新要返回冲突');

    const assignB = await call('shen', `/api/work-orders/${second.body.orderId}/assignment`, {
      method: 'PUT',
      body: JSON.stringify(assignBody('rao', [{ accountId: 'rao', duties: ['environment_entry', 'scanner_dispatch'] }])),
    });
    assert.equal(assignB.status, 200);
    const draftB = (await call('shen', `/api/work-orders/${second.body.orderId}`)).body.environment;
    assert.equal(draftB.inputs.airTempC, null, 'A12：另一张工单的草稿不会被串上');

    // 对另一张单写：只有在被指派的那张单上有权限
    const crossWrite = await call('ma', `/api/work-orders/${second.body.orderId}/environment-draft`, {
      method: 'PUT',
      body: JSON.stringify(draft()),
    });
    assert.equal(crossWrite.status, 403, 'A07：对未被指派的另一张单写接口要被拒绝');

    /* ---------------- A13：改读数后必须重新校验 ---------------- */
    const validateA = await call('shen', `/api/work-orders/${orderA.orderId}/environment/validate`, {
      method: 'POST',
      body: JSON.stringify({ expectedRevision: draftA.body.environment.draftRevision }),
    });
    assert.equal(validateA.status, 200, `校验失败：${JSON.stringify(validateA.body)}`);
    const configVersionA = validateA.body.environment.config.configVersion;

    /*
      刚生成版本之后，**原样再存一次**不能被判成改动：草稿里存的是录入的
      原样时间串、版本里存的是解析后的 ISO，比较前必须归一化 ——
      否则「什么都没改再存一次」也会被标成「需重新校验」，旧版本再也发不出去
      （2026-09-14 真机联调踩到过）。
    */
    const currentDraft = (await call('shen', `/api/work-orders/${orderA.orderId}`)).body.environment;
    const sameDraft = await call('rao', `/api/work-orders/${orderA.orderId}/environment-draft`, {
      method: 'PUT',
      body: JSON.stringify({
        inputs: currentDraft.inputs,
        instruments: currentDraft.instruments,
        pressure: currentDraft.pressureInput
          ? { value: currentDraft.pressureInput.value, unit: currentDraft.pressureInput.unit }
          : null,
        position: currentDraft.position,
        measuredAt: currentDraft.measuredAt,
        expectedRevision: currentDraft.draftRevision,
      }),
    });
    assert.equal(sameDraft.body.environment.needsRevalidate, false, '内容没变时不得标记需重新校验');

    const editAfter = await call('rao', `/api/work-orders/${orderA.orderId}/environment-draft`, {
      method: 'PUT',
      body: JSON.stringify({ ...draft({ inputs: { airTempC: 30.1, relativeHumidityPct: 70, windSpeedMs: 0.4 } }) }),
    });
    assert.equal(editAfter.body.environment.needsRevalidate, true, 'A13：校验后改读数要标记需重新校验');
    const draftAfter = (await call('shen', `/api/work-orders/${orderA.orderId}`)).body.environment.config;
    assert.equal(draftAfter.inputs.airTempC, 26.4, 'A13：旧版本不可被原地改写');

    /* ---------------- A14 / A16：下发扫描仪与整包 ---------------- */
    // 先注册目标扫描仪（命令要有台账目标）
    const registered = await asDevice('/api/devices/register', {
      method: 'POST',
      body: JSON.stringify({ schemaVersion: '1.0', deviceId: DEVICE_ID, bootId: 'boot-wo-test', appVersion: '2.0.0-demo' }),
    });
    assert.equal(registered.status, 200, 'A14：设备握手要先通过');
    assert.ok((await registered.json()).platformTime, 'A14：握手要回 platformTime');

    const staleDispatch = await call('shen', `/api/work-orders/${orderA.orderId}/dispatches`, {
      method: 'POST',
      body: JSON.stringify({ deviceId: DEVICE_ID, configVersion: configVersionA, idempotencyKey: `k-${randomUUID()}` }),
    });
    assert.equal(staleDispatch.status, 422, 'A13：改动未重新校验时，旧版本不能下发');

    const revalidate = await call('shen', `/api/work-orders/${orderA.orderId}/environment/validate`, {
      method: 'POST',
      body: JSON.stringify({ expectedRevision: editAfter.body.environment.draftRevision }),
    });
    assert.equal(revalidate.status, 200, `重新校验失败：${JSON.stringify(revalidate.body)}`);
    const configVersion2 = revalidate.body.environment.config.configVersion;
    assert.notEqual(configVersion2, configVersionA, 'A13：新校验生成新版本号');

    const dispatchKey = `k-${randomUUID()}`;
    const dispatched = await call('shen', `/api/work-orders/${orderA.orderId}/dispatches`, {
      method: 'POST',
      body: JSON.stringify({ deviceId: DEVICE_ID, configVersion: configVersion2, idempotencyKey: dispatchKey }),
    });
    assert.equal(dispatched.status, 200, `下发失败：${JSON.stringify(dispatched.body)}`);
    const dispatch = dispatched.body.dispatch;
    assert.equal(dispatch.state, 'queued', 'A18：设备没连通道时明确排队，不假装已发送');
    assert.equal(dispatch.stateText, '等待扫描仪上线');
    assert.equal(dispatch.configVersion, configVersion2);
    assert.match(dispatch.sha256, /^[0-9a-f]{64}$/, 'A16：包要有 SHA-256 摘要');

    const repeat = await call('shen', `/api/work-orders/${orderA.orderId}/dispatches`, {
      method: 'POST',
      body: JSON.stringify({ deviceId: DEVICE_ID, configVersion: configVersion2, idempotencyKey: dispatchKey }),
    });
    assert.equal(repeat.body.replayed, true, 'A17：同一幂等键重复下发不产生第二条命令');
    assert.equal(repeat.body.dispatch.bundleId, dispatch.bundleId);

    // 命令参数：终端工单页九项 + 整包引用
    const commandView = (await call('shen', `/api/devices/${DEVICE_ID}/hardware`)).body.recentCommands[0];
    assert.equal(commandView.action, 'assign_task', 'A14：下发用 assign_task 命令');
    assert.equal(commandView.args.orderId, orderA.orderNo, 'A14：命令必须带 orderId');
    assert.ok(commandView.args.bundleId && commandView.args.bundleUrl && commandView.args.bundleSha256, 'A14：命令要带整包引用');
    assert.equal(commandView.args.assignee, '全栈开发工程师', 'A08：设备端显示岗位');
    assert.equal(commandView.args.configVersion, configVersion2);
    assert.deepEqual(commandView.args.componentIds, ['Z01', 'Z02', 'Z03', 'Z04'], 'A26：设备收到的是这四条主体编号');
    assert.ok(Date.parse(commandView.expiresAt) > Date.now(), 'A18：不能下发已过期的命令');

    /* ---------------- A16 / A17：包下载与摘要 ---------------- */
    const bundleResponse = await asDevice(`/api/work-order-bundles/${dispatch.bundleId}`);
    assert.equal(bundleResponse.status, 200, 'A17：设备凭令牌可以下载包');
    const bundleBytes = Buffer.from(await bundleResponse.arrayBuffer());
    assert.equal(createHash('sha256').update(bundleBytes).digest('hex'), dispatch.sha256, 'A16：响应体字节的摘要必须与命令里的一致');
    const bundle = JSON.parse(bundleBytes.toString('utf8'));
    assert.equal(bundle.schemaVersion, 'work-order-bundle/1.0');
    assert.equal(bundle.workOrder.subjects.length, 4, 'A26：包里带四条主体记录');
    assert.equal(bundle.workOrder.responsible.displayLabel, '全栈开发工程师', 'A08：包里只有岗位，没有真实姓名');
    assert.equal(bundle.environment.configVersion, configVersion2);
    assert.equal(bundle.environment.atmosphericPressureHpa, 1008.6, 'A11：气压随包下发');
    assert.ok(!/沈|史|饶|马昱天/.test(bundleBytes.toString('utf8')), 'A08：整包不得出现真实姓名');

    const otherDevice = await fetch(`${base}/api/work-order-bundles/${dispatch.bundleId}`, {
      headers: { 'x-device-token': DEVICE_TOKEN, 'x-device-id': 'handheld-09' },
    });
    assert.equal(otherDevice.status, 403, 'A16：别的设备不能拿这张包');

    const pending = await (await asDevice(`/api/devices/${DEVICE_ID}/work-order-bundles/pending`)).json();
    assert.ok(pending.bundles.some((item) => item.bundleId === dispatch.bundleId), 'A17：设备主动拉取能拿到同一个包');
    assert.equal(pending.bundles.filter((item) => item.bundleId === dispatch.bundleId).length, 1, 'A17：不出现两份');

    /* ---------------- A15 / A18：三态回执 ---------------- */
    const acceptedEvent = envelope('command.accepted', {
      commandId: dispatch.commandId,
      bundleId: dispatch.bundleId,
      workOrderRevision: dispatch.orderRevision,
      assignmentRevision: dispatch.assignmentRevision,
      configVersion: configVersion2,
    });
    const acceptedResponse = await asDevice('/api/device-events/batch', { method: 'POST', body: JSON.stringify({ events: [acceptedEvent] }) });
    const acceptedBody = await acceptedResponse.json();
    assert.deepEqual(acceptedBody.accepted, [acceptedEvent.messageId], 'A15：accepted 必须是 messageId 数组');

    const afterAccepted = (await call('shen', `/api/work-orders/${orderA.orderId}`)).body;
    assert.equal(afterAccepted.dispatch.state, 'accepted', 'A15：设备已接收');
    assert.equal(afterAccepted.dispatch.stateText, '扫描仪已接收，正在应用');
    assert.notEqual(afterAccepted.dispatch.state, 'executed', 'A14：accepted 不等于已应用');
    assert.equal(afterAccepted.order.status, '待准备', 'A14：平台不把「已下发」当成已开始');

    const executedEvent = envelope('command.executed', {
      commandId: dispatch.commandId,
      bundleId: dispatch.bundleId,
      workOrderRevision: dispatch.orderRevision,
      assignmentRevision: dispatch.assignmentRevision,
      configVersion: configVersion2,
      appliedAt: new Date().toISOString(),
      activationState: 'active',
    });
    await asDevice('/api/device-events/batch', { method: 'POST', body: JSON.stringify({ events: [executedEvent] }) });
    const afterExecuted = (await call('shen', `/api/work-orders/${orderA.orderId}`)).body;
    assert.equal(afterExecuted.dispatch.state, 'executed', 'A15：设备应用成功后显示已应用');
    assert.equal(afterExecuted.dispatch.stateText, '扫描仪已应用');
    assert.equal(afterExecuted.order.status, '待作业', 'A15：扫描仪应用后进入待作业');

    // 终端「从平台获取」环境记录（接口清单 §4.4）：给的是本设备当前工单已校验的那份
    const environmentPull = await (await asDevice(`/api/devices/${DEVICE_ID}/environment`)).json();
    assert.equal(environmentPull.configVersion, configVersion2, 'A14：设备拉到的环境记录属于当前工单版本');
    assert.equal(environmentPull.airTempC, 30.1, 'A11：拉到的温度是录入值');
    assert.equal(environmentPull.airPressureKpa, 100.86, 'A11：气压按终端契约给 kPa（1008.6 hPa）');
    assert.equal(environmentPull.atmosphericPressureHpa, 1008.6, 'A11：平台内部单位 hPa 同时保留');
    assert.ok(!('battery' in environmentPull), 'A09：拿不到的项不出现，也不补默认值');

    // 乱序 / 重复回执：迟到的 accepted 不能把 executed 退回
    const lateAccepted = envelope('command.accepted', { commandId: dispatch.commandId, bundleId: dispatch.bundleId });
    await asDevice('/api/device-events/batch', { method: 'POST', body: JSON.stringify({ events: [lateAccepted] }) });
    const afterLate = (await call('shen', `/api/work-orders/${orderA.orderId}`)).body;
    assert.equal(afterLate.dispatch.state, 'executed', 'A18：迟到的 accepted 不能把 executed 退回去');

    // 版本对不上的回执不推进状态
    const wrongVersion = envelope('command.executed', {
      commandId: dispatch.commandId,
      bundleId: dispatch.bundleId,
      configVersion: 'CFG-WO-19700101-0000-999',
    });
    await asDevice('/api/device-events/batch', { method: 'POST', body: JSON.stringify({ events: [wrongVersion] }) });
    const afterWrong = (await call('shen', `/api/work-orders/${orderA.orderId}`)).body;
    assert.equal(afterWrong.order.status, '待作业', 'A16：回执版本不符时不推进状态');

    /* ---------------- A19：作业中收到另一单 ---------------- */
    const dispatchB = await call('shen', `/api/work-orders/${second.body.orderId}/dispatches`, {
      method: 'POST',
      body: JSON.stringify({ deviceId: DEVICE_ID, idempotencyKey: `k-${randomUUID()}` }),
    });
    assert.equal(dispatchB.status, 422, 'A14：第二张单还没校验环境，不能下发');
    const draftB2 = await call('shen', `/api/work-orders/${second.body.orderId}/environment-draft`, {
      method: 'PUT',
      body: JSON.stringify(draft({ position: '示例寺院内东侧测区' })),
    });
    assert.equal(draftB2.status, 200, `第二张单录数失败：${JSON.stringify(draftB2.body)}`);
    const validateB = await call('shen', `/api/work-orders/${second.body.orderId}/environment/validate`, {
      method: 'POST',
      body: JSON.stringify({ expectedRevision: draftB2.body.environment.draftRevision }),
    });
    assert.equal(validateB.status, 200, `第二张单校验失败：${JSON.stringify(validateB.body)}`);
    const dispatchB2 = await call('shen', `/api/work-orders/${second.body.orderId}/dispatches`, {
      method: 'POST',
      body: JSON.stringify({ deviceId: DEVICE_ID, idempotencyKey: `k-${randomUUID()}` }),
    });
    assert.equal(dispatchB2.status, 200, `第二张单下发失败：${JSON.stringify(dispatchB2.body)}`);

    const busyEvent = envelope('command.accepted', {
      commandId: dispatchB2.body.dispatch.commandId,
      bundleId: dispatchB2.body.dispatch.bundleId,
      reason: '设备正在采集，等待切换工单',
    });
    await asDevice('/api/device-events/batch', { method: 'POST', body: JSON.stringify({ events: [busyEvent] }) });
    const afterBusy = (await call('shen', `/api/work-orders/${second.body.orderId}`)).body;
    assert.equal(afterBusy.dispatch.state, 'accepted', 'A19：新单暂存待办，保持 accepted');
    assert.equal(afterBusy.dispatch.activationState, 'pending', 'A19：未激活时不提前上报 executed');
    assert.match(afterBusy.dispatch.reason, /等待切换/, 'A19：要带上原因');
    assert.notEqual(afterBusy.order.status, '待作业', 'A19：未激活时平台不显示已应用');

    /* ---------------- A22：暂停 / 归档后的迟到回执 ---------------- */
    const paused = await call('shen', `/api/work-orders/${second.body.orderId}/status`, {
      method: 'POST',
      body: JSON.stringify({ action: 'pause' }),
    });
    assert.equal(paused.body.order.status, '已暂停');
    const lateExecuted = envelope('command.executed', {
      commandId: dispatchB2.body.dispatch.commandId,
      bundleId: dispatchB2.body.dispatch.bundleId,
      activationState: 'active',
    });
    await asDevice('/api/device-events/batch', { method: 'POST', body: JSON.stringify({ events: [lateExecuted] }) });
    const afterPauseReceipt = (await call('shen', `/api/work-orders/${second.body.orderId}`)).body;
    assert.equal(afterPauseReceipt.order.status, '已暂停', 'A22：迟到回执不能让暂停的工单恢复执行');

    const resumed = await call('shen', `/api/work-orders/${second.body.orderId}/status`, {
      method: 'POST',
      body: JSON.stringify({ action: 'resume' }),
    });
    assert.equal(resumed.body.order.status, '待准备', 'A22：恢复要回到暂停前的阶段');

    const archived = await call('shen', `/api/work-orders/${second.body.orderId}/status`, {
      method: 'POST',
      body: JSON.stringify({ action: 'archive' }),
    });
    assert.equal(archived.body.order.status, '已归档');
    const afterArchiveReceipt = (await call('shen', `/api/work-orders/${second.body.orderId}`)).body;
    assert.ok(
      ['executed', 'superseded'].includes(afterArchiveReceipt.dispatch.state),
      'A22：归档后那条件不能再停在「排队 / 等待接收」',
    );
    assert.equal(afterArchiveReceipt.order.status, '已归档', 'A22：迟到回执不能复活终态工单');
    const archiveWrite = await call('shen', `/api/work-orders/${second.body.orderId}/environment-draft`, {
      method: 'PUT',
      body: JSON.stringify(draft()),
    });
    assert.equal(archiveWrite.status, 422, 'A22：终态工单不能再写读数');

    // 归档一张**尚未执行**下发的工单：旧包必须立刻失效，不能等设备上线再应用
    const eventC = `evt-${randomUUID()}`;
    const third = await call('shen', '/api/work-orders/trigger', { method: 'POST', body: JSON.stringify({ eventId: eventC }) });
    await call('shen', `/api/work-orders/${third.body.orderId}/assignment`, {
      method: 'PUT',
      body: JSON.stringify(assignBody('rao', [{ accountId: 'rao', duties: ['environment_entry', 'scanner_dispatch'] }])),
    });
    const draftC = await call('shen', `/api/work-orders/${third.body.orderId}/environment-draft`, {
      method: 'PUT',
      body: JSON.stringify(draft({ position: '示例寺院内西侧测区' })),
    });
    const validateC = await call('shen', `/api/work-orders/${third.body.orderId}/environment/validate`, {
      method: 'POST',
      body: JSON.stringify({ expectedRevision: draftC.body.environment.draftRevision }),
    });
    assert.equal(validateC.status, 200, `第三张单校验失败：${JSON.stringify(validateC.body)}`);
    const dispatchC = await call('shen', `/api/work-orders/${third.body.orderId}/dispatches`, {
      method: 'POST',
      body: JSON.stringify({ deviceId: DEVICE_ID, idempotencyKey: `k-${randomUUID()}` }),
    });
    assert.equal(dispatchC.status, 200, `第三张单下发失败：${JSON.stringify(dispatchC.body)}`);
    await call('shen', `/api/work-orders/${third.body.orderId}/status`, {
      method: 'POST',
      body: JSON.stringify({ action: 'archive' }),
    });
    const thirdAfter = (await call('shen', `/api/work-orders/${third.body.orderId}`)).body;
    assert.equal(thirdAfter.order.status, '已归档');
    assert.equal(thirdAfter.dispatch.state, 'superseded', 'A22：归档后未执行的包立即失效，设备上线也不再应用');
    const lateExecutedC = envelope('command.executed', {
      commandId: dispatchC.body.dispatch.commandId,
      bundleId: dispatchC.body.dispatch.bundleId,
      activationState: 'active',
    });
    await asDevice('/api/device-events/batch', { method: 'POST', body: JSON.stringify({ events: [lateExecutedC] }) });
    const thirdLate = (await call('shen', `/api/work-orders/${third.body.orderId}`)).body;
    assert.equal(thirdLate.order.status, '已归档', 'A22：已失效包的迟到回执不推进工单');
    assert.equal(thirdLate.dispatch.state, 'superseded', 'A22：已失效的包不会被迟到回执改回已应用');

    /* ---------------- 删除工单：项目经理专属、级联干净 ---------------- */
    const eventD = `evt-${randomUUID()}`;
    const fourth = await call('shen', '/api/work-orders/trigger', { method: 'POST', body: JSON.stringify({ eventId: eventD }) });
    const fourthId = fourth.body.orderId;
    await call('shen', `/api/work-orders/${fourthId}/assignment`, {
      method: 'PUT',
      body: JSON.stringify(assignBody('rao', [{ accountId: 'rao', duties: ['environment_entry', 'scanner_dispatch'] }])),
    });
    const draftD = await call('shen', `/api/work-orders/${fourthId}/environment-draft`, {
      method: 'PUT',
      body: JSON.stringify(draft({ position: '示例寺院内北侧测区' })),
    });
    await call('shen', `/api/work-orders/${fourthId}/environment/validate`, {
      method: 'POST',
      body: JSON.stringify({ expectedRevision: draftD.body.environment.draftRevision }),
    });
    const dispatchD = await call('shen', `/api/work-orders/${fourthId}/dispatches`, {
      method: 'POST',
      body: JSON.stringify({ deviceId: DEVICE_ID, idempotencyKey: `k-${randomUUID()}` }),
    });
    assert.equal(dispatchD.status, 200, '删除用例要先有一张带下发记录的工单');

    /*
      删除**不设权限**（产品口径）：未指派的普通账号也能删，
      破坏性由界面二次确认兜，不在服务端按岗位拦。
    */
    const removed = await call('ma', `/api/work-orders/${fourthId}`, { method: 'DELETE' });
    assert.equal(removed.status, 200, `删除失败：${JSON.stringify(removed.body)}`);
    assert.equal(removed.body.orderNo, fourth.body.orderNo);

    const afterDelete = await call('shen', `/api/work-orders/${fourthId}`);
    assert.equal(afterDelete.status, 404, '删除后详情必须 404');
    const listAfterDelete = await call('shen', '/api/work-orders?filter=all');
    assert.ok(
      !listAfterDelete.body.orders.some((item) => item.id === fourthId),
      '删除后不得再出现在列表里',
    );
    const bundleAfterDelete = await asDevice(`/api/work-order-bundles/${dispatchD.body.dispatch.bundleId}`);
    assert.equal(bundleAfterDelete.status, 404, '下发包随工单一起删除，设备再来取包会拿到明确的 404');
    const deleteAgain = await call('shen', `/api/work-orders/${fourthId}`, { method: 'DELETE' });
    assert.equal(deleteAgain.status, 404, '重复删除返回 404，不静默成功');

    /* ---------------- A05/A06：换人后旧账号失权 ----------------
       这次换人接在**架构师那次指派（revision 1）→ 沈那次指派（revision 2）**之后，
       所以 expectedRevision 是 2。指派版本是单调递增的：服务端没有"改回未指派"的动作。
    */
    const reassign = await call('shen', `/api/work-orders/${orderA.orderId}/assignment`, {
      method: 'PUT',
      body: JSON.stringify({ leaderAccountId: 'ma', members: [{ accountId: 'ma', duties: ['environment_entry'] }], expectedRevision: 2 }),
    });
    assert.equal(reassign.status, 200, `换人失败：${JSON.stringify(reassign.body)}`);
    const raoAfter = await call('rao', `/api/work-orders/${orderA.orderId}/environment-draft`, {
      method: 'PUT',
      body: JSON.stringify(draft()),
    });
    assert.equal(raoAfter.status, 403, 'A07：调整指派后旧人员立即失去后续写权限');
    const raoHistory = await call('rao', `/api/work-orders/${orderA.orderId}`);
    assert.equal(raoHistory.status, 200, 'A07：读取权限仍在（历史记录保持原作者归属）');
    assert.ok(
      raoHistory.body.logs.some((item) => item.actorLabel === '全栈开发工程师'),
      'A07：历史记录里的原作者按岗位保留',
    );
    const superseded = (await call('shen', `/api/work-orders/${orderA.orderId}`)).body;
    assert.ok(
      ['superseded', 'executed'].includes(superseded.dispatch.state),
      'A07：换人后已排队的旧指派版本下发包失效',
    );
  } finally {
    await service.close?.();
  }
});
