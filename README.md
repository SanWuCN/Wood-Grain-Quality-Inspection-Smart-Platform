# 木脉智检 · 古建筑智能巡检平台

面向**古建筑木构无损检测**的智能巡检演示平台。以三维地图为主入口，把古建采集点、巡检风险、工单与设备通道放在同一空间语境里，支持从**全国省级地图**平滑下钻到**上海市 district 级地图**，并内置一个可执行平台操作、可多步编排任务的语音语义智能体「小木」。

> 演示内容为**种子数据回放**（`source_mode = replay / simulation`），不含真实设备接入。
> 地图边界文件仅用于界面原型，正式部署时应替换为项目确认的合规地图数据与审图号版本。

---

## 目录

- [界面与功能](#界面与功能)
- [核心演示路径](#核心演示路径)
- [三维地图实现](#三维地图实现)
- [视觉设计系统](#视觉设计系统)
- [小木语音语义智能体](#小木语音语义智能体)
- [技术栈](#技术栈)
- [快速开始](#快速开始)
- [目录结构](#目录结构)
- [数据与素材来源](#数据与素材来源)
- [开发工具脚本](#开发工具脚本)
- [验收](#验收)
- [已知限制](#已知限制)

---

## 界面与功能

平台共 **9 个路由**，顶栏 **8 项一级导航**（另有 presentation 角色的独立演示窗口）。

| 路由 | 导航 | 内容 |
| --- | --- | --- |
| `/` | 任务总览 | 三维地图为主视觉，左右浮层承载态势、四柱状态、风险与工单、待办与事件 |
| `/orders` | 工单档案 | 工单核心信息、构件清单、环境记录与配置校验、环境补偿与差异、人员分工与操作记录 |
| `/mapping` | 建图巡检 | 占据栅格地图、机器人轨迹、航点序列、设备通道状态 |
| `/twin` | 数字孪生 | 示例寺场景、Z01–Z04 构件标签、表面疑点、回波与历史记录 |
| `/adapt` | 检测适配 | 6 个页签：采集 / 异常排查 / 数据集 / 训练验证 / 更新交付 / 融合分析 |
| `/knowledge` | 知识库 | 本地资料检索（TF-IDF + 余弦相似度），检索来源与业务状态分开呈现 |
| `/archive` | 报告归档 | 交付清单与 **真实 SHA-256 校验**，可下载校验报告 |
| `/console` | 演示控制 | 按第二章剧本时间轴推进演示，触发预置异常事件 |
| `/present` | — | 大屏展示窗口，读取共享焦点显示「当前演示对象」与控制权持有人 |

顶栏固定显示四路设备通道（地图 / 位姿 / 视频 / 车辆）的**独立状态与更新时间**——任一路断流只影响该通道，不影响其它页面。

**四种账号**（沈 · 项目经理 / 史 · 人工智能架构师 / 饶 · 全栈开发工程师 / 马 · 具身智能工程师）可切换，切换后进入各自默认工作区。

---

## 核心演示路径

1. 在**全国总览**查看已覆盖省份、古建点位与风险分布。
2. 点击地图上**上海市的轮廓**下钻（或点右下角「进入上海」）。
3. 在**上海区级地图**中定位松江区示例寺与 Z04 风险构件。
4. 在右侧**工单列表**选择 `SH-2026-0901`。
5. 点「查看工单 →」展开融合证据、回波与四步处理时间线。
6. 打开「小木」，用语音或示例问句驱动一次**多步 Agent 任务**（例如「让小车先去一号木柱，再绕一圈，然后回来」），观察执行步骤清单实时推进。

---

## 三维地图实现

地图**不使用任何截图当底图**，是真实几何 + 真实地形贴图：

- **区域几何**：省级 / 区级 GeoJSON 一次性三角化后挤出成体，顶面与侧壁两个 material group。
- **地表贴图**：由 `tools/build-terrain.mjs` 从 **Mapzen Terrain Tiles（terrarium 编码）** 的真实 DEM 生成——青藏高原、横断山脉的山脊是真实高程，不是噪声。
- **省份标注**：DEM 明暗做分位数拉伸后映射到规范冷灰蓝色带，再直接烤入**行政边界描边与外发光**，整幅合成一张贴图。
- **不受光照影响的顶面**：顶面使用 `MeshBasicMaterial` 而非 `MeshStandardMaterial`。原因是地图整体绕 X 轴 -90° 旋转后顶面法线朝上，而方向光在地图后下方，换地区就会「没光」；烤贴图 + 无光照材质可以保证任何地区、任何比例下都稳定可读。
- **侧壁扫光**：ShaderMaterial 按厚度方向做底暗顶亮的竖向渐变，叠加一条上下循环的扫光带。
- **飞线 / 光柱 / 镜面底座 / 同心光环**：沿用 Demo2 的做法，尺寸统一按「地图投影半径 / 参考半径」换算，保证中国与上海两种跨度差 13 倍的地图拥有相同视觉比例。
- **业务点位**：已采集 / 已巡检 / 有风险 / 有工单四态分色（`#4EA8FF` / `#39D5A3` / `#FF5C70` / `#F2B84B`），含地面脉冲环、光斑、旋转光圈、光柱与标签，点击可联动工单。
- **自动取景**：相机距离由投影包围盒反解，两种模式占同样的画面比例；俯角取 42°（四川单省图可用 34°，全国图会被压得太扁）。

### 三个值得记录的坑

1. **雾的远近必须跟着取景距离走**。Demo2 写死 `fog(color, 10, 30)`，因为它的相机恒定在约 13 单位外；本项目的取景距离是按地图跨度反解的（中国约 96），固定 10~30 会让整幅地图落在雾区之外被**全雾成纯黑**——现象是「地图乌漆嘛黑，只有放大才看得见」。
2. **不要在 `<Suspense>` 边界外使用会挂起的资源加载**。drei 的 `useTexture` 走 suspend-react，只要有一个加载不 resolve，整个边界永远不 commit——现象是地图整块消失、只剩 Canvas 背景，而且**完全静默**（无报错）。本项目改用自写的 `useImage`（普通 state）。
3. **入场动画不要和取景计算写在同一个 effect 里**。各材质初始 `opacity: 0`，靠时间线淡入；取景距离在首帧后会随画布尺寸变化，一旦时间线被 kill 重建且没跑完，34 个材质就永远停在透明。

---

## 视觉设计系统

平台视觉遵循仓库内 `docs/design/视觉设计规范-v1.0.md`，唯一主题来源是 `src/styles/tokens.css`。

- **颜色占比**：约 80% 深色中性色 + 15% 蓝色体系 + 5% 状态色。
- **唯一 UI 主色** `#4EA8FF`；**科技光效色** `#5DE4FF` 只用于地图描边、飞线、光柱、扫描光效。
- **状态色只表达语义**：`#39D5A3` 成功 / `#F2B84B` 警告 / `#FF5C70` 风险 / `#4EA8FF` 信息 / `#687A91` 禁用。红黄绿禁止作为装饰色。
- **字号只保留 5 级**：`28 / 16 / 13 / 12.5 / 11`（Logo / Panel 标题 / 正文 / 表格 / 辅助）。
- **字体自托管**：HarmonyOS Sans SC（400/700）+ Inter（400/500/600）放在 `public/fonts/`，**离线可用**，不回退到系统默认字体。
- **原则**：能用留白区分就不加线，能用排版区分就不加框；普通 Panel 不发光、普通正文不发光。

重构前后的量化对照见 `docs/design/视觉重构基线.md` 与 `docs/design/视觉重构验收报告.md`。首页文字节点 177 → 101，边框总数 24 → 3。

---

## 小木语音语义智能体

按 `docs/语音语义Agent技术方案.md` 实现，**意图目录 29 条 / 工具 13 条**，全部为前端本地演示，不依赖任何外部服务与后端。

**交互链路**：麦克风 → VAD → 流式 ASR → 实时字幕 → 语义理解 → 实体抽取 → Intent Router → 回复 / 导航 / 工具调用 / 多步 Agent → 状态回传 → UI + 语音播报。

| 能力 | 实现 |
| --- | --- |
| 语音采集 | `getUserMedia` + `AnalyserNode` 计算音量；静音约 500ms 触发 `sentence_end` |
| 流式 ASR | 优先浏览器 `webkitSpeechRecognition`（`zh-CN`，`interimResults`）；无权限时**降级为逐字脚本流**，模拟 partial → final |
| 语音播报 | `speechSynthesis`（本地离线）；同一意图可配多种说法随机播放以降低机械感 |
| 打断（Barge-in） | 播报中检测到用户说话立即停止当前播报并开新一轮 |
| 语义匹配 | ① 规则匹配（停止 / 暂停 / 返回等确定性指令）→ ② 字符 bigram 余弦相似度（embedding matcher 的本地等价实现），采用 `Top1 + (Top1−Top2) margin` 置信度策略 |
| 实体抽取 | 正则 + 词典：柱号（一号木柱 / Z01 / 柱子1 → `pillar_1`）、风险号、工单号、批次号、页面名 |
| Tool Registry | 每个工具有风险等级 0–4，`run()` 调**真实前端能力**（react-router 跳转、地图模式切换、构件聚焦、工单定位），非模拟点击 |
| 多步 Agent | 把「先去 A，再绕一圈，然后回来」解析为结构化 plan，逐步执行并回传 `agent_step` 事件 |
| 执行过程可视化 | 步骤清单 `✓ 已完成 / ● 进行中 / ○ 待执行`，让观众看到「AI 不只是在聊天，而是在执行任务」 |
| 安全 | 风险 ≥3 的动作走**二次确认层**；低置信度走 Fallback，不猜测执行 |

控制台接口（调用方不需要改 `agent/` 下任何文件）：

```ts
import { openAgent, AGENT_EVENT } from "./agent";
openAgent("让小车去一号木柱");
window.dispatchEvent(new CustomEvent(AGENT_EVENT.CLOSE));

// 或在应用自己的 React 树里挂载，以拿到 react-router 上下文
import { AgentHost } from "./agent/AgentHost";
<AgentHost />
```

未渲染 `<AgentHost />` 时会自动兜底：首次收到 `mumai:agent-open` 事件时弹出一个独立 React root 挂到 `document.body`，导航降级为 hash 路由。

---

## 技术栈

| 层 | 选型 |
| --- | --- |
| 框架 | React 19 + TypeScript + Vite 8 |
| 三维 | three.js 0.183 + @react-three/fiber 9 + @react-three/drei 10 |
| 几何 / 投影 | d3-geo（墨卡托投影）、three `ExtrudeGeometry` |
| 动画 | GSAP |
| 状态 | zustand |
| 样式 | styled-components 6 + 原生 CSS 变量（`tokens.css`） |
| 路由 | react-router 7（HashRouter） |
| 图表 | ECharts 6 |
| 包管理 | pnpm（Windows 用户可直接用 `start-demo.cmd`，无需全局安装） |

---

## 快速开始

Windows 可直接双击项目根目录的 `start-demo.cmd`。

```bash
pnpm install
pnpm dev          # 开发服务器，默认 5199
pnpm build        # 生产构建
pnpm lint         # ESLint
```

类型检查：

```bash
npx tsc --noEmit -p tsconfig.app.json
```

---

## 目录结构

```text
docs/
├── design/
│   ├── 视觉设计规范-v1.0.md          # 视觉唯一权威
│   ├── 视觉重构基线.md               # 重构前后量化对照
│   ├── 视觉重构验收报告.md
│   ├── china-dashboard-concept.png   # 全国态设计稿
│   └── shanghai-dashboard-concept.png# 上海态设计稿
├── 语音语义Agent技术方案.md          # 语音智能体技术方案
└── prd-gap-analysis.md               # PRD 逐条实现情况核查（150 条需求）

prd及第二章剧本/                       # 需求原文与演示剧本

public/
├── fonts/                            # 自托管字体（HarmonyOS Sans SC / Inter）
├── demo_2.jpg                        # 视觉验收基准（上游 Demo2 截图）
└── rviz-reference.png                # 建图页 RViz 参考画面

src/
├── styles/tokens.css                 # 设计 token，唯一主题来源
├── assets/
│   ├── china.json / shanghai.json    # 区域轮廓（DataV）
│   └── map/                          # 构建产物：区域数据 + DEM 地形贴图
└── pages/MumaiDashboard/
    ├── routes.tsx                    # 9 个路由
    ├── Shell.tsx                     # 外壳：顶栏 / 内容区 / 底栏 / 断线态
    ├── entrance.ts                   # 页面与面板入场编排（对齐 Demo2 时序）
    ├── DemoHeader.tsx                # 顶栏（沿用 Demo2 的 1920×85 SVG 折角）
    ├── Panel.tsx / ui.tsx / design.ts
    ├── seed/                         # 演示种子数据与类型（唯一数据来源）
    ├── pages/                        # 九个业务页面
    ├── agent/                        # 小木语音语义智能体
    ├── mapDemo/                      # 三维地图（由 Demo2 迁移并适配双模式）
    └── map/                          # 早期地图实现，现为死代码
```

---

## 数据与素材来源

| 素材 | 来源 |
| --- | --- |
| 区域轮廓 GeoJSON | [DataV.GeoAtlas](https://datav.aliyun.com/portal/school/atlas/area_selector) |
| 地形高程 | [Mapzen Terrain Tiles](https://registry.opendata.aws/terrain-tiles/)（terrarium 编码，AWS Open Data，无需密钥） |
| 三维地图骨架、着色器、动效 | 上游 [`knight-L/sc-datav`](https://github.com/knight-L/sc-datav) 的 Demo2，见下方归属声明 |
| 业务数据 | 仓库内 `src/pages/MumaiDashboard/seed/scenario.ts`，全部为演示种子 |

**上游归属声明**：本项目的三维地图部分（`src/pages/MumaiDashboard/mapDemo/`）是从 `sc-datav` 的 Demo2 迁移而来，并在其上做了双模式适配（中国 / 上海）、取景与光照修正、地表贴图重制、标签与业务点位层扩展。仓库保留了上游的 Apache-2.0 许可证文件 `LICENSE`。上游 Demo 源码也一并保留在 `src/pages/Demo0` ~ `src/pages/Demo3`，以便对照。

---

## 开发工具脚本

```bash
node tools/build-geo.mjs          # DataV GeoJSON → src/assets/map/*_geo.json
node tools/build-map-json.mjs     # 转成地图渲染用的区域数据
node tools/build-terrain.mjs      # 真实 DEM → 地表贴图 / 法线贴图
node tools/build-map-texture.mjs  # 合成最终地图贴图

node tools/shot.mjs --url "http://localhost:5199/#/" --out tmp-shot/a.png --wait 12000
node tools/shot.mjs --audit --url "http://localhost:5199/#/" --out tmp-shot/a.png   # 设计规范量化探针
node tools/accept.mjs             # 9 路由全量验收（截图 + 探针 + console error）
```

`tools/shot.mjs` 是零依赖的 CDP 无头截图工具，`--audit` 会统计**字号层级数 / 有色边框占比 / 去重后的文字·背景·边框色数量**，用于把「视觉是否统一」变成可量化指标。

`tools/accept.mjs` 汇总全部路由的验收结果到 `tmp-shot/accept-<宽>/report.md`，有 console error 时退出码为 1。

> 注意本项目使用 **HashRouter**，路由要写成 `#/orders`，直接写 `/orders` 会落到总览页。

---

## 验收

当前状态：

```text
tsc  -p tsconfig.app.json   → 0 错误
eslint src                  → 0 问题
vite build                  → 通过
9 路由 × 1920×1080 / 1280×720 → console error 0
```

设计规范符合度（`node tools/accept.mjs` 实测）：

| 路由 | 字号层级 | 文字色 | 背景色 | 边框色 |
| --- | --- | --- | --- | --- |
| `/` | 5 | 7 | 9 | 3 |
| `/orders` | 5 | 5 | 8 | 3 |
| `/mapping` | 5 | 6 | 9 | 3 |
| `/twin` | 5 | 6 | 9 | 3 |
| `/adapt` | 5 | 5 | 8 | 3 |
| `/knowledge` | 4 | 5 | 8 | 3 |
| `/archive` | 5 | 5 | 8 | 3 |
| `/console` | 5 | 6 | 7 | 3 |
| `/present` | 4 | 7 | 6 | 1 |

三档分辨率（1920×1080 / 1672×940 / 1280×720）左右面板均分列、不重叠、不覆盖地图核心区域、不溢出。

---

## 已知限制

1. **全程无头 Chrome + SwiftShader 软件渲染验证**，色彩与真实 GPU 存在差异，建议在目标机器上人工复核地图明暗与发光强度。
2. **真实麦克风 ASR 未做实机验证**（无头环境无麦克风权限），已验证的是脚本化降级路径；真实分支的代码逻辑已实现但未经实机运行。
3. 字体文件 HarmonyOS Sans SC 两个字重各约 8MB（共约 16MB）。本地演示无影响，若要部署到服务器建议做子集化。
4. `src/pages/MumaiDashboard/map/` 是早期地图实现，已被 `mapDemo/` 取代，目前是死代码，保留仅供对照。
5. 演示数据全部为种子回放，未接入真实设备、ROS 或后端服务。
