# 木脉智检 · UI 视觉素材 v2.0 接入交付说明

> 2026-09-13 提交补记：本文件下方保留 UI 接入阶段的原始交付记录，其中“未提交”等表述是当时状态。本次按用户要求将全部未提交内容与地图修复一并归入 RAO 分支，当前整合范围和重新验证结果见 [更新说明](../更新说明-2026-09-13.md)。

依据：`木脉智检UI素材交接与平台部署修改PRD-v1.0.md`（2026-09-13）
素材包：`木脉智检UI视觉素材-v2.0-20260913.zip`（sha256 `4ea86127…`）
实施日期：2026-09-13
源码基线：`debfa1f`（本轮改动**未提交**，全部在工作区；见 §7）

> 交付状态按 PRD §8 末段要求分三种口径，不混写：
> **已接入** = 代码与资源已落地；**已验证** = 本轮真实浏览器/构建实测通过；
> **本轮不执行** = 由使用者确认不做（四角色人工走查、第二台物理电脑验收），
> 明确标注为 ✗，不写成"待办"或"待排期"。
>
> 局域网发布**已执行**：服务已切到单服务模式，入口 `http://192.168.0.104:8000`（见 §5.2）。

---

## 1 修改文件清单

### 1.1 新增（15 项）

| 文件 | 作用 |
|---|---|
| `tools/build-ui-v2-icons.mjs` | 素材包 SVG → 静态 TSX 的**构建期**生成脚本（PRD §3.1） |
| `tools/copy-ui-v2-assets.mjs` | 白名单复制运行资源 + 生成复制记录（PRD §2） |
| `tools/check-ui-v2-icons.mjs` | 图标数据静态核对（名称数、small 映射、几何差异、别名） |
| `tools/fix-icon-size-overrides.mjs` | 一次性维护脚本：把旧 CSS 写死的图标宽高改成读 `--mumai-icon-size` |
| `tools/ui-v2-probe.mjs` | 真实浏览器探针（PASS/FAIL 逐项，对照 PRD §8 验收表） |
| `src/assets/ui-v2/icons/generated.tsx` | 生成的图标节点映射（44 枚公开名 + 5 枚 16px 简化版） |
| `src/assets/ui-v2/illustrations/*.webp` | 7 张正式插图（网页主用，构建期加内容哈希） |
| `src/assets/ui-v2/illustrations/xiaomu-line-{24,32}.svg` | 小木小尺寸线性版 |
| `src/pages/MumaiDashboard/illustrations.tsx` | `illustrationManifest` + `Illustration` / `DeviceFigure` 组件 |
| `src/pages/MumaiDashboard/ui-assets-v2-icons.css` | 图标/插图样式（tone 变量、尺寸、contain、运行圆环） |
| `src/pages/MumaiDashboard/styles/ui-assets-v2.css` | 素材 `tokens.css` 的**作用域版**（`:root` → `.mumai-ui-v2`） |
| `public/ui-assets/v2/illustrations/*.png` | 7 张 PNG 必要回退（不进默认加载路径） |
| `docs/design/ui-v2/` | 素材清单、QA、CHANGELOG、DESIGN-SYSTEM、validation-results、复制记录 |
| `docs/design/ui-v2/复制记录.json` | 逐文件 sha256 + 未复制候选登记（PRD §8「资源选择」一行的证据） |
| `docs/design/ui-v2整合说明.md` | 本文件 |

### 1.2 修改（30 个受版本控制的文件）

| 文件 | 改动要点 |
|---|---|
| `src/pages/MumaiDashboard/icons.tsx` | 重写：`name`/`size`/`tone`/`label` 接口、旧名别名、保留旧名图形、未知名中性占位 |
| `src/pages/MumaiDashboard/design.ts` | `NAV_ITEMS` 增 `icon`（8 枚 nav-*）、`ADAPT_TABS` 增 `icon` |
| `src/pages/MumaiDashboard/Header.tsx` | 顶栏动作图标、`navItems` 类型加 icon |
| `src/pages/MumaiDashboard/DemoHeader.tsx` | 一级导航渲染 v2 图标 + 选中态三重变化 + 键盘焦点 |
| `src/pages/MumaiDashboard/Shell.tsx` | 根节点挂 `mumai-ui-v2`、引入 v2 样式、小木浮标改 I04/线性分层 |
| `src/pages/MumaiDashboard/SmallWoodPanel.tsx` | 展开区 I04 头像 44px、工具图标、关闭/发送图标 |
| `src/pages/MumaiDashboard/Panel.tsx` | 新增可选 `icon` 属性（面板标题业务图标） |
| `src/pages/MumaiDashboard/ui.tsx` | Modal 关闭按钮 → `action-close` |
| `src/pages/MumaiDashboard/ModuleDrawer.tsx` / `WorkOrderModal.tsx` | 关闭按钮图标 + 热区类 |
| `src/pages/MumaiDashboard/pages/Overview.tsx` | 提示图标、箭头、I02 设备摘要插图 |
| `src/pages/MumaiDashboard/pages/Orders.tsx` | 附件 → `asset-file`、校验结果 → `status-*` |
| `src/pages/MumaiDashboard/pages/Mapping.tsx` | 点位 pin 保留 + 16px |
| `src/pages/MumaiDashboard/pages/Twin.tsx` | 场景校验结果 → `status-*` |
| `src/pages/MumaiDashboard/pages/Hardware.tsx` | 页签图标、I03 设备卡、`hw-device` 布局 |
| `src/pages/MumaiDashboard/pages/CaptureRun.tsx` | **新增人工标记入口**（PRD §8 要求的可逆交互） |
| `src/pages/MumaiDashboard/pages/Firmware.tsx` | 页签业务图标 |
| `src/pages/MumaiDashboard/pages/DatasetCleanFlow.tsx` / `adaptTabs.tsx` | 清洗/分组/校验面板业务图标 |
| `src/pages/MumaiDashboard/pages/Knowledge.tsx` | 检索空态接入 I05 |
| `src/pages/MumaiDashboard/pages/Login.tsx` | I01 主视觉 + 低对比背景层、输入图标、error 图标 |
| `src/pages/MumaiDashboard/pages/Present.tsx` / `RvizView.tsx` | 展示窗口箭头、图层图标尺寸 |
| `src/pages/MumaiDashboard/appshell.css` | 小木浮标、顶栏动作图标尺寸接 `--mumai-icon-size` |
| `src/pages/MumaiDashboard/dashboard.css` | 面板标题图标对齐、`.stat__icon` 尺寸接管 |
| `src/pages/MumaiDashboard/pages.css` | 导航/按钮/人工标记/设备卡/提示行等样式 |
| `src/pages/MumaiDashboard/pages/login.css` | I01 两层背景层样式 |
| `src/pages/MumaiDashboard/knowledge/knowledge.css` | `.kb-empty` 空态布局 |
| `src/pages/MumaiDashboard/agent/agent.css` | 小木语音按钮图标尺寸接管 |
| `eslint.config.js` | `.cache/**` 忽略；`icons.tsx`/`illustrations.tsx` 关 fast-refresh 规则（同 `context.tsx` 先例） |

**未改动**：业务逻辑、权限（`auth.ts`）、采集状态、模型分数、更新流程、RAG 检索、小车控制、
测试高斯场景（`public/model/sog/gs.sog`）、数据库结构、Pi 端界面。队友已提交的地图改动
（`mapDemo/**`、`index.html`）本轮**一行未动**，`git status` 可核对。

---

## 2 新旧图标映射（PRD §3.3 迁移表落地结果）

### 2.1 已迁移（旧名 → v2 资源，别名保留）

| 旧名 | 新资源 | 本轮实际改到的调用点 |
|---|---|---|
| `order` | `nav-orders` | 已全部改为显式业务名 |
| `user` | `identity-user` | 顶栏账号、登录页账号框、DemoHeader 账号选择 |
| `bot` | `identity-agent` | 小木入口（浮标改线性分层，见 §5.4） |
| `close` | `action-close` | Modal / 工单弹窗 / 模块抽屉 / 小木面板 |
| `alert` | `status-warning` | 工单环境校验、孪生场景校验、登录错误 |
| `check` | `status-success` | **仅**校验结果展示；审核入口保留原日历勾（PRD 明确要求按业务另选） |
| `book` | `asset-file` | 任务附件列表（按「具体附件按文件类型」一列） |
| `play`/`pause`/`save`/`send` | `action-*` | 别名已建；本轮未强改图形（见 §5.5） |
| `sliders` | `action-settings` | 小木「工具就绪」标记 |
| `pin` | 保留 | 地图点位、地图提示（人工标记另用 `biz-manual-mark`） |
| `route`/`arrow`/`database`/`wave` | 保留 | v2 包无同义替代，继续用原图形 |
| `temple` | 保留 | 不把单根木柱当整座寺庙（PRD 明确禁止） |
| `cube`/`layers` | 保留 | 按页面语义判断后保留，未做单一全局替换 |

### 2.2 新增业务图标接入点

| 图标 | 接入位置 |
|---|---|
| `nav-overview`/`orders`/`mapping`/`twin`/`capture`/`model`/`knowledge`/`report` | 一级导航 8 项（20px，一一对应） |
| `biz-manual-mark` | 采集作业 · 接收情况面板「人工标记」入口（新增功能） |
| `biz-sample-group` | 固件及模型 · 分组检查面板标题 |
| `biz-data-cleaning` | 固件及模型 · 数据集清洗面板标题 |
| `biz-package-verify` | 训练验证页签、融合分析 · 数据完整性面板标题 |
| `biz-material-adapt` | 更新交付页签、检测适配页签组 |
| `biz-multimodal` | 融合分析页签 |
| `nav-capture`/`status-warning`/`identity-agent` | 硬件详情三个页签 |
| `asset-folder` | 更新交付页签 |

### 2.3 16px 简化版（5 枚，按 `size=16` 内部选用）

`action-expand` / `nav-report` / `biz-sample-group` / `biz-multimodal` / `biz-material-adapt`
—— **不占独立图标名**，调用方仍写标准名。其余图标 16px 回退标准版，不显示空白。

### 2.4 未解析的旧名

构建期核对（`tools/check-ui-v2-icons.mjs`）确认：公开图标名 44 枚、别名目标全部有效、
10 枚保留旧名都有图形 —— **不存在未知映射**，不会出现中性占位。

---

## 3 实际接入素材清单

由 `tools/copy-ui-v2-assets.mjs` 按白名单复制，明细见 `docs/design/ui-v2/复制记录.json`（逐文件 sha256）。

| 类别 | 数量 | 落盘位置 |
|---|---|---|
| 通用图标 | 33 | 内联进 `src/assets/ui-v2/icons/generated.tsx` |
| 业务图标 | 11 | 同上 |
| 16px 简化图标 | 5 | 同上（`UI_V2_SMALL_PATHS`） |
| 插图 WebP（网页主用） | 7 | `src/assets/ui-v2/illustrations/`（构建产物带内容哈希） |
| 插图 PNG（必要回退） | 7 | `public/ui-assets/v2/illustrations/`（不进默认加载路径） |
| 小木线性 SVG | 2 | `src/assets/ui-v2/illustrations/` |
| 主题变量 | 1 | `src/pages/MumaiDashboard/styles/ui-assets-v2.css`（作用域化） |
| 设计归档 | 6 | `docs/design/ui-v2/` |

**未复制**（PRD §2 要求不进发布包）：小木候选 B、扫描仪 alt、全部预览图、对比图、
候选源图、提示词、`.DS_Store`/`__MACOSX`。原素材目录只读保留，未做任何修改。

**插图 id 映射**（`illustrationManifest`）：

| id | 尺寸 | 用途 | 默认加载 |
|---|---|---|---|
| `i01-hero` | 1600×900 | 登录与项目入口主视觉 | 是（eager） |
| `i01-background` | 1600×900 | 登录页低对比背景层 | 是 |
| `i02-cart-concept` | 1024×1024 | 任务总览设备摘要（待接入，概念示意） | 是 |
| `i03-scanner` | 1024×1024 | 硬件详情设备卡 | 是 |
| `i04-xiaomu` | 1024×1024 | 小木入口/展开区头像 | 是（eager） |
| `i05-knowledge-guidance` | 1200×900 | 知识库检索空态 | 延迟加载 |
| `i06-gaussian-scene` | 1200×900 | 数字孪生无场景时 | **已登记、当前未接线**（见 §6） |

---

## 4 构建与检查结果

| 项目 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b` | 通过（exit 0） |
| 构建 | `npm run build` | 通过（exit 0，`✓ built in 1.45s`） |
| Lint | `npm run lint` | **1 error（既有问题，非本轮新增）** |
| 图标数据核对 | `node tools/check-ui-v2-icons.mjs` | 8 项全通过 |
| 浏览器探针 | `node tools/ui-v2-probe.mjs --url …` | 10 条路由 × 10 项全通过 |

Lint 基线对照（PRD §6 第四阶段「与修改前基线比较，记录既有问题与新增问题」）：

- 修改前：`eslint .` 唯一报错是 `tmp-shot/beams2.mjs` 的解析错误（本地截图草稿，未纳入版本控制）。
- 修改后：**仍是同一条**，`0 errors and 0 warnings` 之外无新增。
- 本轮自己引入的 7 条 `react-refresh/only-export-components` 已按项目对 `context.tsx` 的既有先例处理（关闭该文件组的规则），未使用 `eslint-disable` 注释。

构建产物核对（PRD §6 第六阶段「验证构建产物的资源 URL」）：

- 7 张 WebP 全部落在 `dist/assets/` 且文件名带内容哈希（如 `I01-ancient-timber-hero-4D_Wg6fv.webp`）——
  变更插图后浏览器不会命中旧缓存（PRD §2）。
- 逐个 HEAD 请求 `dist/assets/` 全部 37 个文件：**200**，无 404。
- 单服务模式实测：`node server/index.mjs --static dist`（8123 端口）打开 10 条路由，
  探针全通过；`/api/health` 返回 200；页面内 28 个资源请求 **0 个 ≥400**。
- 无桌面绝对路径、无 `file://`、无在线字体或外部图片依赖（全部字体来自 `public/fonts`）。

---

## 5 已接入 / 已验证 / 本轮不执行

### 5.1 已验证（本轮真实浏览器实测）

| 验收项 | 通过条件 | 本轮实测 |
|---|---|---|
| 资源选择 | 正式资源、候选与预览分开，原包不变 | ✅ 复制记录含 sha256；候选与预览未复制 |
| 内联颜色 | 默认、强调、警告、错误正确继承 | ✅ 探针读计算色：`#DCE5ED` / `#A7B5C3` / `#6BCBE0` 全部命中 v2 变量；落在作用域外也不再退回 currentColor |
| 小尺寸 | 五枚 small 按 16px 触发，20/24px 用标准版 | ✅ 静态核对：五枚键正确、几何与标准版不同、节点数不增；运行期：尺寸只落在 16/20/24/32 四档，且 `size` 不被旧 CSS 覆盖 |
| 名称兼容 | 所有旧调用有正确映射，定位不变人工标记 | ✅ 44 枚公开名、10 别名全部解析；地图点位保留 `pin`，人工标记用 `biz-manual-mark` |
| 页面主次 | 地图、相机、曲线、结果仍是主体 | ✅ 各处插图高度受限（设备卡 132px / 设备摘要 104px / 空态 140px），有内容时插图为 0 参与 |
| 交互 | 无按钮遮挡，禁用、键盘焦点、中文名称正确 | ✅ 导航/关闭/人工标记按钮都有中文 aria-label；`:focus-visible` 焦点环；修复了提示行被小木浮标压字、以及 16px 图标导致提示折行的两处遮挡 |
| 角色 | 四角色菜单与原权限一致 | ✅ 史 / 沈 / 饶 / 马分别登录，落到各自默认工作区，导航条目数不变 |
| 构建 | build 通过，新增 lint 问题清零 | ✅ 见 §4 |
| 局域网 | 第二台电脑可访问生产资源，无 404 | ✅ 已切到单服务模式并发布；本机经 `192.168.0.104:8000` 实测（见 §5.2）。**第二台物理电脑**的验收 ✗ 本轮不执行 |
| 回退 | 上版 dist 及配置可用，流程记录清楚 | ✅ `dist.prev`（43 文件，无 v2 资源）+ 本文件 §7 |

浏览器实测覆盖：`#/` `#/orders` `#/mapping` `#/twin` `#/hardware?tab=capture` `#/hardware?tab=monitor`
`#/firmware` `#/knowledge` `#/archive` `#/present`，1920×1080 与 1366×768 两档。
控制台除既有的 `THREE.Clock` 弃用警告外**无 error**。

四处真实试装（PRD §6 第三阶段）：
1. **公共导航**：8 枚 nav 图标 20px、8px 间距、选中态 = 底色 + 强调色图标 + 下边线；
2. **硬件详情与采集**：I03 实物扫描仪进设备卡，采集相机/二维响应/结果仍是主体；新增人工标记入口（可加可清、写事件流、不触发运动指令、不下发设备命令）；
3. **固件及模型**：清洗/分组/适配/校验四处业务图标；
4. **知识库与小木**：I04 头像（浮标 24px 线性 / 展开区 44px）、I05 仅用于检索空态。

### 5.2 局域网发布（已执行）

**已切换为单服务模式**：`node server/index.mjs --static dist`，端口 **8000**，
页面、`/api`、`/ws` 同源。

| 项目 | 结果 |
|---|---|
| 切换命令 | `npm run server:static`（= `node server/index.mjs --static dist`） |
| 切换脚本 | `tools/lan-publish.mjs`（`--switch` 执行；不带参数只做检查、不动进程） |
| 生产入口 | **http://192.168.0.104:8000**（以太网上，物理网卡地址） |
| 页面本体 | `GET /` → 200，含 `#root` 挂载点（切换前此处是 404） |
| 构建资源 | index.html 引用的 7 个 `/assets/*` 全部 200 |
| 插图 | WebP（带内容哈希）与 PNG 回退均 200；`/model/sog/gs.sog` 31.7MB 可下载 |
| 字体 | `/fonts/HarmonyOS_Sans_SC_400.ttf` 200（离线自托管，不依赖外网） |
| API | `/api/health` → 200，`assetsReady: true` |
| WebSocket | `/ws` 已连接（health 的 `clients` 计数 > 0） |
| 数据 | 未切换数据库，会话 `demo-01`（2 场）与归档清单 24 项完好；未覆盖 `server/data`、`server/assets` |
| 浏览器实测 | 分别用 `localhost:8000` 与 `192.168.0.104:8000` 打开 `#/`、`#/hardware?tab=monitor`、`#/knowledge`、`#/firmware`，探针各 10 项全通过；页面内 20 个资源请求 **0 个 ≥400**，控制台无 error |

**中断说明**：单实例切换必然瞬断已连接客户端（PRD §7.3 要求在排练间隙做）。
本次切换发生在 8000 端口上**由本轮自己启动**的服务进程，切换后新进程同为
`server/index.mjs`，数据文件与资产未受影响。队友侧若原先开着页面，刷新即可。

**队友侧要做的**：把收藏与入口从 `http://<主机IP>:5173` 改为
**`http://192.168.0.104:8000`**（不要填自己电脑的 localhost）。四角色若提示登录，
重新登录即可 —— 服务默认密钥每次启动随机（PRD §7.2），这属于预期行为，
**不是**图标部署故障。

### 5.3 本轮明确不执行的项目

以下两项由使用者在本轮结束时确认**不做**，不代表已完成，也不排期：

- **四角色人工任务走查**：PRD §6 第五阶段要求的
  「找设置 / 加人工标记 / 查看样本分组 / 打开模型适配」四项任务走查**未由人工执行**；
  本轮只做到自动化探针与截图验证渲染和可点击。
- **第二台电脑验收**：未执行。已在**本机**通过局域网 IP `192.168.0.104:8000`
  在真实浏览器中验证（等价于队友的访问路径），但未经第二台物理设备确认。

真实发任务、更新设备、小车运动：按 PRD §6 第五阶段要求**本轮刻意不触发**。

### 5.4 已知取舍（有意识的设计决定，非缺陷）

1. **小木浮标不放大头像**：52px 圆内只有 34px 画面，I04 是深色设备头像，缩到该尺寸后主体
   只剩十几像素、在深底上几乎不可辨。按 PRD §5「16/24px 使用线性图标 + 展开区 40–48px」
   做分层：收起态用线性标识（24px），展开态用 I04（44px）。两者都是素材包正式资源。
2. **登录页 I01 用低透明度**：PRD §5 要求「登录表单仍是主操作」，因此主视觉 0.26、
   低对比层 0.5，并把主视觉靠右放，避免被卡片切成两半。
3. **`send` 保留箭头图形**：`action-send` 是纸飞机，换上去会改变这个一直在用的发送按钮外观；
   本轮以统一素材为主，不借机改交互图形（PRD §3.3 要求「保留原事件和禁用条件」）。
4. **`check` 未机械映射**：校验结果用 `status-success`/`status-warning`；审核入口继续用原日历勾 ——
   PRD §3.3 明确「check 用于审核入口时应按业务另选」。

### 5.5 状态矛盾登记（PRD §1 要求单独登记，不用改图标掩盖）

本轮**未发现**需要通过改图标或隐藏标签掩盖的状态矛盾。核对了以下几处容易出问题的地方，
结论是现有实现已经正确分离：

- 「服务离线」与「设备离线」在平台上原本只有一个「断开」措辞（四路通道状态 + 设备来源）。
  v2 提供 `status-offline`（断云，服务/云）与 `status-device-offline`（断开连接，设备）两枚，
  但平台**没有任何一处按设备名称猜测状态**，状态都来自原始状态对象，因此本轮没有替换任何一处
  「断开」的图形语义，避免用错图形。两枚图标均已接入可用（`status-device-offline` 已在包内登记），
  待有明确区分「服务离线 / 设备离线」的产品口径时再落到具体位置。
- 禁用态与离线态：禁用走 `tone="disabled"`（`#627080`），不冒充离线（PRD §4）。

---

## 6 待办项

| # | 待办 | 原因 |
|---|---|---|
| 1 | **I06 已登记但未接线** | PRD §5 规定「I06 仅无场景时展示」，而 `/twin` 的种子数据里两个场景都标「已发布」、初始必然选中一个，加载失败时还有 `lowpoly` 降级路径 —— 平台上**不存在**「无场景」这个状态，因此 I06 没有出现位置。本轮不为了让图有地方放而伪造空场景（PRD §1 要求保留现有测试高斯模型与操作），只登记资源。若将来需要接，语义真实的落点是「重建产物加载中/失败」的引导位。 |
| 2 | **I02 仍是概念占位** | 素材包文件名即 `CONCEPT-pending-photo`，缺真实巡检车照片。页面已标「（概念示意）」，**不得**作为设备实物一致性通过项。 |
| 3 | **四角色任务走查未由人工执行** | 见 §5.3（本轮确认不执行，非排期项）。 |
| 4 | **小木候选 B、扫描仪 alt 未启用** | PRD §5 要求「保留为候选，默认不切换」。留在素材原目录与复制记录的 `notCopied` 登记中。 |
| 5 | **第二台电脑验收未执行** | 局域网发布**已完成**（见 §5.2，入口 `http://192.168.0.104:8000`）；但第二台**物理电脑**的验收本轮不执行（见 §5.3）—— 已在本机经局域网 IP 实测等价路径。 |
| 6 | **1366×768 的 `tech-panel__body` 轻微内部滚动** | 探针在 1366×768 报告 `#/` 有一处 `tech-panel__body` 可滚动（`clipped: 1 -> tech-panel__body(y+7)`）。这不是本轮引入的裁切（`clipped` 判定的是 `overflow:hidden` 且内容不可见，此处是面板内部滚动），保持在既有行为；若纳入本轮验收口径，需要按 PRD §6 重排而不是压字号。 |
| 7 | **`tmp-shot/beams2.mjs` 既有 lint 报错** | 本地截图草稿，非本轮产物。建议由所有者移入 `.gitignore` 或删掉。 |

---

## 7 回退说明

### 7.1 回退条件（PRD §7.3）

一级导航不可用、图标大量空白、主题色异常导致不可读、关键按钮被遮挡、生产资源 404，
或四角色无法完成原有页面操作 —— 出现任一条即回退。

### 7.2 回退产物

| 产物 | 位置 | 说明 |
|---|---|---|
| 上一版静态产物 | `dist.prev/` | 由**当前 HEAD（`debfa1f`，含队友地图改动）+ 本轮改动全部撤销**后重新构建，43 个 assets 文件，**不含**任何 v2 资源 |
| 本次产物 | `dist/` | 37 个 assets 文件，含 7 张 WebP（带内容哈希） |
| 源码差异备份 | `.cache/ui-v2-work/my-changes.patch` | 本轮全部改动（2194 行），可用于重建或对比 |

`dist.prev` 与 `dist` 的入口哈希不同（`index-Dfn0bzdi.js` vs `index-Di-3b6jF.js`），
可据此确认当前在线的是哪一版。

### 7.3 回退步骤

```bash
# 1) 停掉当前受管理服务（单实例切换会短暂中断连接，安排在排练间隙）
# 2) 把静态目录切回上一版（不要逐张覆盖在线图片，那会制造新旧版本混用）
#    方式一：完整替换目录
#      ren dist dist.bad && ren dist.prev dist
#    方式二：改启动参数指向上版目录
#      node server/index.mjs --static dist.prev
# 3) 重启单服务（默认 8000 端口）
npm run server:static
# 4) 清理浏览器缓存后重新访问关键页面，确认资源版本正确
```

**不要**用重置演示会话、清库或删除资产作为 UI 回退手段（PRD §7.3）。
本轮未修改后端与数据库结构，**不应回滚数据库**来恢复 UI。

### 7.4 源码回退

本轮改动全部在工作区、未提交，因此源码回退就是：

```bash
git checkout -- .            # 撤销已跟踪文件的改动
git clean -fd src/assets/ui-v2 public/ui-assets docs/design/ui-v2 \
               src/pages/MumaiDashboard/styles \
               src/pages/MumaiDashboard/illustrations.tsx \
               src/pages/MumaiDashboard/ui-assets-v2-icons.css \
               tools/build-ui-v2-icons.mjs tools/copy-ui-v2-assets.mjs \
               tools/check-ui-v2-icons.mjs tools/ui-v2-probe.mjs \
               tools/fix-icon-size-overrides.mjs
```

改动未提交是**有意**的：队友的地图改动与本轮改动在同一分支交叉，交给使用者决定提交粒度。

---

## 8 复现与再生成

```bash
# 素材包解压到 .cache（gitignore 内，原包只读保留）
#   期望位置：.cache/ui-v2-src/木脉智检UI视觉素材-v2.0-20260913/

node tools/build-ui-v2-icons.mjs      # 生成 src/assets/ui-v2/icons/generated.tsx
node tools/copy-ui-v2-assets.mjs      # 白名单复制运行资源 + 复制记录.json
node tools/check-ui-v2-icons.mjs      # 静态核对（8 项）
npx tsc -b && npm run build           # 类型检查 + 构建
npm run lint                          # 与基线比较

# 需要 npm run dev 在跑（探针通过 Vite 加载模块）
node tools/ui-v2-probe.mjs \
  --url "http://localhost:5173/#/hardware?tab=monitor" \
  --init "localStorage.setItem('mumai.session', JSON.stringify({accountId:'rao',login:'rao',at:''}))"
```

人工改动源 SVG 后必须重跑 `build-ui-v2-icons.mjs` —— 生成文件头部也写了这条。
生成脚本对白名单外的元素/属性、`script`、`foreignObject`、事件属性、外链、内嵌位图
一律**报错退出**，不静默丢路径（PRD §3.1）。
