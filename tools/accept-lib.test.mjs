/**
 * `accept-lib` 的判据测试（TDD：先锁行为，再改 accept.mjs）
 *
 * 这一组防的是**假红**与**假绿**两件相反的事：
 *   · 假红：把"本机未接入小车链路"的 503 当成缺陷，`/mapping` 长期报 ✗；
 *   · 假绿：为了让验收变绿，把所有 503 一律过滤掉 —— 那真正的服务故障就没人看见了。
 * 所以每条用例都要能证伪。
 *
 * 跑法：node --test tools/accept-lib.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyLogLines, isUnavailableResource, resourceUrlOf } from "./accept-lib.mjs";

test("认出属于未接入外设的资源路径", () => {
  assert.equal(isUnavailableResource("http://127.0.0.1:5173/api/cart/stream/camera"), true);
  assert.equal(isUnavailableResource("http://127.0.0.1:8000/api/sensors/latest"), true);
  assert.equal(isUnavailableResource("http://127.0.0.1:8000/api/capture/screen/stream"), true);
  /* 业务接口不算"未接入" —— 它们坏了就是真坏了 */
  assert.equal(isUnavailableResource("http://127.0.0.1:8000/api/work-orders"), false);
  assert.equal(isUnavailableResource("http://127.0.0.1:8000/api/files/abc/download"), false);
  assert.equal(isUnavailableResource("not a url"), false);
});

test("从日志行里取资源 URL", () => {
  const line = "[log] Failed to load resource: the server responded with a status of 503 (Service Unavailable) @ http://127.0.0.1:5173/api/cart/stream/camera";
  assert.equal(resourceUrlOf(line), "http://127.0.0.1:5173/api/cart/stream/camera");
  assert.equal(resourceUrlOf("普通一行没有链接"), null);
});

test("未接入外设 + 接口自证未配置 → 归入「可预期」而不是失败", async () => {
  const line = "[log] Failed to load resource: the server responded with a status of 503 (Service Unavailable) @ http://127.0.0.1:5173/api/cart/stream/camera";
  const { failures, expected } = await classifyLogLines([line], {
    probe: async () => ({ status: 503, body: { code: "CART_UNCONFIGURED", message: "没有配置小车地址" } }),
  });
  assert.deepEqual(failures, [], "有未配置证据时不应计为失败");
  assert.equal(expected.length, 1);
  assert.equal(expected[0].evidence, "CART_UNCONFIGURED");
});

test("**拿不到未配置证据**时照旧算失败（防假绿）", async () => {
  const line = "[log] Failed to load resource: the server responded with a status of 503 (Service Unavailable) @ http://127.0.0.1:5173/api/cart/stream/camera";
  /* 服务真的挂了：接口回的是 500，不是"未配置" */
  const down = await classifyLogLines([line], { probe: async () => ({ status: 500, body: { code: "INTERNAL" } }) });
  assert.equal(down.failures.length, 1, "服务故障不能因为路径像外设就被放过");
  assert.deepEqual(down.expected, []);

  /* 连探针都没有（默认 null）→ 不能凭空放行 */
  const noProbe = await classifyLogLines([line], {});
  assert.equal(noProbe.failures.length, 1, "没有取证就不能放行");
});

test("业务接口的错误一律算失败", async () => {
  const line = "[log] Failed to load resource: the server responded with a status of 500 @ http://127.0.0.1:5173/api/work-orders";
  const { failures, expected } = await classifyLogLines([line], {
    probe: async () => ({ status: 500, body: { configured: false } }),
  });
  assert.equal(failures.length, 1, "业务接口即使自称 configured=false 也不算外设未接入");
  assert.deepEqual(expected, []);
});

test("未捕获异常一律算失败（它从来不是「未接入」）", async () => {
  const line = "[exception] TypeError: Cannot read properties of undefined (reading 'x')";
  const { failures } = await classifyLogLines([line], { probe: async () => ({ status: 503, body: { code: "CART_UNCONFIGURED" } }) });
  assert.equal(failures.length, 1);
});

test("已知噪声被丢弃（框架弃用告警）", async () => {
  const { failures, expected } = await classifyLogLines([
    "[console.error] THREE.Clock: .getDelta() is deprecated",
  ], {});
  assert.deepEqual(failures, []);
  assert.deepEqual(expected, []);
});

test("同一个未接入资源只取证一次（六条重复错误不会打六次接口）", async () => {
  let calls = 0;
  const line = "[log] Failed to load resource: 503 @ http://127.0.0.1:5173/api/cart/stream/camera";
  const { expected } = await classifyLogLines([line, line, line, line, line, line], {
    probe: async () => { calls += 1; return { status: 503, body: { code: "CART_UNCONFIGURED" } }; },
  });
  assert.equal(expected.length, 6, "六条都要被归类（报告里看得见）");
  assert.equal(calls, 1, "但只查一次接口");
});

test("资源本身回纯文本 503 时，用所属链路的状态端点取证", async () => {
  /*
    实测 crate：`/api/cart/stream/camera` 回的是纯文本 `未配置小车地址`（没有 JSON 体），
    直接探它取不到任何证据；而 `/api/cart/status` 明确回 `configured:false`。
    第一版只做直接探针，于是六条 503 全部仍被算成失败 —— 验收照旧红。
  */
  const line = "[log] Failed to load resource: the server responded with a status of 503 (Service Unavailable) @ http://127.0.0.1:5173/api/cart/stream/camera";
  const { failures, expected } = await classifyLogLines([line], {
    probe: async () => ({ status: 503, body: null }),
    probeState: async () => ({ configured: false, link: "unconfigured" }),
  });
  assert.deepEqual(failures, [], "状态端点自证未配置时应归入可预期");
  assert.equal(expected.length, 1);
  assert.match(expected[0].evidence, /configured=false/);
});

test("状态端点说已配置 → 该资源报错必须算失败（防假绿）", async () => {
  const line = "[log] Failed to load resource: the server responded with a status of 503 @ http://127.0.0.1:5173/api/cart/stream/camera";
  const { failures, expected } = await classifyLogLines([line], {
    probe: async () => ({ status: 503, body: null }),
    probeState: async () => ({ configured: true, link: "live" }),
  });
  assert.equal(failures.length, 1, "链路已配置还报 503 —— 那是真故障");
  assert.deepEqual(expected, []);
});
