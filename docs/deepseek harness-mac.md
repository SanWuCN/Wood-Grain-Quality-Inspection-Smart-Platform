# deepseek harness · Mac 交接说明

> 给 macOS 上的 DeepSeek Harness。接手继续开发「木脉智检 · 古建筑智能巡检平台」演示版。
>
> **分支约定：只在 `RAO` 上工作，不要动 `main`。** 所有提交与推送都到 `RAO`。
> 仓库：https://github.com/SanWuCN/Wood-Grain-Quality-Inspection-Smart-Platform

---

## 0. 一句话背景

古建筑木构无损检测比赛演示平台。三维地图为主入口，全国省级地图可下钻到上海市 district 级；业务围绕工单、风险、文保点位、设备采集、模型适配展开；内置一个能调真实前端能力、能多步编排任务的语音智能体「小木」。

**演示数据全部是种子回放**（`source_mode = replay / simulation`），不含真实设备接入。

---

## 1. Mac 上先跑起来

```bash
git clone https://github.com/SanWuCN/Wood-Grain-Quality-Inspection-Smart-Platform.git
cd Wood-Grain-Quality-Inspection-Smart-Platform
git checkout RAO          # ← 必须，不要留在 main

corepack pnpm install     # 第一次会下载依赖
npx vite                  # 端口固定 5173（vite.config.ts 的 server.port，strictPort）
```

浏览器打开 http://localhost:5173

> 仓库根目录的 `start-demo.cmd` 是 **Windows 专用**，Mac 上忽略它，直接用上面的命令。

**四个账号**（口令统一 `123456`，前端 localStorage，演示用）：

| 账号 | 姓名 · 角色 | 可见导航 | 默认工作区 |
| --- | --- | --- | --- |
| `shen` | 沈 · 项目经理 | 8 项 | `/orders` |
| `shi` | 史 · 人工智能架构师 | 8 项 | `/` |
| `rao` | 饶 · 全栈开发工程师 | 5 项 | `/hardware` |
| `mayutian` | 马昱天 · 具身智能工程师 | 2 项 | `/mapping` |

开发这四个页面时用 `shi`（全权限）最方便。

### 截图 / 验收（Mac 已适配）

`tools/shot.mjs` 会自动探测 Chrome：`/Applications/Google Chrome.app/...`、Chromium、Edge，也支持 `CHROME_PATH=/path/to/chrome` 覆盖。

```bash
# 截图（--init 是必需的：不写会话截到的是登录页）
node tools/shot.mjs --url "http://localhost:5173/#/" --out tmp-shot/a.png --wait 22000 \
  --init "localStorage.setItem('mumai.session', JSON.stringify({accountId:'shi',login:'shi'}))"

# 设计规范量化探针（字号层级 / 有色边框 / 颜色数量）
node tools/shot.mjs --audit --url "http://localhost:5173/#/" --out tmp-shot/a.png --wait 22000 --init "..."

# 全路由验收（截图 + 探针 + console error，有 error 退出码 1）
node tools/accept.mjs
```

类型与规范：

```bash
npx tsc --noEmit -p tsconfig.app.json    # 基线：0 错误
npx eslint src                           # 基线：0 问题
```

---

## 2. 你负责的四个页面

### ① 总览页 `/` — `pages/Overview.tsx`（约 560 行）

**已重构为四个浮层看板**，地图铺满内容区、面板浮在其上：

| 位置 | 看板 | 内容 |
| --- | --- | --- |
| 左上 | 巡检态势 | 覆盖省份 / 古建点位 / 完成巡检 / 完成率 + 四态分布，数字由 `seed/sites.ts` 现算 |
| 左下 | 设备状态 | 扫描枪 / 演示车 / 实机 + 四路通道状态 + 地图版本 |
| 右上 | 风险与工单 | 计数 + 工单列表 + 当前工单卡 + 「查看工单 →」 |
| 右下 | 待办与最近事件 | 待办 + 最近事件 + 历史风险统计 |

**⛔ 绝对不要再放「四柱构件状态」看板。** 那四根柱子（Z01–Z04）是比赛当天到现场才见到的场地，去之前团队并不知道是哪四根。平台在总览页展示它们的采集状态，等于自认数据是编的。这是用户明确指出的问题，已经删掉过一次。

**可以做的**：
- 文案二轮（见第 5 节判据）
- 地图点位被遮挡的技术债（见第 4 节坑 5）
- 看板信息密度与视觉层级继续打磨

**关键文件**：`pages/Overview.tsx`、`pages/overview.constants.ts`、`seed/sites.ts`、`mapDemo/`、`pages.css` 的 `.ov*` 段（注意 `.ov > .ov__side > .ov__panel` 的 `position: absolute` 覆盖不能删，删了四个面板会全部退回文档流）

---

### ② 建图巡检 `/mapping` — `pages/Mapping.tsx`（约 297 行）

**已知缺口（P1）**：

> **`?site=` 参数没有被消费。** 地图点位点击「有任务的点位」会跳到 `/mapping?site=<id>`，但本页没有 `useSearchParams`，所以页面不会高亮对应航点。

**要做的事**：
- 读 `useSearchParams().get("site")`，把点位映射到 `WAYPOINTS`（`seed/scenario.ts`）并高亮。示例寺对应 P2–P5，`seed/sites.ts` 已导出 `waypointForSite(site)` 可直接用。
- 俯视栅格视图现在有三条渲染路径（`RvizView.tsx`）：真实流（`url` + `kind: mjpeg|webrtc`）、静态 `image`、内置 `DemoRvizCanvas`（RViz 风格：`#303030` 底、白色占据栅格、红色激光点、青色 Global Plan、蓝色 Local Plan、绿色位姿箭头、1m 网格、比例尺）。演示默认走静态图 `public/rviz-reference.png` —— **串流接口是留好的**，接实机时填 `url` 即可切到真实画面，页面其它部分不用动。

---

### ③ 数字孪生 `/twin` — `pages/Twin.tsx`（约 551 行）

**这是四个页面里完成度最低的，PRD 差距分析里被点名「不是孪生」。**

| 问题 | 位置 | 说明 |
| --- | --- | --- |
| 手搓低模 | `Twin.tsx:47-229` | 低模庭院 + 圆柱，不是真实重建产物 |
| 无高斯泼溅 | `package.json` / `public/` | 没有 Spark / 高斯依赖，也没有场景产物 |
| 图层开关空操作 | `Twin.tsx:38-39, 282-283` | `route` / `history` 两个开关传进 `TwinScene` 后完全没用 |
| 视角书签与「复位」不动相机 | `Twin.tsx:321-322` | 只 `toast("视角已复位到殿内总览")`，相机没动 |
| 波形写死 | `Twin.tsx:293` | `const waveform = WAVEFORMS[0]` —— 永远是初扫 `wf-Z04-001`，复扫的三处标记（0.71 / 0.84 / 0.87）在孪生页永远看不到 |
| `hotspot.history` 未渲染 | 全库 | `HOTSPOTS[].history` 有 3 条处理记录，没有任何页面渲染 |

**优先做**：把 `route` / `history` 图层接进场景 → 「复位」真的动相机 → 波形按当前构件取（`wf-Z04-002` 才是复扫）→ 渲染 `hotspot.history`。

---

### ④ 硬件详情 `/hardware` — `pages/Hardware.tsx`（新建）

**由原「检测适配」拆出**，三个页签：

| 页签 | 来源 | 内容 |
| --- | --- | --- |
| 采集作业 | `adaptTabs.tsx` 的 `CaptureTab` | 采集配置、批次、启动/暂停、三路接收 |
| 异常排查 | `adaptTabs.tsx` 的 `TriageTab` | 设备 / 信号 / 测区 / 适用域四项排查与签名 |
| 硬件监看 | **本页新写** | 扫描枪实况、四路通道、采集批次三路接收、参考样本 |

`adaptTabs.tsx` 是原 `Adapt.tsx` 改名而来，6 个页签组件改为导出，被 `Hardware.tsx` 与 `Firmware.tsx` 各自组合 —— **已经按 PRD 做完的内容不要重写**。

**可以做的**：硬件监看现在偏静态（读数来自 seed），可以加入更真实的数据监看形态；文案二轮。

---

## 3. Mac 与 Windows 的差异（重要）

| 事项 | Windows | Mac |
| --- | --- | --- |
| 启动脚本 | `start-demo.cmd` | 无，直接 `npx vite` |
| 截图工具 Chrome 路径 | 自动探测 `Program Files` | 自动探测 `/Applications`；也可 `CHROME_PATH=` 覆盖 |
| 换行符 | 仓库有 `.gitattributes`（`* text=auto eol=lf`） | 同样生效，无需额外处理 |
| **chokidar EBUSY 崩溃** | **会**（编辑器锁文件被 watch 到 → Vite 进程直接退出） | 一般不会，但 `vite.config.ts` 里的 `server.watch.ignored` **请保留**，团队里可能还有人在 Windows 上开发 |
| 端口 | 5173 | 5173（`strictPort: true`，被占用会直接报错而不是换端口） |

---

## 4. 必须知道的坑

每一条都是实际踩出来的。

**① `<Suspense>` 边界外不要用会挂起的资源加载。**
drei 的 `useTexture` 走 suspend-react：只要有一个加载不 resolve，**整个边界永远不 commit** —— 现象是地图整块消失、只剩 Canvas 背景，而且**完全静默**（无报错、无异常）。地图贴图一律用自写的 `mapDemo/useImage.ts`。

**② 雾的远近必须跟着取景距离走。**
Demo2 写死 `fog(color, 10, 30)`，因为它相机恒定在约 13 单位外。本项目取景距离由投影包围盒反解（中国约 96），固定 10~30 会让整幅地图被**全雾成纯黑** —— 现象是「地图乌漆嘛黑，只有放大才看得见」。

**③ 「先隐藏再播放」的动画模式有致命失败面。**
只要隐藏发生了、播放那段因为任何原因没跑，元素就**永远停在屏幕外**。入场动画一律带无条件兜底：到点强制清掉内联 `transform/opacity`。初始隐藏态写进 CSS（`body.is-entering`），不能用 JS —— 路由页面是懒加载的，Shell 挂载那一刻它还没进 DOM，用 JS 会「先到位再重播」。

**④ 无头 Chrome 的 rAF 只有约 1fps。**
截图时入场动画可能看起来「没播完」，这是环境限制不是代码问题。另外**改文件会触发 HMR 重放入场**，截图前要静置，`--wait` 给足（首页至少 22s）。

**⑤ 地图的两个几何事实。**
- `extrudeGeometry` 沿 **+Z** 挤出，外层 group 绕 X 轴 -90° 后 +Z 朝上，所以挤出体占 `z ∈ [0, slabDepth]`，**顶面就是 `z = slabDepth`**。
- 地图点位现在用 `depthTest: false` 绕过 z-fighting（等于永远画在地图之上，偏钝）。**更好的做法**：给顶面加 `polygonOffset`，或把点位抬高一个可见量。
- 装饰尺寸统一乘 `deco = 地图投影半径 / 参考半径`。中国与上海跨度差 13 倍，不换算会一张「装饰看不见」一张「装饰糊住地图」。

**⑥ 本项目是 HashRouter。**
路由必须写成 `#/orders`，直接写 `/orders` 会落到总览页。

---

## 5. 两条必须遵守的原则

### 文案判据（用户明确要求，语气很强）

> **一句话如果在向读者解释「这套系统是怎么想的」，而不是陈述「当前发生了什么」，它就不该出现在生产界面里。**

平台要包装成**一家公司真实投入使用的系统**。用户原话：

> web 很多内容文字太假了，专业的施工管理平台哪里有如图这种表述，一眼假，平台也不会太多篇幅解释功能啊，都是专业人员去用的，平台一定要包装的像一家公司真实投入使用的。

**禁止出现在界面上**：PRD 条款号、源码文件名、内部函数名、设计说明段落、教用户理解业务的长句。
**面板标题必须是名词短语**：`训练任务` ✅ / `用新采集的数据重训练` ❌。

已经清理过一轮（删了 6 段设计说明、8 个带括号的面板标题、4 处教学式提示，清掉了所有 PRD / 源码引用），**还剩二轮**：
- `adaptTabs.tsx` 六个页签的按钮名与状态文案
- 各页 `hint` 里仍偏教学的部分
- `SourceTag`（「演示回放 / 模拟采集」）现在每页都挂，建议**降视觉权重而不是删**（PRD 1.2 要求标数据来源）
- 空态文案（`StateBlock` 的 title/hint）整体偏啰嗦

**扫这两个工具**：

```bash
node tools/copy-audit.mjs      # 列出界面上的解释性长句
node tools/panel-titles.mjs    # 列出所有面板标题，标出偏长的
```

### 数据判据

- 所有数字与文案来自 `seed/`，**页面不硬编码**。
- **未检测一律用 `null` 表达「未采集」，不用 0 冒充「无风险」。**
- **不要展示比赛当天才知道的信息。** 示例寺的四根柱子就是现场才见到的场地 —— 这是「四柱构件状态」看板被删掉的根本原因。

---

## 6. 架构速查

```
src/
├── styles/tokens.css                 设计 token，唯一主题来源（颜色/字号/间距只能用它）
├── pages/MumaiDashboard/
│   ├── routes.tsx                    9 个路由（/login 在外壳之外，其余包在 RequireLogin 里）
│   ├── auth.ts                       账号 / 28 项权限 / 路由权限表 / 会话读写
│   ├── Shell.tsx                     外壳 + 导航过滤 + 路由守卫
│   ├── entrance.ts + entrance.css    入场编排（CSS 负责初始隐藏态）
│   ├── Panel.tsx / ui.tsx            折角面板与共享组件（Toolbar / Btn / StatusChip / KV / DataTable / StepFlow / WaveChart…）
│   ├── seed/                         唯一数据源
│   │   ├── scenario.ts               工单 / 构件 / 批次 / 环境 / 知识库 / 波形
│   │   ├── sites.ts                  地图点位（全国 27 / 上海 12）+ waypointForSite()
│   │   └── versions.ts               版本管理矩阵 + 训练流水线阶段
│   ├── pages/                        业务页（你负责 Overview / Mapping / Twin / Hardware）
│   ├── mapDemo/                      三维地图（迁移自上游 Demo2）
│   ├── map/                          早期地图实现；SiteMarker / status / store 仍在使用
│   ├── agent/                        语音智能体
│   └── knowledge/                    知识库逻辑与图表
└── docs/
    ├── design/视觉设计规范-v1.0.md     视觉唯一权威
    ├── 语音语义Agent技术方案.md
    ├── prd-gap-analysis.md           150 条需求逐条核查（查「已实现/部分/未实现」看这个）
    └── 交接说明.md                    Windows 侧交接（含完整历史与全部待办分级）
```

---

## 7. 提交与推送约定

```bash
git checkout RAO                 # 确认在 RAO 上
git add -A
git commit -m "feat(overview): …"     # 提交信息写「为什么」，不只是「做了什么」
git push origin RAO
```

- **不要 push 到 `main`，也不要把 RAO 合并进 `main`。**
- 提交信息用中文可以，但要写清动机。仓库现有提交的风格可参考 `git log`。
- 推送前至少跑 `npx tsc --noEmit -p tsconfig.app.json` 与 `npx eslint src`，两者基线都是 **0**。
