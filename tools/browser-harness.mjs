/**
 * 验收工装共用件 · **一台"电脑"**（一份独立 profile 的浏览器 + 它的页面会话）
 *
 * 为什么单独抽出来：多机相关的验收都要"两台真的浏览器"——各自的 profile、
 * 各自的令牌、各自的 WebSocket。原来每个工装里各写一份 CDP 胶水（连页面、
 * 登录、求值、截图），改一处要改三处，而且很容易只改到其中一个。
 *
 * 用法：
 *   const A = new Machine({ name: "self", port: 9511, base: "http://127.0.0.1:8000", account: "shi" });
 *   await A.start(); await A.login();
 *   await A.evaluate("location.hash = '#/orders'");
 *   const rows = await A.call("GET", "/api/work-orders");   // 用这台机器自己的登录态
 *   A.kill();
 *
 * 说明：
 *   · `call()` 走**页面自己的 fetch**（带 localStorage 里的令牌）—— 等价于这台机器上的
 *     人在页面上点了一下，而不是从工装进程另开一个身份。多机同步验收要的正是这个。
 *   · `login()` 只认登录页那两个输入框（账号 + 口令），不注入令牌。
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const SHOT_DIR = "D:\\平台\\验收截图";

export function findChrome() {
  const candidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ];
  const hit = candidates.find((p) => existsSync(p));
  if (!hit) throw new Error("找不到 Chrome / Edge");
  return hit;
}

/** 登录页脚本：两个输入框 = 账号 + 口令（用 React 认的 setter 写值再派发 input） */
export const loginScript = (account, password = "123456") => `(async () => {
  const inputs = [...document.querySelectorAll('input')];
  if (inputs.length < 2) return false;
  const setValue = (el, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  setValue(inputs[0], ${JSON.stringify(account)});
  setValue(inputs[1], ${JSON.stringify(password)});
  const form = inputs[0].closest('form');
  if (form) form.requestSubmit ? form.requestSubmit() : form.submit();
  return true;
})()`;

export class Machine {
  constructor({ name, port, base, account, password = "123456", width = 1600, height = 1000 }) {
    this.name = name;
    this.port = port;
    this.base = base;
    this.account = account;
    this.password = password;
    this.width = width;
    this.height = height;
    this.profile = `${process.env.TEMP}\\mumai-${name}-profile`;
    this.chrome = null;
    this.ws = null;
    this.id = 0;
    this.waiting = new Map();
  }

  async start({ timeoutMs = 45_000 } = {}) {
    rmSync(this.profile, { recursive: true, force: true });
    const { spawn } = await import("node:child_process");
    this.chrome = spawn(
      findChrome(),
      [
        "--headless=new",
        `--remote-debugging-port=${this.port}`,
        `--user-data-dir=${this.profile}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--enable-unsafe-swiftshader",
        "--use-angle=swiftshader",
        "--mute-audio",
        `--window-size=${this.width},${this.height}`,
        `${this.base}/`,
      ],
      { stdio: "ignore" },
    );
    const want = new URL(this.base);
    const deadline = Date.now() + timeoutMs;
    let page = null;
    while (Date.now() < deadline) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${this.port}/json/list`)).json();
        page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl && t.url.startsWith(want.origin));
        if (page) break;
      } catch {
        /* 还没起来 */
      }
      await sleep(250);
    }
    if (!page) throw new Error(`${this.name}：等不到可调试的页面（${this.base} 通吗？）`);
    this.ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r) => this.ws.addEventListener("open", r, { once: true }));
    this.ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (this.waiting.has(m.id)) {
        this.waiting.get(m.id)(m);
        this.waiting.delete(m.id);
      }
    });
    await this.send("Page.enable");
    await this.send("Runtime.enable");
    /*
      焦点模拟：headless=new 下窗口不是"活动窗口"，`document.hasFocus()` 为 false，
      于是 **CDP 的 Input 事件会被丢掉**（鼠标、键盘全都不进页面 —— 真鼠标点击的验收就此失效）。
      `Emulation.setFocusEmulationEnabled` 是 Puppeteer 里 `bringToFront` 用的同一条命令。
    */
    await this.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => null);
  }

  send(method, params = {}) {
    return new Promise((res) => {
      const i = ++this.id;
      this.waiting.set(i, res);
      this.ws.send(JSON.stringify({ id: i, method, params }));
    });
  }

  async evaluate(expr) {
    const r = await this.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? "页面内抛错");
    return r.result?.result?.value;
  }

  /**
   * 在这台机器自己的登录态下调平台接口（等价于这台机器上的人点了对应按钮）。
   *
   * 401 自动补一次登录再重放：服务重启会换掉签名密钥（`server/services/auth.mjs` 每次
   * 启动随机），页面里那个令牌当场失效 —— 工装要是直接把这个 401 当成"功能坏了"，
   * 排查方向就全歪了（实测踩到：刚重启完跑验收，建单接口"没反应"）。
   * 这条重试与页面 `apiRequest` 的补登录同源，只是走页面自己的 fetch。
   */
  async call(method, path, body) {
    const once = () =>
      this.evaluate(`(async () => {
        const token = localStorage.getItem('mumai.token');
        const response = await fetch(${JSON.stringify(path)}, {
          method: ${JSON.stringify(method)},
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
          ${body === undefined ? "" : `body: JSON.stringify(${JSON.stringify(body)}),`}
        });
        const text = await response.text();
        let json = null;
        try { json = JSON.parse(text); } catch { json = null; }
        return { status: response.status, json };
      })()`);

    let result = await once();
    if (result?.status === 401) {
      const refreshed = await this.evaluate(`(async () => {
        const response = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ account: ${JSON.stringify(this.account)}, password: ${JSON.stringify(this.password)} }),
        });
        if (!response.ok) return false;
        const body = await response.json();
        if (!body || !body.token) return false;
        localStorage.setItem('mumai.token', body.token);
        return true;
      })()`);
      if (refreshed) result = await once();
    }
    return result;
  }

  /** 等服务端返回的快照里满足条件（多机同步：等"另一边的动作落到这台机器上"） */
  async waitFor(expr, { timeoutMs = 15_000, intervalMs = 250 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      last = await this.evaluate(expr);
      if (last) return last;
      await sleep(intervalMs);
    }
    return last;
  }

  async login() {
    for (let i = 0; i < 80; i += 1) {
      if (await this.evaluate(`Boolean(document.querySelector('input'))`)) break;
      await sleep(300);
    }
    await this.evaluate(loginScript(this.account, this.password));
    for (let i = 0; i < 80; i += 1) {
      const state = await this.evaluate(
        `({ hash: location.hash, nav: document.querySelectorAll('nav button, nav a, aside button').length })`,
      );
      if (state && !String(state.hash).includes("login") && state.nav > 0) return true;
      await sleep(300);
    }
    return false;
  }

  /**
   * 按**浏览器的命中测试**点一下：先 `document.elementFromPoint`，再在它身上派发冒泡 click。
   *
   * ── 为什么不是 `element.click()` ──────────────────────────────────────
   * `element.click()` **不看层级**：控件被别的层盖住时它照样触发，人却看不见也点不着。
   * 数字孪生的主视图页签就踩过这个坑 —— 页签放在 `.twin-stage` 里，被
   * `position:absolute; inset:0` 的 `.twin-view` 整个压住，脚本全绿，用户却问
   * "3D 点云图去哪儿查看"。命中测试点法在那种情况下命中的是**盖住它的那个元素**，
   * 目标控件的 onClick 不会被触发 —— 与真人点击的结果一致（`探-主视图页签` 也钉了这条）。
   *
   * ── 为什么不用 CDP 的真鼠标事件 ──────────────────────────────────────
   * 试过：`Input.dispatchMouseEvent`（直连页面端点、以及连浏览器端点 + sessionId 两种）
   * 回包都是 `{}` 成功，但页面里 `document` 上**一个事件都收不到**
   * （`document.hasFocus()` 已用 `Emulation.setFocusEmulationEnabled` 置为 true，
   * viewport 1582×904、dpr 1，坐标无误）。这套 headless=new 环境里 Input 事件进不去页面，
   * 所以退回到"命中测试 + 派发"这条能真正反映层级的做法。
   *
   * 用法：`await machine.clickHitTest('.twin-view__tab', { contains: '内部点云' })`
   *   （`contains` 用来在一组同类控件里认准那一个 —— 只给选择器会点到第一个）
   */
  async clickHitTest(selector, { contains = "" } = {}) {
    return this.evaluate(`(() => {
      const list = [...document.querySelectorAll(${JSON.stringify(selector)})];
      const node = ${contains ? `list.find((item) => (item.textContent || '').includes(${JSON.stringify(contains)}))` : "list[0]"};
      if (!node) return { ok: false, reason: '找不到元素' };
      const rect = node.getBoundingClientRect();
      const x = rect.x + rect.width / 2;
      const y = rect.y + rect.height / 2;
      const top = document.elementFromPoint(x, y);
      if (!top) return { ok: false, reason: '这一点上没有元素' };
      const mine = top === node || node.contains(top);
      top.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window }));
      return { ok: true, hitSelf: mine, text: (node.textContent || '').trim(), topClass: String(top.className || top.tagName) };
    })()`);
  }

  async shot(name) {
    try {
      const r = await this.send("Page.captureScreenshot", { format: "png" });
      const data = r?.result?.data;
      if (!data) return null;
      mkdirSync(SHOT_DIR, { recursive: true });
      const file = `${SHOT_DIR}\\${name}.png`;
      writeFileSync(file, Buffer.from(data, "base64"));
      return file;
    } catch {
      return null;
    }
  }

  kill() {
    try {
      this.ws?.close();
    } catch {
      /* 已经断了 */
    }
    try {
      this.chrome?.kill();
    } catch {
      /* 已经退了 */
    }
  }
}
