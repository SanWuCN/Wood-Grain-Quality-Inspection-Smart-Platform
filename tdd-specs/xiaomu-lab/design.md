# Design — xiaomu-lab

> 由 `usecases.md` 派生。每个模块/接口标注**支持的 UC**；数据流覆盖 UC 主路径。

## 1. 技术栈与既定约束

| 项 | 取值 | 说明 |
|---|---|---|
| 渲染 | `three@0.183`（lab 用**纯 three** 以精确控制上下文与循环） | 产品落地时允许 R3F（已装 fiber/drei/postprocessing），见 UC-06 |
| 页面载体 | Vite 多页入口：仓库根 `xiaomu-lab.html` → `src/lab/main.ts` | 复用已跑的 dev server（5173），**不改产品路由** |
| 单测运行 | `node --test`（Node 24 原生类型剥离，**不新增依赖**） | 项目无测试框架；不变量测试在 Node 中**不需要 WebGL** |
| E2E | 裸 CDP（**无 puppeteer**），参考 `voice-module/验收界面.mjs` | 真实浏览器渲染 + 像素差 + FPS |
| 产物目录 | `D:\平台\voice-module\shots\xiaomu-lab\` | 截图与对照表 |
| 参考图 | `D:\平台\voice-module\refs\小木形象参考-蓝色琉璃球体.png` | 球体外观最高标准 |

## 2. 模块与接口

### Interface: `LabVariant`（`src/lab/types.ts`）

**支持的 UseCase**: UC-01 step 2–4、UC-02 step 1–3、UC-05 step 2

```ts
export interface LabVariant {
  id: string;              // "01".."09"，唯一（REQ-01 AC2）
  name: string;            // "玻璃透射球"
  oneLiner: string;        // 一句话特点（格子展示，REQ-02 AC2）
  tech: string;            // 技术要点
  needsWebGL: boolean;     // 老方法版为 false（REQ-08 AC1）
  create(host: HTMLElement, opts: VariantOptions): VariantHandle; // 失败要抛，由调用方隔离（REQ-01 AC3）
}
export interface VariantOptions { pixelRatioCap: number; seed: number }
export interface VariantHandle {
  dispose(): void;         // 必须幂等，释放 context/几何/材质（UC-02 释放）
  setPaused(paused: boolean): void;   // REQ-04
  setFocused(focused: boolean): void; // REQ-03 AC1
  renderStats(): { fps: number };      // 实测 FPS（REQ-06 AC2）
}
```

### Interface: `VariantRegistry`（`src/lab/registry.ts`）

**支持的 UseCase**: UC-01 step 2、UC-01 备选 4d

- `register(v)`：id 重复即抛错（REQ-01 AC2）。
- `list()`：返回有序变体（首版 9 个）。
- `assertValid()`：空注册表/缺字段/id 重复 → 明确错误（REQ-01 AC2）。
- **上限**：`MAX_VARIANTS = 12`；`needsWebGL === true` 的数量 > 上下文上限时，按顺序降级并在页面提示（REQ-01 AC4）。

### Interface: `columnsFor(width)`（`src/lab/layout.ts`）

**支持的 UseCase**: UC-04 step 1–2、UC-04 备选 4a

- **纯函数**：`columnsFor(1366) = 2`、`columnsFor(1440) = 2`、`columnsFor(1920) = 3`、`columnsFor(1023) = 1`（断点 `<1024 → 1`、`1024–1599 → 2`、`≥1600 → 3`）。
- 单测直接断言（REQ-05 AC3）。

### Interface: `createFpsMeter(windowMs)`（`src/lab/fps.ts`）

**支持的 UseCase**: UC-01 step 5、UC-02 step 3、UC-05 AC2/AC3

- 滑动窗口（默认 1000ms）平均 FPS；`push(now)`、`value()`。
- `isPassing()`：**连续 ≥3s 且窗口值 ≥30** 才判合格（REQ-06 AC3）。

### Module: 渲染宿主与循环（`src/lab/shared.ts`）

**支持的 UseCase**: UC-01 step 3–4、UC-03

- 每格一个 `WebGLRenderer`（`antialias: true`、`alpha: true`、`setPixelRatio(min(dpr,2))`）。
- **单一 rAF 循环**驱动所有格（而非每格一个循环）→ 便于全局暂停（REQ-04 AC1）与上下文降级。
- `paused` 时不推进 `clock`，也不 `render`（保证像素差 ≈ 0）。
- 缩放时**不重建**上下文，只 `setSize`（REQ-05 AC4）。

### Module: 变体实现（`src/lab/variants/*.ts`）——素材已存在，按契约收编

**支持的 UseCase**: UC-01、UC-02、UC-05、REQ-08

| id | 变体 | 文件（素材） | 关键技术 |
|---|---|---|---|
| 01 | 玻璃透射球 | `glassTransmission.ts` | `MeshPhysicalMaterial` transmission/ior/thickness |
| 02 | 果冻抖动球 | `jellyWobble.ts` | 顶点噪声位移 + 呼吸缩放 |
| 03 | 虹彩渐变球 | `iridescentFlow.ts` | 自定义 ShaderMaterial 流动亮带 |
| 04 | 双层壳 | `doubleShell.ts` | 外壳玻璃 + 内核发光 |
| 05 | 等离子能量球 | `plasma.ts` | 内部噪声 + 加色发光 |
| 06 | 肥皂泡薄膜 | `soapFilm.ts` | thin-film 干涉虹彩 |
| 07 | 元球流体变形 | `fluidMetaball.ts` | 缓慢不规则形变 |
| 08 | 扁平发光 2.5D | **待补**（素材未写完） | 低开销风格化 |
| 09 | 老方法 CSS/SVG | `oldMethodSvg.ts`（移植 `xiaomu-candidate-svg` 分支 `3fbb69f`） | SVG 渐变 + 关键帧 + blur，无 WebGL |

**脸部件**（所有变体共用）：两只深蓝椭圆眼 + 白高光点 + 小弧线微笑；眨眼用两个互质周期（REQ-02 AC4）。

### Module: 证据工装（`voice-module/tools/截图展台.mjs`，仓库外）

**支持的 UseCase**: UC-05 全部

- 裸 CDP：打开展台 → 等就绪（≥N 帧已绘制）→ 全页图 → 逐版放大图 → 同版 1.5s 双帧 → 计算像素差 → 写 `方案对照表.md`。
- 空白帧重试（REQ-06 AC5）；FPS 从页面读取实测值，**不做任何估算**。

## 3. 数据流（覆盖 UC 主路径）

```
浏览器访问 /xiaomu-lab.html                     （UC-01 step 1）
        │
        ▼
src/lab/main.ts  ──►  registry.assertValid()     （UC-01 step 2 / 备选 4d）
        │
        ├─► columnsFor(innerWidth) → 网格列数      （UC-04 step 1）
        │
        └─► for each variant:
               variant.create(host, opts)          （UC-01 step 3；抛错→4b 仅该格失败）
                   │  needsWebGL ? WebGLRenderer : DOM/SVG   （REQ-08 / UC-01 备选 4a）
                   ▼
               注册到单一 rAF 循环 ──► 每帧 render + fpsMeter.push()   （UC-01 step 4–5）
        │
        ├─ 点击格子 → focused=id → 其余 setPaused(true)+缩小            （UC-02 step 1–2）
        ├─ 点击顶部控件 → globalPaused → 全格 setPaused(true)（优先）    （UC-03）
        └─ resize → columnsFor(width) 重排（不重建上下文）              （UC-04 step 3–4）
        │
        ▼
证据工装（裸 CDP）→ 并排图 / 单图 / 双帧像素差 / 方案对照表.md        （UC-05）
        │
        ▼
用户挑选 → 落进产品形象本体 → 230/230 验收 → push origin/SHI         （UC-06）
```

## 4. 关键设计决策与理由

| 决策 | 理由 | 对应 UC/REQ |
|---|---|---|
| **单一 rAF 循环**驱动所有格 | 全局暂停才能做到"全页像素差 ≈ 0"；每格独立循环必然出现"半暂停" | UC-03 备选 4a |
| 注册表**上限 12** + 显式降级提示 | 浏览器 WebGL 上下文约 16 个，静默少画会让用户误判"这版不存在" | UC-01 备选 4c |
| FPS **必须实测**，老方法不参与门槛 | 拿 GPU 帧率比 CSS 合成层不公平，但"在动"要证据 | UC-05 备选 4a/4b |
| 布局列数做成**纯函数** | 无测试框架的项目里，纯函数是最可靠的 RED/GREEN 抓手 | REQ-05 AC3 |
| lab 用**纯 three**，产品可用 R3F | lab 要精确控制上下文数量与生命周期；产品侧复用既有 R3F 生态更省事 | REQ-01 / UC-06 决策③ |
| 老方法版**移植**而非重写 | `xiaomu-candidate-svg`（`3fbb69f`）已有可用 SVG 琉璃球，避免重复劳动 | REQ-08 |
