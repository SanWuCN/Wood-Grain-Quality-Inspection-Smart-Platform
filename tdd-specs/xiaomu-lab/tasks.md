# Tasks — xiaomu-lab

> 由 `usecases.md` / `requirements.md` / `design.md` 派生。
> **测试运行方式（本项目无测试框架 → 不新增依赖）**：单测用 Node 原生测试运行器 + 原生类型剥离
> `node --test src/lab/*.test.ts`（Node 24；若报类型不支持则加 `--experimental-strip-types`）。
> 无 WebGL 的 Node 环境**只断言不变量**（注册表/纯函数/契约静态字段），**不调用 `create()`**。
> 浏览器层一律走 E2E（裸 CDP）。

## Phase 1: 基础设施（跨 UC 共享）

- [x] 1.1 建立 `src/lab/` 目录结构并固化 `types.ts`（`LabVariant` / `VariantOptions` / `VariantHandle` 契约，按 design.md §2）
      —— 素材已有 `src/lab/types.ts`（1873 B），待按契约逐字段对齐（缺 `renderStats()`/`setFocused()` 等）
      —— **已完成**：`types.ts` 按 design.md §2 逐字段重写：`LabVariant{id,name,oneLiner,tech,needsWebGL,cost,fidelity,fidelityNote,create}`、
      `VariantOptions{width,height,pixelRatioCap,seed,stage?}`、`VariantHandle{update,dispose,setPaused,setFocused,renderStats}`、
      `Stage`（**故意不暴露 WebGLRenderer**：谁去改渲染器状态，并排看到的差异就混进了噪音）、`MAX_VARIANTS=12`。
      spike 的 `VariantSpec{pitch,webgl,build}` 与契约的对应关系：`pitch→oneLiner`、`webgl→needsWebGL`、`build→create`；
      `setPaused/setFocused/renderStats/dispose` 由宿主 `createHandle()` 统一补齐（见 2.8），方案作者不必各写一遍。
      验证：`node --test src/lab/*.test.ts` 全绿（见 2.1–2.6）；`src/lab/types.ts`
- [x] 1.2 定死单测命令并跑通一个占位断言：**`node --test src/lab/*.test.ts`**
      —— 实测 Node **v24.15.0 原生支持 TS 类型剥离，无需 `--experimental-strip-types`**，**未新增任何依赖**；
      占位断言 `src/lab/smoke.test.ts` → **pass 1 / fail 0 / exit 0**
      —— 复核：`node --test src/lab/*.test.ts` 现为 **pass 63 / fail 0 / exit 0**（含 1.2 的占位断言）；
      命令口径不变：`node --test src/lab/*.test.ts`
- [x] 1.3 打通多页入口：`xiaomu-lab.html` → `src/lab/main.ts`，Vite 直接服务根 html
      —— 实测 `http://127.0.0.1:5173/xiaomu-lab.html` → **HTTP 200**（长度 1830），**无需改产品路由**
      —— **更正一处**：该 html 当时指向的 `/src/lab/xiaomu-lab.ts` **并不存在**（spike 未提交该文件），
      所以"200"只证明 Vite 直出 html，**不证明入口打通**。现已改指 `/src/lab/main.ts`（2.12 落地），
      并在 3.1 的 E2E 里以"9 格真的渲染出来"为最终判据。复核命令：`curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:5173/xiaomu-lab.html`

## Phase 2: 按 UC 垂直切片（单测 + 实现）

### UC-01 打开展台并看到全部方案在动

#### 成功路径与校验
- [x] 2.1 unit test: `registry` 拒绝重复 id、拒绝空注册表、`MAX_VARIANTS=12` 越界报错（Covers UC-01 备选 4d）
      —— RED: `node --test src/lab/registry.test.ts` → `ERR_MODULE_NOT_FOUND src/lab/registry.ts`（未实现，非语法错）；
      GREEN: **pass 10 / fail 0 / exit 0**；覆盖重复 id / 空 id / 第 12 个收得下而第 13 个抛 /
      空表抛 / 缺 id·name·needsWebGL·create 全抛 / **一次报全**（挤牙膏式报错的对照）/ 顺序保持 / list() 返回副本。
      `src/lab/registry.test.ts`
- [x] 2.2 implement: `src/lab/registry.ts`（`register/list/assertValid`）（Covers UC-01 step 2）
      —— **pass 10 / fail 0**；`createRegistry()` + `assertValidRegistry()` 两个入口；
      常量 `MAX_VARIANTS` 从 types 转出，使"上限"与"强制上限的人"同模块。`src/lab/registry.ts`
- [x] 2.3 unit test: `columnsFor` 断点取值（Covers UC-04 step 1；纯函数）
      —— RED: `ERR_MODULE_NOT_FOUND src/lab/layout.ts`；GREEN: **pass 7 / fail 0**。`src/lab/layout.test.ts`
- [x] 2.4 implement: `src/lab/layout.ts`（`<1024→1`、`1024–1599→2`、`≥1600→3`）（Covers UC-04 step 1）
      —— **pass 7 / fail 0**；文件内**无 window/document/ResizeObserver**（否则"列数是纯函数"名存实亡）；
      另含 `COLUMN_BREAKPOINTS`、`minCellWidth`。`src/lab/layout.ts`
- [x] 2.5 unit test: `createFpsMeter(1000)` 滑动窗口均值 + `isPassing()` 需**连续 ≥3s 且 ≥30**（Covers UC-05 AC2/AC3）
      —— RED: `ERR_MODULE_NOT_FOUND src/lab/fps.ts`；GREEN: **pass 15 / fail 0**。
      **这一段连踩三个坑、全部由测试当场抓出**（详见 `.loop-evidence.log` 的 2.5/2.6 GREEN 段）：
      ① 裁剪规则让"窗口填满"恒假（连喂 5s@60FPS 合格时长全程 0）；
      ② 第一帧的 `last=-Infinity` 把每个新 meter 永久标成"卡过顿"；
      ③ 状态机写在查询里 → "连续合格时长"会随**查询时刻**变化（答 1233ms，真值 4983ms）。
      修法分别是 `KEEP_MARGIN_MS=250`、第一帧不判卡顿、**状态机改为每帧在 push() 里推进**。`src/lab/fps.test.ts`
- [x] 2.6 implement: `src/lab/fps.ts`（Covers UC-01 step 5、UC-02 step 3）
      —— **pass 15 / fail 0**；`FPS_WINDOW_MS=1000`、`PASS_FPS=30`、`PASS_STREAK_MS=3000` 三常量即硬指标；
      另有 `passingForMs()`（对照表要的"稳定了多久"）与 `reset()`（放大态重新计量用，2.15 调它）。`src/lab/fps.ts`
- [ ] 2.7 unit test: 每个变体模块导出符合 `LabVariant` 契约（id 唯一、`needsWebGL` 布尔、`create` 为函数；**不调用 create**）（Covers UC-01 step 2、REQ-01）
- [ ] 2.8 implement: 单一 rAF 循环 + 每格渲染宿主（`shared.ts`：`setPixelRatio(min(dpr,2))`、暂停不推进时钟、resize 只 `setSize` 不重建）（Covers UC-01 step 3–4、UC-03 AC1、UC-04 AC4）
- [ ] 2.9 implement: 收编变体 01–07（`glassTransmission` / `jellyWobble` / `iridescentFlow` / `doubleShell` / `plasma` / `soapFilm` / `fluidMetaball`），每个都实现 `dispose/setPaused/setFocused/renderStats`（Covers UC-01 step 3）
- [ ] 2.10 implement: 补齐变体 08「扁平发光 2.5D」（素材未写完）（Covers UC-01 step 3）
- [ ] 2.11 implement: 脸部件（两只深蓝椭圆眼 + 白高光点 + 小弧线微笑）与**双互质周期眨眼**，所有变体共用（Covers REQ-02 AC4）
- [ ] 2.12 implement: 格子标注（编号/一句话/技术/**实测 FPS**）+ `main.ts` 引导网格（Covers UC-01 step 5–6）
- [ ] 2.13 implement: WebGL 不可用/上下文超限/单格初始化抛错的**隔离与降级提示**（Covers UC-01 备选 4a/4b/4c）

### UC-02 放大单看某个方案

#### 成功路径
- [ ] 2.14 unit test: focus 状态机（`focusedId` 唯一；`setFocused` 与全局暂停的组合优先级）（Covers UC-02 step 1/4、UC-03 AC5）
- [ ] 2.15 implement: 点击放大 / 再点或 `Esc` 还原；放大时其余 `setPaused(true)` 并缩小；放大态 FPS 重算（Covers UC-02 step 1–3）
- [ ] 2.16 implement: 放大态下 resize 不溢出（Covers UC-02 备选 4a）

### UC-03 全局播放控制

#### 成功路径
- [ ] 2.17 unit test: 全局暂停优先于单格播放（暂停中放大不得恢复渲染）（Covers UC-03 备选 4b）
- [ ] 2.18 implement: 顶部「暂停 / 重播」控件 + 全局 `paused` 广播到全部 handle + `aria-pressed`（Covers UC-03 step 1–4）
- [ ] 2.19 implement: 连点去抖（Covers UC-03 备选 4a）

### UC-04 自适应布局

#### 成功路径
- [x] 2.20 unit test: `columnsFor` 边界（1023/1024/1599/1600/1920）（Covers UC-04 备选 4a）
      —— 与 2.3 合并在 `src/lab/layout.test.ts`（同一个纯函数，拆两个文件没有额外收益）：
      显式断言 **1023→1 / 1024→2 / 1599→2 / 1600→3 / 1920→3**，另有边界内取值、退化输入（0/NaN/-Infinity→1 列）、
      **单调不减**（拉宽窗口反而少一列 = 排列错乱）、一万次同结果（纯函数）。**pass 7 / fail 0**
- [ ] 2.21 implement: resize → 重排（不重建上下文，最后一帧收敛）（Covers UC-04 step 3–4）

### UC-05 产出挑选依据

- [ ] 2.22 implement: 证据工装 `voice-module/tools/截图展台.mjs`（裸 CDP：等就绪 → 并排大图 → 逐版放大图 → 同版 1.5s 双帧 → 像素差）（Covers UC-05 step 1–3）
- [ ] 2.23 implement: 对照表生成 `方案对照表.md`（编号/外观/技术/API/FPS 实测/相似度自评/观感/推荐；老方法行标注非 WebGL）（Covers UC-05 step 4–5）
- [ ] 2.24 implement: 空白帧重试与记录；FPS 只读页面实测值（Covers UC-05 备选 4c、REQ-06 AC2）

### UC-06 选中方案落地产品（前置：用户给出选择）

- [ ] 2.25 implement（阻塞待选择）: 把选定方案接入产品形象本体（`src/pages/MumaiDashboard/agent/`），保留 7 状态与 `prefers-reduced-motion` 静态可辨（Covers UC-06 step 1–2）

---

## Phase 3: E2E 验收（裸 CDP）

- [ ] 3.1 E2E: UC-01 成功路径 — 打开 `/xiaomu-lab.html`，9 格同框、每格双帧像素差 > 阈值、标注齐全（含实测 FPS）
- [ ] 3.2 E2E: UC-01 备选 4a/4b/4c — 禁用 WebGL / 注入一个会抛错的变体 / 降低上下文上限，断言"只影响该格 + 显式提示"
- [ ] 3.3 E2E: UC-02 成功路径 + 4b — 点击放大（其余暂停并缩小）→ 还原；全局暂停中放大仍保持暂停
- [ ] 3.4 E2E: UC-03 成功路径 + 4a — 暂停后全页双帧像素差 ≈ 0 → 重播恢复；快速连点不出现半暂停
- [ ] 3.5 E2E: UC-04 三档 — 1366 / 1440 / 1920 下换行、无横向滚动条、每格仍在动
- [ ] 3.6 E2E: UC-05 产物 — 并排大图/逐版单图/双帧像素差/对照表齐全；FPS<30 的版本被标不合格；老方法版通过像素差且标注非 WebGL
- [ ] 3.7 E2E: UC-06（阻塞待选择）— 选定方案落地后 `验收界面.mjs` 230/230、小尺寸清晰、7 状态可辨

---

## 覆盖检查（ff Step 7）

| 层 | 任务 | 说明 |
|---|---|---|
| 单元测试 | 2.1 / 2.3 / 2.5 / 2.7 / 2.14 / 2.17 / 2.20 | 7 条；覆盖注册表校验、布局纯函数、FPS 判据、变体契约、状态优先级 |
| 集成测试 | 2.8 / 2.12 / 2.13 / 2.21 / 2.22 | 渲染宿主与循环、网格引导、降级隔离、resize 重排、证据工装链路（**本项目无测试框架，集成层以 E2E 覆盖，已在 3.x 落实**） |
| E2E | 3.1 – 3.7 | 每个 UC 的每条适用路径都有对应 E2E；UC-01 备选 4d 由单测 2.1 覆盖（浏览器层无法自然构造空注册表），已在 3.2 注明边界 |

**每条 UC 路径 → 任务对照**：UC-01（2.1–2.13 + 3.1/3.2）｜UC-02（2.14–2.16 + 3.3）｜UC-03（2.17–2.19 + 3.4）｜UC-04（2.3/2.4/2.20/2.21 + 3.5）｜UC-05（2.5/2.6/2.22–2.24 + 3.6）｜UC-06（2.25 + 3.7）
