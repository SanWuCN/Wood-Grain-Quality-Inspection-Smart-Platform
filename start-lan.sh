#!/usr/bin/env bash
#
# 木脉智检 · Mac／Linux 内网启动脚本
#
# 用途：把平台以**生产构建**跑起来，同一个局域网下的其他设备可以直接打开。
# 与根目录的 `start-demo.cmd` 不是一回事 —— 那个跑的是开发服务器（vite dev，
# 带 HMR、不压缩），适合改代码时用；这个跑的是 `vite build` 的产物，
# 适合给评委 / 其他同事演示。
#
# 用法：
#   ./start-lan.sh              # 没有 dist 就先构建，然后启动
#   ./start-lan.sh --build      # 强制重新构建再启动
#   MUMAI_PORT=8080 ./start-lan.sh
#
# 停止：Ctrl-C

set -euo pipefail
cd "$(dirname "$0")"

PORT="${MUMAI_PORT:-4173}"
HOST="${MUMAI_HOST:-0.0.0.0}"

# ---- 运行环境 ----
if ! command -v node >/dev/null 2>&1; then
  echo "[错误] 未找到 node。请先安装 Node.js 18 或以上。" >&2
  exit 1
fi

# 优先用 corepack 提供的 pnpm（与仓库的 pnpm-lock.yaml 一致）
if command -v pnpm >/dev/null 2>&1; then
  PNPM=pnpm
elif command -v corepack >/dev/null 2>&1; then
  PNPM="corepack pnpm"
else
  echo "[错误] 未找到 pnpm。请先运行：corepack enable" >&2
  exit 1
fi

# ---- 依赖 ----
if [ ! -d node_modules ]; then
  echo "首次运行，正在安装依赖（可能需要几分钟）..."
  $PNPM install
fi

# ---- 构建 ----
FORCE_BUILD=0
[ "${1:-}" = "--build" ] && FORCE_BUILD=1

if [ "$FORCE_BUILD" = "1" ] || [ ! -f dist/index.html ]; then
  echo "正在构建生产版本..."
  $PNPM build
fi

# ---- 取本机局域网地址，直接给可点的 URL ----
LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
if [ -z "$LAN_IP" ]; then
  LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
fi

echo
echo "木脉智检已启动（生产构建）"
echo "  本机     http://localhost:${PORT}"
if [ -n "$LAN_IP" ]; then
  echo "  局域网   http://${LAN_IP}:${PORT}"
  echo
  echo "局域网内的其他设备浏览器打开上面那条「局域网」地址即可（需在同一 Wi-Fi／网段）。"
else
  echo
  echo "（没取到局域网 IP，用 ifconfig 查一下本机地址，端口是 ${PORT}）"
fi
echo "按 Ctrl-C 停止服务。"
echo

exec npx vite preview --host "$HOST" --port "$PORT" --strictPort
