#!/usr/bin/env node
/**
 * 木脉智检 · 局域网发布切换脚本（PRD §7.2 比赛发布）
 *
 * 把「页面用 Vite 开发服务器(5173) + 后端单独跑(8000)」切成
 * 「单个 Node 服务在 8000 同时提供页面、/api 与 /ws」：
 *
 *   切换前   队友浏览器 → http://<主机IP>:5173          （页面，带热更新）
 *                        http://<主机IP>:5173/api      （Vite 代理到 8000）
 *   切换后   队友浏览器 → http://<主机IP>:8000          （页面 + /api + /ws 同源）
 *
 * 为什么比赛要用单服务模式（PRD §7.2）：
 *   · 5173 是开发服务器，带热更新与源码映射，不该拿去比赛；
 *   · 两个端口意味着收藏、投屏入口、二维码要维护两套地址；
 *     切完统一成「主机IP:8000」，开赛前只要统一一次。
 *
 * 用法：
 *   node tools/lan-publish.mjs            # 检查现状，不动任何进程
 *   node tools/lan-publish.mjs --switch   # 执行切换
 *   node tools/lan-publish.mjs --switch --port 8000
 *
 * 切换会重启 8000 上的服务 —— 单实例切换必然瞬断已连接的客户端（PRD §7.3
 * 要求安排在排练间隙）。脚本会先打印将要做什么，再等 3 秒才动手。
 */

import { spawn, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const SWITCH = process.argv.includes("--switch");
const PORT = Number(arg("port", "8000"));
const DIST = arg("dist", "dist");

/* ------------------------------------------------------------------ *
 * 发布前的硬性检查（PRD §7.2：验收 dist 中的资源，再启动服务）
 * ------------------------------------------------------------------ */

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

if (!existsSync(DIST)) fail(`静态产物目录不存在：${DIST}（先跑 npm run build）`);
if (!existsSync(`${DIST}/index.html`)) fail(`${DIST}/index.html 不存在（先跑 npm run build）`);

const indexHtml = readFileSync(`${DIST}/index.html`, "utf8");
if (!indexHtml.includes('id="root"')) fail(`${DIST}/index.html 里没有 #root 挂载点，产物不完整`);

/* 产物里的 /assets/*.js 必须真实存在 —— 缺文件就是构建被中断过 */
const assets = [...indexHtml.matchAll(/\/assets\/([A-Za-z0-9_.-]+)/g)].map((m) => m[1]);
const missing = assets.filter((name) => !existsSync(`${DIST}/assets/${name}`));
if (missing.length > 0) fail(`产物引用但缺失的资源：${missing.join(" ")}`);

/* 旧版产物是否还在，决定回退说明能不能成立（PRD §7.3） */
const hasPrev = existsSync("dist.prev") && existsSync("dist.prev/index.html");

console.log("木脉智检 · 局域网发布检查");
console.log(`  静态产物      ${DIST}/（index.html 引用 ${assets.length} 个资源，全部存在）`);
console.log(`  端口          ${PORT}`);
console.log(`  回退产物      ${hasPrev ? "dist.prev/ 存在，可回退" : "⚠ dist.prev/ 不存在 —— 切换前请先保留上一版 dist"}`);

/* ------------------------------------------------------------------ *
 * 找出现在谁占着端口
 * ------------------------------------------------------------------ */

function listenersOn(port) {
  try {
    const out = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique`,
      ],
      { encoding: "utf8" },
    );
    return out
      .split(/\r?\n/)
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    return [];
  }
}

function commandLineOf(pid) {
  try {
    const out = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`,
      ],
      { encoding: "utf8" },
    );
    return out.trim();
  } catch {
    return "(无法读取)";
  }
}

function lanAddresses() {
  try {
    const out = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | ForEach-Object { $_.IPAddress + '|' + $_.InterfaceAlias }",
      ],
      { encoding: "utf8" },
    );
    return out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [ip, alias] = line.split("|");
        return { ip, alias };
      });
  } catch {
    return [];
  }
}

/**
 * 虚拟网卡的地址对队友没用 —— 他们连 WSL / VMware / VirtualBox / Hyper-V 的
 * 内网地址一定连不上，列出来只会让人照错的那个填收藏夹。
 * 所以把真实以太网 / Wi-Fi 排在最前并单独标注，虚拟网卡折叠成一行提示。
 */
const VIRTUAL_ADAPTER_RE = /(WSL|VMware|VirtualBox|Hyper-V|Default Switch|Loopback|Radmin|TAP|Bluetooth)/i;

function splitAddresses(list) {
  const real = list.filter((item) => !VIRTUAL_ADAPTER_RE.test(item.alias));
  const virtual = list.filter((item) => VIRTUAL_ADAPTER_RE.test(item.alias));
  return { real, virtual };
}

const current = listenersOn(PORT);
if (current.length === 0) {
  console.log(`\n  端口 ${PORT} 当前空闲。`);
} else {
  console.log(`\n  端口 ${PORT} 当前被占用：`);
  for (const pid of current) console.log(`    pid ${pid}  ${commandLineOf(pid)}`);
}

/* 判断是不是已经切好了：命令行里带 --static 就是单服务模式 */
const alreadyStatic = current.some((pid) => commandLineOf(pid).includes("--static"));
if (alreadyStatic) {
  console.log("\n✓ 已经在单服务模式（占用端口的进程带了 --static），无需切换。");
}

const addresses = lanAddresses();
const { real, virtual } = splitAddresses(addresses);

function printAddresses() {
  console.log("\n  队友访问地址（不要让他们用自己电脑的 localhost）：");
  if (real.length === 0) {
    console.log("    ⚠ 没有检测到物理网卡地址 —— 检查网线 / Wi-Fi 是否连着。");
  }
  for (const item of real) console.log(`    http://${item.ip}:${PORT}    ← ${item.alias}`);
  if (virtual.length > 0) {
    console.log(
      `    （另有 ${virtual.length} 个虚拟网卡地址，是 WSL / VMware / VirtualBox / Hyper-V 的内部网络，队友连不上，不要用）`,
    );
  }
}

printAddresses();

if (!SWITCH) {
  console.log("\n这是**检查模式**，没有改动任何进程。");
  console.log("确认无误后执行切换：node tools/lan-publish.mjs --switch");
  process.exit(0);
}

if (alreadyStatic) process.exit(0);

/* ------------------------------------------------------------------ *
 * 执行切换
 * ------------------------------------------------------------------ */

if (!hasPrev) {
  console.log("\n⚠ 没有 dist.prev/：切换后就没有上一版产物可回退。3 秒后继续（Ctrl+C 可取消）…");
} else {
  console.log("\n即将停掉上面列出的进程并启动单服务模式。3 秒后执行（Ctrl+C 可取消）…");
}
await new Promise((resolve) => setTimeout(resolve, 3000));

for (const pid of listenersOn(PORT)) {
  console.log(`  停止 pid ${pid}`);
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    execFileSync("powershell", ["-NoProfile", "-Command", `Stop-Process -Id ${pid} -Force`]);
  }
}

await new Promise((resolve) => setTimeout(resolve, 1500));

const child = spawn("node", ["server/index.mjs", "--static", DIST], {
  stdio: "inherit",
  env: { ...process.env, MUMAI_PORT: String(PORT) },
});

child.on("exit", (code) => {
  console.log(`\n单服务进程已退出（code ${code}）。`);
  console.log("回退：node server/index.mjs --static dist.prev（详见 docs/design/ui-v2整合说明.md §7）");
});

console.log(`\n已启动：node server/index.mjs --static ${DIST}  （端口 ${PORT}）`);
console.log("验证：");
for (const item of real) {
  console.log(`  curl ${item.ip}:${PORT}/api/health`);
}
