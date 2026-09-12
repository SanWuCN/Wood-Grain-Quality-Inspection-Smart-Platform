# 木脉智检平台 · PRD 差距分析报告

> 评审对象：`F:\1\平台deepseek`（React 19 + Vite + Three.js 前端演示仓库）
> 对照基准：`prd及第二章剧本\木脉智检平台开发PRD（演示版）(1).md`（651 行，已完整读取）
> 　　　　　`prd及第二章剧本\3.1木脉智检（第二章）.docx`（已解包为纯文本 434 行，第一幕~第四幕 S01–S23 剧本）
> 评审方式：只读代码 + grep 取证，未运行 build / lint / dev server，未修改任何源文件。
> 结论口径：`已实现` = 代码中可稳定复现该行为；`部分实现` = 有代码但缺关键要素或不可达；`未实现` = 有需求无代码；`不适用` = 前端演示仓库范围外/属文档性要求。

---

## 0 摘要

| 指标 | 数值 |
| --- | --- |
| 拆解需求条目（主表） | **150** |
| 已实现 | **40** |
| 部分实现 | **81** |
| 未实现 | **25** |
| 不适用 | **4** |

一句话结论：
**这是「大屏视觉 + 单个总览页」完成度很高、但「八页业务闭环」完成度很低的仓库。**
视觉与地图部分（全国/上海 GeoJSON 挤出、地形贴图、光柱飞线、转场）远超 PRD 要求；
但 PRD 的核心诉求——**八页各自成体系、业务对象跨页互跳、上海下钻后的业务点位联动、四账号视角差异、数字孪生加载真实高斯成果、小木 14 条意图 + 数值口径正确**——大面积缺失。

最关键的 5 个结构性问题（详见 §3 专项核查）：

1. **首页地图上没有业务点位**：`Overview.tsx` / `Present.tsx` 用的 `mapDemo` 只画省界和上游 Demo2 的装饰性光锥（`mapDemo/base.tsx:280`），工单点、风险点、文保单位、当前巡检位置一个都没有。真正能画业务点的 `map/SiteMarker.tsx` + `map/MapScene.tsx` 是**死代码**（全库无 import）。
2. **首页信息架构被砍**：设计草图（`docs/design/*.png`）与旧实现（`MumaiDashboard/index.tsx`）里的「右栏工单列表 + 风险计数 + 当前工单卡 + 查看工单」「左栏态势指标 + 趋势/区县分布」「底部 slogan + 实时位置」在**已路由的 `Overview.tsx` 里全部不存在**；`WorkOrderModal`（Z04 融合证据 + 回波 + 处理时间线）也随旧实现一起失去入口。
3. **`lib.ts` 里 718 行「真算」逻辑全是死代码**：`validateEnvironment` / `checkGrouping` / `runEvaluation`（精确率、召回率、F1、按材种回归）/ `fuseByRule` / `runArchiveCheck` / `searchKnowledge`（真 TF-IDF + 余弦）**没有任何页面 import**，各页改为自己写弱化版，直接导致 PRD 3.6 / 3.8 / 5.2 / 12 的验收点不达标。
4. **数字孪生不是孪生**：`Twin.tsx` 用手搓的低模庭院 + 圆柱代替高斯场景，`package.json` 无 Spark/高斯依赖，`public/` 无场景产物；`route`/`history` 两个图层开关是空操作，视角书签与「复位」只弹 toast 不动相机。
5. **小木回答的数字与 PRD 硬冲突**：`SmallWoodPanel.tsx:58` 里 `total = 3 + 6 = 9`，而 PRD 5.3 / 14.3 与验收用例 A01 要求「共 6 处风险」；`reportedDone` 种子值 6，PRD 要求 4。加上 7 个 facts 键在映射表里不存在，多条回答会直接显示「未登记」。

---

## 1 总表（需求 → 状态 → 证据 → 差距）

> 证据列 `文件:行号`；「全库无匹配」表示已用 grep 检索关键词后零命中，关键词写在差距列。

### 1 产品目标与开发范围

| 编号 | 一句话需求 | 状态 | 证据文件 | 差距摘要 |
| --- | --- | --- | --- | --- |
| R-1.1.1 | 19 个环节的展示闭环可完整走通 | 部分实现 | `pages/Overview.tsx:113`、`pages/Adapt.tsx:854`、`pages/Twin.tsx:272` | 页面都在，但「历史资料→打开旧场景」「施工反馈→验收」「复巡下发」等环节无入口或无状态迁移 |
| R-1.1.2 | 所有页面同一组数据；点 Z04 打开同一份图像/回波/处理记录 | 部分实现 | `seed/scenario.ts:651`（HOTSPOTS）、`pages/Twin.tsx:292`（写死 `WAVEFORMS[0]`） | 种子同源 ✓，但 Twin 回波固定用初扫 `wf-Z04-001`，复扫三处 0.71/0.84/0.87 在孪生页永远看不到 |
| R-1.2.1 | 每条记录标 source_mode（live/replay/simulation） | 部分实现 | `seed/types.ts:13`、`ui.tsx:72`、`pages/Overview.tsx:155` | 类型与标签组件齐备，但 `orders/knowledge/archive/console` 多数区块未挂来源角标 |
| R-1.2.2 | 首版 P0/P1 边界（P1 不作为主流程前提） | 不适用 | — | 文档性约束，代码无可核对项 |
| R-1.3.1 | 四客户端操作一致、断网/刷新/重复点击可恢复 | 未实现 | 全库无匹配（关键词 `WebSocket`/`ws://`/`EventSource`/`localStorage`/`BroadcastChannel`） | 无后端、无事件总线、无持久化；刷新即丢全部演示状态 |
| R-1.3.2 | 关键页面无占位空按钮，所有成功状态有产物 | 部分实现 | `pages/Adapt.tsx:114`、`pages/Adapt.tsx:684`、`pages/Orders.tsx:110` | 多处按钮只 `toast`，不产生记录（如「启动采集」「下发更新包」「确认草稿工单」不改任何种子状态） |

### 2 角色与信息架构

| 编号 | 一句话需求 | 状态 | 证据文件 | 差距摘要 |
| --- | --- | --- | --- | --- |
| R-2.1.1 | 四个账号 + 各自默认工作区 | 已实现 | `design.ts:67-72`、`Shell.tsx:81-89` | 切换账号会 `navigate(next.page)`，工作区文案与 PRD 2.1 表一致 |
| R-2.1.2 | 角色限制在后端执行、固定账号快捷登录 | 未实现 | 全库无匹配（关键词 `403`/`无权`/`login`） | 无登录、无鉴权；`accountId` 只影响顶栏文字与落地页 |
| R-2.1.3 | 演示控制台使用独立管理权限 | 部分实现 | `routes.tsx:36`、`Shell.tsx:181-194` | `/console` 是独立页 ✓，但任何账号都能进；且 `Shell` 里人人可见「装载快照」按钮 |
| R-2.2.1 | 左侧一级导航控制在八项 | 部分实现 | `design.ts:75-84`（八项 ✓）、`DemoHeader.tsx:122-152`、`Shell.tsx:4-8` | 八项齐全但导航在**顶栏第二行**，Shell 注释明确写「不放左侧导航栏」——与 PRD「左侧一级导航」不符 |
| R-2.2.2 | 设备状态与个人账号放在顶部 | 已实现 | `DemoHeader.tsx:297-324`、`Header.tsx:31-47` | 四路通道 + 账号下拉都在顶栏 |
| R-2.2.3 | 小木作为右侧可展开面板 | 已实现 | `Shell.tsx:169-179`、`SmallWoodPanel.tsx:238` | 右侧抽屉，可开可关 |
| R-2.2.4 | 检测适配下六个页签 | 已实现 | `design.ts:87-94`、`Adapt.tsx:846-859` | 采集/异常排查/数据集/训练验证/更新交付/融合分析，文案与顺序一致 |
| R-2.2.5 | 切换页签保留筛选条件、当前批次、滚动位置 | 部分实现 | `Adapt.tsx:828-834`（只写 URL）、`Adapt.tsx:50`（CaptureTab 用局部 state） | `batch` 只写进 URL 给工具栏文案看，`CaptureTab` 不读它；滚动位置完全未保留（无 `scrollTop` 相关代码） |
| R-2.2.6 | URL 记录 job_id / component_id / batch_id | 部分实现 | `Orders.tsx:82-99`、`Twin.tsx:273-299`、`Adapt.tsx:824-834` | 有 `order` / `component` / `tab` / `batch`，**没有 `job_id`**；全库无匹配关键词 `job_id` |
| R-2.2.7 | 四人浏览器各自导航，不因他人切页被强制跳转 | 未实现 | 全库无匹配（关键词 `WebSocket`/`EventSource`/`session`） | 无多端同步通道，该需求无法被演示或验证 |
| R-2.2.8 | 大屏窗口独立 presentation 角色 + 「投到展示窗口」 | 部分实现 | `Shell.tsx:68-70,100-110`、`Header.tsx:96-105`、`pages/Present.tsx:17` | 路由与无壳渲染 ✓；但投屏只开一个静态总览窗，不承载「当前演示对象」 |
| R-2.2.9 | 展示控制权有当前持有人 + 换人显式交接 | 未实现 | 全库无匹配（关键词 `持有人`/`交接`/`控制权`） | 仅在 `Console.tsx:238` 与 `scenario.ts:198` 有说明性文字，无状态、无 UI |
| R-2.2.10 | 小木另提供大屏对话模式 | 未实现 | `pages/Present.tsx:17-103`（无小木） | Present 页只有地图 + 5 个统计块 + 四柱条，无对话区 |

### 3.1 任务总览与工单档案

| 编号 | 一句话需求 | 状态 | 证据文件 | 差距摘要 |
| --- | --- | --- | --- | --- |
| R-3.1.1 | 总览：寺院/工单/四柱/阶段 + 三通道 + 场地概览 + 待办与最近事件 | 部分实现 | `pages/Overview.tsx:133-236` | 四块浮层都在，但**缺「风险与工单」计数、工单列表、当前工单卡、查看工单入口**（详见 §3.1 与 §4-a） |
| R-3.1.2 | 未检测显示「未采集」，不显示零风险 | 已实现 | `pages/Overview.tsx:101`、`seed/scenario.ts:227`（`radarScore:null`） | 四柱条与 Present 均正确显示「未采集」 |
| R-3.1.3 | 统计来自数据库查询 | 未实现 | 全库无匹配（关键词 `sqlite`/`SQL`/`fetch(`/`api/`） | 全部为 `seed/scenario.ts` 常量，改动需重编译 |
| R-3.1.4 | 工单详情：地点/范围/Z01–Z04 清单/附件/环境/人员/操作记录 | 已实现 | `pages/Orders.tsx:185-212`（详情+构件表）、`:214-226`（附件）、`:385-409`（人员+日志） | 七项齐全 |
| R-3.1.5 | 支持创建、编辑、开始、暂停、归档 | 部分实现 | `pages/Orders.tsx:110-134` | 只有「确认草稿工单 / 暂停 / 归档」三个；**无创建、无编辑、无开始** |
| R-3.1.6 | 开始前验证构件清单和地点 | 未实现 | 全库无匹配（关键词 `开始前`/`validateOrder`/`构件清单校验`） | 无前置校验流程 |
| R-3.1.7 | 历史工单与当前工单分列表显示 | 已实现 | `pages/Orders.tsx:139-177`、`seed/scenario.ts:287-348` | 当前 / 历史两块，历史 3 条 |
| R-3.1.8 | 环境表单：温度℃、湿度 0–100、风速非负、仪表、位置、测量时间 | 已实现 | `pages/Orders.tsx:232-291`、`:31-61` | 六字段 + 四条校验规则 |
| R-3.1.9 | 校验通过 → 不可变配置版本 → 饶 ack，界面显示「已提交」「设备已确认」 | 部分实现 | `pages/Orders.tsx:294-353`、`context.tsx:169-172` | 两态显示 ✓；但版本号用 `ENV_HISTORY.length+3` 拼（`:300`），不走 `lib.buildConfigVersion`；ack 由按钮直接置 true，无代理语义 |
| R-3.1.10 | 环境补偿页展示补偿前后参考曲线及配置差异 | 部分实现 | `pages/Orders.tsx:364-382`、`seed/scenario.ts:759-767` | 有配置差异表 + 历史记录列表；**补偿前后两条曲线 `wf-comp-before`/`wf-comp-after` 在 Orders 页没有画出来**（只在 lib/seed 里存在） |
| R-3.1.11 | HH 只作环境先验、风速不代入 HH | 已实现 | `pages/Orders.tsx:355-360`、`seed/scenario.ts:456-462` | 文案 + `windExcluded:true` 明确 |

### 3.2 建图巡检

| 编号 | 一句话需求 | 状态 | 证据文件 | 差距摘要 |
| --- | --- | --- | --- | --- |
| R-3.2.1 | 可缩放平移的占据栅格地图，叠加小车/轨迹/巡检点/四柱/禁入区 | 部分实现 | `pages/RvizView.tsx:56-234`（内置渲染）、`:256-257`（优先静态图）、`pages/Mapping.tsx:36-43`、`seed/scenario.ts:520-536` | `public/rviz-reference.png` 存在 → **默认渲染的是一张静态 RViz 截图**，无缩放/平移（canvas 无 `onWheel`/`onPointerDown`）；内置渲染里四柱只作为占据块出现（`seed/scenario.ts:521-525`），**没有 Z01–Z04 标识**，且此时工具栏的叠加开关完全失效 |
| R-3.2.2 | 旁侧以视频和通信状态辅助判断 | 部分实现 | `pages/Mapping.tsx:158-172`、`:174-192` | 通信状态四路完整 ✓；视频是纯占位 div（`摄像头画面占位`），无画面、无通道名/回放标记 |
| R-3.2.3 | 工具栏：地图保存/版本选择/路线预览/任务下发/暂停/取消 | 已实现 | `pages/Mapping.tsx:78-141` | 六项齐全 |
| R-3.2.4 | 显示覆盖情况、更新时间与「采集中/待检查/已保存」，不虚构完成百分比 | 已实现 | `seed/scenario.ts:494-498`、`pages/Mapping.tsx:147-152` | 三态 + 覆盖率 + 更新时间，无假进度条 |
| R-3.2.5 | 选地图版本与点位序列 → 预览 → 下发 → 机器人确认 → 执行 | 部分实现 | `pages/Mapping.tsx:119-135`、`:253-259` | 版本选择 ✓、预览 ✓、等待确认 ✓；**点位序列不可选**（`WAYPOINTS` 直接渲染，无勾选/排序） |
| R-3.2.6 | 路径预览与机器人实际路径分开着色 | 部分实现 | `pages/RvizView.tsx:146-169` | 内置渲染分色正确；但默认走静态截图路径，看不到 |
| R-3.2.7 | 通信状态四路独立，任一路断流只影响该通道 | 已实现 | `seed/scenario.ts:206-211`、`Header.tsx:31-47`、`pages/Mapping.tsx:174-192` | 视频 `stale` 与其它三路 online 并存，文案明确 |
| R-3.2.8 | 演示车与实机名称明显不同，切换来源只能在任务停止后 | 已实现 | `seed/scenario.ts:214-218`、`pages/Mapping.tsx:88-107` | `DEMO-CART-01` vs `FIREBAT-N100`；`running` 时拒绝切换 |

### 3.3 场景管理与数字孪生

| 编号 | 一句话需求 | 状态 | 证据文件 | 差距摘要 |
| --- | --- | --- | --- | --- |
| R-3.3.1 | 场景库显示历史/本轮场景、来源视频、关键帧、处理记录、版本、发布时间 | 已实现 | `pages/Twin.tsx:392-411`、`seed/scenario.ts:621-640` | 3 个场景，字段基本齐（发布时间并入 `updatedAt`） |
| R-3.3.2 | 上传后「待检查」→ 架构师发布 → 其他客户端收到通知 | 部分实现 | `pages/Twin.tsx:412-419`、`seed/scenario.ts:635-639` | 有「待检查」条目与「检查并发布」按钮，但只弹 toast，不改 `published`，无通知机制 |
| R-3.3.3 | 场景构建页按影像检查/关键帧整理/位姿展示/成果导入依次展开 | 未实现 | 全库无匹配（关键词 `影像检查`/`关键帧整理`/`位姿展示`/`成果导入`） | 完全没有该页面/区块 |
| R-3.3.4 | 孪生主视图 ≥2/3，可自由移动/旋转/复位，按 Z01–Z04 快速跳转 | 部分实现 | `pages.css:2193-2199`（1fr + 372px ≈ 80% ✓）、`pages/Twin.tsx:313-325` | 占比与 OrbitControls ✓；**「复位」只 `setBookmarkId` + toast（`:318-324`），不动相机** |
| R-3.3.5 | 五图层分别开关 | 部分实现 | `pages/Twin.tsx:33-39`、`:277-283`、`:348-363` | `labels` ✓；`surface`/`radar` 生效但作用于**全部四柱**（含未采集的 Z01/Z02）；`route`/`history` 传进 `TwinScene` 后**完全没被使用** → 空操作 |
| R-3.3.6 | 点 Z04 下部热点 → 展开原图/回波/初筛/融合结果/历史任务 | 部分实现 | `pages/Twin.tsx:422-538` | 原图/回波/初筛/融合规则/融合结果/历史对比 ✓；**`hotspot.history`（3 条处理记录）全库无渲染**；三维里没有可点的热点，只能点柱身 |
| R-3.3.7 | 同构件历史与当前对比，可用视角书签切换或并排查看 | 部分实现 | `pages/Twin.tsx:511-537`（并排 ✓）、`:365-381`（书签只 toast） | 书签不切换相机；并排只有文字卡，无画面并排 |
| R-3.3.8 | 未完成坐标标定时以柱号与人工热点对应 | 已实现 | `pages/Twin.tsx:310`、`seed/scenario.ts:105` | 横幅明示，柱号-热点人工绑定 |
| R-3.3.9 | 内部异常以「示意响应区域」表达，不画虫道/深度/承载 | 已实现 | `pages/Twin.tsx:204-218`、`seed/scenario.ts:655` | 圆片 + 半透明圆柱，文案明确「不预画虫道深度与形状」 |

### 3.4 手持采集与异常排查

| 编号 | 一句话需求 | 状态 | 证据文件 | 差距摘要 |
| --- | --- | --- | --- | --- |
| R-3.4.1 | 采集页选择工单/柱号/测区/扫描方向/配置/模型版本 | 部分实现 | `pages/Adapt.tsx:72-111` | 只读展示构件/测区/轮次/配置/模型/rawLevel；**工单、柱号、测区、扫描方向都没有选择控件**，只有「切换批次」下拉 |
| R-3.4.2 | 实时预览、接收帧数、文件落盘状态、波形；三类分别呈现；整批校验通过才报「数据全部回传」 | 部分实现 | `pages/Adapt.tsx:131-140`、`:122-128` | 接收帧数三行 ✓、波形 ✓、冻结提示 ✓；**无实时预览画面、无「文件落盘状态」**；「数据全部回传」只在文案里被否定，没有正向成功态 |
| R-3.4.3 | 初扫触发「适用域待核验」，冻结该批诊断输出并提示保存/暂停 | 已实现 | `pages/Adapt.tsx:216-241`、`Seed:686-696` | 触发/恢复按钮 + StateBlock + 批次 `frozen` |
| R-3.4.4 | 异常排查四项，每项可看记录、填结论并签名 | 已实现 | `pages/Adapt.tsx:244-301`、`seed/scenario.ts:771-806` | 设备/信号/测区/模型适用性，记录+输入框+签名字段齐全 |
| R-3.4.5 | 完成检查后创建参考样本采集任务 | 已实现 | `pages/Adapt.tsx:292-300` | 四项签满才可点 |
| R-3.4.6 | 首版异常由演示控制事件触发；不用固定置信度自动判材种 | 已实现 | `pages/Adapt.tsx:216-233`、`seed/scenario.ts:812`、`:804` | `trigger: "演示控制事件"`，结论明确拒绝低置信度判材种 |
| R-3.4.7 | 暂停页面状态 ≠ 传感器停止；未接入显示「等待操作员确认停止」 | 已实现 | `pages/Adapt.tsx:117-119` | toast 文案与 PRD 完全一致 |

### 3.5 数据集与人工审核

| 编号 | 一句话需求 | 状态 | 证据文件 | 差距摘要 |
| --- | --- | --- | --- | --- |
| R-3.5.1 | 样本列表：物理样本ID、路径、材种来源、已知状态、标签依据、采集文件、质量标志 | 部分实现 | `pages/Adapt.tsx:353-370` | 表头只有 `样本/记录/材种来源/已知状态/质量/说明`；**缺「路径」与「标签依据」两列**（`Sample.path`、`Sample.labelBasis` 未被渲染） |
| R-3.5.2 | 未知标签单独管理 | 部分实现 | `seed/scenario.ts:841-842`、`pages/Adapt.tsx:353-370` | 数据里有 `未知待核验` 状态，但**没有独立的未知标签列表/区块**，混在同一张表里 |
| R-3.5.3 | 清洗展示每步输入量/保留量/待审核量及原因；可查看一条记录清洗前后内容 | 部分实现 | `pages/Adapt.tsx:337-350` | 五步表 ✓；**「一条记录清洗前后对比」完全缺失** |
| R-3.5.4 | 空文件/格式损坏标不可用；疑似重复/饱和/离群先待审核；保留原文件 | 已实现 | `seed/scenario.ts:837-853`、`pages/Adapt.tsx:347-350` | 口径文案与数据一致 |
| R-3.5.5 | 相似记录按物理样本分组 | 已实现 | `seed/scenario.ts:828-847`、`pages/Adapt.tsx:373-385` | `G-SAMPLE-01..06`，同组多记录 |
| R-3.5.6 | 审核页按职责分配（饶信号/马来源位置/沈标签分组/史版本） | 已实现 | `seed/scenario.ts:862-867`、`pages/Adapt.tsx:399-407` | 四人分工与 PRD 逐字对应 |
| R-3.5.7 | 全部必要项通过后冻结 dataset_version | 部分实现 | `pages/Adapt.tsx:409-420`、`seed/scenario.ts:860` | 按钮有，但**不读 `reviewAssign` 状态**（全为「已通过」是种子写死的），`frozen` 恒为 true，无法演示「未通过不能冻结」 |
| R-3.5.8 | 经理分组检查真读训练/验证/测试物理样本 ID，输出交集与冲突清单 | 部分实现 | `pages/Adapt.tsx:314-330`、`:387-397` | 交集计算是真的 ✓，但只算 ID 交集；**`lib.checkGrouping` 里的「同一样本跨集合冲突」「未知标签混入监督训练」「未纳入集合的样本」三项检查未接入**，也没有 A13 那种「故意制造冲突再整组调整」的可演示路径 |

### 3.6 训练验证与更新交付

| 编号 | 一句话需求 | 状态 | 证据文件 | 差距摘要 |
| --- | --- | --- | --- | --- |
| R-3.6.1 | 训练页展示基线/数据集/更新范围/学习率/停止条件/输入规格；提交生成 job；排队→数据准备→适配→验证→完成 | 部分实现 | `pages/Adapt.tsx:466-508`、`seed/scenario.ts:924-930` | 字段齐 ✓、五步流程 ✓；**没有「提交」按钮，job 步骤是写死的「已完成」**，无法演示任务推进 |
| R-3.6.2 | 损失曲线/样本预测/日志同属一份预置实验包，保留「演示记录」身份 | 部分实现 | `pages/Adapt.tsx:466`、`:510-532` | 曲线来自 `EXPERIMENT` 同源 ✓、身份标识 ✓；**日志完全没有渲染**（`epochs.csv` 只出现在归档清单里） |
| R-3.6.3 | 验证页：新旧曲线、逐样本预测、混淆矩阵、漏检与误报、原有材种回归结果 | 部分实现 | `pages/Adapt.tsx:534-595` | 曲线/逐样本/混淆矩阵/漏检误报变化 ✓；**「原有材种回归」只显示材种名列表（`:559-561`），没有按材种的召回对比数值** |
| R-3.6.4 | 比较程序从归档预测表真正计算统计值（含精确率、召回率、F1；分母为零返回不适用） | 未实现 | `lib.ts:258-302`（已实现但**零引用**）、`ui.tsx:413-445`（只有 TP/FP/TN/FN） | 页面未算精确率/召回率/F1，无「不适用」分支；`lib` 版本没被任何页面 import |
| R-3.6.5 | 验收规则由配置给出，可预置通过与失败两套案例 | 部分实现 | `pages/Adapt.tsx:500-507`、`seed/scenario.ts:947-960` | 失败案例开关 ✓；但失败案例只换预测表与验收表，**不阻止进入发布**（交付页不读验收结果） |
| R-3.6.6 | 交付页按量化记录/兼容性检查/封装/下发/接收/更新/重启自检/版本确认呈现 | 已实现 | `seed/scenario.ts:989-998`、`pages/Adapt.tsx:670-679` | 八步与 PRD 逐字一致 |
| R-3.6.7 | 包清单展示模型版本/预处理/输入输出规格/目标环境/摘要/恢复版本；下载产生真实文件 | 部分实现 | `pages/Adapt.tsx:611-646` | 清单字段齐（`sha256` 未展示）；**没有下载按钮，无 Blob/文件产出** |
| R-3.6.8 | 饶在自己的账户接收并执行模拟更新，史同步看到回执 | 部分实现 | `pages/Adapt.tsx:680-698`、`seed/scenario.ts:999` | 有「下发更新包」「读取设备版本」两个按钮；**与账号无关**（任何账号都能点），无「饶接收」独立动作，无跨端同步 |

### 3.7 复扫与多模态融合

| 编号 | 一句话需求 | 状态 | 证据文件 | 差距摘要 |
| --- | --- | --- | --- | --- |
| R-3.7.1 | 复扫创建新批次，继承 Z04 测区但重选当前配置，不覆盖初扫 | 已实现 | `seed/scenario.ts:697-706`、`pages/Adapt.tsx:102-111` | `scan-Z04-002` 与 `scan-Z04-001` 并存 |
| R-3.7.2 | 三条样例响应 0.71/0.84/0.87，对应原始文件、图像和标记 | 已实现 | `seed/scenario.ts:395-417`、`:744-752` | 数值与 mark/waveform 标记完全一致 |
| R-3.7.3 | 融合页依次显示数据完整性/图像标注/雷达特征/测区匹配/结果汇总 | 已实现 | `pages/Adapt.tsx:717-814` | 五段齐全 |
| R-3.7.4 | 点击任一异常即可联动原图局部、曲线片段和三维热点 | 未实现 | `pages/Adapt.tsx:739-772`（纯表格，无点击）、`ui.tsx:385-394`（`WaveChart` 有 `highlight` 参数但**无人传值**） | 表格行不可点，无跨页联动，`highlight` 能力闲置 |
| R-3.7.5 | 融合是明确三规则；不做分数相加平均；返回优先级/依据/下一步；保存规则版本 | 已实现 | `seed/scenario.ts:1073-1077`、`pages/Adapt.tsx:774-813` | 三规则 + 「非分数相加」标签 + 规则版本 |

### 3.8 工单跟踪与归档

| 编号 | 一句话需求 | 状态 | 证据文件 | 差距摘要 |
| --- | --- | --- | --- | --- |
| R-3.8.1 | 小木依据所选风险生成复核工单草稿，自动带入位置/图像/回波/结果/建议 | 部分实现 | `seed/scenario.ts:351-372`、`pages/Orders.tsx:151-158`、`SmallWoodPanel.tsx:1230-1234` | 草稿数据完整 ✓；但小木回答里 `orderId/priority/attachments` 三个 facts 键**不在映射表中** → 渲染为「未登记」；草稿也不能「编辑优先级/责任部门/处理建议/复巡日期」 |
| R-3.8.2 | 状态为草稿/待复核/待处理/处理中/待验收/已关闭；验收不通过回到处理中 | 部分实现 | `design.ts:97-104`、`context.tsx:156-167` | 六态定义 ✓、草稿→待复核 ✓、归档 ✓；**验收到「回到处理中」的回退路径没有实现**（无验收操作 UI） |
| R-3.8.3 | 施工反馈与验收是两个独立操作；上传完工资料只进待验收，人工验收通过才关闭 | 部分实现 | `seed/scenario.ts:281`、`:369`、`pages/Orders.tsx:110-134` | 只有 `acceptanceNote` 文案，**没有「上传完工资料」「人工验收」两个按钮**，无法演示两段式 |
| R-3.8.4 | 复巡计划引用地图版本/观察点/视角书签；生成后仍需单独下发 | 部分实现 | `seed/scenario.ts:1083-1094`、`pages/Orders.tsx:192` | 计划数据齐（`dispatched:false`）、工单里显示编号；**无计划详情视图、无「下发」按钮** |
| R-3.8.5 | 归档清单覆盖工单/环境/原始数据/图像/地图/场景/数据集/模型记录/更新日志/报告十类 | 已实现 | `seed/scenario.ts:1100-1125`、`pages/Archive.tsx:29-40` | 10 组 24 项 |
| R-3.8.6 | 运行实际 SHA-256 校验，报告缺失和不一致文件 | 部分实现 | `pages/Archive.tsx:43-49`（真算 `crypto.subtle`）、`:81-93` | **摘要对比逻辑失效**：第 90 行 `actualShort === declaredShort ? "一致" : "一致"` 两个分支同值，结论完全由种子里预置的 `actualSha256 !== declaredSha256` 决定；`lib.runArchiveCheck` 的正确实现未被调用 |
| R-3.8.7 | 报告输出 HTML 打印版及 PDF；归档包按清单下载 | 部分实现 | `pages/Archive.tsx:113-118`（`window.print()`）、`lib.ts:535-566`（HTML 报告生成器未被调用） | 打印走浏览器 ✓；**无 PDF 导出、无归档包下载**，`lib.buildArchiveReportHtml` 闲置 |

### 4 小木语音与自动化

| 编号 | 一句话需求 | 状态 | 证据文件 | 差距摘要 |
| --- | --- | --- | --- | --- |
| R-4.1.1 | 主链路（规范化→意图→槽位→上下文→权限校验→白名单工具→模板回复→播放语音+跳转）；工具卡片显示实际调用状态 | 部分实现 | `SmallWoodPanel.tsx:126-216`、`:281-301` | 意图匹配 + 步骤点亮 ✓；**无权限/业务状态校验、无视图跳转、无语音播放**；工具卡片标签用 `XIAOMU_TOOLS` 的 key 反查，而 `intent.tools` 存的是中文短语（如「检索报告」「视觉分析」），查不到就原样显示（`:116-123`、`:284-287`） |
| R-4.2.1 | 意图目录 14 条 | 部分实现 | `seed/scenario.ts:1186-1247`（10 条） | **缺 4 条**：`site_weather`（查近三个月天气）、`prepare_split`（生成数据集划分）、`open_evidence`（打开 Z04 下部记录）、`create_revisit`（安排下次复巡） |
| R-4.2.2 | 同义词集合 + 必需槽位；复杂查询优先；一次请求支持「查询并打开」 | 部分实现 | `SmallWoodPanel.tsx:126-139` | 按**单字**包含命中数打分（`Array.from(intent.utterance)` 逐字符），无同义词表、无槽位必需性、无「查询+打开」组合；「五月／5月」「第四根／4号柱／Z04」未统一 |
| R-4.2.3 | 未知输入回复「可查询巡检资料、查看构件或启动当前业务流程」 | 部分实现 | `SmallWoodPanel.tsx:157-165` | 实际文案为「意图目录里没有匹配项，也不调用大模型猜测。可以换一种说法，或直接用关键词查询资料。」——与 PRD 规定文案不一致 |
| R-4.2.4 | 「今年」按业务日期解析并冻结；「当时/剩下的」取最近一次成功查询上下文；跨项目清空 | 部分实现 | `seed/scenario.ts:55-56`（`DEMO_BUSINESS_DATE`）、`SmallWoodPanel.tsx:55-70`（无上下文） | 业务日期常量存在但**无任何解析逻辑**；无会话上下文对象，`unresolved_followup` 无法知道「上一次查的是哪个项目」 |
| R-4.3.1 | 三入口：按住说话、文本输入、常用指令 | 部分实现 | `SmallWoodPanel.tsx:345-368` | 有文本输入 + 4 个常用指令按钮；**无「按住说话」入口，也无「演示语句选择」的显式说明**（PRD 4.3 要求麦克风按钮未接 ASR 时明确进入演示语句选择） |
| R-4.3.2 | 本地预录音频优先 / speechSynthesis；停止播放、重播、静音 | 未实现 | 全库无匹配（关键词 `speechSynthesis`/`SpeechRecognition`/`getUserMedia`/`audio`） | 只有 `AI语音1..10` 这样的**文字标签**（`seed/scenario.ts:1191` 等），没有任何音频元素与播放控制 |

### 5 RAG 知识库

| 编号 | 一句话需求 | 状态 | 证据文件 | 差距摘要 |
| --- | --- | --- | --- | --- |
| R-5.1.1 | 资料与工单状态分开读取，回复模板合并两种结果并分别给出来源 | 已实现 | `pages/Knowledge.tsx:73-78`、`:179-189`、`SmallWoodPanel.tsx:305-337` | 「业务状态（结构化数据）」与「资料引用」两块并列 |
| R-5.2.1 | 中文 2–4 字 TF-IDF 稀疏向量 + 余弦相似度 | 部分实现 | `pages/Knowledge.tsx:31-61`（n-gram **命中率**）、`lib.ts:614-680`（真 TF-IDF，零引用） | 页面用的是「命中 gram 数 / 总 gram 数」，没有 IDF、没有余弦，不是 TF-IDF；真实现闲置 |
| R-5.2.2 | 先按权限/项目/日期过滤候选，再取 Top 5；阈值 0.15；无命中答「当前资料未检索到」，不返回其他寺院 | 部分实现 | `pages/Knowledge.tsx:45`、`:134-140`、`seed/scenario.ts:1284-1291` | TopK=5 与阈值 0.15 ✓、「未检索到」文案 ✓；**但没有权限/项目/日期过滤**（`lib.searchKnowledge` 的 `filters` 未接入），"换项目检索同一句"（A03）无法演示 |
| R-5.2.3 | 每段 300–500 字、重叠约 60 字、保存原段落序号或页码 | 部分实现 | `seed/scenario.ts:1289` | 仅在 `KNOWLEDGE_META.chunkSize` 里以**文案**声明；没有分块器，`KnowledgeDoc.chunks` 是手写死的 4 段 |
| R-5.3.1 | 知识库页面提供文档上传、分类、索引状态、版本和检索测试 | 部分实现 | `pages/Knowledge.tsx:85-141`、`:191-205` | 检索测试 ✓、版本 ✓、资料库清单 ✓；**无上传、无分类筛选、无索引发布状态机** |
| R-5.3.2 | 来源卡片展开可见查询词/筛选条件/命中片段/相似度；点击打开资料所在段落；相似度标为「检索相似度」 | 部分实现 | `pages/Knowledge.tsx:119-177` | 相似度标注与原文位置 ✓；**无查询词回显、无筛选条件显示**；小木侧来源卡片点击只 `navigate("/knowledge")`（`SmallWoodPanel.tsx:326`），不带 `chunkId`，落不到具体段落 |
| R-5.3.3 | MAY-DEMO-01 固定答案「6 处风险，施工反馈完成 4 处，验收关闭 3 处，尚未关闭 3 处」 | 未实现 | `SmallWoodPanel.tsx:58`、`seed/scenario.ts:390` | `total = CURRENT_RISKS.length + HISTORY_STATS.total = 9`；`reportedDone = 6`（六条 `reported` 全为 true）。实际回答为「共 **9** 处风险，施工反馈完成 **6** 处，验收关闭 3 处，尚未关闭 3 处」——**两项数字与 PRD 冲突** |
| R-5.3.4 | 命中报告同时关联历史 scene_id 和柱底 camera_bookmark；先给证据再打开场景 | 部分实现 | `seed/scenario.ts:1194-1198`、`SmallWoodPanel.tsx:64-65` | facts 表里有 `sceneId`/`bookmark`，但 `sceneId` 写死 `scene-SH-0901`（本轮），不是历史 `scene-May`；**没有「打开场景」的实际动作** |

### 6 系统架构与工程组织

| 编号 | 一句话需求 | 状态 | 证据文件 | 差距摘要 |
| --- | --- | --- | --- | --- |
| R-6.1 | React/TS/Vite + Tailwind + ECharts + Three.js&Spark + FastAPI/SQLite/scikit-learn | 部分实现 | `package.json:12-29` | React/TS/Vite/Three ✓；**无 Tailwind（用 styled-components + 手写 CSS）、无 ECharts（自绘 SVG）、无 Spark、无任何后端依赖** |
| R-6.2 | 建议目录 web/ server/ data/ tests/ | 不适用 | — | 本仓库为纯前端演示，目录结构由上游 sc-datav 模板决定 |
| R-6.3 | 配置与统一 ID 贯穿（project/session/order/component/batch/model/scene） | 部分实现 | `seed/scenario.ts:56-77` | `DEMO_SESSION` 有 profile 与 deviceModes ✓；但 **ID 未贯穿到 URL/请求**，且无 `scene_version` 与 `job_id` 概念 |

### 7 演示任务状态机与多端同步

| 编号 | 一句话需求 | 状态 | 证据文件 | 差距摘要 |
| --- | --- | --- | --- | --- |
| R-7.1 | 13 个全程阶段（history → delivery） | 已实现 | `seed/scenario.ts:80-94`、`pages/Console.tsx:158-172` | 13 项与 PRD 7.1 表逐行对应，含剧本定位与时间 |
| R-7.2 | job 六态、进度由服务端累计、等待审核不得自行通过、持久化与重试 | 未实现 | `context.tsx:105-135`（全部 `useState`） | 无 job 状态机；状态刷新即丢；无 `attempt` 概念 |
| R-7.3 | WebSocket 事件契约（event_id/seq/entity_version/last_seq/resync_required/Idempotency-Key） | 未实现 | 全库无匹配（关键词 `WebSocket`/`seq`/`Idempotency`） | `Shell.tsx:212` 的 `事件 seq {1000 + events.length}` 只是本地数组长度伪装 |
| R-7.4 | 演示控制台：新建会话/正常与故障案例/暂停动画/触发异常/装载快照/检查缺失素材 | 部分实现 | `pages/Console.tsx:17-255`、`seed/scenario.ts:191-200` | 时间轴、阶段推进、8 个事件按钮、事件总线 ✓；**无「新建会话」、无正常/故障案例选择、无「暂停动画」、无「检查缺失素材」** |
| R-7.5 | 重置新建 session 且不删素材原件；真实设备运行时拒绝重置；大屏隐藏控制台入口 | 部分实现 | `context.tsx:174-185`、`Shell.tsx:100-110` | `resetDemo` 只回退内存状态 ✓、Present 无外壳 ✓；**无 session 概念、无「真实设备运行中」判断、无受影响对象提示** |

### 8 小车联动（前端可核对部分）

| 编号 | 一句话需求 | 状态 | 证据文件 | 差距摘要 |
| --- | --- | --- | --- | --- |
| R-8.1 | ROS1 rosbridge 接入；RobotAdapter 七个接口 | 未实现 | 全库无匹配（关键词 `rosbridge`/`RobotAdapter`/`ros`） | 仅 `seed/scenario.ts:210` 的 `source` 文案提到 rosbridge |
| R-8.2 | OccupancyGrid 解析（origin 旋转平移、行方向翻转）；地图 1–2Hz/位姿 2–5Hz/状态 1Hz；视频 MJPEG | 部分实现 | `seed/types.ts:184-192`、`pages/RvizView.tsx:103-113` | 栅格数据结构与着色 ✓；**无 origin 变换、无行翻转校验、无频率配置、无地图/位姿分通道推送** |
| R-8.3 | 导航命令与回放：accepted/running/paused/completed/failed 回报、回放时钟、暂停冻结回放 | 部分实现 | `pages/Mapping.tsx:122-141`、`seed/scenario.ts:599-614` | 步骤与接管记录 ✓；**状态机是前端 `setTimeout` 假装车端 ack**，无回放时钟、无拖动定位 |

### 9 手持设备与平台的数据通道

| 编号 | 一句话需求 | 状态 | 证据文件 | 差距摘要 |
| --- | --- | --- | --- | --- |
| R-9.1 | 文件导入与本地代理；ScannerAdapter 六接口 | 未实现 | 全库无匹配（关键词 `ScannerAdapter`/`upload_id`/`manifest`/`代理`） | 无上传流程 |
| R-9.2 | 原始数据包契约（batch/zone/source_mode/config/model/raw_level/schema/files+sha256）；三种时间戳；分块续传 | 部分实现 | `seed/types.ts:258-276`、`pages/Adapt.tsx:72-100` | 展示了 batch/zone/round/config/model/rawLevel ✓；**无 files 清单+摘要、无设备时间/接收时间、无分块上传与断点续传** |
| R-9.3 | FFT 口径、坐标轴单位、量程规则；特征输出保留处理版本 | 已实现 | `seed/scenario.ts:719-768`、`ui.tsx:347-407` | 明确「频谱不再 FFT」「横轴频点索引不写深度」、单位 `归一化幅值`、量程检查 |

### 10 高斯场景与空间关联

| 编号 | 一句话需求 | 状态 | 证据文件 | 差距摘要 |
| --- | --- | --- | --- | --- |
| R-10.1 | MipMap 流程登记、成果发布和浏览 | 部分实现 | `seed/scenario.ts:635-639`、`pages/Twin.tsx:412-419` | 只有「待检查→发布」的空壳按钮，无流程登记表 |
| R-10.2 | Three.js + Spark 加载经验证的高斯成果（SplatMesh）；必须交付一份能在目标机打开的四柱场景 | 未实现 | `package.json:12-29`（无 spark）、`public/`（无场景产物，仅上游 `model/glb/turbine.glb`）、全库无匹配（关键词 `splat`/`SplatMesh`） | `Twin.tsx:47-270` 是手搓低模庭院 + 圆柱；`SceneAsset.format` 写着 `spark-splat / manifest json` 但无加载器 |
| R-10.3 | 场景 manifest（format/asset_url/scene_id/version/单位/轴方向/初始相机/包围盒/书签）；热点绑 component/zone/evidence | 部分实现 | `seed/types.ts:231-255`、`seed/scenario.ts:621-680` | 有 format/version/bbox/热点绑定 ✓；**无 asset_url、无单位与轴方向、无初始相机、无 manifest 文件** |
| R-10.4 | map 与 scene 坐标分离；标定保存 T_scene_from_map、参考点、误差、尺度 | 部分实现 | `pages/Twin.tsx:310`、`seed/types.ts:106` | 用柱号人工对应 ✓ 的表述；**无标定数据结构、无坐标变换、无参考点/误差字段** |
| R-10.5 | 大文件预加载与释放；加载失败降级为标明身份的全景视图；支持 Range 与缓存摘要 | 未实现 | 全库无匹配（关键词 `全景视图`/`Range`/`释放`/`dispose` 于场景加载语境） | 无资源加载、无降级视图 |

### 11 清洗训练与部署的演示实现

| 编号 | 一句话需求 | 状态 | 证据文件 | 差距摘要 |
| --- | --- | --- | --- | --- |
| R-11.1 | 对可解析数据真实执行空值/重复/范围检查；相似度筛查与 KMeans 聚类 | 部分实现 | `seed/scenario.ts:849-855` | 五步与「固定随机种子聚类」的**结果**是种子常量，页面不执行任何计算 |
| R-11.2 | 划分以 physical_sample_id 为最小组，固定随机种子并保存组清单；未知标签不进监督训练 | 已实现 | `seed/scenario.ts:828-847`、`:869-873`、`pages/Adapt.tsx:373-397` | 分组清单与求交均在页面上真实呈现 |
| R-11.3 | 实验包同源（config/epochs/predictions_old/new/model_card/quantization_report/日志） | 部分实现 | `seed/scenario.ts:913-944`、`pages/Adapt.tsx:466` | 曲线与两份预测表同源 ✓；**无 config、无 model_card、无 quantization_report、无日志的界面承载** |
| R-11.4 | 演示包 `.demo.zip`、`artifact_kind=demo_nonflashable`，禁止命名为可烧录固件 | 已实现 | `seed/scenario.ts:967-968`、`:987`、`pages/Adapt.tsx:611` | 三处一致，兼容性表明确「烧录能力」不通过 |
| R-11.5 | Device 分开保存 live/demo 版本，界面按模式展示，模拟回执不覆盖真机 | 已实现 | `seed/scenario.ts:999`、`pages/Adapt.tsx:689-697`、`pages/Archive.tsx:246-249` | `liveReported` / `demoReported` 分开显示 |

### 12 项目经理的实际技术操作

| 编号 | 一句话需求 | 状态 | 证据文件 | 差距摘要 |
| --- | --- | --- | --- | --- |
| R-12.1 | 三个校验单元 + 一个评估入口，均作用于当前工单数据 | 部分实现 | `pages/Orders.tsx:294-335`（环境）、`pages/Adapt.tsx:372-420`（分组）、`pages/Archive.tsx:110-112`（归档）、`pages/Adapt.tsx:534`（评估） | 四个入口都在，但分散在三个页面，无「经理工作区」聚合视角 |
| R-12.2 | 界面明确「受限 Python 校验单元」；返回 passed/details/data_version/executed_at | 部分实现 | 全库无匹配（关键词 `受限`/`受限Python`/`data_version`/`executed_at`）；`lib.ts:26-35` 定义了结果结构但未接入 | 页面只展示断言文本（`Orders.tsx:40`、`Adapt.tsx:388`），**没有「受限」标识，也不返回四项结构化结果** |
| R-12.3 | 冲突时列出物理样本 ID 并允许整组调整，调整后重新运行 | 部分实现 | `pages/Adapt.tsx:391-397` | 能列出交集 ID ✓；**分组不可编辑，没有「整组调整后重跑」** |

### 13 数据库与文件模型

| 编号 | 一句话需求 | 状态 | 证据文件 | 差距摘要 |
| --- | --- | --- | --- | --- |
| R-13.1 | 业务表统一 id/project_id/session_id/created_at/version…；历史库只读、演示会话独立副本 | 未实现 | 全库无匹配（关键词 `sqlite`/`session_id`/`created_by`/`WAL`） | 前端常量，无持久化层 |
| R-13.2 | 资产相对路径、外键、冻结后不可原地修改、归档不级联删除原文件 | 不适用 | — | 属后端数据层要求 |

### 14 API 与适配器契约

| 编号 | 一句话需求 | 状态 | 证据文件 | 差距摘要 |
| --- | --- | --- | --- | --- |
| R-14.1 | `/api/v1` 统一路径、鉴权、分页、错误码、202/201 | 未实现 | 全库无匹配（关键词 `/api/`/`fetch(`/`request_id`） | 无网络层 |
| R-14.2 | 必需接口清单（约 41 个） | 未实现 | 全库无匹配（关键词 `auth/login`/`work-orders`/`missions`/`scan-batches`） | 全部未实现 |
| R-14.3 | 小木请求/返回示例（intent/status/answer/facts/sources/actions/index_version/tool_run_id） | 部分实现 | `seed/scenario.ts:1176-1247`、`SmallWoodPanel.tsx:29-49` | 前端有 intent/answer/facts/sources 的近似结构；**无 `status`、无 `actions`、无 `index_version`、无 `tool_run_id`** |

### 15 界面视觉与交互要求

| 编号 | 一句话需求 | 状态 | 证据文件 | 差距摘要 |
| --- | --- | --- | --- | --- |
| R-15.1 | 浅色工作区、深色导航、青绿主色、木色小面积强调 | 未实现 | `pages.css:11-25`（`--ma-bg:#02060e`、`--ma-primary:#3061db`）、`design.ts:15-44` | 实现为**全深色大屏 + Demo2 蓝**，无浅色工作区、无青绿主色（`#3ee3a4` 仅作 ok 语义色）、无木色 |
| R-15.2 | 场景页三维主导、巡检页地图带视频、适配页曲线样本任务、知识库对话与证据；不要所有页面都是四张卡片 | 部分实现 | `pages/Twin.tsx:327-329`、`pages/Mapping.tsx:144-155`、`pages/Adapt.tsx:71`、`pages/Knowledge.tsx:82` | 四页构图确有差异 ✓；但 Overview 与 Present 都是「地图 + 浮层」，Orders/Archive/Console 是同一套 `Panel` 堆叠 |
| R-15.3 | 总览突出当前任务与待办，不堆无实际作用的大数字 | 部分实现 | `pages/Overview.tsx:133-236` | 待办 ✓；但概览与设计稿相比缺少任务性区块（见 §4-a），现有的四柱/历史统计偏「数字陈列」 |
| R-15.4 | 技术细节（索引、工具调用、数据版本、曲线参数）放可展开面板 | 部分实现 | `pages/Knowledge.tsx:104-117`、`SmallWoodPanel.tsx:305-337` | 已展示但**全部常显**，无折叠/展开交互 |
| R-15.5 | 设计稿需包含总览、巡检、孪生、训练验证、小木检索五张重点页面及公共组件 | 部分实现 | `docs/design/china-dashboard-concept.png`、`docs/design/shanghai-dashboard-concept.png` | 只有 2 张总览概念图（且 `docs/` 下**没有任何 .md 设计文档**）；巡检/孪生/训练验证/小木检索无设计稿 |
| R-15.6 | 主要 1920×1080，兼容 1366×768 | 部分实现 | `pages.css:3213,3235,3262,3285` | 有 1720/1440/1320 与 max-height:800 断点；**无 1366×768 的显式验收**（1320 断点落到单列，未验证） |
| R-15.7 | 大屏模式正文 ≥18px、关键结论 ≥24px以上 | 未实现 | `pages.css:39`（`font-size:13px`）、`pages.css:1023`（`.metric strong` 20px）、`pages.css:1109`（`matrix__cell strong` 18px）、全库无匹配（关键词 `24px` 仅在无关处） | 基础字号 13px，正文普遍 10–12px，与要求差距明显 |
| R-15.8 | 状态同时用文字和颜色 | 已实现 | `ui.tsx:55-70`、`pages.css:763-776` | `StatusChip` 文字 + 色点 |
| R-15.9 | 弹窗不遮住现场最重要的场景或停止控件 | 部分实现 | `Shell.tsx:179`（小木固定在右侧）、`pages.css:326-335` | 小木抽屉宽 `min(420px,38vw)` 覆盖右侧内容区；无遮挡检测（当前唯一的模态 `WorkOrderModal` 属死代码） |
| R-15.10 | 所有页有加载、空数据、错误、断线、部分完成和成功状态 | 已实现 | `ui.tsx:17-49`、`Shell.tsx:142-152` | 六态齐备，页面广泛使用 |
| R-15.11 | 首次进入引导先选择工单；切换工单时提示未保存表单 | 未实现 | 全库无匹配（关键词 `引导`/`未保存`/`beforeunload`） | 直接进总览 |
| R-15.12 | 快捷操作支持键盘；提交与删除不共用热键 | 未实现 | 全库无匹配（关键词 `onKeyDown`/`hotkey`/`快捷键`） | 无键盘快捷键 |
| R-15.13 | 小木工具过程用短步骤卡片（动作/对象/状态/结果入口），不显示虚构长篇推理 | 已实现 | `SmallWoodPanel.tsx:281-301` | 三个短步骤 + 状态 |
| R-15.14 | 图表使用真实或预置文件数据；无数据即提示待导入，不生成随机曲线 | 部分实现 | `seed/scenario.ts:720-736`（`specPoints` 用正弦+高斯峰**合成**波形）、`ui.tsx:289`（空态 ✓） | 空态处理 ✓；但波形/损失曲线是程序合成而非「预置文件数据」，与 PRD 11.2「预先制作实验包」的口径有差距 |

### 16 素材种子与内容清单

| 编号 | 一句话需求 | 状态 | 证据文件 | 差距摘要 |
| --- | --- | --- | --- | --- |
| R-16.1 | 12 个素材包（历史巡检/当前项目/天气环境/机器人回放/场景包/手持样例/数据集/实验/更新/融合/语音/交付） | 部分实现 | `seed/scenario.ts:1-1291` | 历史巡检 ✓、当前项目 ✓、天气 ✓、机器人回放（栅格+位姿）✓、手持样例 ✓、数据集 ✓、实验 ✓、更新 ✓、融合 ✓；**场景包只有元数据无产物、语音包零实现、交付包缺报告模板与缺失文件案例** |
| R-16.2 | `scenario_manifest.json` 集中管理 asset_id/实体ID/source_mode/脚本阶段/文件摘要 | 部分实现 | `seed/scenario.ts`（TS 常量集中 ✓） | 无 manifest.json、**无文件摘要**（`ARCHIVE_ITEMS` 的 sha256 是手写占位） |
| R-16.3 | 历史 R01–R06 与本轮 CUR-Z04-01~03 分开，不自动合并 | 已实现 | `seed/scenario.ts:378-417`、`pages/Twin.tsx:293` | ID 体系分离 |

### 17 部署运行与故障恢复

| 编号 | 一句话需求 | 状态 | 证据文件 | 差距摘要 |
| --- | --- | --- | --- | --- |
| R-17.1 | 局域网部署、启动脚本检查端口/存储/迁移/摘要/索引/通道；健康检查页 | 部分实现 | `start-demo.cmd`、`README.md:41-55` | 有本地启动脚本与 dev/build 说明；**无健康检查页、无迁移/摘要/索引检查** |
| R-17.2 | 失败恢复表 11 种情况 | 部分实现 | `Shell.tsx:142-152`（断网）、`pages/Adapt.tsx:122-128`（部分接收）、`ui.tsx:17-26` | 断网/部分完成有 UI ✓；**ASR 不可用、语音失败、小车断连、上传中断、清洗未通过、验证失败、更新失败、后台重启、资料未命中、缺素材 等场景无对应 UI** |

### 19–20 其他

| 编号 | 一句话需求 | 状态 | 证据文件 | 差距摘要 |
| --- | --- | --- | --- | --- |
| R-19.1 | 联调补齐参数以配置项/适配器预留（Topic、视频地址、地图坐标、导出格式、寺院名称等） | 部分实现 | `pages/Mapping.tsx:36-43`、`seed/scenario.ts:214-218` | RVIZ 串流地址与设备名做了配置化预留 ✓；**地图坐标关系、MipMap 导出格式、正式指标与标定曲线未预留** |
| R-20.1 | 技术资料入口（外部文档链接） | 不适用 | — | 文档性内容 |

---

## 2 逐模块细节

### 2.1 路由与外壳现状（先建立事实基线）

```
src/App.tsx:1-5           → routes.tsx
routes.tsx:25-40          → 9 条路由：/ /orders /mapping /twin /adapt /knowledge /archive /console /present
AppShell.tsx:11-17        → MumaiProvider + Shell
Shell.tsx:100-110         → /present 走无外壳分支
Shell.tsx:112-217         → 其余页面：顶栏(85px) + <Outlet/> + 小木按钮/抽屉 + 左下账号块 + toast + 底部 ticker
main.tsx:8-14             → HashRouter（所有 URL 形如 #/adapt?tab=dataset）
```

关键事实：

- **没有左侧导航**。`Shell.tsx:4-8` 的注释明确说明「这里**不放左侧导航栏**——顶栏的 NavLayer 已经是完整的一级导航」。八项导航渲染在 `DemoHeader.tsx:326-336`，位置是顶栏第二行左下（`DemoHeader.tsx:122-129` 的 `left:22px; bottom:6px`）。这与 PRD 2.2「左侧一级导航控制在八项」冲突。
- **`MumaiDashboard/index.tsx`（335 行）与 `workOrders/moduleCopy/chinaSites/shanghaiSites`（`data.ts`）已不在路由中**。`index.tsx:2-7` 的注释自述「本文件已不参与路由」。它是当前唯一含有完整首页信息架构 + `WorkOrderModal` 的文件。
- **`map/MapScene.tsx`、`map/MapGroup.tsx`、`map/SiteMarker.tsx`、`map/FlyLines.tsx`、`map/BeamLights.tsx` 是死代码**。grep `MapScene|SiteMarker|FlyLines|BeamLights` 全库仅命中其自身定义与注释，无任何 import。真正被 `Overview.tsx:14` / `Present.tsx:11` 使用的是 `mapDemo/`（从上游 Demo2 拷贝的一套）。
- **`lib.ts`（718 行）业务函数零引用**。grep `validateEnvironment|checkGrouping|runEvaluation|fuseByRule|runArchiveCheck|searchKnowledge|hhPrior|computeMetrics` 仅命中 `lib.ts` 自身；`lib.ts` 被 import 的只有 `clockStamp`（`context.tsx:28`、`SmallWoodPanel.tsx:26`）和类型 `Tone`（`Header.tsx:14`、`ui.tsx:10`）。

### 2.2 地图渲染链（决定 (a)(b) 两个结论）

被使用的链：

```
Overview.tsx:14  → mapDemo/index.tsx:61
  Canvas(Lights / Base / Bottom / Mirror / BeamLight / OrbitControls)
  mapDemo/base.tsx:249-287
    regions.map(<City/>)        ← 省/区挤出几何 + 省名标签（base.tsx:385-393）
    <GeoTrail/>                 ← 中国国界描边
    <Cones data={regions}/>     ← 每个区域一个上游装饰光锥（cone.tsx:24-63）
    <FlyLine data={regions}/>   ← 区域间飞线
    <Boundary data={boundary}/>
  base.tsx:267-271              ← 仅「上海」区域可点击下钻
```

**这条链上没有任何业务数据**：grep `CURRENT_RISKS|WORK_ORDER|scenario|COMPONENTS` 在 `mapDemo/` 下**零命中**。`Cones` 是 `guangquan01.png` 贴图的四棱锥 + 旋转光圈（`mapDemo/cone.tsx:34-59`），每个省级/区级区域一个，不含工单、风险、文保、位置语义。

未被使用但已写好的链（`map/MapScene.tsx:339-388`）：`MapGroup(中国/上海) + SiteMarker(按 collected/inspected/risk/workorder 四态分色 + 当前点脉冲) + FlyLines + BeamLights`，数据来自 `data.ts:36-71` 的 `chinaSites/shanghaiSites/flyLineSeeds`。其中 `shanghaiSites`（`data.ts:52-59`）恰恰就是 PRD / 设计稿要的「文保单位」层（示例寺、广富林、真如寺、龙华寺、静安寺、玉佛禅寺）。

### 2.3 各页实现质量速览

| 页面 | 文件行数 | 实际内容 | 主要问题 |
| --- | --- | --- | --- |
| `/` Overview | 294 | 地图 + 4 浮层（场地概览 / 数据通道 / 四柱状态 / 待办与事件）+ 面包屑 + 图例 + 进入上海 | 缺工单列表、风险计数、当前工单卡、查看工单；地图无业务点 |
| `/orders` | 414 | 工单列表（当前+历史）+ 详情 + 构件表 + 附件 + 环境表单/校验 + 补偿差异 + 人员/操作记录 | 缺创建/编辑/开始；附件不可点开；无验收与施工反馈操作 |
| `/mapping` | 291 | RVIZ 视图 + 视频占位 + 四路通道 + 巡检任务/点位/步骤/接管 | 默认渲染静态截图；点位不可选；视频是空占位 |
| `/twin` | 543 | 手搓庭院 3D + 图层开关 + 场景库 + 热点详情 + 融合结果 + 频谱 + 历史对比 | 非高斯场景；route/history 空开关；书签/复位不动相机；hotspot.history 未渲染；波形写死初扫 |
| `/adapt` | 863 | 6 个页签全部有实质内容（见 §4-d） | 采集缺选择器；数据集缺路径/标签依据列；训练缺提交与精确率/召回率/F1；交付缺下载 |
| `/knowledge` | 217 | 检索 + 元信息 + 命中列表 + 原文位置 + 业务状态 + 资料库 | 检索是 n-gram 命中率非 TF-IDF；无上传/分类/过滤；`**` 字面量残留 |
| `/archive` | 264 | 10 组 24 项清单 + SHA-256 校验 + 汇总 + 打印 | 摘要比对逻辑失效（死分支）；无归档包下载 |
| `/console` | 255 | 16 段剧本时间轴 + 阶段推进 + 8 事件按钮 + 状态 + 事件总线 | 无新建会话/故障案例/暂停动画/缺失素材检查；无鉴权 |
| `/present` | 103 | 地图 + 标题 + 5 个统计块 + 四柱条 + 切换按钮 | 无对话模式、无当前对象、无控制权 |

---

## 3 九项专项核查

### (a) 首页信息架构：应该有哪些区块 vs `Overview.tsx` 实际有哪些

**依据**：PRD 3.1 + PRD 15 + 剧本 S01（史：*工单附件与构件清单已打开*）+ 设计稿 `docs/design/china-dashboard-concept.png` / `shanghai-dashboard-concept.png`。

设计稿与旧实现（`index.tsx:113-290`）共同定义的首页 IA 共 9 块：

| # | 区块 | 设计稿/旧实现证据 | `Overview.tsx` 现状 |
| --- | --- | --- | --- |
| 1 | 左栏·态势指标（已覆盖省份 8 / 古建点位 24 / 完成巡检 18·75%；上海：古建点位 6 / 完成巡检 4·67% / 风险构件 3） | `index.tsx:119-131` | ❌ 缺失 |
| 2 | 左栏·趋势/区县分布图 | `index.tsx:134-140`、`TrendChart.tsx:1-20` | ❌ 缺失 |
| 3 | 地图主区（省/区下钻、图例、进入/返回） | `index.tsx:143-207` | ✅ 有（`Overview.tsx:127-285`） |
| 4 | 地图上的业务点位（已采集/有风险/有工单/文保单位/当前巡检位置） | 设计稿上的示例寺/广富林/真如寺/广富林 图标；`data.ts:52-59` | ❌ **缺失**（见 (b)） |
| 5 | 右栏·风险与工单计数（高风险 3 / 待处理 7 / 处理中 4） | `index.tsx:210-218` | ❌ 缺失 |
| 6 | 右栏·工单列表（6 条，含风险等级与状态） | `index.tsx:219-245`、`data.ts:73-79` | ❌ 缺失 |
| 7 | 右栏·当前工单卡 + 「查看工单」按钮 | `index.tsx:246-274` | ❌ 缺失 |
| 8 | 底部状态条（slogan「让古建被看见 · 让历史有未来」+ 实时位置 + 时间） | `index.tsx:278-290` | ❌ 缺失（`Overview.tsx:287-291` 只有三行浅色小字） |
| 9 | 地图外的「场地概览 / 数据通道 / 四柱状态 / 待办与最近事件」 | PRD 3.1 明文要求 | ✅ 有（`Overview.tsx:133-236`，这是唯一超出设计稿的部分） |

**结论**：`Overview.tsx` 保住了 PRD 3.1 的文字要求（寺院/工单/四柱/阶段/三通道/场地概览/待办/最近事件），但**丢掉了全部「任务性」区块（工单列表、风险计数、当前工单、查看工单入口）与全部「统计性」区块（态势指标、趋势/区县分布）**，也丢掉了设计稿的底部状态条与 slogan。结果是：总览页「看得到状态，看不到要做的事」。

**改哪里、加什么**：
- `src/pages/MumaiDashboard/pages/Overview.tsx`：新增右栏区块（风险与工单计数 / 工单列表 / 当前工单卡 + 「查看工单」），数据改用 `seed/scenario.ts` 的 `WORK_ORDER + HISTORIC_ORDERS + CURRENT_RISKS`（**不要**继续用 `data.ts:73-79` 的 `workOrders`，它与 `WORK_ORDER` 字段口径不同）；新增左栏态势指标（用 `HISTORY_STATS` + `COMPONENTS` + `CURRENT_RISKS` 现算，避免硬编码 8/24/18）。
- `src/pages/MumaiDashboard/pages/Overview.tsx:287-291`：底部 footer 改为 `statusbar` 样式，补 slogan 与实时位置。
- 可直接搬运 `index.tsx:113-290` 的结构，但数据源全部换成 `seed/scenario.ts`；`TrendChart.tsx` / `DistrictBars` 若复用需把 `values`（`TrendChart.tsx:1`）迁进种子。

### (b) 上海下钻后的联动：工单点 / 风险点 / 文保单位 / 当前巡检位置 / 选中工单

| 联动项 | 代码里存在吗 | 在地图上渲染了吗 | 证据 |
| --- | --- | --- | --- |
| 工单点 | 数据存在（`data.ts:53` `orderId:"SH-2026-0901"`；`seed/scenario.ts:258` `WORK_ORDER`） | ❌ | `mapDemo/` 全目录 grep `Site`/`marker`/`scenario`/`WORK_ORDER` **零命中**；`mapDemo/base.tsx:280` 只有 `<Cones data={regions}/>` |
| 风险点 | 数据存在（`seed/scenario.ts:395-417` 三条；`data.ts:53` `risk:"Z04 下部疑似空洞"`） | ❌ | 同上 |
| 文保单位 | 数据存在（`data.ts:52-59` 六个寺/遗址，含 `district`） | ❌ | `src/` 全库 grep `文保` **零命中**；`shanghaiSites` 只被死代码 `index.tsx:69` 与 `map/MapScene` 使用 |
| 当前巡检位置 | 数据存在（`seed/scenario.ts:580-588` `POSE_TRACK`） | ❌（总览地图）；△（建图页 canvas 内） | 总览/Present 用的 `mapDemo` 不含位姿；`POSE_TRACK` 只在 `pages/RvizView.tsx:192-215` 被画进 RViz canvas |
| 选中工单 | 只有 `selectedComponent` 局部状态（`Overview.tsx:117`、`:188-196`） | ❌ | 该状态只切换左下风险卡，不改变地图；无「选中高亮」概念进入 `map/store.ts`（`hoveredRegion`/`focusRegion` 定义了但**全库无人写入或读取**）|

**结论**：点击上海轮廓能下钻（`mapDemo/base.tsx:267-271` + `mapDemo/index.tsx:142`），但下钻后地图上**除省/区名标签外没有任何业务信息**，与 PRD 3.2 / 剧本 S08–S09「Z01–Z04 位置可对照」以及设计稿的联动完全不符。

**改哪里、加什么**：
1. 新增 `src/pages/MumaiDashboard/mapDemo/BusinessMarkers.tsx`：直接复用现成的 `map/SiteMarker.tsx`（已实现四态分色、地面脉冲环、光斑、旋转光圈、光柱、HTML 标签、`onSelect` 拾取球）。
2. `mapDemo/base.tsx:280` 附近挂载 `<BusinessMarkers sites={...} selectedOrderId={...} currentPose={...}/>`，坐标用 `d3-geo` 的 `projection`（`base.tsx:59-63` 已有实例）把经纬度投到与地图同一平面；`mapDemo/base.tsx:170-176` 已有 `data.features[].geometry.coordinates` 可做投影参考。
3. 把 `data.ts:36-71` 的 `chinaSites/shanghaiSites/flyLineSeeds/workOrders` **迁移进 `seed/scenario.ts`**（PRD 16.2 要求单一 manifest），字段补 `sourceMode`、`componentId`。
4. `map/store.ts` 补 `selectedOrderId` / `selectedComponentId` / `currentPose`，让 `Overview.tsx` 的工单点击能高亮地图点位（双向联动）。

### (c) `SH-2026-0901` / `Z04` 融合证据 / 回声 / 处理时间线：数据链完整性与界面可达性

**数据链：完整。**

| 环节 | 数据 | 证据 |
| --- | --- | --- |
| 工单 | `SH-2026-0901`，7 个附件（含 `asset-img-04` / `asset-radar-04`） | `seed/scenario.ts:258-284` |
| 本轮风险 | `CUR-Z04-01/02/03` = 0.71 / 0.84 / 0.87 | `seed/scenario.ts:395-417` |
| 热点证据 | `hs-Z04-lower`：原图 `img-Z04-lower-f11.jpg`、回波 `peakIndex 0.62 / amplitude 0.87`、初筛「疑似楠木（低置信）」、融合 `FUSION-03`、**history 3 条** | `seed/scenario.ts:651-663` |
| 融合记录 | 完整性 4 项、标注 3 框、雷达 3 段、测区匹配 3 对、输出 3 条（含规则与下一步） | `seed/scenario.ts:1035-1071` |
| 频谱 | `wf-Z04-002`（复扫）带 3 个标记：疑似受潮 0.71 / 疑似空洞 0.84 / 疑似空洞 0.87 | `seed/scenario.ts:744-752` |
| 操作时间线 | `ORDER_LOGS` 12 条（建单 → 环境 → 校验 → ack → 地图 → 发布场景 → 异常 → 分组 → 评估 → 更新 → 测区 → 草稿） | `seed/scenario.ts:475-488` |
| 处理时间线（热点级） | `HOTSPOTS[0].history` 3 条（2026-05-18 R04 / 2026-09-11 28:04 冻结 / 39:44 复扫回传） | `seed/scenario.ts:658-662` |

**界面可达性：不完整。**

| 路径 | 状态 | 证据 |
| --- | --- | --- |
| 工单 → 附件 | 只列文件名，**不可点击** | `pages/Orders.tsx:214-226` |
| 工单 → 融合证据 | 只能绕到 `/adapt?tab=fusion` 手动找 | `pages/Adapt.tsx:774-802` |
| 工单 → Z04 回波（复扫 0.71/0.84/0.87） | **不可达**。Twin 页写死 `WAVEFORMS[0]`（初扫 `wf-Z04-001`，只有 1 个标记） | `pages/Twin.tsx:292`、`:504-509` |
| 工单 → 处理时间线 | 部分：`ORDER_LOGS` 在 Orders 页底部可见（`:397-408`）；`WorkOrderModal` 的 4 步时间线随死代码失去入口 | `WorkOrderModal.tsx:15`、`index.tsx:332` |
| 点 Z04 热点 → 历史任务 | **缺失**：`hotspot.history` 全库无渲染 | grep `hotspot.history`/`historyRisk` 仅 `Twin.tsx:293,524` 用于历史风险对比，不含 3 条处理记录 |
| 从工单点附件回到同一份结果（PRD 1.1） | **不可达** | 无双向 ID 跳转（`assetId` 未被任何路由或页面消费） |

**改哪里、加什么**：
1. `pages/Orders.tsx:214-226`：附件 `<li>` 改为 `<button>`，按 `assetId` 打开。
2. 新增 `src/pages/MumaiDashboard/pages/EvidenceDrawer.tsx`：入参 `assetId` / `riskId`，从 `HOTSPOTS` + `FUSION_RECORD.annotations` + `WAVEFORMS` + `hotspot.history` + `ORDER_LOGS` 聚合出「原图 / 回波片段 / 初筛 / 融合结果 / 处理时间线」，同时给「在孪生中定位」按钮（`navigate('/twin?component=Z04')`）。
3. `pages/Twin.tsx:292`：`const waveform = WAVEFORMS[0]` 改为按 `selected` + 当前批次选取（Z04 → `wf-Z04-002`）。
4. `pages/Twin.tsx:422-465`：在热点详情里补渲染 `hotspot.history`（3 条处理记录）。

### (d) 检测适配 6 个 Tab：是否都在、内容是否空壳

**6 个 Tab 全在**（`design.ts:87-94` 定义、`Adapt.tsx:846-859` 渲染），**没有空壳页**。逐 Tab 内容与缺口：

| Tab | 内容量 | 已有 | 缺什么 |
| --- | --- | --- | --- |
| 采集 `Adapt.tsx:48-163` | 3 个 Panel | 批次配置 6 字段、批次切换、启动/暂停、三类接收表、频谱、参考样本批次、冻结提示 | 工单/柱号/测区/扫描方向选择器；实时预览画面；文件落盘状态；URL `batch` 未读取（`:50`）|
| 异常排查 `:169-304` | 2 个 Panel | 异常事件 4 字段 + 证据列表 + 触发/恢复按钮；四项检查（记录/结论输入/签名）+ 创建样本任务 | 基本完整；缺「预置异常演示」的显式标记（PRD S12 要求页面显示「预置异常演示」）|
| 数据集 `:310-424` | 3 个 Panel | 清洗五步表、12 条样本表、分组卡、交集表、审核分工、冻结按钮 | 样本表缺「路径/标签依据」列；无未知标签独立列表；无清洗前后对比；冻结不读审核状态 |
| 训练验证 `:430-599` | 3 个 Panel | 实验 6 字段、五步流程、双损失曲线、双混淆矩阵、漏检/误报变化、12 行逐样本表、6 条验收规则、失败案例开关 | 提交按钮；真算的精确率/召回率/F1；按材种回归数值；日志；结果阻止发布 |
| 更新交付 `:605-707` | 3 个 Panel | 包清单 8 字段、量化 3 条、兼容性 5 条、交付八步、下发/读取版本按钮 | 下载按钮（真实文件）；sha256 展示；失败回执案例 |
| 融合分析 `:713-817` | 4 个 Panel | 完整性表、分支状态、标注表、测区匹配表、雷达特征表、三规则、输出表（3 条）、保存按钮 | 行可点击 → 联动原图/曲线/三维热点 |

### (e) 数字孪生是否符合 PRD 场景与交互

| PRD 3.3 / 10 要求 | 实现 | 判定 |
| --- | --- | --- |
| 加载预采高斯成果（Spark/SplatMesh） | 无依赖、无产物、无加载器 | ❌ |
| 四柱场景可自由浏览 | 手搓低模（`Twin.tsx:47-229` 地砖/栏杆/照壁/圆柱）+ OrbitControls | △ 视觉可看，但不是孪生成果 |
| 按 Z01–Z04 快速跳转 | `Twin.tsx:313-317` 四个按钮 + `?component=` | ✅ |
| 主视图 ≥2/3 | `pages.css:2197` `1fr + 372px` | ✅ |
| 可移动/旋转/复位 | `Twin.tsx:267` OrbitControls ✓；复位 = 只改书签 id（`:318-324`） | △ |
| 五图层开关 | labels ✓ / surface △ / radar △（作用于全部柱，含未采集柱）/ route ✗ / history ✗ | ❌ |
| 点 Z04 下部热点展开原图/回波/初筛/融合/历史任务 | 前四项 ✓，历史任务 ✗，热点本身不可点 | △ |
| 历史与当前对比（书签或并排） | 并排文字卡 ✓，书签不动相机 ✗ | △ |
| 内部异常以示意响应区表达 | ✓（`Twin.tsx:204-218`） | ✅ |
| 未标定时以柱号+人工热点对应 | ✓（横幅 + 柱号按钮） | ✅ |
| 不把车辆追踪三维点击位置 | ✓（`Twin.tsx:310`） | ✅ |

**改哪里、加什么**：
- `package.json`：加 `@sparkjsdev/spark`（或按 PRD 10 允许的 `three` + splat loader），并在 `public/scenes/` 放一份可打开的四柱场景产物。
- `pages/Twin.tsx:231-270`：把 `TwinScene` 拆成 `<GaussianScene/>`（加载 manifest + SplatMesh）与 `<ProxyOverlay/>`（透明代理网格承载热点点击，PRD 10 建议做法），`SceneAsset.format` 已声明 `spark-splat / manifest json` 可直接消费。
- `pages/Twin.tsx:277-283`：`route` 用 `PLANNED_PATH`/`WAYPOINTS` 画线，`history` 用 `HISTORY_RISKS`+`hotspot.history` 显示历史观察点。
- `pages/Twin.tsx:318-324`、`:365-381`：书签改为真正驱动相机（把 `SCENE_BOOKMARKS.azimuth/polar` 转成相机位置，或用一个 `useThree` 的相机控制器执行 tween）。
- `pages/Twin.tsx:213-218`：`showRadar` 加 `component.radarScore !== null` 条件。

### (f) 4 个账号权限 / 视角差异

| 项目 | 状态 | 证据 |
| --- | --- | --- |
| 账号定义（沈/史/饶/马 + 角色 + 默认工作区） | ✅ | `design.ts:67-72`，与 PRD 2.1 表逐字一致 |
| 切换账号 | ✅ | `DemoHeader.tsx:304-317` 下拉；`Shell.tsx:81-89` 切换后 `navigate(next.page)` |
| 账号可见性（顶栏 + 左下角） | ✅ | `Shell.tsx:181-194` |
| 权限/操作差异 | ❌ **完全没有** | `accountId` 在全库只被 `Shell.tsx:63-66,81-89,119` 与 `Header.tsx:79` 使用，全部用于**显示**；没有任何 `if (accountId === ...)` 的按钮禁用或页面隔离 |
| 视角差异（各账号看到不同默认页与不同工作区） | △ 仅默认落地页 | 切换账号会跳默认页，但可以自由导航到任意页；越权操作全部可用 |

**具体越权示例**（PRD 2.1 规定这些是专属操作）：

| 操作 | 应为 | 现状 |
| --- | --- | --- |
| 「运行校验」环境 + 生成配置版本 | 沈 | 任何账号可点（`pages/Orders.tsx:294-308`） |
| 「全栈接收并返回 ack」 | 饶 | 任何账号可点（`pages/Orders.tsx:309-316`） |
| 「检查并发布」场景 | 史 | 任何账号可点（`pages/Twin.tsx:412-419`） |
| 「下发更新包」 | 史 | 任何账号可点（`pages/Adapt.tsx:681-688`） |
| 「读取设备版本 / 执行模拟更新」 | 饶 | 任何账号可点（`pages/Adapt.tsx:689-697`） |
| 「任务下发 / 暂停 / 取消」 | 马/史 | 任何账号可点（`pages/Mapping.tsx:122-141`） |
| 「装载快照」（演示控制） | 管理员 | 任何账号可见（`Shell.tsx:187-193`） |

**改哪里、加什么**：在 `context.tsx` 增加 `can(action: ActionKey): boolean`（用 `ACCOUNTS.permissions` 表驱动），在 `ui.tsx:147` 的 `Btn` 增加 `disabledReason` 属性，各页把上表操作接上；`Shell.tsx:187-193` 的「装载快照」按 `accountId === "admin"` 或独立管理员开关隐藏；演示控制台 `/console` 加账号门禁（PRD 2.1「演示控制台使用独立管理权限」）。

### (g) `/present` 演示窗口

已实现的部分：
- 路由存在（`routes.tsx:37`），且 `Shell.tsx:100-110` 对它走**无外壳**分支 → 无导航、无小木浮层、无 ticker（满足 PRD 7.4「大屏隐藏控制台入口」）。
- 入口两处：`Header.tsx:96-105`「投到展示窗口」、`Console.tsx:230-232`；实现为 `window.open("#/present","_blank","noopener")`（`Shell.tsx:68-70`）。

未实现的部分：

| PRD 要求 | 现状 |
| --- | --- |
| presentation 角色能承载「当前演示对象」（工单/Z04 证据/批次） | ❌ 无选中对象概念，只有 `WORK_ORDER.id` 与阶段名（`Present.tsx:52-56`） |
| 小木大屏对话模式（PRD 2.2） | ❌ 整页无小木 |
| 展示控制权当前持有人 + 换人显式交接（PRD 2.2） | ❌ 无任何 UI |
| 投屏动作才改变大屏（本端操作不影响大屏） | ❌ 两端是各自独立的 React 状态，无通道，行为上「互不影响」但不是设计意图 |
| 大屏信息量适配投影（正文 ≥18px、结论 ≥24px） | △ `present__stats strong` 为 22px（`pages.css:3117-3121`），仍未达「结论 24px 以上」，`small/em` 只有 10–11px |

**改哪里、加什么**：`pages/Present.tsx` 增加右侧/底部「当前演示对象」区（订阅一个共享 store 的 `presentFocus`），加小木对话抽屉（复用 `SmallWoodPanel` 但去掉导航跳转），页首加「控制权持有人」徽标；`Shell.tsx:68-70` 在 `window.open` 前把当前 focus 写入 `localStorage`/`BroadcastChannel` 供大屏读取。

### (h) PRD 数字指标与代码值对照

| PRD 指标（出处） | PRD 值 | 代码值 | 位置 | 一致？ |
| --- | --- | --- | --- | --- |
| 历史巡检风险数（5.3 / 14.3 / A01） | 6 | `HISTORY_RISKS.length` = 6 | `seed/scenario.ts:378-385` | ✅ |
| 施工反馈完成数（5.3 / A01） | **4** | **6**（六条 `reported: true`） | `seed/scenario.ts:390` | ❌ |
| 验收关闭数（5.3 / A01） | 3 | 3 | `seed/scenario.ts:391` | ✅ |
| 尚未关闭数（5.3 / A01） | 3 | 3 | `seed/scenario.ts:392` | ✅ |
| 小木回答「共 N 处风险」（5.3 / 14.3） | **6** | **9**（`CURRENT_RISKS.length + HISTORY_STATS.total`） | `SmallWoodPanel.tsx:58` | ❌ |
| 复扫三处置信度（3.7 / A17 / S19） | 0.71 / 0.84 / 0.87 | 0.71 / 0.84 / 0.87 | `seed/scenario.ts:398,405,412` | ✅ |
| 本轮异常响应区（Present） | 3 | 3 | `pages/Present.tsx:22` | ✅ |
| 检索 Top K（5.2） | 5 | 5 | `seed/scenario.ts:1287` | ✅ |
| 无命中阈值（5.2） | 初始 0.15 | 0.15 | `seed/scenario.ts:1288`、`Knowledge.tsx:45` | ✅ |
| 分块（5.2） | 300–500 字 / 重叠 60 | 仅文案 | `seed/scenario.ts:1289` | △ 无实现 |
| 意图条数（4.2 表） | 14 | 10 | `seed/scenario.ts:1186-1247` | ❌ |
| 小木工具卡片（4.1） | 工具与意图一一对应 | 6 个工具 vs 10 条意图的中文短语，查不到 | `seed/scenario.ts:1250-1257`、`SmallWoodPanel.tsx:116-123` | ❌ |
| 地图更新/位姿/状态频率（8.2） | 1–2Hz / 2–5Hz / 1Hz | 无 | 全库无匹配关键词 `Hz` | ❌ |
| 场景帧率（18.3） | ≥25fps | 无 | 全库无匹配关键词 `fps` | ❌ |
| 单次列表上限（14.1） | 100 条 | 无 API | — | 不适用 |
| 四柱编号（3.1/3.3） | Z01–Z04 | Z01–Z04 | `seed/scenario.ts:224-250` | ✅ |
| 本轮风险编号（16） | CUR-Z04-01~03 | CUR-Z04-01~03 | `seed/scenario.ts:396-416` | ✅ |
| 历史风险编号（16） | R01–R06 | R01–R06 | `seed/scenario.ts:379-384` | ✅ |
| 地图版本（3.2 / 剧本 S05） | 本轮 MAP-SH-06 | 总览卡片显示 **MAP-SH-05**（`MAP_VERSIONS[0]`） | `pages/Overview.tsx:22`、`seed/scenario.ts:494-496` | ❌ |
| 场景版本（3.3） | GS-2026.09（本轮）/ GS-2026.05（历史） | 一致 | `seed/scenario.ts:625,631` | ✅ |
| 场景关键帧（3.3） | 历史 168 / 本轮 214 | 168 / 214 | `seed/scenario.ts:624,630` | ✅ |
| 数据集版本（3.5） | DS-06 冻结 | DS-06，`frozen:true` | `seed/scenario.ts:857-861` | ✅ |
| 实验记录（3.6 / 11.2） | 同一实验 ID | `EXP-2026-0911` 同源 | `seed/scenario.ts:913-944` | ✅ |
| 输入规格（11.2） | 1×420 频谱向量 | 一致 | `seed/scenario.ts:922,971` | ✅ |
| 量化复测（11.2） | 24 条复测 | 24 条 / 一致 22 条 | `seed/scenario.ts:979` | ✅ |
| 更新包（11.3） | `.demo.zip`、`demo_nonflashable` | 一致 | `seed/scenario.ts:967-968` | ✅ |
| 设备版本双轨（11.4） | live 与 demo 分开 | `FW-1.4.2` / `DEMO-M02b · FW-DEMO-1.4.2` | `seed/scenario.ts:999` | ✅ |
| 天气归档（剧本 S01） | 近三个月、含来源 | 2026-06-11~09-10、412mm、78%、11.4℃ | `seed/scenario.ts:71-76`、`:1144` | ✅ |
| 排练时长（PRD 1.3 50–53 分钟；剧本 08:00–47:00） | 剧本口径 47:00 | `CLOCK_PHASES` 覆盖 08:00→47:00 | `seed/scenario.ts:97-188` | ✅（与剧本一致） |
| 归档清单项数（剧本 S23） | 按清单 | 24 项 / 10 组 | `seed/scenario.ts:1100-1125` | ✅ |
| HH 平衡含水率（3.1） | 只作先验 | 种子 `estimatedEmcPct:14.2`；`lib.hhPrior()` 按同工况算出约 8.60 —— 两者不一致，但 `hhPrior` 未被调用、`14.2` 也未在任何页面显示 | `seed/scenario.ts:456-462`、`lib.ts:105-114` | △ 死代码内部不自洽 |
| 趋势图 4 月值（设计稿） | 10 | 6（死代码） | `TrendChart.tsx:1` | ❌ |
| 区县分布（设计稿） | 6 行（含闵行区 0） | 5 行（无闵行区） | `TrendChart.tsx:18` | ❌ |

### (i) PRD 文案与代码文案对照

| 类别 | PRD 文案 | 代码文案 | 位置 | 一致？ |
| --- | --- | --- | --- | --- |
| 平台大标题 | 木脉智检 | 木脉智检 | `DemoHeader.tsx:293` | ✅ |
| 平台副标题 | 古建筑智能巡检平台 | 古建筑智能巡检平台 | `DemoHeader.tsx:294`；`document.title` 同（`Shell.tsx:60`） | ✅ |
| 一级导航 8 项 | 任务总览/工单档案/建图巡检/数字孪生/检测适配/知识库/报告归档/演示控制 | 完全相同 | `design.ts:76-83` | ✅ |
| 检测适配 6 页签 | 采集/异常排查/数据集/训练验证/更新交付/融合分析 | 完全相同 | `design.ts:88-93` | ✅ |
| 工单状态 6 态 | 草稿/待复核/待处理/处理中/待验收/已关闭 | 完全相同 | `design.ts:97-104` | ✅ |
| 环境提交两态 | 「已提交」「设备已确认」 | 完全相同 | `pages/Orders.tsx:341,348` | ✅ |
| 未检测口径 | 「未采集」 | 「未采集」 | `pages/Overview.tsx:101`、`pages/Present.tsx:86` | ✅ |
| 投屏按钮 | 投到展示窗口 | 投到展示窗口 | `Header.tsx:104`、`Console.tsx:231` | ✅ |
| 下钻按钮 | 进入上海 / 返回全国 | 进入上海 / 返回全国 | `pages/Overview.tsx:278` | ✅ |
| 交付 8 步 | 量化记录/兼容性检查/封装/下发/接收/更新/重启自检/版本确认 | 完全相同 | `seed/scenario.ts:990-997` | ✅ |
| 演示包口径 | 不可烧录演示包 | 「不可烧录演示包」 | `pages/Adapt.tsx:611`、`pages/Archive.tsx:238` | ✅ |
| 相似度口径 | 检索相似度，不能标为病害置信度 | 「检索相似度」✓ | `pages/Knowledge.tsx:128` | ✅ |
| 未知输入回复 | 可查询巡检资料、查看构件或启动当前业务流程 | 「意图目录里没有匹配项，也不调用大模型猜测。可以换一种说法，或直接用关键词查询资料。」 | `SmallWoodPanel.tsx:161-162` | ❌ |
| 异常暂停提示 | 等待操作员确认停止 | 一致 | `pages/Adapt.tsx:117-118` | ✅ |
| 底部 slogan（设计稿） | 让古建被看见 · 让历史有未来 | 只存在于**死代码** | `index.tsx:279` | ❌ 活页面缺失 |
| 「受限 Python 校验单元」（PRD 12） | 界面明确 | 全库无匹配 | — | ❌ |
| 「预置异常演示」（剧本 S12） | 页面应显示 | 只有 `presetAnnotation` 状态与 Console 里的「预设标注演示」 | `context.tsx:126`、`pages/Console.tsx:206` | △ 采集/排查页未显示 |
| 首页标题（设计稿） | 全国巡检态势 / 上海巡检态势 | 「场地概览 · 示例寺」 | `pages/Overview.tsx:133` | ❌ 不一致 |
| Markdown 残留 | — | `相似度是**检索相似度**` 中的 `**` 会原样显示 | `pages/Knowledge.tsx:171` | ❌ 显示缺陷 |
| 视频通道说明 | 「视频在播放不等于车辆在线」 | 一致 | `pages/Mapping.tsx:169` | ✅ |

---

## 4 按优先级排序的待补清单

### P0 — 演示必须（不做就在评委面前露馅）

| # | 事项 | 改哪个文件 | 加什么 |
| --- | --- | --- | --- |
| P0-1 | **上海下钻后的业务点位联动**：工单点、风险点、文保单位、当前巡检位置、选中高亮 | 新建 `src/pages/MumaiDashboard/mapDemo/BusinessMarkers.tsx`；改 `mapDemo/base.tsx:280`；改 `map/store.ts`；把 `data.ts:36-71` 的站点数据迁入 `seed/scenario.ts` | 复用现成的 `map/SiteMarker.tsx`（四态分色 + 脉冲 + 光柱 + 标签 + `onSelect`）；用 `base.tsx:59-63` 的 `projection` 把经纬度投影到地图平面；store 补 `selectedOrderId/selectedComponentId/currentPose` |
| P0-2 | **首页补齐任务性区块**：风险与工单计数、工单列表（6 条）、当前工单卡 + 「查看工单」 | `pages/Overview.tsx`（新增右栏），可参照 `index.tsx:209-275` 的结构 | 数据源改用 `seed/scenario.ts` 的 `WORK_ORDER/HISTORIC_ORDERS/CURRENT_RISKS/HISTORY_STATS`；「查看工单」跳 `/orders?order=SH-2026-0901` |
| P0-3 | **Z04 证据链可点可达**：工单附件 → 原图 / 回波 / 初筛 / 融合 / 处理时间线 | `pages/Orders.tsx:214-226` 改成可点；新建 `pages/EvidenceDrawer.tsx`；`pages/Twin.tsx:292` 波形按构件取 `wf-Z04-002`；`pages/Twin.tsx:422` 补渲染 `hotspot.history` | 以 `assetId`/`riskId` 为键聚合 `HOTSPOTS + FUSION_RECORD + WAVEFORMS + HOTSPOTS[].history + ORDER_LOGS`；提供「在孪生中定位」跳转 |
| P0-4 | **小木数字与文案对齐 PRD，消除「未登记」** | `seed/scenario.ts:388-393`（拆出 `reportedDone=4`）；`SmallWoodPanel.tsx:55-70`（facts 表补齐 `items/reviewState/compatPass/compatBlock/cleanSteps/reviewCount/metrics/acceptance/fusionRecordId/outputs/orderId/priority/attachments/anomalyId/nextActions`）；`SmallWoodPanel.tsx:161-162` 改用 PRD 规定文案 | 让历史问答输出「共 6 处风险，施工反馈完成 4 处，验收关闭 3 处，尚未关闭 3 处」（A01/A02 验收点） |
| P0-5 | **建图主视图恢复为可交互栅格 + 让叠加开关生效** | `pages/RvizView.tsx:243-260`（默认改走 `DemoRvizCanvas`，或在静态图上叠加矢量层）；`pages/Mapping.tsx:36-43` | 给 canvas 加滚轮缩放 / 指针拖拽平移；补画四柱位置；`showActualPath`/`showLaser` 在两种渲染路径下都要有效 |
| P0-6 | **总览地图通道版本号显示 MAP-SH-06** | `pages/Overview.tsx:22` | 改为读 `MISSION.mapVersion`（或 `MAP_VERSIONS.find(v => v.id === MISSION.mapVersion)`），不要用 `MAP_VERSIONS[0]` |
| P0-7 | **归档 SHA-256 真比对** | `pages/Archive.tsx:65-97`（删掉 `:90` 的恒等三元） | 直接调用 `lib.runArchiveCheck(ARCHIVE_ITEMS)`（已实现完整逻辑），并在结果面板渲染 `reportHtml` 提供下载 |
| P0-8 | **训练验证真算指标** | `pages/Adapt.tsx:430-599` | 用 `lib.runEvaluation(EXPERIMENT)` 替换页面内联的 tp/fp/tn/fn；`ui.tsx:413-445` 的 `ConfusionMatrix` 增加精确率/召回率/F1 与「不适用」显示；补按材种回归表 |
| P0-9 | **数据集分组检查接真实现** | `pages/Adapt.tsx:310-424` | 用 `lib.checkGrouping(DATASET, SAMPLES)` 替换内联求交；渲染 `conflicts / orphans / unknownInSupervised` 明细；给「整组调整后重跑」一个可编辑入口（对应 A13） |
| P0-10 | **`/present` 承载当前演示对象 + 控制权指示** | `pages/Present.tsx`、`Shell.tsx:68-70` | Present 读取共享 focus（工单/构件/批次）；顶部加「控制权持有人」徽标；加小木对话抽屉（PRD 2.2） |
| P0-11 | **检测适配页签与批次 URL 打通** | `pages/Adapt.tsx:824-834`、`CaptureTab`（`:50`） | `CaptureTab` 改读 `params.batch`，切换批次时 `setParams`（顺便满足 PRD 2.2「切换页签保留当前批次」） |
| P0-12 | **底部状态条**：slogan + 实时位置 | `pages/Overview.tsx:287-291`（或提升到 `Shell.tsx:208-215` 的 ticker） | 加「让古建被看见 · 让历史有未来」与「实时位置 31.2304°N 121.4737°E」 |

### P1 — 明显缺口（容量允许就补，直接影响 PRD 条款满足度）

| # | 事项 | 改哪个文件 |
| --- | --- | --- |
| P1-1 | 四账号权限差异：按 PRD 2.1 禁用越权按钮（校验/ack/发布/下发/接收/任务下发/装载快照），`/console` 加门禁 | `context.tsx`（加 `can()`）、`ui.tsx:147`（`Btn` 加 `disabledReason`）、`Orders.tsx:294,309`、`Twin.tsx:412`、`Adapt.tsx:681,689`、`Mapping.tsx:122`、`Shell.tsx:187` |
| P1-2 | 导航改回左侧（或至少提供左侧八项导航以满足 PRD 2.2） | `Shell.tsx:4-8,112-124`、`pages.css:107-116` |
| P1-3 | 高斯场景：引入 Spark / SplatMesh，交付一份可打开的四柱场景（或明确降级为「全景视图」并标注身份） | `package.json`、`pages/Twin.tsx:231-270`、`public/scenes/` |
| P1-4 | 孪生图层 `route`/`history` 真正生效；书签与「复位」真正移动相机 | `pages/Twin.tsx:277-283,318-324,365-381` |
| P1-5 | 场景构建页（影像检查/关键帧整理/位姿展示/成果导入） | 新建 `pages/SceneBuild.tsx` + `routes.tsx` 或并入 `Twin.tsx` 新 Panel |
| P1-6 | 训练页「提交生成后台 job」+ 五阶段推进 + 日志面板；失败案例阻止发布 | `pages/Adapt.tsx:466-508`、`:605-707` |
| P1-7 | 交付页「下载演示包」真实文件（Blob + 文件名 `DEMO-PKG-02.demo.zip`） | `pages/Adapt.tsx:680-698` |
| P1-8 | 融合页行点击联动原图局部 / 曲线片段 / 三维热点（`WaveChart.highlight` 已就绪） | `pages/Adapt.tsx:739-772`、`ui.tsx:385-394` |
| P1-9 | 工单「创建 / 编辑 / 开始」+ 开始前校验构件清单与地点 | `pages/Orders.tsx:110-134`、`context.tsx:156-167` |
| P1-10 | 施工反馈与验收两个独立操作 + 验收不通过回退处理中 | `pages/Orders.tsx` 新增 Panel、`context.tsx` 加 `submitFeedback/acceptOrder` |
| P1-11 | 复巡计划详情 + 「下发」按钮（`REVISIT_PLAN.dispatched`） | `pages/Orders.tsx:192`、新建计划 Panel |
| P1-12 | 「受限 Python 校验单元」界面 + 接入 `lib.validateEnvironment/checkGrouping`，返回 passed/details/data_version/executed_at | `pages/Orders.tsx:294-335`、`pages/Adapt.tsx:372-420`、`lib.ts`（已就绪） |
| P1-13 | 小木补 4 条意图（`site_weather`/`prepare_split`/`open_evidence`/`create_revisit`）+ 意图匹配改同义词/槽位规则 | `seed/scenario.ts:1186-1247`、`SmallWoodPanel.tsx:126-139` |
| P1-14 | 语音三入口（按住说话/文本输入/常用指令）+ 预录音频或 `speechSynthesis` + 停止/重播/静音 | `SmallWoodPanel.tsx:345-368`、新增 `lib` 音频模块与 `public/audio/` |
| P1-15 | 知识库接 `lib.searchKnowledge`（真 TF-IDF + 余弦 + 权限/项目/日期过滤）；补文档上传、分类、索引状态；来源卡片带 `chunkId` 跳转 | `pages/Knowledge.tsx:31-61,119-177`、`SmallWoodPanel.tsx:326`、`lib.ts:614-680` |
| P1-16 | 归档包按清单下载 + 报告 HTML/PDF 导出（`lib.buildArchiveReportHtml` 已就绪） | `pages/Archive.tsx:110-118`、`lib.ts:535-566` |
| P1-17 | 数据集样本表补「路径 / 标签依据」列 + 未知标签独立列表 + 一条记录清洗前后对比 | `pages/Adapt.tsx:353-370` |
| P1-18 | 采集页补工单/柱号/测区/扫描方向选择器 + 实时预览区 + 文件落盘状态 | `pages/Adapt.tsx:72-140` |
| P1-19 | 建立事件/状态同步的最小子集（`BroadcastChannel` 或后端 WS 桩），让「四客户端一致」「投屏改变大屏」可演示 | 新增 `src/pages/MumaiDashboard/bus.ts`、`context.tsx` |

### P2 — 锦上添花（不阻塞演示，但 PRD 有明文）

| # | 事项 | 改哪个文件 |
| --- | --- | --- |
| P2-1 | 视觉规范对齐：浅色工作区 / 青绿主色 / 木色强调（与当前深蓝大屏风冲突，需产品先确认以哪份为准） | `pages.css:11-25`、`design.ts:15-44` |
| P2-2 | 大屏字号规范：正文 ≥18px、关键结论 ≥24px | `pages.css:39`（根字号）、`pages.css:1023`（指标值 20px）、`pages.css:1109`（矩阵值 18px） |
| P2-3 | 1366×768 档实测与修正 | `pages.css:3262` 断点 |
| P2-4 | 补总览/巡检/孪生/训练验证/小木检索五张设计稿；为 `docs/` 补设计说明 .md | `docs/design/` |
| P2-5 | 地图区域 hover/focus 反馈（`store.hoveredRegion`/`focusRegion` 已定义未使用） | `map/store.ts:25-27`、`mapDemo/base.tsx:335-343` |
| P2-6 | 消除 Markdown 残留 `**` | `pages/Knowledge.tsx:171` |
| P2-7 | 键盘快捷键 + 首次进入引导选题 + 切换工单未保存提示 | `pages/*`、`Shell.tsx` |
| P2-8 | 技术细节改可折叠面板 | `ui.tsx`（新增 `Collapse`）、`Knowledge.tsx:104-117`、`SmallWoodPanel.tsx:305-337` |
| P2-9 | 「预置异常演示」显式标记（剧本 S12 要求） | `pages/Adapt.tsx:179-241` |
| P2-10 | 趋势图/区县分布数值与设计稿对齐（4 月 10、补闵行区）或直接不使用该区块 | `TrendChart.tsx:1,18` |
| P2-11 | 清理或复用死代码（`MumaiDashboard/index.tsx`、`map/MapScene*`、`WorkOrderModal`、`ModuleDrawer`、`usePanelEntrance`、`data.ts`），避免后续维护者改错文件 | 上述文件 |
| P2-12 | 断裂恢复表逐条补 UI（ASR 不可用/语音失败/小车断连/上传中断/清洗未通过/验证失败/更新失败/后台重启/资料未命中/缺素材） | `ui.tsx`、各页 `StateBlock` |
| P2-13 | 恢复失败案例的「阻止进入发布」链路 | `pages/Adapt.tsx:605-707` |
| P2-14 | 场景 manifest 补 `asset_url`/单位/轴方向/初始相机；`ARCHIVE_ITEMS` 的 sha256 改为真实摘要 | `seed/scenario.ts:621-640,1100-1125` |

---

## 5 验收用例（PRD 18.2）对照

> 单列一节，不计入 §0 统计。

| 编号 | 结果 | 说明 |
| --- | --- | --- |
| A01 查五月巡检并打开场景 | ❌ | 数字为 9/6/3/3（应 6/4/3/3），且无「打开旧场景」动作 |
| A02 追问剩余事项 | ❌ | `unresolved_followup` 的 `{items}` → 「未登记」 |
| A03 换项目检索同一句 | ❌ | 无权限/项目过滤 |
| A04 录入湿度 105 并校验 | ✅ | `pages/Orders.tsx:39` 断言生效，未通过不产生版本 |
| A05 饶接收环境配置 | △ | 有 ack 按钮，但与账号无关，且有本地 state 刷新即失 |
| A06 建图及任务预览 | △ | 方向/柱位/路径分色只在内置 canvas 渲染里有，默认被静态图挡住 |
| A07 巡检重复下发 | ❌ | 无幂等键，按钮只 `disabled={running}` |
| A08 饶提交场景、史发布 | △ | 只有 toast，不改 `published`，无通知 |
| A09 比较四柱 | △ | 小木 `compare_columns` 可答，但无「Z04 标记对应原图与构件」的跳转 |
| A10 初扫中触发异常 | ✅ | `pages/Adapt.tsx:216-241` + 批次冻结 |
| A11 缺一张图的批次上传 | △ | 有「部分接收」状态，但无上传与补齐动作 |
| A12 清洗并人工审核 | △ | 坏帧原因可查、原始文件保留 ✓；「记录清洗前后内容」缺失 |
| A13 同一木样跨集合 | △ | 能检出交集；**无「整组调整后通过」路径** |
| A14 训练中刷新及重连 | ❌ | 无持久化、无重连 |
| A15 新旧模型比较 | △ | 有混淆矩阵与曲线；缺精确率/召回率/F1，缺「测试集不同时阻止比较」的 UI 分支 |
| A16 下载演示包并更新 | ❌ | 无下载；模拟/真机版本分离 ✓ |
| A17 复扫与融合 | ✅ | 0.71/0.84/0.87 + 证据 + 不做综合分数 |
| A18 点 Z04 热点 | △ | 无双击热点；图像/回波/批次/版本/工单之间不能互相跳转 |
| A19 施工反馈后查进展 | ❌ | 无反馈/验收操作，无进展查询 |
| A20 删除归档副本文件 | △ | 种子内置 1 项缺失 + 1 项不一致，能展示；但摘要比对逻辑失效（`Archive.tsx:90`） |
| A21 输入未知小木指令 | ✅ | 不执行工具、不推进阶段，文案与 PRD 不同但行为正确 |
| A22 非管理员调用演示重置 | ❌ | 无 403，无真实设备运行判断 |
| A23 断开互联网完整排练 | ✅ | 全部本地资源，无外网依赖 |
| A24 新开第二轮会话 | ❌ | 无 session 概念，`session-A` 是硬编码字符串（`context.tsx:190`） |

A 类用例通过情况（宽松判定：「✅」记通过，「△」记部分）：✅ 5 / △ 11 / ❌ 8。

---

## 6 取证方法与检索关键词（可复现）

| 结论 | 检索方式 |
| --- | --- |
| `mapDemo` 无业务点 | `grep "CURRENT_RISKS\|WORK_ORDER\|scenario\|COMPONENTS" src/pages/MumaiDashboard/mapDemo` → 0 命中 |
| `MapScene/SiteMarker` 是死代码 | `grep "MapScene\|SiteMarker\|FlyLines\|BeamLights\|MapGroup" src` → 仅自身定义 |
| `lib.ts` 业务函数未被调用 | `grep "validateEnvironment\|checkGrouping\|runEvaluation\|fuseByRule\|runArchiveCheck\|searchKnowledge\|hhPrior\|computeMetrics\|diffConfig\|buildConfigVersion" src` → 仅 `lib.ts` 内 |
| 无多端同步 | `grep "WebSocket\|ws://\|EventSource\|localStorage\|BroadcastChannel" src` → 0 命中 |
| 无语音 | `grep "speechSynthesis\|SpeechRecognition\|getUserMedia\|按住说话\|常用指令" src` → 0 命中（仅 `AI语音N` 文本标签） |
| 无后端/API | `grep "fetch(\|/api/\|sqlite\|request_id\|Idempotency" src` → 0 命中 |
| 无「文保单位」 | `grep "文保\|文物保护" src` → 0 命中 |
| 无「当前巡检位置」 | `grep "当前巡检位置\|巡检位置" src` → 0 命中 |
| 无「受限 Python 校验单元」 | `grep "受限" src` → 0 命中 |
| 无场景构建四步 | `grep "影像检查\|关键帧整理\|位姿展示\|成果导入" src` → 0 命中 |
| 无频率指标 | `grep "Hz\|fps" src` → 仅无关 CSS/字体命中 |
| 静态 RViz 图存在 | `public/rviz-reference.png`（1,880,251 字节）；`pages/RvizView.tsx:243,256-257` 优先使用 |
| 无 Spark/高斯依赖 | `package.json:12-29`；`grep "splat\|SplatMesh" src` → 仅 `seed/scenario.ts:625,631` 的 format 字符串 |
| `docs/` 无设计 .md | `glob docs/**/*` → 仅 `china-dashboard-concept.png`、`shanghai-dashboard-concept.png` |
| PRD 章节完整性 | PRD 651 行；第二章剧本 434 行（由 `word/document.xml` 解包为纯文本） |

---

*报告生成：只读评审，未修改任何现有源文件；新增文件仅本报告 `docs/prd-gap-analysis.md`。*
