/**
 * 剧本 S18「更新包已下发，请接收」· 端到端验收（真浏览器 + 真设备通道 + 真回执）
 *
 * ── 这条工装回答的问题（用户 2026-09-28 口径：剧本里标「待测试」的那四处）──
 * 剧本原文：「我们自主开发的部署流程会把模型、预处理配置和版本信息统一封装，
 * 生成设备更新包下发给设备。全栈开发工程师，更新包已下发，请接收。」
 *
 * 而平台侧当时**没有这一步**：设备网关的命令白名单里有 `prepare_update`
 * （`server/services/device-gateway.mjs:700`），但全仓没有一处调用它
 * （一致性审查清单 B-21 / 盘点文档 §C3 / PRD-第二章改造 PR-03 三条都记着）。
 * 现象就是：台词说「已下发」，页面上没有按钮、设备上一辈子收不到。
 *
 * 现在补上了，这条工装要证明的是**它真的能走完**，而不是"按钮在页面上"：
 *   ① `#/firmware?tab=delivery` 的已发布产物行上有「下发到设备」按钮（PRD C1）；
 *   ② 点开是**真的设备名录**（来自 `/api/devices`），不是写死的选项；
 *   ③ 确认下发 → 设备通道收到 `prepare_update`，载荷四个字段齐
 *      （产物编号 / 版本 / 下载地址 / 摘要 —— PRD PR-03 点名的那四个；PRD C2）；
 *   ④ `accepted ≠ executed`：只下发时**不许**显示"已执行"（PRD C3 前一半）；
 *   ⑤ 设备回 accepted → 页面写「设备已接收」；回 executed → 「设备已执行」，
 *      且版本行给出「设备当前版本 → 目标版本」；
 *   ⑥ 服务端实体里能查到这条命令的落点（谁发的、什么时间、什么状态）。
 *
 * ── 设备侧怎么演 ────────────────────────────────────────────────────
 * 真机（树莓派 woodpulse）现在没连平台（`link.state=offline`，最后一次上报是几小时前），
 * 而它**注册只在开机时做一次**，远端重启不是本工装能做的事。所以设备那一侧由本脚本
 * 用**真令牌**开一条真的设备通道（`ws://…/ws/devices/handheld-02?deviceToken=…`），
 * 按终端文档的报文格式回 accepted / executed。
 *
 * ⚠ 这样跑会**短暂顶掉真机的命令通道**（网关策略：同一设备只保留最新一条连接）。
 *   真机没在跑的时候无所谓；真机在跑时先别跑这条工装。
 *
 * 用法（仓库根目录）：
 *   node tools/验收-更新包下发.mjs [--url http://127.0.0.1:8000] [--device handheld-02] [--token demo-token]
 */

import { Machine, sleep } from "./browser-harness.mjs";

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const BASE = argOf("url", process.env.MUMAI_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");
const DEVICE_ID = argOf("device", "handheld-02");
const DEVICE_TOKEN = argOf("token", "demo-token");

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? `　（${detail}）` : ""}`);
  if (!ok) failed += 1;
};

const wsUrl = `${BASE.replace(/^http/, "ws")}/ws/devices/${encodeURIComponent(DEVICE_ID)}?deviceToken=${encodeURIComponent(DEVICE_TOKEN)}&bootId=e2e-update-${Date.now().toString(36)}`;

/** 页面上读「下发到设备」弹窗里能看到的东西 */
const DIALOG_PROBE = `(() => {
  const dialog = [...document.querySelectorAll('.modal')].find((node) => (node.querySelector('.modal__head h3')?.textContent || '').trim().startsWith('下发到设备'));
  if (!dialog) return { found: false };
  const devices = [...dialog.querySelectorAll('.dispatch__devices button')].map((node) => ({
    id: (node.querySelector('b')?.textContent || '').trim(),
    text: (node.textContent || '').trim(),
    active: node.classList.contains('is-active'),
  }));
  const receipt = [...dialog.querySelectorAll('.dispatch__receipt li')].map((node) => (node.textContent || '').trim());
  return {
    found: true,
    deviceCount: devices.length,
    first: devices[0] ?? null,
    dialogText: (dialog.textContent || '').trim(),
    receipt,
    receiptState: (dialog.querySelector('.dispatch__receipt .chip, .dispatch__receipt .status-chip')?.textContent || '').trim(),
    cmd: (dialog.querySelector('[data-cmd]')?.getAttribute('data-cmd') || '').trim(),
  };
})()`;

/** 已发布产物行：找「下发到设备」按钮 */
const OPEN_DISPATCH = `(() => {
  const rows = [...document.querySelectorAll('.art-row')];
  for (const row of rows) {
    const button = [...row.querySelectorAll('button')].find((node) => (node.textContent || '').trim() === '下发到设备');
    if (button) {
      const name = (row.querySelector('.art-row__name b')?.textContent || '').trim();
      const disabled = button.disabled;
      const title = button.getAttribute('title') || '';
      button.click();
      return { clicked: true, name, disabled, title };
    }
  }
  return { clicked: false };
})()`;

const browser = new Machine({ name: "upd", port: 9537, base: BASE, account: "shi" });
/** 设备通道：本脚本扮演终端 */
let deviceSocket = null;
const deviceInbox = [];
let deviceMessageSeq = 0;

/** 设备 → 平台：只走公开接口，与终端文档 §3.5 的批量事件接口一致 */
async function deviceEvent(type, payload) {
  deviceMessageSeq += 1;
  const body = {
    events: [
      {
        schemaVersion: "1.0",
        type,
        deviceId: DEVICE_ID,
        bootId: `e2e-update-${DEVICE_ID}`,
        messageId: `e2e-${type}-${Date.now().toString(36)}-${deviceMessageSeq}`,
        seq: deviceMessageSeq,
        sentAt: new Date().toISOString(),
        payload,
      },
    ],
  };
  const response = await fetch(`${BASE}/api/device-events/batch`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-device-token": DEVICE_TOKEN },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

/** 等服务端台账里的某条命令进入某个状态（读的是平台自己的落库结果） */
async function waitCommand(commandId, states, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const result = await browser.call("GET", `/api/devices/${encodeURIComponent(DEVICE_ID)}/hardware`);
    const command = (result?.json?.recentCommands ?? []).find((item) => item.commandId === commandId);
    if (command) {
      last = command;
      if (states.includes(command.state)) return command;
    }
    await sleep(600);
  }
  return last;
}

try {
  console.log(`更新包下发验收 · ${BASE} · 设备 ${DEVICE_ID}`);

  /* ---------- 0 设备侧上线：开一条真的设备通道 ---------- */
  const { WebSocket } = await import("ws");
  deviceSocket = new WebSocket(wsUrl);
  const hello = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("设备通道 10 秒内没有 hello")), 10000);
    deviceSocket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      deviceInbox.push(message);
      if (message.type === "device.welcome") {
        clearTimeout(timer);
        resolve(message);
      }
    });
    deviceSocket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  check("设备通道握手成功（真令牌、真网关）", hello.deviceId === DEVICE_ID, `platformTime=${hello.platformTime}`);

  /* ---------- 1 浏览器：已发布产物行上的入口 ---------- */
  await browser.start();
  if (!(await browser.login())) throw new Error(`登录失败（shi）—— 页面在 ${BASE} 上吗？`);
  /*
    ⚠ 先关掉「跟随演示机」再验。
    内网多主机同步（`agent/roundSync.ts`）里，最后 30 秒内别的机器广播过一轮
    `xiaomu.round`，**新打开的页面会跟着那一轮走**（跟着跳页面、跟着开浮层）。
    实测踩到：验收跑到一半，页面被另一轮带着跳去 `#/workbench`，
    「下发到设备」弹窗连同它的 state 一起被卸载 —— 现象看着像"点了没反应"。
    这里只关本浏览器 profile 的开关，跑完按原值还原。
  */
  const followBefore = await browser.evaluate(`(localStorage.getItem('mumai.follow.presenter') || '(未设置=开)')`);
  await browser.evaluate(`localStorage.setItem('mumai.follow.presenter', 'off'); 1`);
  if (followBefore !== "(未设置=开)") console.log(`  提示：本 profile 的跟随开关原值 ${followBefore}，已临时关掉`);
  await browser.evaluate(`location.hash = '#/firmware?tab=delivery'`);
  /*
    等产物行真的渲染出来再点。
    ⚠ 原来这里写的是 `sleep(2500)`：产物清单要等共享服务把快照取回来才有行，
    取回来慢一点（内网地址、刚重启）就会点了个空 —— 实测跑出过
    「行数 0 / 没找到按钮」，看着像功能没做，其实是页面还没画。
  */
  const rowsReady = await browser.waitFor(
    `document.querySelectorAll('.art-row').length > 0 ? document.querySelectorAll('.art-row').length : null`,
    { timeoutMs: 20000 },
  );
  if (!rowsReady) throw new Error("20 秒内没等到已发布产物行（共享服务连上了吗？）");

  const opened = await browser.evaluate(OPEN_DISPATCH);
  check("已发布产物行有「下发到设备」按钮（PRD C1）", opened?.clicked === true, opened?.name ?? "没找到按钮");
  await sleep(600);

  const dialog = await browser.evaluate(DIALOG_PROBE);
  check("点开是「下发到设备」弹窗（不是替换整页）", dialog?.found === true);

  /*
    ⚠ 等设备真的出现在弹窗里再往下。
    设备「在线」是**平台侧按最近一次上报距今多久算的**（6 秒内算在线，见
    `device-gateway.mjs:linkOf`）。W S 握手完成 ≠ 台账已经算它在线：验收第一版
    正好卡在这个缝里 —— 设备通道握上手了，弹窗那头读到的还是「没有在线的设备」，
    看着像「平台认不出设备」。
  */
  const deviceReady = await browser.waitFor(
    `(() => {
      const dialog = [...document.querySelectorAll('.modal')].find((node) => (node.querySelector('.modal__head h3')?.textContent || '').trim().startsWith('下发到设备'));
      if (!dialog) return null;
      const button = [...dialog.querySelectorAll('.dispatch__devices button')].find((node) => (node.querySelector('b')?.textContent || '').trim() === ${JSON.stringify(DEVICE_ID)});
      return button ? (button.textContent || '').trim() : null;
    })()`,
    { timeoutMs: 25000, intervalMs: 500 },
  );
  check("弹窗里的设备名录来自服务端，且列出了刚上线的设备（PRD C2 前置）", Boolean(deviceReady), deviceReady ?? "25 秒内没等到设备出现在名录里");
  check(
    "设备行写明命令通道状态（能不能立刻收到）",
    /命令通道(已连接|未连接)/.test(deviceReady ?? ""),
    deviceReady ?? "—",
  );

  /* ---------- 2 下发：设备通道要收到 prepare_update，载荷四字段齐 ---------- */
  /*
    先选设备。弹窗不会替人默认选中一台 —— 这一步正是剧本里"选中目标设备"那个动作，
    现场是点的，工装也照点，不替页面改 state。
  */
  const picked = await browser.evaluate(`(() => {
    const dialog = [...document.querySelectorAll('.modal')].find((node) => (node.querySelector('.modal__head h3')?.textContent || '').trim().startsWith('下发到设备'));
    if (!dialog) return { ok: false, why: '弹窗没了' };
    const button = [...dialog.querySelectorAll('.dispatch__devices button')].find((node) => (node.querySelector('b')?.textContent || '').trim() === ${JSON.stringify(DEVICE_ID)});
    if (!button) return { ok: false, why: '名录里没有这台设备' };
    button.click();
    return { ok: true };
  })()`);
  check("能在名录里选中目标设备", picked?.ok === true, picked?.why ?? "");
  await sleep(800);

  const sent = await browser.evaluate(`(() => {
    const dialog = [...document.querySelectorAll('.modal')].find((node) => (node.querySelector('.modal__head h3')?.textContent || '').trim().startsWith('下发到设备'));
    if (!dialog) return { ok: false, why: '弹窗没了' };
    const button = [...dialog.querySelectorAll('button')].find((node) => (node.textContent || '').trim() === '确认下发');
    if (!button) return { ok: false, why: '没有「确认下发」按钮' };
    if (button.disabled) return { ok: false, why: '按钮是灰的 · ' + (dialog.querySelector('footer')?.textContent || '').trim() };
    button.click();
    return { ok: true };
  })()`);
  check("「确认下发」可点（权限与在线设备都满足）", sent?.ok === true, sent?.why ?? "");

  const command = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("设备通道 12 秒内没收到命令")), 12000);
    const scan = () => {
      const hit = deviceInbox.find((item) => item.type === "command" && item.payload?.action === "prepare_update");
      if (hit) {
        clearTimeout(timer);
        resolve(hit);
      }
    };
    scan();
    deviceSocket.on("message", (raw) => {
      deviceInbox.push(JSON.parse(raw.toString()));
      scan();
    });
  }).catch((error) => ({ error: error.message }));

  const envelopeOk = !command?.error && command.deviceId === DEVICE_ID && Boolean(command.payload?.commandId);
  check("设备通道收到 prepare_update（不是只写了个界面提示）", envelopeOk, command?.error ?? `messageId=${command?.messageId ?? "—"}`);
  const load = command?.payload?.args ?? {};
  check(
    "载荷四个字段齐：产物编号 / 版本 / 下载地址 / 摘要（PRD C2）",
    Boolean(load.artifactId && load.version && load.downloadUrl && load.sha256),
    `artifactId=${load.artifactId ?? "—"} version=${load.version ?? "—"} url=${String(load.downloadUrl ?? "—").slice(0, 48)} sha256=${String(load.sha256 ?? "—").slice(0, 12)}…`,
  );
  check(
    "下载地址是**绝对地址**（设备在另一台机器上，相对路径它取不到）",
    /^https?:\/\//.test(String(load.downloadUrl ?? "")),
    String(load.downloadUrl ?? "—"),
  );

  /* ---------- 3 accepted ≠ executed ---------- */
  const commandId = command?.payload?.commandId ?? "";
  const justSent = await waitCommand(commandId, ["sent", "queued"], 6000);
  check("下发后先落到「已下发 / 排队中」，不替设备宣布执行完成", ["sent", "queued"].includes(justSent?.state), `state=${justSent?.state ?? "—"}`);

  await sleep(2600); // 等页面自己轮询一轮（2 秒一次）
  const beforeReceipt = await browser.evaluate(DIALOG_PROBE);
  check(
    "页面此刻不显示「设备已执行」（accepted ≠ executed）",
    !/设备已执行/.test(beforeReceipt?.receiptState ?? ""),
    `页面状态=${beforeReceipt?.receiptState || "（还没有回执行）"}`,
  );

  /* ---------- 4 设备回执：accepted → executed ---------- */
  const acceptedResponse = await deviceEvent("command.accepted", {
    commandId,
    state: "accepted",
    reason: "更新包已接收，正在校验",
  });
  check("设备回 accepted 被平台收下（HTTP 200）", acceptedResponse.status === 200, JSON.stringify(acceptedResponse.body?.accepted ?? acceptedResponse.body));
  const accepted = await waitCommand(commandId, ["accepted"], 8000);
  check("服务端台账记到 accepted", accepted?.state === "accepted", `state=${accepted?.state ?? "—"}`);

  await sleep(2600);
  const midway = await browser.evaluate(DIALOG_PROBE);
  check("页面把回执写出来：「设备已接收」", midway?.receiptState === "设备已接收", `页面状态=${midway?.receiptState || "—"}`);

  const executedResponse = await deviceEvent("command.executed", {
    commandId,
    state: "executed",
    result: { modelVersion: load.version, sha256Matched: true },
  });
  check("设备回 executed 被平台收下（HTTP 200）", executedResponse.status === 200);
  const executed = await waitCommand(commandId, ["executed"], 8000);
  check("服务端台账记到 executed，并带着设备回来的结果", executed?.state === "executed", `result=${JSON.stringify(executed?.result ?? {})}`);

  await sleep(2600);
  const after = await browser.evaluate(DIALOG_PROBE);
  check("页面最终写「设备已执行」（PRD C3 后一半）", after?.receiptState === "设备已执行", `页面状态=${after?.receiptState || "—"}`);
  check(
    "版本行给出「设备当前版本 → 目标版本」",
    /→/.test((after?.receipt ?? []).join(" ")),
    (after?.receipt ?? []).find((text) => text.includes("→")) ?? "—",
  );

  const shot = await browser.shot("更新包下发-回执");
  if (shot) console.log(`  截图：${shot}`);
  console.log(failed === 0 ? "\n✓ 更新包下发：全部通过" : `\n✗ 有 ${failed} 项未通过`);
  process.exitCode = failed === 0 ? 0 : 1;
} catch (error) {
  console.error(`工装异常：${error?.stack ?? error}`);
  process.exitCode = 1;
} finally {
  /* 还原跟随开关：这个 profile 是复用的，别把「不跟随」留给下一次 */
  await browser
    .evaluate(`(localStorage.removeItem('mumai.follow.presenter'), 1)`)
    .catch(() => {});
  try {
    deviceSocket?.close();
  } catch {
    /* 已经断了 */
  }
  browser.kill();
}
