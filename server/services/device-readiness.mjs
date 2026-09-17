/**
 * 设备链路自检（把交接包 `smoke-devices.sh` 的判据搬进平台）
 *
 * ── 用户给的交接包（2026-09-22）────────────────────────────────────
 * 「木脉智检-设备接入交接包」的结论是：**代码是全的，缺的是三份故意不入库的本地配置
 * + 一种正确的启动方式**。原包里 `smoke-devices.sh` 从**外面**对着平台发 HTTP 请求，
 * 分 5 节给出 `[ OK ] / [FAIL] / [WARN]`（退出码 0 / 1 / 2）。
 *
 * 这个模块做的是同一件事，但从**服务内部**做：
 *   · 0 平台服务    —— 服务名/会话数/客户端数 + 设备网关（令牌组数、在线台数）
 *   · 1 前端托管    —— 是否带 `--static dist`（带上才有同源 `/api` 与 `/ws`）
 *   · 2 小车        —— 配置、链路、两路 MJPEG（代码语义与 `cart.streamProbe` 同一套）
 *   · 3 手持扫描仪  —— 上报新鲜度（阈值来自网关自己的 `staleAfterMs/offlineAfterMs`）、
 *                     预览帧、设备令牌组数
 *   · 4 采集屏幕    —— 可选的树莓派桌面串流
 *
 * 为什么值得放进平台：这一页现在能直接说「小车地址没配，去写 server/data/cart.json，
 * 改完重启后端」——而不是让现场先怀疑平台代码。判据全部来自**既有服务**
 * （`cart.status()/streamProbe()`、网关的 `hardwareView()`、`screenStatus()`），
 * 页面与自检脚本看到的是同一套结论，不另算一套。
 *
 * 5 节之外还给出**三份本地配置**的落盘状态：不存在 / 还是模板占位符 / 已填。
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/** 三份故意不入库的本地配置（`.gitignore` 里的 `server/data/`） */
export const LOCAL_CONFIGS = [
  {
    key: "cart",
    file: "server/data/cart.json",
    purpose: "平台 → 小车（建图巡航页的状态 / 地图 / 两路视频 / 控制按钮）",
    env: "MUMAI_CART_URL / MUMAI_CART_TOKEN",
  },
  {
    key: "deviceTokens",
    file: "server/data/device-tokens.json",
    purpose: "设备 → 平台上行（手持终端注册与硬件上报）",
    env: "MUMAI_DEVICE_TOKENS",
  },
  {
    key: "screen",
    file: "server/data/capture-screen.json",
    purpose: "采集设备画面（树莓派桌面串流，可选一路）",
    env: "MUMAI_SCREEN_URL / MUMAI_SCREEN_TOKEN",
  },
];

/** 模板里的占位符：拷了模板但没换值，等于没配 */
const PLACEHOLDER = /REPLACE_WITH|CHANGE_ME|YOUR_|<[^>]{0,24}IP[^>]{0,24}>/;

/**
 * 一份本地配置的状态（纯函数：给"读到的文本"就能判）。
 * `text === null` 表示文件不存在 —— 这不是部署失败，是**克隆后的正常状态**。
 */
export function configStateOf({ path, text }) {
  if (text === null) return { path, present: false, placeholder: false };
  return { path, present: true, placeholder: PLACEHOLDER.test(text) };
}

/**
 * 把事实翻成 5 节结论（纯函数，可单测）。
 *
 * @param facts 见 `createDeviceReadiness().snapshot()` 的组装处
 */
export function buildReadiness(facts) {
  const { health, hosting, cart, streams, device, screen, configs, generatedAt } = facts;
  const sections = [];

  /* ---------------- 0 平台服务 ---------------- */
  const platformItems = [
    { level: "ok", title: `后端在跑（${health.service} v${health.version}）`, detail: `会话 ${health.sessions} · 浏览器连接 ${health.clients}` },
  ];
  const tokens = health.devices?.tokens ?? 0;
  if (tokens === 0) {
    platformItems.push({
      level: "fail",
      title: "设备令牌 0 组 —— 任何设备令牌都会被拒（终端注册必然 401）",
      detail: "这是最容易被误判成「设备坏了」的一条",
      hints: ['设 MUMAI_DEVICE_TOKENS="handheld-02:demo-token" 后重启后端', '或写 server/data/device-tokens.json：{"handheld-02":"demo-token"}（值要与终端完全一致）'],
    });
  } else {
    platformItems.push({ level: "ok", title: `设备令牌已配置 ${tokens} 组`, detail: `在线设备 ${health.devices?.online ?? 0} 台` });
  }
  sections.push({ key: "platform", title: "0 平台服务", items: platformItems });

  /* ---------------- 1 前端托管 ---------------- */
  const hostingItems = [];
  if (!hosting.staticRoot) {
    hostingItems.push({
      level: "fail",
      title: "后端没有托管前端（启动命令缺 --static dist）",
      detail: "页面能开但没有同源 /api 与 /ws 时，小车与扫描仪全都看不到",
      hints: ["pnpm build && node server/index.mjs --static dist", "只把 dist 交给 nginx / vite preview / 纯静态服务器都不行"],
    });
  } else if (!hosting.indexHasRoot) {
    hostingItems.push({
      level: "warn",
      title: "托管目录里没有预期的前端页面（dist/index.html 缺 #root）",
      detail: hosting.staticRoot,
      hints: ["确认 dist 是最新构建：pnpm build"],
    });
  } else {
    hostingItems.push({ level: "ok", title: "后端在同源托管前端（/ 返回含 #root 的 HTML）", detail: hosting.staticRoot });
  }
  sections.push({ key: "hosting", title: "1 前端构建产物", items: hostingItems });

  /* ---------------- 2 小车 ---------------- */
  const cartItems = [];
  if (!cart.configured) {
    cartItems.push({
      level: "fail",
      title: `小车地址没配（configured=false, link=${cart.link}）`,
      detail: "建图巡航页会显示「未配置小车地址」，两路视频是黑的",
      hints: ['创建 server/data/cart.json：{"url":"http://<小车IP>:8765","token":"<control_token>"}', "或用环境变量 MUMAI_CART_URL / MUMAI_CART_TOKEN；改完必须重启后端", "小车屏幕上写的 127.0.0.1:8765 是它自己，要用它的局域网地址"],
    });
  } else if (cart.link === "online") {
    cartItems.push({ level: "ok", title: `平台 → 小车链路 online`, detail: `configured=true · canControl=${cart.canControl} · live=${cart.live}` });
  } else {
    cartItems.push({
      level: "fail",
      title: `平台 → 小车链路 ${cart.link}：${cart.lastError ?? "无错误信息"}`,
      detail: "地址配了但连不上，通常是网段 / 防火墙 / 小车服务没起",
      hints: ["在后端这台机器上跑：curl -s http://<小车IP>:8765/api/health", "通不了 = 网络问题，不是平台代码问题"],
    });
  }
  for (const probe of streams) {
    const label = `stream/${probe.channel}`;
    if (probe.code === 200) {
      cartItems.push({ level: "ok", title: `${label} 有真实出帧（200 multipart）`, detail: probe.contentType ?? "" });
    } else if (probe.code === 503) {
      cartItems.push({
        level: "fail",
        title: `${label} 503 —— 平台侧没配小车地址`,
        detail: "与上面 configured=false 同一个原因",
        hints: ["补 server/data/cart.json 再重启后端"],
      });
    } else {
      cartItems.push({
        level: "fail",
        title: `${label} 502 —— 平台能连小车，但这一路没出帧（${probe.reason}）`,
        detail: "在小车上验该通道：curl -s -o NUL -w '%{size_download}' http://127.0.0.1:8765/api/streams/<通道>.mjpeg",
        hints: ["字节为 0 = 小车侧该通道未就绪（RViz 没起 / 摄像头没起），不是平台的问题"],
      });
    }
  }
  sections.push({ key: "cart", title: "2 小车（平台 → 小车）", items: cartItems });

  /* ---------------- 3 手持扫描仪 ---------------- */
  const deviceItems = [];
  if (!device.report) {
    deviceItems.push({
      level: "fail",
      title: `设备 ${device.deviceId} 一次都没上报过（report=null, link=${device.link.state}）`,
      detail: "硬件监看页会退回种子数据并标来源，看起来像「设备坏了」",
      hints: [
        "终端 platform_url 要指向这台后端：http://<后端局域网IP>:8000（写 127.0.0.1 指的是终端自己）",
        `终端 device_id 要等于 ${device.deviceId}，device_token 要与平台侧配置一致`,
        "注册握手只在终端开机时做一次 —— 改完必须重启终端进程（sudo systemctl restart woodpulse）",
      ],
    });
  } else if (device.ageSec !== null && device.ageSec > device.offlineAfterMs / 1000) {
    deviceItems.push({
      level: "warn",
      title: `收到过设备上报，但已经不新鲜（${device.ageSec}s，页面会显示「离线」）`,
      detail: `在线判定：≤${device.staleAfterMs / 1000}s 在线 / ${device.staleAfterMs / 1000}–${device.offlineAfterMs / 1000}s 延迟 / >${device.offlineAfterMs / 1000}s 离线`,
      hints: ["终端进程还在跑吗？平台地址是不是改了没重启终端？"],
    });
  } else if (device.ageSec !== null && device.ageSec > device.staleAfterMs / 1000) {
    deviceItems.push({
      level: "warn",
      title: `设备上报延迟（${device.ageSec}s，页面标「延迟」）`,
      detail: "持续这样看终端的上报周期与网络质量",
    });
  } else {
    deviceItems.push({ level: "ok", title: `收到设备上报且新鲜（${device.ageSec ?? 0}s 前）`, detail: `link=${device.link.state}` });
  }
  deviceItems.push(
    device.preview
      ? { level: "ok", title: "设备预览帧可读（preview/latest 有帧）" }
      : {
          level: "warn",
          title: "设备预览帧还没有：终端没 POST 过预览帧",
          detail: "预览图由终端主动推（JPEG 直传），平台不生成画面 —— 页面显示「等待设备推流」属正常边界",
        },
  );
  sections.push({ key: "device", title: "3 手持扫描仪（设备 → 平台上行）", items: deviceItems });

  /* ---------------- 4 采集屏幕（可选） ---------------- */
  const screenItems = [];
  if (!screen.configured) {
    screenItems.push({
      level: "warn",
      title: "未配置屏幕串流（configured=false）—— 这一路是可选的",
      detail: "采集工作台的「采集设备画面」会黑屏并提示信号中断，属预期",
      hints: ["要开这一路：server/data/capture-screen.json + 树莓派上的 mumai-screen.service（X11 → FFmpeg → MJPEG）"],
    });
  } else if (screen.online) {
    screenItems.push({ level: "ok", title: "屏幕串流在线" });
  } else {
    screenItems.push({
      level: "warn",
      title: "屏幕串流已配置但离线",
      detail: "在树莓派上：systemctl --user status mumai-screen.service",
    });
  }
  sections.push({ key: "screen", title: "4 采集设备屏幕（可选）", items: screenItems });

  const items = sections.flatMap((section) => section.items);
  const counts = {
    ok: items.filter((item) => item.level === "ok").length,
    fail: items.filter((item) => item.level === "fail").length,
    warn: items.filter((item) => item.level === "warn").length,
  };

  return {
    generatedAt: generatedAt ?? new Date().toISOString(),
    sections,
    counts,
    /** 与交接包脚本同一口径：0 全过 / 1 有 FAIL */
    exitCode: counts.fail > 0 ? 1 : 0,
    verdict: counts.fail > 0 ? "fail" : "ok",
    configs: configs ?? [],
  };
}

/** 读三份本地配置的落盘状态（不存在 = null） */
export function readLocalConfigs(root = process.cwd()) {
  return LOCAL_CONFIGS.map((item) => {
    const path = resolve(root, item.file);
    let text = null;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      /* 不存在是正常状态 */
    }
    return { ...item, ...configStateOf({ path: item.file, text }) };
  });
}

/**
 * 组装实时自检快照。
 *
 * 依赖全部从外面注入（与其它服务一样便于单测）：网关、小车、屏幕状态、静态托管配置。
 */
export function createDeviceReadiness({ staticRoot = null, cart = null, gateway = null, screen = null, health = null, root = process.cwd() } = {}) {
  const fileOf = (key) => readLocalConfigs(root).find((item) => item.key === key) ?? null;

  async function snapshot() {
    const [cartStatus, streams, screenState] = await Promise.all([
      Promise.resolve(cart ? cart.status() : { configured: false, canControl: false, link: "unconfigured", live: false, lastError: null }),
      cart ? Promise.all(["rviz", "camera"].map((channel) => cart.streamProbe(channel))) : Promise.resolve([]),
      screen ? screen.status() : Promise.resolve({ configured: false, online: false }),
    ]);

    const deviceId = process.env.MUMAI_SMOKE_DEVICE ?? "handheld-02";
    const view = gateway ? gateway.hardwareView(deviceId) : { deviceId, report: null, ageSec: null, link: { state: "unknown" } };
    const gatewayStatus = gateway ? gateway.status() : { tokens: 0, online: 0, devices: 0 };

    const hostingRoot = staticRoot ? resolve(staticRoot) : null;
    const indexPath = hostingRoot ? resolve(hostingRoot, "index.html") : null;
    let indexHasRoot = false;
    if (indexPath && existsSync(indexPath)) {
      try {
        indexHasRoot = readFileSync(indexPath, "utf8").includes('id="root"');
      } catch {
        indexHasRoot = false;
      }
    }

    return buildReadiness({
      generatedAt: new Date().toISOString(),
      /* 平台自身那几项由调用方给（它可以现取会话数与客户端数）；不给就按最小事实来 */
      health: (typeof health === "function" ? health() : health) ?? {
        service: "mumai-shared",
        version: "1.0.0",
        sessions: 0,
        clients: 0,
        devices: gatewayStatus,
      },
      hosting: { staticRoot: hostingRoot, indexHasRoot },
      cart: cartStatus,
      streams,
      device: {
        deviceId,
        report: view.report ?? null,
        ageSec: view.ageSec ?? null,
        link: { state: view.link?.state ?? "unknown" },
        preview: Boolean(gateway && gateway.latestPreview && gateway.latestPreview(deviceId)),
        staleAfterMs: gatewayStatus.staleAfterMs ?? 6000,
        offlineAfterMs: gatewayStatus.offlineAfterMs ?? 15000,
      },
      screen: screenState,
      configs: readLocalConfigs(root).map(({ key, file, present, placeholder, purpose, env }) => ({ key, file, present, placeholder, purpose, env })),
    });
  }

  return { snapshot, configs: () => readLocalConfigs(root), fileOf };
}
