#!/usr/bin/env bash
#
# 木脉智检 · 部署自检（设备画面为什么看不见）
#
# 只读脚本：不写任何文件、不改任何配置，只对着部署好的平台发 HTTP 请求，
# 把「小车 / 手持扫描仪的数据链路通不通」打成分节的结论。
#
# 用法：
#   bash tools/smoke-devices.sh                          # 默认 http://127.0.0.1:8000
#   bash tools/smoke-devices.sh http://192.168.31.196:8000
#   bash tools/smoke-devices.sh http://192.168.31.196:8000 --device handheld-02 --token demo-token
#
# 只需要 bash + curl；JSON 解析优先用 python3，没有 python3 时退回 grep 取值。
# 退出码：0 = 全部通过（可能有提醒）；1 = 有 FAIL；2 = 连不上平台（后面各项无法判定）

set -u

BASE="${1:-http://127.0.0.1:8000}"
BASE="${BASE%/}"
shift || true

DEVICE_ID="handheld-02"
DEVICE_TOKEN="${MUMAI_DEVICE_TOKENS_SAMPLE:-demo-token}"
while [ $# -gt 0 ]; do
  case "$1" in
    --device) DEVICE_ID="${2:-handheld-02}"; shift 2 ;;
    --token) DEVICE_TOKEN="${2:-demo-token}"; shift 2 ;;
    *) echo "未知参数：$1"; exit 2 ;;
  esac
done

PASS=0; FAIL=0; WARN=0
LINE="------------------------------------------------------------"
BODY="$(mktemp 2>/dev/null || echo /tmp/.mumai-smoke-body.$$)"

ok()   { PASS=$((PASS+1)); printf '  [ OK ] %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  [FAIL] %s\n' "$1"; }
warn() { WARN=$((WARN+1)); printf '  [WARN] %s\n' "$1"; }
info() { printf '         %s\n' "$1"; }
hint() { printf '         → %s\n' "$1"; }

# NOTE: python 程序必须用单引号包住，否则 shell 会先吃掉 $1 之类。
# 输出统一成 true / false / null / 裸值，调用方只跟字符串比。
json() {
  if command -v python3 >/dev/null 2>&1; then
    python3 -c '
import json,sys
try: d = json.load(sys.stdin)
except Exception: print("__ERR__"); sys.exit(0)
def walk(o, path):
    if path == "": return o
    head, _, rest = path.partition(".")
    if head == "" and isinstance(o, list) and o: return walk(o[0], rest)
    if isinstance(head, str) and head.startswith("[") and head.endswith("]"): return walk(o[int(head[1:-1])], rest)
    if not isinstance(o, dict) or head not in o: return None
    return walk(o[head], rest)
v = walk(d, sys.argv[1])
if v is None: print("null")
elif v is True: print("true")
elif v is False: print("false")
else: print(v)
' "$1" < "$BODY"
  else
    # 没有 python3 时的退化路径：只在顶层键上够用
    grep -o "\"$1\"[[:space:]]*:[[:space:]]*[^,}]*" "$BODY" 2>/dev/null | head -1 | sed 's/.*:[[:space:]]*//' | tr -d '"'
  fi
}
has() { grep -q "$1" "$BODY" 2>/dev/null; }

echo
echo "木脉智检 · 设备链路自检"
echo "平台：$BASE    设备：$DEVICE_ID"
echo "$LINE"

# ---------------------------------------------------------------- 0 平台可达
echo "0. 平台服务"
CODE=$(curl -s -o "$BODY" -w '%{http_code}' -m 4 "$BASE/api/health" 2>/dev/null)
if [ "$CODE" = "000" ]; then
  bad "连不上 $BASE/api/health"
  hint "后端没起，或页面所在的 origin 不是这个后端。必须是「后端自己托管前端」的那一种部署："
  hint "  pnpm build && node server/index.mjs --static dist"
  hint "vite preview / nginx 只发静态文件时，/api 与 /ws 都不存在，页面一定看不到小车和扫描仪。"
  echo "$LINE"
  echo "结论：平台不可达，其余各项无法判定（退出码 2）"
  rm -f "$BODY"; exit 2
fi
if [ "$CODE" = "200" ]; then
  ok "/api/health 200"
  info "service=$(json service)   设备网关=$(json devices)"
else
  bad "/api/health 返回 HTTP $CODE"
  hint "200 之外的响应说明这个地址上不是平台的共享服务（可能是别的服务或反向代理占了路径）。"
fi
echo "$LINE"

# ------------------------------------------------------------ 1 前端构建产物
echo "1. 前端构建产物（后端是否在托管页面）"
CODE=$(curl -s -o "$BODY" -w '%{http_code}' -m 4 "$BASE/" 2>/dev/null)
CTYPE=$(curl -s -o /dev/null -w '%{content_type}' -m 4 "$BASE/" 2>/dev/null || echo "")
if [ "$CODE" = "200" ] && printf '%s' "$CTYPE" | grep -q 'text/html'; then
  if has 'id="root"'; then
    ok "后端在同源托管前端（/ 返回 HTML 且含 #root）"
  else
    warn "/ 返回 200 但不是预期的前端页面"
    hint "确认启动时带了 --static dist，且 dist/index.html 是最新构建。"
  fi
else
  bad "/ 返回 HTTP $CODE（content-type: ${CTYPE:-无}）"
  hint "只起了 API、没有托管前端：启动命令要带 --static dist（先 pnpm build）。"
fi
echo "$LINE"

# ------------------------------------------------------------------ 2 小车
echo "2. 小车（平台 → 小车的服务器侧链路）"
curl -s -m 5 -o "$BODY" -X POST "$BASE/api/auth/login" \
  -H 'content-type: application/json' \
  -d '{"account":"mayutian","password":"123456"}' 2>/dev/null
TOKEN=$(json token)
if [ -z "$TOKEN" ] || [ "$TOKEN" = "null" ] || [ "$TOKEN" = "__ERR__" ]; then
  warn "登录拿不到平台令牌，跳过需要登录态的检查"
  hint "演示口令默认 123456。要换账号就改本脚本里的 account/password。"
  TOKEN=""
fi
# 注意：`"${AUTH_HEADER[@]}"` 在 bash 3.2（macOS 自带）的空数组上配合 set -u 会报
# unbound variable，必须用 `${AUTH_HEADER[@]+"${AUTH_HEADER[@]}"}` 这种写法。
AUTH_HEADER=()
if [ -n "$TOKEN" ]; then AUTH_HEADER=(-H "authorization: Bearer $TOKEN"); fi

CODE=$(curl -s -o "$BODY" -w '%{http_code}' -m 5 ${AUTH_HEADER[@]+"${AUTH_HEADER[@]}"} "$BASE/api/cart/status" 2>/dev/null)
if [ "$CODE" != "200" ]; then
  bad "/api/cart/status 返回 HTTP $CODE"
  if has 'NO_ROUTE'; then
    hint "NO_ROUTE = 小车那组路由没注册。这个后端不是最新代码，或启动的不是 server/index.mjs。"
  fi
else
  CONF=$(json configured); LINK=$(json link); LIVE=$(json live); ERRS=$(json lastError)
  # lastError 没有错误时是 JSON null，别把它当字符串显示出来
  case "$ERRS" in null|__ERR__|"") ERRS="" ;; esac
  if [ "$CONF" = "true" ]; then
    ok "已配置小车地址（configured=true）"
  else
    bad "小车地址没配（configured=false, link=$LINK）"
    hint "创建 server/data/cart.json：{\"url\":\"http://<小车IP>:8765\",\"token\":\"<control_token>\"}"
    hint "或用环境变量 MUMAI_CART_URL / MUMAI_CART_TOKEN。改完必须重启后端。"
  fi
  case "$LINK" in
    online)  ok "平台 → 小车链路 online（live=$LIVE）" ;;
    offline) bad "平台 → 小车链路 offline：${ERRS:-无错误信息}"
             hint "在后端这台机器上跑：curl -s http://<小车IP>:8765/api/health"
             hint "通不了 = 网络 / 防火墙 / 网段问题，不是平台代码问题。" ;;
    *)       warn "平台 → 小车链路 link=$LINK${ERRS:+（$ERRS）}" ;;
  esac
fi

echo "  两路 MJPEG（页面 <img> 直接读这一条，不需要登录态）："
for ch in rviz camera; do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -m 4 "$BASE/api/cart/stream/$ch" 2>/dev/null)
  CT=$(curl -s -o /dev/null -w '%{content_type}' -m 4 "$BASE/api/cart/stream/$ch" 2>/dev/null || echo "")
  if [ "$CODE" = "200" ] && printf '%s' "$CT" | grep -q 'multipart/x-mixed-replace'; then
    ok "stream/$ch 200 multipart（有真实出帧）"
  elif [ "$CODE" = "503" ]; then
    bad "stream/$ch 503 —— 平台侧没配小车地址"
    hint "与上面 configured=false 同一个原因：补 server/data/cart.json 再重启。"
  elif [ "$CODE" = "502" ]; then
    bad "stream/$ch 502 —— 平台能连小车，但小车这一路没出帧"
    hint "在小车上验：curl -s -m 3 -o /dev/null -w '%{size_download}' http://127.0.0.1:8765/api/streams/$ch.mjpeg"
    hint "字节为 0 = 小车侧该通道未就绪（RViz 没起 / 摄像头没起），不是平台的问题。"
  else
    warn "stream/$ch 返回 HTTP $CODE（content-type: ${CT:-无}）"
  fi
done
echo "$LINE"

# -------------------------------------------------------- 3 手持扫描仪链路
echo "3. 手持扫描仪 / 手持终端（设备 → 平台上行）"
CODE=$(curl -s -o "$BODY" -w '%{http_code}' -m 5 ${AUTH_HEADER[@]+"${AUTH_HEADER[@]}"} "$BASE/api/devices/$DEVICE_ID/hardware" 2>/dev/null)
if [ "$CODE" != "200" ]; then
  bad "/api/devices/$DEVICE_ID/hardware 返回 HTTP $CODE"
else
  # 判新鲜度用**顶层 ageSec**（= 最后一份硬件上报的年龄，页面 phaseOf() 用的就是这个），
  # 不是 link.ageSec —— 后者是台账 last_seen_at（注册与设备通道事件才刷新），
  # 终端只 POST 数据不重连时它会一直涨，照着它判会把在线设备误报成离线。
  REP=$(json report); STATE=$(json link.state); AGE=$(json ageSec)
  case "$AGE" in null|__ERR__|"") AGE="" ;; esac
  if [ "$REP" = "null" ] || [ "$REP" = "__ERR__" ]; then
    bad "设备一次都没上报过（report=null, link=$STATE）"
    hint "终端 platform_url 要指到这台后端：http://<后端局域网IP>:8000（不能是 127.0.0.1）"
    hint "终端 device_id 要等于 $DEVICE_ID，device_token 要等于平台侧配的令牌。"
    hint "注册握手只在终端开机时做一次 —— 改完必须重启终端进程。"
  elif [ -n "$AGE" ] && [ "$AGE" -gt 15 ] 2>/dev/null; then
    warn "收到过设备上报，但已经不新鲜（${AGE}s 没有新数据，页面会显示「离线 ${AGE}s」）"
    hint "终端在线判定：≤6s 在线 / 6—15s 延迟 / >15s 离线。"
    hint "终端进程还在跑吗？平台地址是不是改了没重启终端？"
  elif [ -n "$AGE" ] && [ "$AGE" -gt 6 ] 2>/dev/null; then
    warn "设备上报延迟（${AGE}s，页面标「延迟」）"
    hint "6—15 秒属延迟区间；持续这样看终端的上报周期与网络质量。"
  else
    ok "收到设备上报且新鲜（${AGE:-0}s 前，link=$STATE）"
  fi
fi

CODE=$(curl -s -o "$BODY" -w '%{http_code}' -m 5 ${AUTH_HEADER[@]+"${AUTH_HEADER[@]}"} "$BASE/api/devices/$DEVICE_ID/preview/latest" 2>/dev/null)
case "$CODE" in
  200) ok "设备预览帧可读（preview/latest 200 image/jpeg）" ;;
  404) warn "设备预览帧 404：终端还没 POST 过预览帧"
       hint "预览图由终端主动推（POST /api/devices/{id}/preview，JPEG 直传），平台不生成画面；"
       hint "终端没开预览上传时页面显示「等待设备推流」属于正常边界。" ;;
  401) bad "预览读取 401：平台侧没有登录态也没带设备令牌"
       hint "这条接口要 Bearer 登录令牌。上面的登录已失败，先把登录修好。" ;;
  *)   warn "preview/latest 返回 HTTP $CODE" ;;
esac

echo "  平台侧设备令牌（0 组 = 任何令牌都会被拒，终端必然连不上）："
curl -s -m 4 -o "$BODY" "$BASE/api/health" 2>/dev/null
DCOUNT=$(json devices.tokens)
if [ "$DCOUNT" = "0" ]; then
  bad "设备令牌 0 组 → 终端注册会 401 BAD_DEVICE_TOKEN"
  hint "设 MUMAI_DEVICE_TOKENS=\"$DEVICE_ID:$DEVICE_TOKEN\" 后重启后端；"
  hint "或写 server/data/device-tokens.json：{\"$DEVICE_ID\":\"$DEVICE_TOKEN\"}（值要与终端配置完全一致）"
elif [ -n "$DCOUNT" ] && [ "$DCOUNT" != "null" ] && [ "$DCOUNT" != "__ERR__" ]; then
  ok "已配置设备令牌 $DCOUNT 组"
else
  warn "读不到设备令牌组数（/api/health 的响应不是预期结构）"
fi
echo "$LINE"

# ------------------------------------------------- 4 采集设备屏幕（可选一路）
echo "4. 采集设备屏幕（树莓派桌面串流，可选）"
CODE=$(curl -s -o "$BODY" -w '%{http_code}' -m 5 ${AUTH_HEADER[@]+"${AUTH_HEADER[@]}"} "$BASE/api/capture/screen/status" 2>/dev/null)
if [ "$CODE" = "200" ]; then
  CONF=$(json configured); ONLINE=$(json online)
  if [ "$CONF" != "true" ]; then
    warn "未配置屏幕串流（configured=false）"
    hint "这一路是树莓派桌面（X11 → FFmpeg → MJPEG）：要 server/data/capture-screen.json + Pi 上的 mumai-screen.service。"
  elif [ "$ONLINE" = "true" ]; then
    ok "屏幕串流在线"
  else
    warn "屏幕串流已配置但离线"
    hint "在树莓派上：systemctl --user status mumai-screen.service"
  fi
else
  warn "screen/status 返回 HTTP $CODE"
fi
echo "$LINE"

printf '结论：%d 项通过 · %d 项失败 · %d 项提醒\n' "$PASS" "$FAIL" "$WARN"
if [ "$FAIL" -gt 0 ]; then
  echo "有 FAIL —— 按每一条下面的 → 提示修，修完重启后端再跑一次。"
  echo "完整排查与配置清单见 docs/部署-设备画面排查交付-v1.0.md"
  rm -f "$BODY"; exit 1
fi
echo "设备链路自检通过。"
rm -f "$BODY"; exit 0
