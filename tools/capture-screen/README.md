# 树莓派采集设备屏幕

只读桌面链路：X11 → FFmpeg MJPEG → Python 单编码器服务 → 平台鉴权代理 → 浏览器 Canvas。保持 1024×600 原图，默认 10 FPS，无音频，不发送鼠标/键盘指令。浏览器从收到的 JPEG 更新状态；3 秒无帧退出“实时”，中断后每 2 秒重连。未登录不能读取平台视频接口。

## 安装

树莓派需要 Python 3、FFmpeg 与已登录的 X11 桌面。将 `stream.py` 放到 `~/.local/share/mumai-screen/stream.py`，将 `mumai-screen.service` 放到 `~/.config/systemd/user/`。创建仅当前用户可读的 `~/.config/mumai-screen/environment`：

```ini
MUMAI_SCREEN_TOKEN=<随机生成的设备访问密钥>
MUMAI_SCREEN_WIDTH=1024
MUMAI_SCREEN_HEIGHT=600
MUMAI_SCREEN_FPS=10
MUMAI_SCREEN_PORT=8766
```

```sh
chmod 600 ~/.config/mumai-screen/environment
systemctl --user daemon-reload
systemctl --user enable --now mumai-screen.service
```

平台后端本地文件 `server/data/capture-screen.json`（git 忽略，权限 600）：

```json
{"url":"http://<树莓派内网地址>:8766","token":"<同一设备访问密钥>"}
```

也可使用环境变量 `MUMAI_SCREEN_URL` / `MUMAI_SCREEN_TOKEN` 覆盖。修改本地 JSON 后直接重新连接即可，无需重启平台。SSH 登录口令不保存到项目或服务中。设备密钥只由后端转发，不传给浏览器，不放 URL。当前链路用于已授权局域网，跨公网部署应使用 HTTPS 或专网。

用户服务随该桌面用户会话启动。显示器分辨率变化时调整宽高后重启服务；Wayland 桌面需要另配捕获源，当前服务针对实测 X11。

## 接口与运维

- `GET /api/capture/screen/status`：已配置/在线、源分辨率和目标帧率。
- `GET /api/capture/screen/stream`：需要现有平台 Bearer 登录令牌，透传 MJPEG；8 秒上游无字节断开；浏览器离开后关闭对应上游连接。
- 一次 FFmpeg 编码为多个查看者供帧，每位慢客户端只拿最新帧，不累积历史。原始桌面图像不落盘。
- 树莓派状态：`systemctl --user status mumai-screen.service`。
- 停止串流：`systemctl --user stop mumai-screen.service`。
- 取消开机启动：`systemctl --user disable --now mumai-screen.service`。
- 故障日志：`journalctl --user -u mumai-screen.service -n 40 --no-pager`。

## 本次实测

2026-09-13：设备桌面为 X11 `:0`、HDMI-2 1024×600；FFmpeg 捕获成功。已安装并启动用户服务，本机浏览器通过平台同源鉴权接口实际显示 9–10 FPS 桌面。停止服务后页面显示“屏幕信号已中断，正在重连”；恢复后无需刷新自动恢复画面。未执行整机重启测试。

屏幕内应用自己的“平台离线”等标签属于树莓派原应用的业务连接状态；本功能真实转播该桌面，不改写它的状态。启动/暂停采集仍沿用平台演示流程，没有借屏幕串流伪装成远程采集控制。

验证：`node --test tools/test-capture-screen.mjs tools/test-sensortag.mjs`，生产构建、前端 ESLint、Python 编译以及浏览器实际断流/恢复。

参考：[FFmpeg 官方 X11 捕获说明](https://ffmpeg.org/ffmpeg-devices.html#x11grab)。
