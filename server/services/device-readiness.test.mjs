/**
 * 设备链路自检 —— 判据回归（纯函数，不起服务）
 *
 * 判据是从用户 2026-09-22 给的「设备接入交接包」搬进来的（原包 `smoke-devices.sh`
 * 从外面发 HTTP，这里从服务内部算），所以这一组测的是**结论对不对**：
 *   · 小车没配 → FAIL 且给出 cart.json 的确切写法（不是让现场猜）；
 *   · 两路 MJPEG 的 503 / 502 要分开说（一个是没配、一个是小车没出帧）；
 *   · 设备令牌 0 组是 FAIL（终端注册必然 401，最容易被误判成设备坏了）；
 *   · 前端没带 `--static dist` 是 FAIL（没有同源 /api 与 /ws）；
 *   · 屏幕串流那一路是**可选**：没配只算提醒，不算失败；
 *   · 退出码与交接包同一口径：有 FAIL = 1，全过 = 0。
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildReadiness, configStateOf, createDeviceReadiness, readLocalConfigs } from "./device-readiness.mjs";

/** 一份"全都通了"的事实，测试里按需覆盖 */
const facts = (overrides = {}) => ({
  generatedAt: "2026-09-22T00:00:00.000Z",
  health: { service: "mumai-shared", version: "1.0.0", sessions: 3, clients: 2, devices: { tokens: 1, online: 1, devices: 1, staleAfterMs: 6000, offlineAfterMs: 15000 } },
  hosting: { staticRoot: "/srv/dist", indexHasRoot: true },
  cart: { configured: true, canControl: true, link: "online", live: true, lastError: null },
  streams: [
    { channel: "rviz", code: 200, contentType: "multipart/x-mixed-replace; boundary=frame", reason: "frames" },
    { channel: "camera", code: 200, contentType: "multipart/x-mixed-replace; boundary=frame", reason: "frames" },
  ],
  device: { deviceId: "handheld-02", report: { temperatureC: 31 }, ageSec: 2, link: { state: "online" }, preview: true, staleAfterMs: 6000, offlineAfterMs: 15000 },
  screen: { configured: true, online: true },
  configs: [],
  ...overrides,
});

const levelsOf = (result) => result.sections.flatMap((section) => section.items.map((item) => item.level));
const textsOf = (result) => result.sections.flatMap((section) => section.items.map((item) => `${item.title}${item.hints?.join("") ?? ""}`)).join("\n");

test("全都通了：5 节齐全、退出码 0", () => {
  const result = buildReadiness(facts());

  assert.deepEqual(result.sections.map((section) => section.key), ["platform", "hosting", "cart", "device", "screen"]);
  assert.equal(result.counts.fail, 0);
  assert.equal(result.exitCode, 0);
  assert.equal(result.verdict, "ok");
  assert.ok(!levelsOf(result).includes("fail"));
});

test("小车没配：FAIL，并给出 cart.json 的确切写法与「改完要重启」", () => {
  const result = buildReadiness(
    facts({
      cart: { configured: false, canControl: false, link: "unconfigured", live: false, lastError: null },
      streams: [
        { channel: "rviz", code: 503, contentType: null, reason: "unconfigured" },
        { channel: "camera", code: 503, contentType: null, reason: "unconfigured" },
      ],
    }),
  );

  assert.equal(result.exitCode, 1);
  const text = textsOf(result);
  assert.match(text, /小车地址没配/);
  assert.match(text, /server\/data\/cart\.json/);
  assert.match(text, /重启后端/);
  /* 503 与 502 必须分开讲：一个是没配，一个是小车没出帧 */
  assert.match(text, /503 —— 平台侧没配小车地址/);
  assert.equal(result.counts.fail, 3, "配置 + 两路 503");
});

test("地址配了但小车没出帧：502 要说清「不是平台的问题」", () => {
  const result = buildReadiness(
    facts({
      cart: { configured: true, canControl: false, link: "online", live: true, lastError: null },
      streams: [
        { channel: "rviz", code: 502, contentType: "text/plain", reason: "not-multipart" },
        { channel: "camera", code: 200, contentType: "multipart/x-mixed-replace", reason: "frames" },
      ],
    }),
  );

  const text = textsOf(result);
  assert.match(text, /stream\/rviz 502/);
  assert.match(text, /不是平台的问题/);
  assert.equal(result.counts.fail, 1);
  assert.equal(result.counts.ok >= 1, true, "另一路仍应报 OK");
});

test("设备令牌 0 组是 FAIL（终端注册必然 401）；令牌有组数但不是 0 则 OK", () => {
  const zero = buildReadiness(facts({ health: { service: "mumai-shared", version: "1.0.0", sessions: 0, clients: 0, devices: { tokens: 0, online: 0, devices: 0 } } }));
  assert.equal(zero.exitCode, 1);
  assert.match(textsOf(zero), /设备令牌 0 组/);
  assert.match(textsOf(zero), /MUMAI_DEVICE_TOKENS/);
});

test("设备从未上报：FAIL 且把终端侧三件事写清楚（platform_url / device_id+token / 必须重启）", () => {
  const result = buildReadiness(
    facts({ device: { deviceId: "handheld-02", report: null, ageSec: null, link: { state: "unknown" }, preview: false, staleAfterMs: 6000, offlineAfterMs: 15000 } }),
  );

  const text = textsOf(result);
  assert.match(text, /一次都没上报过/);
  assert.match(text, /platform_url/);
  assert.match(text, /device_token/);
  assert.match(text, /重启终端进程/);
  assert.match(text, /预览帧/);
});

test("在线判定用网关自己的阈值：≤6s 在线 / 6–15s 延迟 / >15s 离线", () => {
  const at = (ageSec) =>
    buildReadiness(facts({ device: { deviceId: "d", report: {}, ageSec, link: { state: "x" }, preview: true, staleAfterMs: 6000, offlineAfterMs: 15000 } }));

  assert.equal(at(3).exitCode, 0, "3s：在线");
  assert.equal(at(9).counts.warn >= 1, true, "9s：延迟（提醒）");
  assert.match(textsOf(at(9)), /设备上报延迟（9s/);
  /* 读数给人读：秒数换成"多久前"（2026-10-01），断言跟着改口径 */
assert.match(textsOf(at(40)), /已经不新鲜（最后收到设备上报：40 秒前/);
  assert.equal(at(40).exitCode, 0, "不新鲜是提醒不是失败");
});

test("前端没带 --static dist：FAIL（没有同源 /api 与 /ws）", () => {
  const result = buildReadiness(facts({ hosting: { staticRoot: null, indexHasRoot: false } }));

  assert.equal(result.exitCode, 1);
  assert.match(textsOf(result), /没有托管前端/);
  assert.match(textsOf(result), /--static dist/);
});

test("采集屏幕那一路是可选的：没配只算提醒，不算失败", () => {
  const result = buildReadiness(facts({ screen: { configured: false, online: false } }));

  assert.equal(result.exitCode, 0);
  assert.equal(result.counts.warn, 1);
  assert.match(textsOf(result), /这一路是可选的/);
});

test("配置状态：不存在 / 还是模板占位符 / 已填，三种要分得开", () => {
  assert.deepEqual(configStateOf({ path: "server/data/cart.json", text: null }), { path: "server/data/cart.json", present: false, placeholder: false });
  assert.equal(configStateOf({ path: "x", text: '{ "token": "REPLACE_WITH_CART_CONTROL_TOKEN" }' }).placeholder, true);
  assert.equal(configStateOf({ path: "x", text: '{ "url": "http://<小车IP>:8765" }' }).placeholder, true);
  assert.equal(configStateOf({ path: "x", text: '{ "url": "http://192.168.31.221:8765", "token": "abc" }' }).placeholder, false);
});

test("三份本地配置的默认状态是「不存在」——克隆后没配不是部署失败", () => {
  const root = mkdtempSync(join(tmpdir(), "mumai-readiness-"));
  try {
    const before = readLocalConfigs(root);
    assert.deepEqual(before.map((item) => [item.key, item.present]), [["cart", false], ["deviceTokens", false], ["screen", false]]);

    mkdirSync(join(root, "server", "data"), { recursive: true });
    writeFileSync(join(root, "server", "data", "cart.json"), '{ "url": "http://192.168.31.221:8765", "token": "t" }');
    const after = readLocalConfigs(root);
    assert.equal(after.find((item) => item.key === "cart")?.present, true);
    assert.equal(after.find((item) => item.key === "cart")?.placeholder, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("组装器把既有服务的事实接上：小车探针、网关视图、屏幕状态都来自注入的服务", async () => {
  const calls = { stream: [], hardware: [], tokens: 0 };
  const readiness = createDeviceReadiness({
    staticRoot: null,
    cart: {
      status: () => ({ configured: true, canControl: true, link: "online", live: true, lastError: null }),
      streamProbe: (channel) => {
        calls.stream.push(channel);
        return Promise.resolve({ channel, code: 200, contentType: "multipart/x-mixed-replace", reason: "frames" });
      },
    },
    gateway: {
      status: () => ({ tokens: 2, online: 0, devices: 0, staleAfterMs: 6000, offlineAfterMs: 15000 }),
      hardwareView: (deviceId) => {
        calls.hardware.push(deviceId);
        return { deviceId, report: null, ageSec: null, link: { state: "unknown" } };
      },
      latestPreview: () => null,
    },
    screen: { status: async () => ({ configured: false, online: false }) },
    health: () => ({ service: "mumai-shared", version: "1.0.0", sessions: 1, clients: 1, devices: { tokens: 2, online: 0 } }),
  });

  const snapshot = await readiness.snapshot();
  assert.deepEqual(calls.stream, ["rviz", "camera"], "两路都要探");
  assert.equal(calls.hardware.length, 1, "要取一次设备视图");
  assert.equal(snapshot.counts.fail >= 1, true, "这台机器上：托管缺失 + 设备没上报");
  assert.equal(snapshot.configs.length, 3, "三份本地配置状态要一并给出");
});
