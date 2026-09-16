# 木脉智检平台 · 前端 → 后端 HTTP 面 & 数据源架构（代码实测）

> 工作目录：`/Users/sanwu/Downloads/平台`（前端 `src/`，后端 `server/`）
> 所有结论均以 `文件:行号` 标注，逐行读过真实代码；未找到的写「未找到」。

---

## 0. 结论速览

| 问题 | 结论 |
| --- | --- |
| base URL 在哪配 | **前端没有 base URL / API 前缀常量**，全部同源相对路径 `/api/*`、`/ws`（`src/pages/MumaiDashboard/api/client.ts:4-5`）。开发期由 Vite 代理转发（`vite.config.ts:74-83`）。 |
| 环境变量 | 前端**没有任何 `VITE_*` 变量**（`import.meta.env` 只用于 `DEV`：`agent/XiaomuDock.tsx:246`、`agent/store.ts:137`）。代理目标用服务端变量 `MUMAI_API`（`vite.config.ts:76,80`）。 |
| 令牌 | `localStorage["mumai.token"]`（`api/client.ts:222`），以 `Authorization: Bearer` 发送（`api/client.ts:308`）。WebSocket **不带令牌**（`api/client.ts:1090-1093`）。 |
| 登录 | 页面登录**不走网络**（`auth.ts:508` 本地比对固定口令 `123456`，`pages/Login.tsx:269-282`）；网络登录只发生在 `POST /api/auth/login`（`api/client.ts:447`、`:277`）。 |
| 演示会话 id | 前端共享 store 固定 `demo-01`（`store/shared.ts:62`），但 UI 上下文写死显示 `session-A`（`context.tsx:314`）——两者不一致。 |
| 本地种子兜底 | **存在**，集中在硬件页 + 传感器页：`pages/Hardware.tsx:202-210`、`:367-372`、`:408-413`；`sensors/weather.ts:38,54`；`sensors/SensorWorkspace.tsx:30,172`。详见 §6。 |
| TODO / FIXME | 这 13 个文件里**没有一处 `TODO` / `FIXME` 注释**（未找到）。等价的「写死 / 占位 / 临时」清单见 §7。 |

---

## 1. 完整 HTTP 请求表（按域分组）

### 1.0 底层请求器（所有请求经此发出）

| 名字 | 位置 | 说明 |
| --- | --- | --- |
| `apiRequest<T>(path, init)` | `api/client.ts:305` | 唯一入口：注入 `Authorization`、401 补登录重放一次（`:336-350`）、网络失败抛 `{status:0, code:"OFFLINE"}`（`:316-323`） |
| `reloginWithSession()`（内部） | `api/client.ts:270`（`fetch` 在 `:277`） | 用本地会话重新 `POST /api/auth/login`，并发去重（`:268`） |
| `subscribe()` | `api/client.ts:1075` | 事件流 WebSocket（见 §3） |
| `kbRequest<T>()` | `knowledge/api.ts:35`（`fetch` 在 `:45`） | 知识库**自己重写了一份**请求器（未复用 `apiRequest`），同样注入 Bearer（`:40`） |
| `sensorRequest<T>()` | `sensors/useSensor.ts:6`（`fetch` 在 `:7`） | 传感器请求器，Bearer + `AbortSignal.timeout(15000)` |
| `cartGet<T>()` | `pages/cart/api.ts:181` | 复用 `apiRequest`（`:182`） |
| `api.download()` | `api/client.ts:587`（`fetch` 在 `:591`） | 原生下载：fetch 拿字节 + blob URL 触发保存 |
| `useDevicePreview` 的 `fetch` | `device/useDeviceLink.ts:145` | 裸 fetch + Bearer（`<img>` 带不了头） |
| `CaptureScreen` 的 `fetch` | `sensors/CaptureScreen.tsx:33`、`:37` | 裸 fetch + Bearer（MJPEG 流） |
| `useStreamSize` 的 `fetch` | `pages/cart/api.ts:273` | 裸 fetch，**不带令牌**（只在流首帧解析 JPEG 尺寸） |

### 1.1 auth 认证域（2 条）

| 导出函数 | 方法 | URL | file:line |
| --- | --- | --- | --- |
| `api.login(account,password)` | POST | `/api/auth/login`（body `{account,password}`，返回 `{token,actor,allowedActions}`，并 `writeToken`） | `api/client.ts:447`（`writeToken` 于 `:451`） |
| `api.ensureSession(account,password)` | GET | `/api/auth/me`（`actor:null` 视为未登录，不抛错；失败则清 token 走 login） | `api/client.ts:464`；清 token `:469`；回落 login `:471` |
| （内部）`reloginWithSession` | POST | `/api/auth/login`（`{account, password: DEMO_PASSWORD}`） | `api/client.ts:277-281` |

### 1.2 会话 / 命令总线（4 条）

| 导出函数 | 方法 | URL | file:line |
| --- | --- | --- | --- |
| `api.snapshot(sessionId)` | GET | `/api/sessions/{sessionId}/snapshot` | `api/client.ts:475` |
| `api.createSession(scenarioId="chapter2")` | POST | `/api/sessions`（body `{scenarioId}`） | `api/client.ts:479-482` |
| `api.command(body)` | POST | `/api/commands`（body `{commandId,sessionId,action,entityId,expectedRevision,payload}`；`commandId` 由 `makeCommandId` 生成，`api/client.ts:1038`） | `api/client.ts:499-508` |
| `api.validateEnvironment(inputs)` | POST | `/api/environments/validate`（body `{inputs}`） | `api/client.ts:520` |

> `api.command` 是**所有业务写操作的唯一通道**（服务端 `server/api/http.mjs:655`）。
> 前端通过它发出的 `action` 名（非 URL）：
> - 共享 store 透传：`store/shared.ts:134`
> - 知识库：`asset.register` / `asset.revise` / `asset.updateMetadata` / `asset.setInclusion` / `asset.delete` / `knowledge.sync` / `knowledge.retry` / `knowledge.cancel` / `knowledge.activateVersion` / `knowledge.configure`
>   （`knowledge/api.ts:221,225,229,233,237,242,246,250,254,258`；`send` 于 `:210`）
>
> **`api.snapshot` / `api.createSession` 的调用点**：`api.snapshot` 在 `store/shared.ts:117`；`api.createSession` **未被任何页面调用**（未找到调用点）。

### 1.3 工单域 work-orders（9 条）

| 导出函数 | 方法 | URL | file:line |
| --- | --- | --- | --- |
| `api.triggerWorkOrder(eventId)` | POST | `/api/work-orders/trigger`（body `{eventId}`，前端幂等键） | `api/client.ts:759-762` |
| `api.workOrders(filter="all", q="")` | GET | `/api/work-orders?filter=&q=` | `api/client.ts:765-769` |
| `api.workOrder(orderId)` | GET | `/api/work-orders/{orderId}` | `api/client.ts:773` |
| `api.assignWorkOrder(orderId, body)` | PUT | `/api/work-orders/{orderId}/assignment`（`{leaderAccountId,members[{accountId,duties[]}],expectedRevision}`） | `api/client.ts:780-783` |
| `api.setWorkOrderStatus(orderId, action, expectedRevision?)` | POST | `/api/work-orders/{orderId}/status`（`{action,expectedRevision}`；action ⊂ `start\|submit\|accept\|archive\|pause\|resume`，`:845`） | `api/client.ts:787-790` |
| `api.saveWorkOrderEnvironment(orderId, body)` | PUT | `/api/work-orders/{orderId}/environment-draft`（`{inputs,pressure,instruments,position,measuredAt,expectedRevision}`） | `api/client.ts:805-808` |
| `api.validateWorkOrderEnvironment(orderId, expectedRevision)` | POST | `/api/work-orders/{orderId}/environment/validate` | `api/client.ts:812-815` |
| `api.deleteWorkOrder(orderId)` | DELETE | `/api/work-orders/{orderId}` | `api/client.ts:820-823` |
| `api.dispatchWorkOrder(orderId, body)` | POST | `/api/work-orders/{orderId}/dispatches`（`{deviceId,configVersion,expectedRevision,idempotencyKey}`） | `api/client.ts:830-833` |

### 1.4 小车端入口 cart（9 条，含 1 条 WS）

| 导出函数 | 方法 | URL | file:line |
| --- | --- | --- | --- |
| `cartApi.status()` | GET | `/api/cart/status` | `pages/cart/api.ts:187` |
| `cartApi.info()` | GET | `/api/cart/info` | `pages/cart/api.ts:188` |
| `cartApi.read(channel)` | GET | `/api/cart/read/{channel}`（白名单：health / session / state / map / maps / routes / battery / chassis / config） | `pages/cart/api.ts:190`；直连调用见 `pages/Mapping.tsx:1157-1159`（`health`、`session`、`config`） |
| `cartApi.maps()` | GET | `/api/cart/read/maps` | `pages/cart/api.ts:191`（调用点 `pages/Mapping.tsx:210`） |
| `cartApi.routes()` | GET | `/api/cart/read/routes` | `pages/cart/api.ts:192`（调用点 `pages/Mapping.tsx:210`） |
| `cartApi.action(action,args,requestId?)` | POST | `/api/cart/action`（body `{action,...args}`，头 `x-request-id`） | `pages/cart/api.ts:206-210`；`newRequestId` 于 `:216` |
| `savedMapPreviewUrl(map)` | GET | `/api/cart/maps/{mapId}/preview.png?v={revision}`（`<img src>`） | `pages/cart/api.ts:319`（渲染于 `pages/Mapping.tsx:1088`） |
| `liveMapUrl(revision)` | GET | `/api/cart/map.png?v={revision}`（`<img src>`） | `pages/cart/api.ts:324`（`pages/Mapping.tsx:202`） |
| `streamUrl(channel)` | GET | `/api/cart/stream/{channel}`（`rviz`/`camera`，MJPEG，`<img src>` + 裸 fetch 探测尺寸） | `pages/cart/api.ts:335`；渲染 `pages/Mapping.tsx:950,982`；探测 `pages/cart/api.ts:273` |
| （页面内联下载链接） | GET | `/api/cart/maps/{mapId}/map.pgm`、`/api/cart/maps/{mapId}/map.yaml` | `pages/Mapping.tsx:1115`、`:1118` |
| （WS）`useCartLive` | WS | `ws(s)://{host}/ws?sessionId={id}&afterSeq=0` | `pages/cart/api.ts:409` |

> `cartApi.action` 的实际 action 名（`pages/Mapping.tsx`）：`mapping/start:265`、`mapping/stop:274`、`mapping/save:276`、`navigation/load:283`、`navigation/auto-localize:286`、`navigation/localize:289`、`navigation/preview:298`、`navigation/pause:335`、`navigation/resume:336`、`control/stop:337`、`navigation/speed:339`。
> 平台侧白名单在 `server/api/http.mjs:276`（`CART_ACTIONS`）。

### 1.5 设备网关 devices（4 条 + 1 条裸 fetch）

| 导出函数 | 方法 | URL | file:line |
| --- | --- | --- | --- |
| `api.deviceHardware(deviceId)` | GET | `/api/devices/{deviceId}/hardware` | `api/client.ts:731` |
| `api.deviceEvents(deviceId, limit=40)` | GET | `/api/devices/{deviceId}/events?limit={limit}` | `api/client.ts:735-737` |
| `api.deviceLedger()` | GET | `/api/devices`（返回 `{devices,status,serverTime}`） | `api/client.ts:741` —— **未被调用（未找到调用点）** |
| `api.deviceCommand(deviceId, type, args={})` | POST | `/api/devices/{deviceId}/commands`（body `{type,args}`） | `api/client.ts:747-749` |
| `useDevicePreview(deviceId, enabled, intervalMs=1500)` | GET | `/api/devices/{deviceId}/preview/latest`（裸 fetch + Bearer + `AbortSignal.timeout(4000)`） | `device/useDeviceLink.ts:145` |

> 设备 id 常量：`HANDHELD_DEVICE_ID = "handheld-02"`（`device/types.ts:27`）。
> 命令类型实际用到：`query_status`（`pages/Hardware.tsx:263`）、`request_upload`（`pages/Hardware.tsx:263`、`:590`）。

### 1.6 传感器网关 sensors（9 条 + 1 条 WS）

全部经 `sensorRequest`（`sensors/useSensor.ts:6`，前缀 `/api/sensors/`）：

| 调用形态 | 方法 | URL | file:line |
| --- | --- | --- | --- |
| `sensorRequest("latest?"+query)` | GET | `/api/sensors/latest?sessionId=&batchId=` | `sensors/useSensor.ts:61` |
| `sensorRequest("bridge")` | GET | `/api/sensors/bridge` | `sensors/useSensor.ts:62` |
| `sensorRequest("history?"+query)` | GET | `/api/sensors/history?sessionId=&batchId=&deviceId=&from=` | `sensors/useSensor.ts:68`、`sensors/SensorWorkspace.tsx:130` |
| `sensorRequest("scan",{})` | POST | `/api/sensors/scan` | `sensors/SensorWorkspace.tsx:224` |
| `sensorRequest("connect",{deviceId,batchId,sessionId})` | POST | `/api/sensors/connect` | `sensors/SensorWorkspace.tsx:226` |
| `sensorRequest("disconnect",{})` | POST | `/api/sensors/disconnect` | `sensors/SensorWorkspace.tsx:226` |
| `sensorRequest("gyro-calibrate",{sessionId,batchId,deviceId})` | POST | `/api/sensors/gyro-calibrate` | `sensors/SensorWorkspace.tsx:233` |
| `sensorRequest("calibration/{deviceId}", calibration)` | POST | `/api/sensors/calibration/{id}` | `sensors/SensorWorkspace.tsx:235` |
| `sensorRequest("frames", ...)` | POST | `/api/sensors/frames` | 服务端存在（`server/api/http.mjs:584`）；**前端未找到调用点** |
| （WS）`useSensor` | WS | `ws(s)://{host}/ws?sessionId=&afterSeq={lastSeq}` | `sensors/useSensor.ts:80` |

### 1.7 知识库 knowledge（9 条 GET/POST + 10 种 command action）

| 导出函数 | 方法 | URL | file:line |
| --- | --- | --- | --- |
| `knowledgeApi.overview(sessionId, projectId?)` | GET | `/api/knowledge/overview?sessionId=&projectId=` | `knowledge/api.ts:91`（调用 `knowledge/hooks.ts:62`） |
| `knowledgeApi.assets(sessionId, filters, projectId?)` | GET | `/api/knowledge/assets?sessionId=&projectId=&type=&q=&objectId=&source=&category=&state=&from=&to=&cursor=&limit=`（`limit` 默认 50） | `knowledge/api.ts:96-109`（`hooks.ts:164`） |
| `knowledgeApi.asset(sessionId, assetId)` | GET | `/api/knowledge/assets/{assetId}?sessionId=` | `knowledge/api.ts:114`（`hooks.ts:218`） |
| `knowledgeApi.graph(sessionId, opts)` | GET | `/api/knowledge/graph?sessionId=&projectId=&view=&focusId=&depth=&full=`（`view` 默认 `business`，`depth` 默认 1） | `knowledge/api.ts:122-129`（`hooks.ts:245`） |
| `knowledgeApi.indexes(sessionId, projectId?)` | GET | `/api/knowledge/indexes?sessionId=&projectId=` | `knowledge/api.ts:146` —— **未被调用（未找到调用点）** |
| `knowledgeApi.jobs(sessionId, status?)` | GET | `/api/knowledge/jobs?sessionId=&status=` | `knowledge/api.ts:150`（`hooks.ts:63`） |
| `knowledgeApi.job(sessionId, jobId)` | GET | `/api/knowledge/jobs/{jobId}?sessionId=` | `knowledge/api.ts:154`（`hooks.ts:106`） |
| `knowledgeApi.search(sessionId, query, options)` | POST | `/api/knowledge/search`（body `{sessionId,query,filters,topK,version,projectId}`） | `knowledge/api.ts:162-172`（`hooks.ts:291`） |
| `knowledgeApi.fixture(sessionId)` | GET | `/api/knowledge/fixture?sessionId=` | `knowledge/api.ts:176` —— **未被调用（未找到调用点）** |
| `knowledgeCommands.*`（10 个） | POST | 全部落到 `/api/commands`（`knowledge/api.ts:210` → `baseApi.command` → `api/client.ts:499`） | `register:221` `revise:225` `updateMetadata:229`(未调用) `setInclusion:233` `remove:237` `sync:242` `retry:246` `cancel:250` `activateVersion:254` `configure:258` |

### 1.8 平台资源 platform（2 条）

| 导出函数 | 方法 | URL | file:line |
| --- | --- | --- | --- |
| `api.platformResources(fixture?)` | GET | `/api/platform/resources[?fixture={name}]`（`fixture` 从 location hash 的查询串取，`pages/usePlatformResources.ts:32-37`，仅开发环境服务端生效） | `api/client.ts:715`；调用 `pages/usePlatformResources.ts:51` |
| `api.platformResourceHistory(windowSec=60)` | GET | `/api/platform/resources/history?windowSec={n}` | `api/client.ts:719`；调用 `pages/usePlatformResources.ts:72`（60s）、`:204`（60s） |

### 1.9 文件 files（4 条）

| 导出函数 | 方法 | URL | file:line |
| --- | --- | --- | --- |
| `api.fileMeta(fileId)` | GET | `/api/files/{fileId}` | `api/client.ts:542` —— **未被调用（未找到调用点）** |
| `api.verifyFile(fileId)` | GET | `/api/files/{fileId}/verify` | `api/client.ts:548` —— **未被调用（未找到调用点）** |
| `api.downloadUrl(fileId)` | GET | `/api/files/{fileId}/download`（返回 URL 字符串；被 `api.download` 内部使用） | `api/client.ts:554`；内部使用 `:591` |
| `api.modelUrl(fileId, fileName?)` | GET | `/api/files/{fileId}/model/{name}?token={token}`（Three.js 加载器用，**令牌走查询串**） | `api/client.ts:564-572`（调用 `pages/Twin.tsx`） |
| `api.download(fileId, fallbackName)` | GET | `/api/files/{fileId}/download`（fetch 字节 → blob 保存；文件名从 `content-disposition` 解析，`filenameFromDisposition` 于 `:1049`） | `api/client.ts:587-626` |
| `api.upload(file, sessionId, dir="uploads")` | POST | `/api/files?name=&sessionId=&dir=&mediaType=`（body 为原始文件字节，raw body） | `api/client.ts:630-635` |

### 1.10 归档 archives（2 条）

| 导出函数 | 方法 | URL | file:line |
| --- | --- | --- | --- |
| `api.archiveCheck(sessionId, assetIds?)` | POST | `/api/archives/check`（body `{sessionId,assetIds}`；服务端逐项重算 SHA-256） | `api/client.ts:650-653` |
| `api.archiveRepair(sessionId, assetId, fileId)` | POST | `/api/archives/repair`（body `{sessionId,assetId,fileId}`） | `api/client.ts:658-661` |

### 1.11 排练控制台 console（6 条）

| 导出函数 | 方法 | URL | file:line |
| --- | --- | --- | --- |
| `api.consoleOverview(sessionId)` | GET | `/api/console/overview?sessionId=` | `api/client.ts:667` |
| `api.consoleNewSession(scenarioId="chapter2")` | POST | `/api/console/sessions`（body `{scenarioId}`） | `api/client.ts:672-675` |
| `api.consoleCapture(sessionId, stage, label)` | POST | `/api/console/snapshots`（body `{sessionId,stage,label}`） | `api/client.ts:679-682` |
| `api.consoleRestore(sessionId, snapshotId)` | POST | `/api/console/snapshots/restore`（body `{sessionId,snapshotId}`） | `api/client.ts:687-690` |
| `api.consoleDeleteSnapshot(sessionId, snapshotId)` | POST | `/api/console/snapshots/delete`（body `{sessionId,snapshotId}`） | `api/client.ts:694-697` |
| `api.consoleDiagnostics(sessionId)` | GET | `/api/console/diagnostics?sessionId=` | `api/client.ts:702` |

### 1.12 投屏 projection（1 条）

| 导出函数 | 方法 | URL | file:line |
| --- | --- | --- | --- |
| `api.setProjection(sessionId, {viewType,focusIds,hold})` | POST | `/api/projection`（body `{sessionId,viewType,focusIds,hold}`；非持有人 409 `NOT_HOLDER`） | `api/client.ts:534-537`；经 store 调用 `store/shared.ts:143` |

### 1.13 健康检查（1 条，未使用）

| 导出函数 | 方法 | URL | file:line |
| --- | --- | --- | --- |
| `api.health()` | GET | `/api/health` | `api/client.ts:639` —— **未被调用（未找到调用点）** |

### 1.14 截屏 capture（2 条）

| 调用点 | 方法 | URL | file:line |
| --- | --- | --- | --- |
| `CaptureScreen` 状态探测 | GET | `/api/capture/screen/status`（裸 fetch + Bearer） | `sensors/CaptureScreen.tsx:33` |
| `CaptureScreen` MJPEG 流 | GET | `/api/capture/screen/stream`（裸 fetch + Bearer，逐帧解析 JPEG） | `sensors/CaptureScreen.tsx:37` |

### 1.15 事件流 / WebSocket（4 条连接）

| 用途 | 协议 | URL | file:line |
| --- | --- | --- | --- |
| 共享会话事件流（store） | WS | `ws(s)://{host}/ws?sessionId={id}&afterSeq={lastSeq}` | `api/client.ts:1090-1093`；订阅 `store/shared.ts:101` |
| 小车状态帧 | WS | `ws(s)://{host}/ws?sessionId={id}&afterSeq=0` | `pages/cart/api.ts:409` |
| 传感器帧 | WS | `ws(s)://{host}/ws?sessionId={id}&afterSeq={lastSeq}` | `sensors/useSensor.ts:80` |
| 语音唤醒常驻通道 | WS | `ws(s)://{host}/voice-wake`（开发期 Vite 代理到 `127.0.0.1:8780`） | `agent/wakeChannel.ts:559-560`；代理 `vite.config.ts:105-110` |
| 语音识别（一次一句） | WS | `/voice-asr`（代理配置存在：`vite.config.ts:99-104`） | 前端调用点**未找到**（不在本次 13 个文件范围内；`agent/asr.ts` 走 `voice-api`） |
| HTTP 事件补拉（REST 兜底） | GET | `/api/events?sessionId=&afterSeq=` | 服务端存在（`server/api/http.mjs:647`）；**前端未找到调用点** |

### 1.16 非 `/api` 的外部 / 静态请求（不属于后端面，列出以免遗漏）

| 用途 | 方法 | URL | file:line |
| --- | --- | --- | --- |
| 北京市相对湿度（**外网 Open-Meteo，无密钥**） | GET | `https://api.open-meteo.com/v1/forecast?latitude=39.9042&longitude=116.4074&current=relative_humidity_2m&timezone=Asia%2FShanghai` | `sensors/weather.ts:30-32`（`HUMIDITY_ENDPOINT`），fetch 于 `:88` |
| 预生成语音包清单 | GET | `/voice/manifest.json` | `agent/voicePack.ts:26`（`MANIFEST_URL`），fetch 于 `:39` |

---

## 2. base URL / API 前缀配置（答问 2）

1. **前端零配置**：所有请求都是同源相对路径，代码里没有 `baseUrl`、没有 `VITE_API_BASE` 之类的注入点。
   设计理由写在文件头：`api/client.ts:4-5`「全部走同源相对路径（`/api`、`/ws`）：开发期由 Vite 代理，内网演示期由共享服务自己托管构建产物 —— 两种部署下前端代码完全一样，不需要构建期注入地址」。
2. **开发期代理**（`vite.config.ts:74-83`）：
   - `"/api"` → `process.env.MUMAI_API ?? "http://localhost:8000"`，`changeOrigin: true`（`:75-78`）
   - `"/ws"` → 同一目标，`ws: true`（`:79-83`）
   - 代理错误处理：后端不在时该请求回 502 `{code:"UPSTREAM_DOWN", retryable:true}`，不打死 dev server（`:20-41`，注释 `:5-19`）
3. **dev server 端口**：`port: 5173` + `host: true` + `strictPort: true`（`vite.config.ts:60-63`；注释说明这是唯一来源）。
4. **后端默认端口**：`server/index.mjs:57` `port = Number(process.env.MUMAI_PORT ?? 8000)`（注释 `server/index.mjs:10`）。
5. **生产/内网演示**：由共享服务托管构建产物（`npm run server:static`，`package.json` scripts），此时同源，无需代理。
6. **其它同源通道**（同一套「不写死地址」原则）：`/voice-asr`、`/voice-wake`、`/voice-api` → `MUMAI_VOICE` / `MUMAI_VOICE_HTTP`（`vite.config.ts:99-115`）。
7. 前端**未使用**的任何 `VITE_*` 变量：未找到。

---

## 3. 认证、令牌、WebSocket（答问 3）

### 3.1 令牌存储与发送
- 存储：`TOKEN_KEY = "mumai.token"`，`localStorage`（`api/client.ts:222`）；`readToken()` `:224`、`writeToken()` `:232`（隐私模式失败仅内存生效，注释 `:237`）。
- 发送：`headers.set("authorization", \`Bearer ${token}\`)`（`api/client.ts:308`）；知识库自建请求器同样处理（`knowledge/api.ts:40`）；传感器 `useSensor.ts:9`；设备预览 `useDeviceLink.ts:146`；截屏 `CaptureScreen.tsx:32`；下载 `client.ts:592`。
- **例外（令牌走查询串）**：`api.modelUrl` 输出 `…/model/{name}?token=…`（`api/client.ts:564-572`，注释 `:557-563`：Three.js 加载器加不了头）。服务端 `/api/files/:id/download` 与 `/model/:name` 均为 `auth:false` 后自校验（`server/api/http.mjs:899`、`:959`）。
- 会话（另一把键）：`SESSION_STORAGE_KEY = "mumai.session"`（`auth.ts:361`），读写 `readSession:429` / `writeSession:458` / `clearSession:474`。

### 3.2 登录流程
1. 登录页**纯本地**校验：`login(loginName, password)`（`auth.ts:508-513`），口令硬编码 `DEMO_PASSWORD = "123456"`（`auth.ts:333`）；成功后 `writeSession(result.account.id, …)` 再按 `workspacePath` 跳转（`pages/Login.tsx:269-289`）。
2. 进入应用后 `MumaiProvider` 的 effect 调 `useSharedStore.getState().init(accountId)`（`context.tsx:197-199`）→ `api.ensureSession(accountId, DEMO_PASSWORD)`（`store/shared.ts:86`）。
3. 网络登录：`POST /api/auth/login`（`api/client.ts:447`，`server/api/http.mjs:612`，服务端 `auth:false`）。
4. 令牌失效自愈：任何请求收到 401 且带令牌时，用本地会话补一次登录并**只重放一次**原请求（`api/client.ts:336-350`），并发去重（`reloginInFlight` `:268-296`）；补不上则抛 `{code:"SESSION_EXPIRED"}`（`:343-349`）。
5. 退出：`clearSession()` + `useSharedStore.getState().reset()` + `resetDemo()`（`context.tsx:300-304`）。

### 3.3 WebSocket 连接细节（`subscribe`，`api/client.ts:1075-1158`）
- 路径：`${ws|wss}://${window.location.host}/ws?sessionId={id}&afterSeq={lastSeq}`（`:1090-1093`）——**无令牌、无子协议**。
- 建连：`connect()` `:1095`；`onopen` 重置 `attempt=0` 并启动 15s `"ping"` 保活（`:1104-1111`）。
- 收帧：`kind === "hello"` → `onHello({lastSeq, replayed})`（`:1119-1123`）；`kind === "event"` → 用 `event.seq <= lastSeq` 去重后交给 `onEvent`（`:1124-1129`）；其余 kind 忽略（`:1124`）。
- 断线与重连：`onclose` → `onStatus("closed")` + `scheduleRetry()`（`:1131-1135`）；退避 `Math.min(800 * attempt, 5000)` 毫秒（`:1141-1146`）；`onerror` 直接 `close()`（`:1136-1138`）。
- 关闭：`close()` 清 timer 并 `socket.close()`（`:1150-1157`）。
- 服务端对应实现：`server/services/hub.mjs:18-75`（`/ws`，缺省 sessionId `demo-01`，连接时先补发 `afterSeq` 之后的缺口事件再发 `hello`，只认客户端 `"ping"` → 回 `"pong"`，心跳 `isAlive` 定期 `terminate()`）；upgrade 分发在 `server/index.mjs:94-98`（设备通道优先）。
- 前端**未实现**「缺口超范围时拉全量快照」的专门分支（`hub.mjs:11-12` 提到的协议约定）——客户端只按 seq 去重；未找到对应代码。

---

## 4. `store/shared.ts` 做什么（答问 4）

`store/shared.ts` 是**跨端共享状态的唯一读源**：配置 / 地图 / 场景 / 产物 / 任务全部来自服务端快照与命令总线（文件头 `:1-16`）。

| 能力 | 实现 | file:line |
| --- | --- | --- |
| 初始状态 | `status:"idle"`、`actor:null`、`sessionId:"demo-01"`、`entities:{}`、`projection` 默认 `{holderId:null,viewType:"map",focusIds:[],updatedAt:null}` | `:62`（`DEFAULT_SESSION`）、`:70-79` |
| `init(accountId)` | 置 `connecting`；`api.ensureSession(accountId, DEMO_PASSWORD)` 拿 `actor/allowedActions`；再 `refresh()`；失败 → `status:"offline"` + `connectionError` + **清空** `session/entities` 并 return | `:81-98` |
| 重入保护 | `if (status === "connecting" \|\| "online") return` | `:82` |
| 演示口令 | 本地再声明一份 `DEMO_PASSWORD = "123456"`（注释：与 auth.ts 同源） | `:63-64` |
| WebSocket 订阅 | 先 `stream?.close()` 再 `subscribe(DEFAULT_SESSION, …)`；`onStatus("open")`→`online`，`"closed"`（原 online）→`connecting`；`onHello`→存 `lastSeq`；`onEvent`→存 `lastEvent` 并 `scheduleRefresh` | `:100-112` |
| 事件合并重拉 | `scheduleRefresh` 90ms 防抖（一次命令产生 1–2 条事件，只拉一次快照） | `:165-170` |
| `refresh()` | `api.snapshot(sessionId)` → 写 `session/entities/projection`，`lastSeq = max(本地, snapshot.session.lastSeq)`，置 `online`；失败 → `status:"offline"` + `connectionError`，且 `code === "UNAUTHORIZED"` 时 `writeToken(null)` | `:115-131` |
| `send(command)` | `api.command({sessionId, ...command})`，成功后**立刻 refresh**（不等事件回环，避免「已成功但状态还是旧的」一帧） | `:133-138` |
| `setProjection` | `api.setProjection(...)` 后 refresh（不走命令总线，因为前置条件是「持有人」而非 revision） | `:140-145` |
| `reset()` | 关 stream、清 timer、状态回 `idle` 且清空 actor/session/entities/lastSeq | `:147-161` |
| 离线行为 | `isOnline(state) = state.status === "online"`，供页面禁用写操作并说明原因 | `:234-237` |
| 选择器 | `latestEnvironment:195`、`environmentHistory:199`、`currentMission:204`、`mapVersions:208`、`scenes:212`、`publishedScene:216`、`artifacts:220`、`currentArtifact:225`、`archiveItems:230`；空列表共用冻结常量 `EMPTY`（避免 `useSyncExternalStore` 无限重渲染，注释 `:176-188`） | 同左 |
| 写入本地先行？ | **不**。两条硬规则写在文件头 `:10-15`：写操作不本地先行；事件只驱动一次快照重拉 | `:10-15` |

> 注意：`sessionId` 是常量 `"demo-01"`，**没有** `setSessionId`，也没有「新建会话后切换」的路径（`api.createSession` 未被调用，见 §1.2）。

---

## 5. `store/workOrders.ts` 做什么（答问 5）

工单域客户端 store，服务端 `server/services/work-orders.mjs` 为唯一权威；单独成 store 的理由写在文件头 `:8-10`（工单按单、与演示回放老工单并排显示，不适合塞进按会话拉全量的共享快照）。

| action | 调用的端点 | file:line |
| --- | --- | --- |
| `refresh()` | `GET /api/work-orders?filter=&q=`（`api.workOrders(filter, query)`） | `:73` |
| `select(orderId)` | `GET /api/work-orders/{id}` | `:86` |
| `setFilter` / `setQuery` | 纯本地状态，拉列表交给页面 effect | `:93-100` |
| `trigger(eventId)` | `POST /api/work-orders/trigger`；带 `triggering` 重入保护（按住快捷键不重复提交）；失败**不换 eventId**（换 ID = 一次按键两张单） | `:108-120` |
| `assign(orderId, body)` | `PUT /api/work-orders/{id}/assignment`，成功后写 detail + refresh | `:122-127` |
| `setStatus(orderId, action, expectedRevision?)` | `POST /api/work-orders/{id}/status` | `:129-134` |
| `saveEnvironment(orderId, body)` | `PUT /api/work-orders/{id}/environment-draft` **再** `GET /api/work-orders/{id}` 取详情 | `:136-141` |
| `validateEnvironment(orderId, expectedRevision)` | `POST /api/work-orders/{id}/environment/validate` **再** GET 详情 + refresh | `:143-149` |
| `dispatch(orderId, body)` | `POST /api/work-orders/{id}/dispatches` **再** GET 详情 + refresh | `:151-157` |
| `remove(orderId)` | `DELETE /api/work-orders/{id}`，若删的是当前详情则先清空 detail，再 refresh | `:165-170` |
| `reset()` | 清空 orders/detail/error/filter/query | `:172-174` |
| 事件判定辅助 | `isWorkOrderEvent(type)` = `type.startsWith("workOrder.")` | `:178-180` |

**本地种子兜底：没有。** 失败路径只写 `error: toApiError(error)`（`toApiError` 于 `:55-58`，未知错误降级为 `{status:0, code:"UNKNOWN", message:"操作失败"}`）；初始 `orders` 就是空数组 `:62`。未找到任何 seed / mock 数据源。

---

## 6. 后端不可用时的本地种子 / 演示数据兜底（答问 6，逐处）

### 6.1 真·静默回落到种子 / 固定值（重点）

| # | 位置 | 兜底内容 | 是否静默 |
| --- | --- | --- | --- |
| F1 | `pages/Hardware.tsx:202-205` | 通道状态：`report?.channels?.length ? report.channels : CHANNELS`（服务端一份都没报时用 `seed/scenario.ts` 的四路通道） | 静默；面板只在 `live` 时挂 `SourceTag label="真机上报"`（`:514`），**未上报时没有任何「种子/演示」标记**（未找到对应的种子标记） |
| F2 | `pages/Hardware.tsx:207-210` | 采集批次：`report?.batches?.length ? report.batches.map(toScanBatch) : SCAN_BATCHES` | 静默（同上；`SourceTag` 只在 `live` 时出现，`:605`） |
| F3 | `pages/Hardware.tsx:367-372` | 未上报时的「设备状态」四行：设备名 / 设备编号取 `DEVICES.scanner`，来源标 `SourceTag label="模拟采集"`，连接状态显示 **`已连接 · 只读监视` + tone `"ok"` 绿点** | **不是静默**（有「模拟采集」标签），但「已连接」文案与真实断线状态相矛盾 |
| F4 | `pages/Hardware.tsx:408-413` | 未上报时四个版本格取 `VERSION_ITEMS`（`versionOf()` 于 `:76-77`） | 静默 |
| F5 | `pages/Hardware.tsx:584-588` | 「补传」按钮在 `!live` 时**不发请求**，直接 `toast("已向扫描枪请求重传未接收分片","info")` | **伪成功反馈** |
| F6 | `sensors/SensorWorkspace.tsx:30` + `:172` | 扫描枪电量硬编码 `FIXED_BATTERY_PCT = 83`，chip 文案「写死」、foot「演示固定值 · 设备 …」 | 明示（有「写死」标签） |
| F7 | `sensors/SensorWorkspace.tsx:89-90` | 「姿态演示」开关本地用 `Math.sin` 造 30Hz 姿态帧（`deviceId:'demo-scanner'`, `source:'demo'`），页面挂水印「模拟姿态 · 非实机」（`:202`） | 明示 |
| F8 | `sensors/weather.ts:38,54` | `FALLBACK_HUMIDITY = 58`（北京秋季常湿常量）+ `readCache()` 二级缓存 | 明示（`source` 三档 `live/cache/fallback` 直接决定标签，`SensorWorkspace.tsx:166-171`） |

### 6.2 文件头注释与实现相矛盾的地方（值得记一笔）

- `pages/Hardware.tsx:14`「## 数据来源：真机优先，种子兜底」、`:21-27`「没有的就是没有…不补默认值」「**断流只影响该设备**…**不静默回退成种子**」，但实现里 F1/F2/F4 就是静默回落到 `CHANNELS`/`SCAN_BATCHES`/`VERSION_ITEMS`。
- `device/useDeviceLink.ts:15` 明说 `unavailable 平台服务不可达（页面退回种子并说明原因）`——这是**设计意图**（该文件本身不含种子数据，只给 phase），实际回退发生在 `pages/Hardware.tsx`。
- `api/client.ts:726-728`（`deviceHardware` 注释）：「读不到…由调用方兜底 —— 硬件页在设备离线时要**退回种子数据继续演示**」。**这是代码里对「静默回种子」最直白的一处自述。**

### 6.3 明确**不**兜底 / 只标错误的地方（对照）

| 位置 | 行为 | file:line |
| --- | --- | --- |
| `apiRequest` 网络失败 | 抛 `{status:0, code:"OFFLINE", message:"连接不上共享服务，请确认服务已启动", retryable:true}`，**不返回假数据** | `api/client.ts:314-323`；下载同理 `:594-603`；`kbRequest` 同款 `knowledge/api.ts:46-55` |
| `store/shared.ts` 初始化失败 | `status:"offline"` + `session:null` + `entities:{}`（无本地快照可用） | `:89-98` |
| `store/shared.ts` refresh 失败 | 保留旧值但置 `offline` + `connectionError`；`UNAUTHORIZED` 时清 token | `:126-130` |
| `pages/usePlatformResources.ts` | 失败**保留上一份快照**并标 `error`（注释「失败不编数」`:12`）；历史拉不到退化为空曲线（`:74-76`、`:207`） | `:60-66` |
| `pages/usePlatformResources.ts:54-57` | `snapshotId` 未变则忽略（防界面倒退，ERR-07） | 同左 |
| `device/useDeviceLink.ts:81-85` | 读失败**保留上一份**并置 `error`（phase 变 `unavailable`），清空只发生在 `enabled=false` | 同左；phase 计算 `:112-118` |
| `store/workOrders.ts` | 失败只写 `error`，无种子 | `:55-58`、`:69-78` |
| `knowledge/hooks.ts` | 失败只写 `error`（如 `:250-253`「读取关系图失败」） | `hooks.ts:248-253` |
| `ui.tsx:39` | `offline` 状态块的文案是「通道已断开…」 | `ui.tsx:27`、`:39` |

---

## 7. TODO / FIXME / 写死 / 占位 / 未实现 / 临时 / mock 清单（答问 7）

### 7.1 指定的 13 个文件

`grep -niE "TODO|FIXME|未实现"` 在这 13 个文件中**零命中（未找到）**。以下是同类的「写死 / 占位 / 演示固定」类注释与实现：

| file:line | 原文（引号内为逐字引用） |
| --- | --- |
| `pages/usePlatformResources.ts:207` | `/* 拉不到保持空态，弹窗里画一条空曲线而不是假数据 */` |
| `device/types.ts:25` | `* 也是设备台账里的主键 —— 页面与顶栏都用这一个常量，不在各处写死字符串。` |
| `context.tsx:257` | `// 新建单还没有附件，留空而不是塞占位项` |
| `auth.ts:332` | `/** 账号名即姓名拼音；密码为演示用固定口令（PRD 2.1：比赛环境提供固定账号快捷登录） */`（实现：`:333` `export const DEMO_PASSWORD = "123456";`） |
| `design.ts:8` | `*   - CSS 里一律写 var(--primary) 这类 token，不写死色值` |
| `lib.ts:784` | `/** 演示用稳定伪随机：同一 seed 恒定，避免每次渲染数字跳动 */` |
| `api/client.ts:1165` | `export const DEMO_PASSWORD = "123456";`（第二处硬编码口令） |
| `store/shared.ts:63-64` | `/** 演示口令：与 auth.ts 的 DEMO_PASSWORD 同源，登录页已经校验过一次 */` + `const DEMO_PASSWORD = "123456";`（第三处） |
| `api/client.ts:727-728` | `* 读不到（设备从没上报过 / 服务不可达）时由调用方兜底 —— 硬件页在设备离线时` / `* 要退回种子数据继续演示，而不是整页报错。` |
| `pages/cart/api.ts:309` | `/** 兜底轮询周期。小车 2 Hz，这里 2 秒一次足够发现「WS 悄悄断了」 */`（`FALLBACK_POLL_MS`） |
| `pages/cart/api.ts:583-585` | `* 大文件不适用的道理要写在代码里：这里是整包读进内存。` / `* 演示更新包是几十 KB 量级，够用；真要下几百 MB 的产物应改成` / `* 「服务端签发一次性下载地址」。`（**已知未实现的改进项**，位于 `api/client.ts:583-585`） |
| `device/useDeviceLink.ts:8` / `:15` | `* 显示真机读数还是退回种子数据 —— 而不是让页面到处写 report?.xxx ?? seed.xxx：` / `*   unavailable  平台服务不可达（页面退回种子并说明原因）` |
| `pages/Mapping.tsx:10-14`（相邻域，供参考） | `*   2. **真实数据，不编。**…` / `*   3. **状态与动作分开。** 所有动作走 /api/cart/action/* …` |

### 7.2 直接相关但不在 13 个文件里的同类项（补齐「静默兜底」证据链）

| file:line | 原文 |
| --- | --- |
| `sensors/SensorWorkspace.tsx:24-31` | `* 演示用：电量取自 SensorTag 的电池通道，枪不在线时那一格是空的。` / `* 按需求把这一格写死成 83%，界面上标明「写死」而不是伪装成实时读数。` / `* 需要恢复真实读数时删掉这一处覆盖即可…` + `const FIXED_BATTERY_PCT = 83;` |
| `sensors/SensorWorkspace.tsx:160-161` | `*   · 扫描枪电量 —— 写死 83%（FIXED_BATTERY_PCT），标签同样是「写死」。` |
| `sensors/SensorWorkspace.tsx:172` | `if (key === 'battery') return { value: FIXED_BATTERY_PCT, …, chip: '写死', …, foot: \`演示固定值 · 设备 ${currentDevice}\` };` |
| `sensors/SensorWorkspace.tsx:187` | `* 设备 ID / 固件版本 / 时间戳 / 按键位掩码 / 写死的电量（FIXED_BATTERY_PCT）` |
| `sensors/SensorWorkspace.tsx:210` | `{demo?'演示仅展示模型，环境读数未模拟':…}` |
| `sensors/weather.ts:16-17` | `*   3. fallback —— 连缓存都没有（首次打开就断网）：给一个北京秋季的` / `*                 常湿常量，同样标明来源，绝不留空。` |
| `sensors/weather.ts:37` | `/** 第一级就失败、又没有任何缓存时的兜底值（北京秋季常湿，量级正确即可） */` |
| `pages/Hardware.tsx:14` / `:21-27` | `* ## 数据来源：真机优先，种子兜底` / `*   · **断流只影响该设备**：设备离线时保留最后一份真机数据并标「离线」，` / `*     不静默回退成种子（那会让人以为设备还在上报）。` |
| `pages/Hardware.tsx:174-176` | `* 并保留最后一份）。**没有上报时不退回演示数据**：读数按静态行模板全部显示` / `* 「—」，布局与连接后完全一致。` |
| `pages/Hardware.tsx:585-587` | `if (!live) {` / `toast("已向扫描枪请求重传未接收分片", "info");` / `return;` |
| `seed/scenario.ts:1919` | `export const TODO_ITEMS = [`（业务数据的「待办事项」常量，**不是代码 TODO**） |
| `pages/overview.constants.ts:92` | `export const TODO_PREVIEW_ITEMS = 3;`（总览页待办预览条数，**不是代码 TODO**） |
| `knowledge/types.ts:6` | `* 类型来源。页面里不允许再写 as any 或者别的形状的临时对象。` |
| `pages/cart/MapCanvas.tsx:80` / `:382` | `/** 定位拖拽的临时位姿（松手前的预览） */` / `// 临时位姿预览（正在拖方向）` |
| `pages/Knowledge.tsx:322` / `:351` | `{/* 徽标只在计数非 0 时出现；数字传原始值，空值时组件自己落「—」占位 */}` / `没有参数就是普通知识库首页，这块完全不占位置。` |
| `context.tsx:286` | `pushEvent("装载阶段快照 fusion：工单、环境、巡检、数据集与更新记录同步回退", "warn");` |

**全仓 `TODO` / `FIXME` 命中总计 2 处，都不是代码待办**（`seed/scenario.ts:1919`、`pages/overview.constants.ts:92`）。

---

## 8. 数据源架构总览（谁读谁）

```
页面组件
 ├─ useSharedStore (store/shared.ts)  ──► GET /api/sessions/demo-01/snapshot   （实体快照：environment / mission / mapVersion / scene / artifact / archiveItem）
 │                                     ──► POST /api/commands                  （所有共享写操作，带 commandId）
 │                                     ──► POST /api/projection                （投屏，单列接口）
 │                                     ──► WS /ws?sessionId=demo-01&afterSeq=… （事件通知 → 90ms 防抖重拉快照）
 ├─ useWorkOrderStore (store/workOrders.ts) ──► /api/work-orders*（9 个端点，按单拉取，不进共享快照）
 ├─ knowledge/api.ts ──► /api/knowledge/*（9 个读接口）+ /api/commands（10 种 action）
 ├─ pages/usePlatformResources.ts ──► /api/platform/resources(+/history)（2s 轮询，后台降频 10s）
 ├─ pages/cart/api.ts ──► /api/cart/*（8 条）+ WS /ws（kind:"cart"）+ 2s 兜底轮询
 ├─ sensors/useSensor.ts ──► /api/sensors/*（9 条）+ WS /ws（kind:"sensor"）+ 2s 轮询
 ├─ device/useDeviceLink.ts ──► /api/devices/{id}/hardware|events（2s / 5s 轮询）+ /preview/latest（1.5s）
 ├─ context.tsx ──► 纯本地种子状态（orders / envRecord / mission / channels 全部 useState(seed)，:171-189），仅把连接状态暴露为 sharedStatus/sharedOnline
 └─ 外部：Open-Meteo 湿度（sensors/weather.ts:30,88）、/voice/manifest.json（agent/voicePack.ts:26）
```

### 8.1 `context.tsx` 的角色（易误读，单列）

`context.tsx` **不是数据源**：工单、环境记录、任务、通道、事件全部由 `seed/scenario.ts` 初始化进 `useState`（`context.tsx:171-189`），`createOrder` / `setOrderStatus` / `publishConfig` / `resetDemo` 都只改本地 state（`:225-287`）。它唯一与后端相关的部分是共享 store 的连接状态透传（`:192-199`、`:358-361`）与登出时 `reset()`（`:300-304`）。
另外它写死 UI 层 `sessionId: "session-A"`（`:314`）和事件文案里的 `session session-A`（`:187`），与真实共享会话 `demo-01`（`store/shared.ts:62`）**不一致**。

### 8.2 `design.ts` / `auth.ts` 的常量（问到的三张表）

| 常量 | 位置 | 内容要点 |
| --- | --- | --- |
| `ACCOUNTS` | `design.ts:96-106` | 四账号：`shen/shen/沈/项目经理/page:"/orders"`、`shi/shi/史/人工智能架构师/page:"/"`、`rao/rao/饶/全栈开发工程师/page:"/hardware"`、`ma/mayutian/马昱天/具身智能工程师/page:"/mapping"`；`workspace` 字段为中文工作区名（如「工单与审核」） |
| `ROUTE_PERMISSION` | `auth.ts:214-234` | 一级路由的**写**权限：`/`=[]（不限）、`/orders`=[`order:review`]、`/mapping`=[`mission:monitor`]、`/twin`=[`scene:publish`,`scene:submit`]、`/hardware`=[`scan:capture`,`data:upload`]、`/firmware`=[`training:submit`,`deployment:receive`]、`/knowledge`=[`knowledge:search`]、`/archive`=[`archive:verify`]、`/console`=[`console:admin`] |
| `ROUTE_READ` | `auth.ts:243-256` | 读取资格优先表：`/orders`=[shen,shi,rao]、`/twin`=[shen,shi,rao,ma]、`/firmware`=[shen,shi,rao,ma]、`/knowledge`=[shen,shi,rao,ma]；未登记则回退 `ROUTE_PERMISSION`（`allowsPath` 于 `:275-282`） |
| `WORKSPACE` | **未找到** | `design.ts` / `auth.ts` 中没有名为 `WORKSPACE` 的导出；等价物是 `ACCOUNTS[].workspace`（`design.ts:97-105`）与 `workspacePath(accountId)`（`auth.ts:393-395`，返回 `page` 路由） |
| 口令与登录名 | `auth.ts:333` `DEMO_PASSWORD`、`auth.ts:336-341` `ACCOUNT_LOGIN`（`ma → mayutian`）、`auth.ts:350-355` `LOGIN_ALIASES`、`auth.ts:358` `DEFAULT_ACCOUNT_ID="shen"` | |
| 显示名表 | `api/accounts.ts:10-15` `ACCOUNT_NAME` + `actorName()` `:18-20`（与服务端 `permissions.mjs` 的 `ACCOUNT_NAME` 手工同步，注释 `:5-7`） | |

### 8.3 `data.ts` / `lib.ts` 导出什么（简要）

- `data.ts`（70 行）：`MapMode`、再导出 `SiteStatus/SiteSurvey/Site`（`data.ts:12`）、`WorkOrder` 类型（`:14`）、再导出 `chinaSites`/`shanghaiSites`（`:34`）、`flyLineSeeds`（`:37`）、**已下线旧布局用的** `workOrders` 数组（`:55`，注释 `:48-54` 明说不是地图点位数据源）、`moduleCopy`（`:63`）。全部是前端静态演示文案/点位数据。
- `lib.ts`（794 行）：**全部是本地纯函数**，无网络调用。导出：`CheckDetail/CheckResult/Tone`、`toneOf:39`、`buildConfigVersion:47`、`validateEnvironment:52`、`diffConfig:97`、`checkGrouping:127`、`Metrics/SampleCompareRow/EvaluationResult`、`computeMetrics:259`、`runEvaluation:305`、`fmtPct:396`、`fmtNum:401`、`FusionInput/FusionPriority/FusionDecision`、`fuseByRule:471`、`ArchiveCheckRow/ArchiveCheckResult`、`sha256Hex:577`（**浏览器 WebCrypto，本地算摘要**）、`runArchiveCheck:585`（对种子清单做的**本地**校验）、`buildArchiveReportHtml:611`、`RetrievalHit/KnowledgeChunk`、`searchKnowledge:690`（**本地关键词检索**）、`nowStamp:762`、`clockStamp:768`、`sourceLabel:774`、`clamp:780`、`seededRandom:785`、`DEFAULT_ENV_RECORD:794`。
  > 注意：`lib.ts` 里的 `runArchiveCheck` / `searchKnowledge` 是**前端本地实现**，与线上的 `/api/archives/check`（`api/client.ts:650`）和 `/api/knowledge/search`（`knowledge/api.ts:162`）是两套；本次 13 个文件范围内未发现页面在服务端路径上调用这两个本地函数（归档页用的是 `api.archiveCheck`，见 `pages/Archive.tsx:19` 引入 `api`）。

---

## 9. 风险与不一致清单（供后续决策，均引自代码）

1. **演示会话 id 双轨**：`store/shared.ts:62` = `demo-01`（真实请求用）vs `context.tsx:314` = `session-A`（界面文案）。服务端默认也是 `demo-01`（`server/services/session.mjs:17`）。
2. **硬件页静默回种子**：F1/F2/F4（`pages/Hardware.tsx:202,208,408`）与文件头注释 `:14,:26-27` 冲突；且 F1/F2 的种子回退**没有**任何「演示数据」标记（`SourceTag` 只在 `live` 时渲染，`:514`、`:605`）。
3. **伪成功反馈**：`pages/Hardware.tsx:584-588`，离线时「补传」提示成功但不发请求。
4. **同一页面可能开 3 条 `/ws`**：`store/shared.ts:101`、`pages/cart/api.ts:408`、`sensors/useSensor.ts:80`（各自独立重连退避，互不共享）。
5. **`/ws` 无鉴权、无令牌**：`api/client.ts:1090`、`pages/cart/api.ts:409`、`sensors/useSensor.ts:80`；服务端 `hub.mjs:28-33` 也不校验令牌（只按 `sessionId` 入房间）。
6. **口令三处硬编码 `123456`**：`api/client.ts:1165`、`store/shared.ts:64`、`auth.ts:333`；页面登录完全不经过服务端（`pages/Login.tsx:269`）。
7. **未实现的改进项（代码自述）**：`api/client.ts:583-585`（下载整包读进内存，建议改为服务端签发一次性地址）。
8. **定义但未使用**：`api.health`（`client.ts:639`）、`api.fileMeta`（`:542`）、`api.verifyFile`（`:548`）、`api.deviceLedger`（`:741`）、`api.createSession`（`:479`）、`knowledgeApi.indexes`（`knowledge/api.ts:146`）、`knowledgeApi.fixture`（`:176`）、`knowledgeCommands.updateMetadata`（`:229`）、`cartApi.read`（`pages/cart/api.ts:190`，仅页面内联 `apiRequest` 用法替代）。
9. **知识库自建请求器**：`knowledge/api.ts:35-77` 复制了 `apiRequest` 的令牌注入与 OFFLINE 错误处理，**但没有 401 补登录重放**（`apiRequest` 在 `client.ts:336-350` 有）——知识库页面在服务重启换签名后会直接吃 401。
