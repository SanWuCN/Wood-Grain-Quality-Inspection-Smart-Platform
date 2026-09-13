/**
 * 设备网关回归测试（手持终端一路）
 *
 * 对着 `手持扫描仪/docs/平台接入实施说明.md` 与 `设备数据接口说明.md` 的验收要点写：
 *   · 注册握手要回 `platformTime`（终端拿它算时钟偏差，没有这一项 readings.clock 就不上报）；
 *   · 硬件上报 / 读取一进一出，读数与来源标识原样保留；
 *   · 事件批量接口的 `accepted` / `duplicated` 必须是 **messageId 数组**——
 *     回计数终端会解析失败，表现为「事件永远在重传」（文档 §3.5 实测踩过）；
 *   · 命令三态：下发 → accepted ≠ executed → executed；
 *   · 设备断电后 6 秒内标 stale、15 秒后标 offline，且不影响其它设备；
 *   · 没有电量计就没有「电池电量」这一行 —— 平台不补默认值。
 *
 * 跑法：node --test tools/test-device-gateway.mjs
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

const DEVICE_ID = 'handheld-02';
const TOKEN = 'demo-token';

/** 一份最小的硬件上报：结构照终端 `build_report()`，读数带 source */
function hardwareReport(overrides = {}) {
  return {
    schemaVersion: '1.0',
    deviceId: DEVICE_ID,
    bootId: 'boot-test-1',
    generatedAt: new Date().toISOString(),
    sampledAt: '18:50:54',
    sourceMode: 'live',
    hardware: { model: 'Raspberry Pi 5 Model B Rev 1.1', hostname: 'SANWU', kernel: '6.12.75+rpt-rpi-2712', python: '3.13.5', cpuCount: 4, isRaspberryPi: true },
    versions: { app: '2.0.0-demo', adapter: '2.0.0-demo', config: 'CFG-02-L3', model: 'DEMO-M02', controller: null },
    state: { task: 'running', taskLabel: '采集中', connection: 'online', connectionLabel: '在线', latencyMs: 9.7, thermalThrottled: false, estimatedCount: 1, derivedCount: 1 },
    readings: [
      { key: 'storage', label: '存储余量', value: 14.3, unit: 'GB', digits: 1, preflight: true, min: 2, scale: 32, source: 'real', origin: '/var/lib/woodpulse' },
      { key: 'temp', label: '机身温度', value: 43.2, unit: '℃', digits: 1, max: 55, source: 'derived', origin: '由 CPU 负载经散热模型推算' },
      { key: 'gpu', label: 'GPU 利用率', value: 12, unit: '%', source: 'estimated', origin: 'Pi 5 无该节点' },
    ],
    channels: [
      { key: 'map', label: '地图', state: 'offline', updatedAt: '18:50:50', ageSec: 4, source: '手持端不建图；建图由巡检车负责' },
      { key: 'pose', label: '位姿', state: 'offline', updatedAt: '18:50:50', ageSec: 4, source: '本机未配置 IMU，不提供枪体姿态' },
      { key: 'video', label: '视频', state: 'online', updatedAt: '18:50:52', ageSec: 0, source: '/dev/video0 1280×720 实采' },
      { key: 'vehicle', label: '车辆', state: 'offline', updatedAt: '18:50:50', ageSec: 4, source: '手持端不含车辆通道' },
    ],
    batches: [
      {
        batchId: 'scan-Z04-002', componentId: 'Z04', zoneId: 'Z04-lower', round: 'rescan',
        configVersion: 'CFG-02-L3', modelVersion: 'DEMO-M02', state: 'sealed', datasetHash: '7b0c1085e132',
        startedAt: '2026-09-13T18:44:02Z', frameCount: 420,
        receive: { radar: { received: 1, expected: 1, state: '完成' }, image: { received: 3, expected: 3, state: '完成' }, result: { received: 1, expected: 1, state: '完成' } },
      },
    ],
    capabilities: { camera: 'live', radar: 'replay', imu: 'unavailable', battery: 'unavailable', telemetry: 'live', gpu: 'unavailable', preview: 'live' },
    note: '实测 21 项 · 推算 1 项 · 估算 0 项',
    ...overrides,
  };
}

const envelope = (type, payload, messageId, seq = 1) => ({
  schemaVersion: '1.0', type, deviceId: DEVICE_ID, bootId: 'boot-test-1', demoSessionId: 'demo-01',
  messageId, seq, sentAt: new Date().toISOString(), payload,
});

test('设备网关：注册 / 硬件上报读取 / 事件去重 / 命令三态 / 预览 / 断流判定', async () => {
  const { startService } = await import('../server/index.mjs');
  const service = await startService({ port: 0, host: '127.0.0.1', dbFile: ':memory:', quiet: true });
  const base = service.url;
  const deviceHeaders = { 'content-type': 'application/json', 'x-device-token': TOKEN, 'x-device-id': DEVICE_ID };
  try {
    const login = async (account) =>
      (await (await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ account, password: '123456' }) })).json()).token;
    const browser = await login('rao');
    const asDevice = (path, init = {}) => fetch(`${base}${path}`, { ...init, headers: { ...deviceHeaders, ...(init.headers ?? {}) } });
    const asBrowser = (path, init = {}) => fetch(`${base}${path}`, { ...init, headers: { authorization: `Bearer ${browser}`, 'content-type': 'application/json', ...(init.headers ?? {}) } });

    /* ---- 1. 注册握手 ---- */
    const badToken = await fetch(`${base}/api/devices/register`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-device-token': 'wrong' }, body: JSON.stringify({ schemaVersion: '1.0', deviceId: DEVICE_ID, bootId: 'boot-test-1' }) });
    assert.equal(badToken.status, 401, '令牌不对要拒绝，不能静默接受');

    const handshake = await (await asDevice('/api/devices/register', {
      method: 'POST',
      body: JSON.stringify({ schemaVersion: '1.0', deviceId: DEVICE_ID, bootId: 'boot-test-1', appVersion: '2.0.0-demo', host: { hostname: 'SANWU' }, capabilities: { radar: 'replay' } }),
    })).json();
    assert.equal(handshake.ok, true);
    assert.equal(handshake.deviceId, DEVICE_ID);
    assert.ok(handshake.platformTime, '必须回 platformTime：终端拿它算时钟偏差');
    assert.equal(typeof handshake.heartbeatIntervalMs, 'number');
    const again = await (await asDevice('/api/devices/register', { method: 'POST', body: JSON.stringify({ schemaVersion: '1.0', deviceId: DEVICE_ID, bootId: 'boot-test-1' }) })).json();
    assert.equal(again.restarted, false, '同一 bootId 重复注册是重连，不是重启');

    /* ---- 2. 硬件上报 → 页面读取 ---- */
    const report = hardwareReport();
    const ingested = await (await asDevice(`/api/devices/${DEVICE_ID}/hardware`, { method: 'POST', body: JSON.stringify(report) })).json();
    assert.equal(ingested.ok, true);
    assert.deepEqual(ingested.summary, { readings: 3, channels: 4, batches: 1, estimated: 1, derived: 1 });

    const view = await (await asBrowser(`/api/devices/${DEVICE_ID}/hardware`)).json();
    assert.equal(view.report.hardware.model, 'Raspberry Pi 5 Model B Rev 1.1');
    assert.equal(view.link.state, 'online');
    assert.equal(view.stale, false);
    assert.equal(view.report.readings[0].source, 'real');
    assert.equal(view.report.readings[2].source, 'estimated');
    assert.equal(view.report.channels.find((c) => c.key === 'map').state, 'offline', 'map 通道要保留并写 offline + 原因');
    assert.ok(!view.report.readings.some((r) => r.key === 'battery'), '终端没有电量计，页面也不该出现电池电量');
    assert.equal(view.report.capabilities.radar, 'replay');
    assert.equal(view.report.batches[0].datasetHash, '7b0c1085e132');

    // 页面读取要登录态；设备令牌对同一 deviceId 也放行（联调方便）
    assert.equal((await fetch(`${base}/api/devices/${DEVICE_ID}/hardware`)).status, 401);
    assert.equal((await asDevice(`/api/devices/${DEVICE_ID}/hardware`)).status, 200);

    /* ---- 3. 事件批量：accepted / duplicated 是 messageId 数组 ---- */
    const first = await (await asDevice('/api/device-events/batch', { method: 'POST', body: JSON.stringify({ events: [envelope('capture.started', { batchId: 'scan-Z04-002' }, 'msg-a'), envelope('device.health', { heartbeat: true, platformLatencyMs: 9.7 }, 'msg-b'), envelope('capture.finished', { batchId: 'scan-Z04-002', frameCount: 420 }, 'msg-c')] }) })).json();
    assert.deepEqual(first.accepted, ['msg-a', 'msg-b', 'msg-c'], 'accepted 必须是 messageId 数组，心跳同样要拿到确认');
    assert.deepEqual(first.duplicated, []);
    const replay = await (await asDevice('/api/device-events/batch', { method: 'POST', body: JSON.stringify({ events: [envelope('capture.started', { batchId: 'scan-Z04-002' }, 'msg-a')] }) })).json();
    assert.deepEqual(replay.duplicated, ['msg-a'], '重复的 messageId 要进 duplicated，终端据此停止重传');
    const bad = await (await asDevice('/api/device-events/batch', { method: 'POST', body: JSON.stringify({ events: [{ deviceId: DEVICE_ID, type: 'capture.x' }] }) })).json();
    assert.equal(bad.rejected.length, 1, '每个 messageId 必须落到 accepted / duplicated / rejected 之一');
    assert.equal(bad.rejected[0].retryable, false);

    const events = await (await asBrowser(`/api/devices/${DEVICE_ID}/events`)).json();
    assert.equal(events.events[0].messageId, 'msg-c', '关键事件按时间倒序，页面看到的最近一条在最前');
    assert.ok(
      !events.events.some((event) => event.type === 'device.health'),
      '心跳（5 秒一条）不入事件表：它会把采集与回执这些要留痕的事件冲掉',
    );

    /* ---- 4. 命令三态（accepted ≠ executed） ---- */
    const noPermission = await (await (async () => {
      const ma = await login('ma');
      return fetch(`${base}/api/devices/${DEVICE_ID}/commands`, { method: 'POST', headers: { authorization: `Bearer ${ma}`, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'query_status' }) });
    })()).json();
    assert.equal(noPermission.code, 'FORBIDDEN', '没有设备指令权限的账号要被拦住');

    const issued = await (await asBrowser(`/api/devices/${DEVICE_ID}/commands`, { method: 'POST', body: JSON.stringify({ type: 'query_status', args: { reason: '联调' } }) })).json();
    const commandId = issued.command.commandId;
    assert.equal(issued.command.state, 'queued', '设备不在线时命令排队，不发出去就算执行了');
    assert.match(issued.hint, /排队|下发/);

    await asDevice('/api/device-events/batch', { method: 'POST', body: JSON.stringify({ events: [envelope('command.accepted', { commandId, state: 'accepted', reason: '命令已接收，正在执行' }, 'msg-c')] }) });
    let commands = await (await asBrowser(`/api/devices/${DEVICE_ID}/hardware`)).json();
    assert.equal(commands.recentCommands[0].state, 'accepted');
    await asDevice('/api/device-events/batch', { method: 'POST', body: JSON.stringify({ events: [envelope('command.executed', { commandId, state: 'executed', result: { task: 'running' } }, 'msg-d')] }) });
    commands = await (await asBrowser(`/api/devices/${DEVICE_ID}/hardware`)).json();
    assert.equal(commands.recentCommands[0].state, 'executed');
    assert.deepEqual(commands.recentCommands[0].result, { task: 'running' });

    /* ---- 5. 预览图（二进制直传，回显要一模一样） ---- */
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
    const previewPost = await asDevice(`/api/devices/${DEVICE_ID}/preview`, { method: 'POST', headers: { 'content-type': 'image/jpeg', 'x-frame-index': '128' }, body: jpeg });
    assert.equal(previewPost.status, 200);
    const previewGet = await asBrowser(`/api/devices/${DEVICE_ID}/preview/latest`);
    assert.equal(previewGet.headers.get('content-type'), 'image/jpeg');
    assert.equal(previewGet.headers.get('x-frame-index'), '128');
    assert.deepEqual(Buffer.from(await previewGet.arrayBuffer()), jpeg);
    const missing = await asBrowser('/api/devices/unknown-dev/preview/latest');
    assert.equal(missing.status, 404, '没推过预览帧要回 404，页面显示「等待推流」而不是裂图');

    /* ---- 6. 现场调参回写 ---- */
    await asDevice('/api/configs/CFG-02-L3/ack', { method: 'POST', body: JSON.stringify({ deviceId: DEVICE_ID, configVersion: 'CFG-02-L3', state: 'local-tuned', appliedAt: new Date().toISOString(), diff: [['环境温度', '26.0 ℃', '31.5 ℃']] }) });
    const withAck = await (await asBrowser(`/api/devices/${DEVICE_ID}/hardware`)).json();
    assert.equal(withAck.configAck.state, 'local-tuned');
    assert.deepEqual(withAck.configAck.diff[0], ['环境温度', '26.0 ℃', '31.5 ℃']);

    /* ---- 7. 断流判定：6 秒 stale、15 秒 offline（模拟拔电） ---- */
    const staleAt = new Date(Date.now() - 8000).toISOString();
    service.db.prepare('UPDATE device_registry SET last_seen_at = ? WHERE device_id = ?').run(staleAt, DEVICE_ID);
    const stale = await (await asBrowser(`/api/devices/${DEVICE_ID}/hardware`)).json();
    assert.equal(stale.link.state, 'stale');
    assert.equal(stale.stale, true, '8 秒没上报要标 stale');
    const offlineAt = new Date(Date.now() - 20000).toISOString();
    service.db.prepare('UPDATE device_registry SET last_seen_at = ? WHERE device_id = ?').run(offlineAt, DEVICE_ID);
    const offline = await (await asBrowser(`/api/devices/${DEVICE_ID}/hardware`)).json();
    assert.equal(offline.link.state, 'offline');
    assert.ok(offline.report, '设备掉线时最后一份数据仍在，页面标注「离线」而不是清空');

    const ledger = await (await asBrowser('/api/devices')).json();
    assert.equal(ledger.devices.length, 1);
    assert.equal(ledger.devices[0].hardware.hostname, 'SANWU');
  } finally {
    await service.close();
  }
});

test('设备网关：WebSocket 通道要令牌，连上后能收到下发命令', async () => {
  const { startService } = await import('../server/index.mjs');
  const { WebSocket } = await import('ws');
  const service = await startService({ port: 0, host: '127.0.0.1', dbFile: ':memory:', quiet: true });
  const wsBase = service.url.replace('http', 'ws');
  let socket;
  try {
    await fetch(`${service.url}/api/devices/register`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-device-token': TOKEN }, body: JSON.stringify({ schemaVersion: '1.0', deviceId: DEVICE_ID, bootId: 'boot-ws' }) });

    // 令牌不对：升级被拒，终端会按退避重连（文档 §3.10）
    const rejected = new WebSocket(`${wsBase}/ws/devices/${DEVICE_ID}?deviceToken=nope`);
    const rejectedClosed = await new Promise((resolve) => {
      rejected.on('unexpected-response', (_req, res) => resolve(res.statusCode));
      rejected.on('error', () => resolve('error'));
      rejected.on('open', () => resolve('open'));
    });
    assert.notEqual(rejectedClosed, 'open', '错误令牌不能连上设备通道');
    rejected.terminate?.();

    const browser = await (await fetch(`${service.url}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ account: 'rao', password: '123456' }) })).json();
    socket = new WebSocket(`${wsBase}/ws/devices/${DEVICE_ID}?deviceToken=${TOKEN}&bootId=boot-ws`);
    const inbox = [];
    socket.on('message', (raw) => inbox.push(JSON.parse(raw)));
    await new Promise((resolve, reject) => {
      socket.on('open', resolve);
      socket.on('error', reject);
    });
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(inbox[0].kind, 'hello', '连上先收到平台握手（终端凭「收到过平台消息」判在线）');
    assert.ok(inbox[0].platformTime);

    const issued = await (await fetch(`${service.url}/api/devices/${DEVICE_ID}/commands`, { method: 'POST', headers: { authorization: `Bearer ${browser.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'pause_capture', args: { reason: '联调' } }) })).json();
    assert.equal(issued.pushed, true);
    await new Promise((r) => setTimeout(r, 200));
    const command = inbox.find((m) => m.type === 'command');
    assert.ok(command, '在线设备要能直接从设备通道收到命令');
    assert.equal(command.payload.type, 'pause_capture');
    assert.equal(command.payload.commandId, issued.command.commandId);
    assert.ok(command.sentAt && command.seq, '命令信封缺字段终端会整条丢掉');

    // 浏览器通道 `/ws` 与设备通道共用端口，互不影响
    const browserSocket = new WebSocket(`${wsBase}/ws?sessionId=${service.sessionId}`);
    const hello = await new Promise((resolve, reject) => {
      // 浏览器通道先补发缺口事件再发 hello（hub 的老行为，这里只在等 hello）
      browserSocket.on('message', (raw) => {
        const message = JSON.parse(raw);
        if (message.kind === 'hello') resolve(message);
      });
      browserSocket.on('error', reject);
      setTimeout(() => reject(new Error('浏览器通道没有收到 hello')), 2000);
    });
    assert.equal(hello.kind, 'hello');
    browserSocket.terminate();
  } finally {
    socket?.terminate();
    await new Promise((r) => setTimeout(r, 50));
    await service.close();
  }
});
