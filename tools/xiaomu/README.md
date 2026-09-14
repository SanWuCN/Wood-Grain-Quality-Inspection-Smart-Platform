# 小木形象与动效 · 工具链

本目录是把**小木形象页**与**透明动效素材**生成出来的全部工具。
页面本身是构建产物（`dist-lab/`，不入库），所以生成能力必须随源码一起进版本管理。

> 完整的工程约定、踩坑记录与验证口径见 `voice-module/AGENTS.md`（工作区文档，不在本仓库）。
> 下面只讲"怎么跑"和"路径怎么对应"。

## 一、路径映射（本目录 ↔ 工作区）

工具原本在工作区目录下开发，入库时**只改了路径常量**，逻辑一字未动：

| 本目录 | 工作区原位置 |
|---|---|
| `01-抠图.mjs` | `D:\平台\voice-module\tools\rebuild\01-抠图.mjs` |
| `03-检查台.mjs` | `D:\平台\voice-module\tools\rebuild\03-检查台.mjs` |
| `量参考图.mjs` | `D:\平台\voice-module\tools\量参考图.mjs` |
| `拍三态.mjs` | `D:\平台\voice-module\tools\rebuild\拍三态.mjs` |
| `video/*.mjs` | `D:\平台\voice-module\tools\video\*.mjs` |

脚本里的 `REPO` 常量指向本仓库的 `dist-lab`，`REBUILD` 指向素材工作目录，运行时按需覆盖。

## 二、形象页：两段式

```
01-抠图.mjs      起一次 headless Chrome → 像素级算 alpha → xiaomu-assets/xiaomu-cut.webp
                 顺带把参考图里那条"原嘴"擦掉（页面会用自己的矢量嘴重画）
03-检查台.mjs    纯文本生成两个页面：
                   dist-lab/xiaomu-rebuild.html  形象本体（待机=几何动画，说话/思考=透明 GIF）
                   dist-lab/rebuild/index.html   动效素材总览（运行时读 assets.json）
```

**分界线是"要不要碰像素"**：碰像素的只在第 1 段做一次、结果落盘；之后所有样式与参数调整都在纯文本层，秒级完成、不需要浏览器。

### 关键规则（违反会静默出错）

1. **抠背景必须动像素，不能靠 CSS mask**：mask 只能改不透明度、改不了像素颜色。参考图球边缘本来就有一圈白色回光，遮罩怎么调都还是白的。
2. **球外按亮度抠、球内只按半径降 alpha**：球心的白是球自己的颜色，不是背景。一刀切会把球心整片抠掉。
3. **换参考图必须重新量几何**：球心/半径/眼嘴位置全都会变，沿用旧坐标会让整张脸错位。
4. **模板字符串的注释里不许出现反引号**：会截断模板，报错位置离真凶几十行。

## 三、动效素材：视频 → 透明 GIF

```
抠绿幕.mjs <视频> -o 出.gif [--out-webm 出.webm] [--size 240] [--fps 12] [--t 0.405] [--w 0.05]
验透明.mjs <出.gif>          # 必跑：逐帧查四角透明、中心不透明、有无过渡带
```

**判据模型**：`alpha = 255 * clip((T - greenness) / W, 0, 1)`，`greenness = g/(r+g+b)`。

用绿度而不是"量背景色再算距离"，是因为背景其实**不是纯色**（有棋盘两格、垂直渐变、压缩噪声），
任何"按背景色匹配"的做法都会残留 alpha 6~30 的像素，再被 GIF 的一位透明二值化成**不透明的背景色块**。
绿度判据只要求"背景比主体更绿"，对背景具体是多少不敏感。实测三个素材 **49/49 帧四角全透明**。

**必须遵守的几条**（全部踩过）：

1. **中间格式用 PNG 序列，不要用 VP9** —— `-pix_fmt yuva420p` 会**静默丢 alpha**（退出码仍是 0）。
2. **不要用 `pad` 滤镜** —— `color=0x00000000` 的带 alpha 十六进制不被正确解析，会把整个 alpha 通道盖成不透明。
3. **GIF 编码必须 `dither=none`** —— `sierra2_4a` 会在全透明像素上抖出调色板颜色，把 alpha=0 的背景抖成不透明色块。
4. **`palettegen` 必须有 `reserve_transparent=1`**，否则透明静默丢失。
5. **别用 `-vf gif`** —— 不做透明处理，边缘出黑边/白边。
6. **geq 表达式里不能有逗号**（会被当参数分隔符）；`hypot` **只吃两个参数**。

`接口服务.mjs` 把上面这套包成一个本地 HTTP 端点（默认 `127.0.0.1:8090`）：

```
GET  /health
POST /alpha-gif  {"input":"<mp4>","size":240,"fps":12,"t":0.405,"w":0.05}
```

## 四、依赖

- **Node 24+**（原生类型剥离，脚本为 `.mjs`，无 npm 依赖）
- **ffmpeg**：`winget install --id Gyan.FFmpeg -e`（装完 PATH 要新进程才生效；
  脚本已兜住已知安装路径，也可用 `FFMPEG_PATH` 覆盖）
- **headless Chrome**：仅 `01-抠图.mjs` / `量参考图.mjs` / `拍三态.mjs` 需要，
  走裸 CDP（`--remote-debugging-port` + WebSocket），不依赖 puppeteer

## 五、素材目录约定

```
<素材根>/
  assets.json      动效清单，页面运行时读它（换素材只改这里）
  src/*.mp4        原始视频
  gif/*.gif        透明 GIF（成品，兼容性最好）
  webm/*.webm      带 alpha 的 WebM（体积约为 GIF 的 1/30，边缘更干净）
```
