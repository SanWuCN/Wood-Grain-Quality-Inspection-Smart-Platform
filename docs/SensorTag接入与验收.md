# 采集工作台与 SensorTag 接入

实现位置：硬件详情 → 采集作业。采集配置改为顶部横栏，1024×600 原比例树莓派屏幕、窄竖向透明背景 GLB、竖排“实时数据”三个窗口并排，接收进度、波形和参考样本使用页签。

## 本机启动

```sh
python3 -m venv .venv-sensortag
.venv-sensortag/bin/python -m pip install -r tools/sensortag/requirements.txt
npm run build
npm run server:static
```

Windows 的 Python 路径为 `.venv-sensortag/Scripts/python.exe`。后端自动寻找项目内虚拟环境；也可用 `MUMAI_BLE_PYTHON` 指向其他 Python。Node 使用项目原有运行版本，支持 `node:sqlite`（本次验证 v22.22.1）。

1. 在后端电脑启用蓝牙并允许 Python/终端访问蓝牙。
2. SensorTag 开机，退出手机 SensorTag App 的连接。
3. 使用饶或管理员账号进入采集作业，选择批次，点击“连接设置 → 扫描附近设备”。
4. 核对真实设备的 MAC / UUID，选择后“绑定并连接本批次”。不按第一个结果自动连接。
5. 平台只连接已绑定设备。绑定保存在 SQLite，重启自动恢复；“断开连接”停止采集并清除自动绑定。
6. 安装后逐轴调整 X/Y/Z 固定转角，水平指向规定前方，执行“姿态归零”。安装参数在本浏览器按设备保存；零位在本浏览器会话内按设备与采集进程 streamId 保存，重新连接后需要归零。
7. 静置后可执行“陀螺仪静置校准”，收集 100 个稳定样本计算零偏；抖动会重新收集，成功后按设备持久化并在重连时恢复。

## 软件链路

`SensorTag BLE → Python Bleak → 本机鉴权 HTTP → Node 六轴姿态融合 → WebSocket → Three.js GLB`

- 保持现有 React/Vite/Node/SQLite 技术栈，没有按参考文档切换为 Vue。
- 四元数按 `[x,y,z,w]` 传输。六轴重力反馈融合与陀螺仪积分，归一化，渲染使用 SLERP；磁力计只展示，不参与融合。因此 Yaw 是相对角，会累积漂移，需要定期归零。
- 不计算位移、不移动场景。模型用上传的原始 `scanner.glb`，不创建地面、房间或数字孪生场景。
- BLE Movement 请求周期 20 ms（50 Hz），实际频率取决于固件；服务端逐帧推送。网络堵塞时采集器只保留各字段最新值，不堆积旧姿态。
- 温度/湿度/气压/光照请求周期 1 秒；电量及按键只在实际提供特征时展示。
- 每个字段独立记录更新时间；3 秒延迟、10 秒离线。环境通知不会刷新姿态时间。断线冻结模型，旧值显示最后时间。开发“姿态演示”默认关闭，有持续水印，环境读数不造假、不写库。
- 数据时间是后端电脑收到 BLE 通知后的主机时间，固件协议没有提供设备采样时钟；不把它描述为已验证的硬件时间戳。
- SQLite 每秒存一条原始/校准快照，保留最近 7 天；校准修改另外记录操作者、时间与依据。高频姿态推送不逐帧落盘。导出 CSV 限当前设备/批次，包含原始值、校准值及入库时的数据新鲜度。
- 最近五分钟曲线启动时从数据库恢复，再合并实时数据，中断处留空；完整持久化记录通过 CSV 获取。

## 协议与接口

复用平台 `/ws?sessionId=...`，消息 `kind: "sensor"`，`frame` 带 `sessionId / batchId / deviceId / streamId / seq / sampledAt / receivedAt / quaternion / poseAt / readings / fieldAt / calibrated / calibration / source: "ble:sensortag" / simulated: false`。

| 方法 | 路径 | 功能 |
|---|---|---|
| GET | `/api/sensors/bridge` | 本机连接状态 |
| POST | `/api/sensors/scan` | 扫描后端电脑附近 BLE 设备 |
| POST | `/api/sensors/connect` | 指定 deviceId、sessionId、batchId 绑定并连接 |
| POST | `/api/sensors/disconnect` | 断开并取消自动绑定 |
| POST | `/api/sensors/frames` | 鉴权原始读数接入，服务端解算姿态 |
| GET | `/api/sensors/latest?sessionId=&batchId=&deviceId=` | 最新帧（设备筛选可选） |
| GET | `/api/sensors/history?sessionId=&batchId=&deviceId=&after=` | 每页最多 1000 条，after 为上一页最后 id |
| GET / POST | `/api/sensors/calibration/:deviceId` | 读取/更新校准参数 |
| POST | `/api/sensors/gyro-calibrate` | 指定设备、会话、批次开始静置零偏校准 |

所有 REST 接口沿用现有登录令牌；写入和 BLE 控制只允许 `scan:capture` 或 `console:admin`。拒绝明确标记为模拟的数据帧。接口会拒绝非法字段、非有限数值、乱序/重复序号和偏差超过 60 秒的时间戳。WebSocket 复用平台现有的局域网只读会话订阅机制。

标准 SensorTag 2 GATT UUID 后缀为 `-0451-4000-b000-000000000000`，前缀 `f000`：

| 数据 | 服务 / 数据 / 配置 / 周期 | 解码 |
|---|---|---|
| Movement | AA80 / AA81 / AA82 / AA83 | 18 字节，小端有符号：Gyro × 500/65536 °/s；Accel × 16/65536 g（明确配置 ±8g）；Mag × 4912/32768 µT |
| 温度 | AA00 / AA01 / AA02 / AA03 | 目标/环境 int16 右移 2 位 × 0.03125 °C |
| 湿度 | AA20 / AA21 / AA22 / AA23 | uint16，湿度清低两位 × 100/65536 |
| 气压 | AA40 / AA41 / AA42 / AA44 | 6 字节中后 3 字节 uint24 /100 hPa |
| 光照 | AA70 / AA71 / AA72 / AA73 | 低 12 位尾数 × 0.01 × 2^高4位 lux |
| 电量 / 按键 | 2A19 / FFE1 | 可选 uint8 |

参考：[TI SensorTag 2 服务、原始数据与转换说明](https://e2e.ti.com/support/wireless-connectivity/bluetooth-group/bluetooth/f/bluetooth-forum/746524/cc2650-sensortag-kit---wiki-is-not-available)、[TI SensorTag 设计指南](https://www.ti.com/lit/ug/tidu862/tidu862.pdf)、[Bleak 官方文档](https://bleak.readthedocs.io/)。

## 验证与实机边界

已验证：`npm run build`、改动前端文件 ESLint、`node --test tools/test-sensortag.mjs`（解析/姿态/零偏/输入校验/隔离/校准/持久化/鉴权/HTTP→WebSocket）、Python 编译、本机 BLE 扫描、浏览器页面与交互。

实机已连接：广播为 CC2650 SensorTag / SensorTag 2.0，Device Information 返回 `CC2650 SensorTag`、固件 `1.20 (Jul 20 2015)`。已接收真实加速度、角速度、四元数、TMP007 环境/目标温度、气压和光照。实测 Movement 约 10 Hz，配置回读 `7f02`（±8g）及周期 `0a`（100 ms）；旧固件拒绝 20 ms 请求，已自动兼容回退。湿度配置返回 `ff`（设备错误），未接到湿度通知；磁力计为全零，未发现可用电量。均保持明确的空值/原始值，不作为有效航向来源。

已验证后端重启按已绑定 UUID 自动连接，恢复真实数据推送。未验证最终安装轴向、快速旋转效果、温度/光照仪器对标精度、30 分钟连续运行，以及断电重连验收。固件当前仅 10 Hz，因此不能承诺 PRD 的 30–60 Hz 推送或 ≤100 ms 端到端目标；需换固件/硬件再测。RSSI 当前仅扫描结果可用，持续连接 RSSI 未实现，不填假值。

这台旧设备的实测陀螺仪静态偏移较大（约 X -10、Y +10 °/s），静态噪声约 1–1.4 °/s；静置校准要求加速度和角速度窗口同时稳定，计算 100 个样本的均值作为零偏。

温湿度等字段无服务时保持“未接入”。TMP007 在某些固件/硬件版本可能不存在，不静默用另一来源替代环境温度。磁力计全零不代表有效航向。

本次静置校准已完成，实测 gyro bias 为 `[-9.17618, 9.57848, -0.59639] °/s`，已按设备保存并记录校准事件；用户已确认平放静止。

## 树莓派真实桌面

已接入树莓派 1024×600 桌面，默认 10 FPS，独立于演示启动/暂停流程。安装、访问鉴权和停止方法见 [屏幕串流说明](../tools/capture-screen/README.md)。模型使用窄竖向区域。初始模型统一缩放至上一版的 75%（缩小 25%，归一化最长边由 3 改为 2.25），面板尺寸与姿态算法保持原有设置；支持滚轮缩放，“恢复视角”回到当前默认取景。
