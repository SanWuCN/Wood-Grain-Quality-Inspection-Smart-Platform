# deepseek harness · Windows 交接说明

> 给 Windows 上的 DeepSeek Harness。接手继续开发「木脉智检 · 古建筑智能巡检平台」。
>
> **分支约定：只在 `RAO` 上工作，不要动 `main`。** 所有提交与推送都到 `RAO`。
> 仓库：https://github.com/SanWuCN/Wood-Grain-Quality-Inspection-Smart-Platform
>
> 这份是 **Mac 侧交给 Windows 侧**的说明。Windows 侧原来那份 `docs/交接说明.md`
> 仍然有效（架构、坑、历史都在里面），本文只讲**增量**：Mac 这一轮做了什么、
> 现在还剩什么、我踩过的坑。
>
> **Windows 侧已接手**（顶点 `c35465c` → 见 §7）：P0 第 1 条「向量库可视化三维化」已完成，
> 动手前请先读 §7 —— 那一节记了这一轮改了什么、以及新踩的坑。

---

## 0. 先对齐位置

Mac 侧接手时的顶点是 `a403582`（就是 `docs/deepseek harness-mac.md` 那次提交），
之后推到 `RAO` 的是 **17 个提交**，合计 37 个文件、+8398 / −1332 行。

```bash
git fetch origin
git checkout RAO
git pull                       # 应该落在 77257e0
git log --oneline a403582..HEAD   # 17 条，可以逐条看
```

**先做这两件事确认环境没坏**（两个基线都必须是 0）：

```bash
npx tsc --noEmit -p tsconfig.app.json
npx eslint src
```

---

## 1. Windows 上跑起来

```bash
start-demo.cmd                 # 开发服务器，端口 5173（vite.config.ts 里写死）
```

`start-demo.cmd` 是 Windows 专用，Mac 上的等价物是 `start-lan.sh`（那个跑的是
**生产构建**，用于内网演示，端口 4173）。两边端口刻意分开。

演示给别人看时用生产构建：

```bash
pnpm build
npx vite preview --host 0.0.0.0 --port 4173 --strictPort
```

四个账号口令统一 `123456`，**开发用 `shi`**（权限最全）。路由是 HashRouter，
地址要写成 `#/twin` 这种。

> ⚠️ `/adapt` 这条路由**已经不存在**（拆成了 `/hardware` + `/firmware`）。
> 它现在会落到「页面不存在」，这是预期行为，不是 bug。

---

## 2. Mac 侧这一轮做了什么

按页面归类，每条都写清了动机。想细看就 `git show <sha>`。

### 2.1 修掉的三个真 bug（与页面无关，影响全局）

| 提交 | 问题 |
| --- | --- |
| `9ee2e23` | **验收脚本一直在给登录页打分**。`tools/accept.mjs` 调 `shot.mjs` 时没传 `--init`，`RequireLogin` 把 9 个路由全送到 `#/login`，而登录页同样有字号和边框、console 也干净 —— 探针读出「字号 4、有色边框 100%」，9 行全 ✓，**9 张截图全是登录页**。路由表还停在拆页之前，验着已删除的 `/adapt`、`/console`。已补会话注入 + 对齐路由表 + 加「最终 hash 是 `#/login` 即判失败」的防线。 |
| `8018a45` | **页签选中态与未选中态完全相同**。`.btn.is-active` 的三项声明（边框色/底色/文字色）与默认 `.btn` 逐个相同，等于没有选中反馈，所有页签条上看不出停在哪一页。 |
| `2cbc603` | **用 rao 登录后黑屏**。拆页时漏改了 `design.ts` 里 rao 的默认工作区（还写着 `/adapt`）；同一个漏改还在小木的 6 处跳转目标里。另外路由表没有兜底项，未登记的地址连外壳都不挂载 → 纯黑屏。已补 `path="*"` 与「页面不存在」页。 |

> 这三条说明一件事：**跑一遍 `accept.mjs` 通过不代表页面是对的**。
> 它现在会真的打开业务页了，但仍只是 console + 探针，不检查内容。

### 2.2 总览页 `/`（`c786263`）

- 左下「设备状态」的四路通道原本读成 `地图●正常14:22:31` —— `.ov-channels` 只定义了 `ul`，没给 `li` 任何布局。补齐后按列对齐。
- 清掉一批死 CSS：`.ov-components`（**文档点名不许回归的「四柱构件状态」残留**，留着等于给它留了条复活的路）、`.ov-channel`、`.ov-meta`、`.ov-risks`、`.ov-note`、`.ov-rec`。
- 补设计稿里有、实现里漏了的完成率进度条；「本轮任务」脚注贴底。

### 2.3 文案二轮（`3355bea` + 后续几轮）

文档 §5 列的还剩项，我清掉了大部分：

- **`adaptTabs.tsx` 六个页签的按钮名与状态文案** ✅
- **`SourceTag` 降视觉权重** ✅（圆点由 `--primary` 亮蓝改成与文字同色，标签保留）
- **`StateBlock` 空态文案** ✅（去掉「该通道独立断流」这类讲机制的句子）
- 各页 `hint`：还剩 4 条，见 §3。

`node tools/copy-audit.mjs` 现在只剩 4 条 `[hint]`，`node tools/panel-titles.mjs`
剩 5 条偏长标题（都不在 Mac 改过的页面里）。

### 2.4 硬件详情 `/hardware`（`560cd15`、`63c5961`）

- **异常排查改成日志形态**：异常事件逐条列表化、点击弹窗看详情（**设备证据 / 模型证据分开**，依据是剧本 S12 沈的原话）；去掉「四项检查与签名」，换成硬件实际日志输出记录，按 ESP32-S3 / 树莓派 / 毫米波模块 / 传输 / 供电 五层分来源。
- **四项检查改造成「设备启动检查」并移到采集作业**：点「启动采集」后逐条确认并签署，签完才进入采集中。原来挂在异常排查页做事后填结论，拦不住任何东西。
- **采集设备画面预留推流位**：`CAPTURE_SCREEN_STREAM.url` 填地址即可切真实推流，未接入时显示静态参考画面并明确标「未接入」。
- **硬件监看读数轻微浮动**：围绕种子基准做正弦摆动（不同周期），判态用浮动后的当前值。

### 2.5 固件及模型 `/firmware`（`150550f`、`9c09aea`、`6e2149a`、`2d2d4f3`、`7bd8577`、`820e9a5`）

这一页改动最大，五个页签里有四个重做：

- **版本管理 → 两级结构**：21 条版本补到 **71 条**（含平台版本 1 → 12 条）；主页只列组件摘要（八个组件一屏看完），点开弹窗看完整发行历史并操作切换。删掉了「负责原始 ADC 采集与落盘…」这类解释性 `note`。
- **训练验证**：12 栅格显式分区（原来 `auto-fit` 导致分区随分辨率漂移）；损失曲线随任务回放渐进绘制；新增「采集数据」面板（原始雷达数据 vs 成果数据，可展开看波形与导入校验）与「导入数据包」（真的 `<input type="file">`）。
- **任务控制台**：接入用户给的两个终端脚本（见 §2.6）。
- **更新交付 → 产物提交与分发**：删掉「交付步骤」八步流水线（用户点名太假），改成 **待提交产物 / 提交前校验 / 已发布产物**（可下载、记录烧录、留取用记录）。
- **训练配置**：学习率 / 批大小 / 最大轮数等可调，越界拦住；只读项写明为什么不能改。

### 2.6 两个终端脚本进了任务控制台（`2d2d4f3`、`820e9a5`）

用户给的 `terminal_train_log.py`（训练流水）与 `terminal_distill.py`（知识蒸馏 + INT8 量化）
移植成了前端可播放的步骤流。**关键点：随机数是逐位复现的。**

移植了 CPython 的 MT19937（`src/pages/MumaiDashboard/pyrandom.ts`，照
`_randommodule.c` 的 `init_by_array` / `genrand_res53` / `uniform`），
所以屏幕上跑出来的 loss / mAP / 显存和脚本打印的**完全一致**：

```
两侧都是  Epoch 01/03 loss=0.590700 lr=0.000880 gpu=14.7G
16 轮整跑  final val accuracy=0.7172  final loss=0.320395
蒸馏侧    mAP50=0.9342 acc=0.9119 drop=-0.0299
```

连 Python 的 `round()`（四舍六入五成双）都移植了 —— 进度条的格子数要用它。
**移植时最容易错的一点：脚本的 `_animate_bar` 每画一帧都要一次 `random.uniform`（取 it/s），
所以进度条的每一帧都是随机数消费者。帧数写错（train 15 / eval 9 / distill 11 /
TensorRT 11 / 上传 9），后面所有数字就全偏了。**

### 2.7 建图巡检 `/mapping`（`7e209a8`）

消费 `?site=` 参数（文档里我负责四页中唯一标注 P1 的确定性 bug）。补的时候发现
`seed/sites.ts` 里那个「可直接用」的 `waypointForSite()` **本身是错的**：
它忽略传入的点位，永远返回第一个带构件的航点（P2），而且只返回一个。
示例寺要看 P2–P5 四个观察点，返回 P2 等于只说对四分之一 ——
**这个函数从来没被调用过，所以错误一直没暴露，两个洞刚好互相盖住。**

### 2.8 数字孪生 `/twin`（`a9cbf44`、`1941ad1`）

- `route` / `history` 图层接进场景（原来是空操作）；「复位」与视角书签**真的动相机**；波形按当前构件与批次取（复扫 `wf-Z04-002` 的三处标记 0.71/0.84/0.87 终于看得到）；渲染 `HOTSPOTS[].history`（全库原先没有任何页面渲染它）。
- **主视图换成真实高斯泼溅产物**：`public/model/sog/gs.sog`（SOG v2，MipMap Software 生成，**238 万高斯点**，31 MB），渲染用 `@sparkjsdev/spark`。

---

## 3. 还剩什么

### P0 — 用户明确提出、尚未完成

1. ✅ **向量库可视化的三维化**（知识库页）—— **Windows 侧已完成**，见 §7。
   2D 散点图已换成三维 Token 关系链：PCA 取三个主成分、余弦相似度做边、
   3D 力导向布局，节点可悬停 / 点选并高亮邻居。

2. **文案二轮还剩 4 条 `hint`**（`node tools/copy-audit.mjs`）：

   | 文件 | 文案 |
   | --- | --- |
   | `Orders.tsx` | 「校验通过后才会生成不可变配置版本；未通过时不产生版本。」← 文档点名的典型 |
   | `Mapping.tsx` | 「收到机器人确认后才进入执行中；未接入实机时显示为等待操作员确认。」 |
   | `Twin.tsx` | 「该批次诊断输出已冻结；内部异常以示意响应区域表达，不代表实际虫道深度与形状。」← 这条是 PRD 3.3 要求的免责，建议保留 |
   | `Hardware.tsx` | 「缺少该批次木材的有效标定记录，暂不输出病害结论，等待专业复核。」← 事实陈述，建议保留 |

   另有 5 条偏长面板标题（`Orders.tsx` 三条、`Knowledge.tsx`、`Archive.tsx`），
   都不在 Mac 改过的页面里。

### P1 — 技术债

3. **地图点位遮挡的干净修法**。`map/SiteMarker.tsx` 用 `depthTest: false` 绕过 z-fighting。
   Mac 侧**评估后没有改**，理由是：点位最主要的载体（状态锚点圆点、文字标签）是
   drei `<Html>` 的 DOM 覆盖层（`zIndexRange 59/60`），按设计就永远在 canvas 之上，
   `depthTest` 改成什么它都在最上面；`NO_DEPTH` 只作用在 6 个 3D 网格上。
   加上 `maxPolarAngle={1.5}` 让相机去不到地图背面，拖到接近地平也没看到明确穿帮。
   **要改的话**：抬高点位 + 恢复深度测试 + 给顶面 `polygonOffset`，
   但有文档记录过的「27 个点位全看不见」的失败面，建议单独一轮做并逐角度验证。

4. **`/orders?create=1` 未被识别**，详情浮层的「去创建工单」只跳到工单列表。**Mac 侧没动。**

5. **高斯泼溅的取景系数是本产物的标定值**。`SplatStage.tsx` 里 `fitToBox` 的
   `× 6`：SOG 的 `meta.json` 声明包围盒约 7.3，但 Spark 渲染出来的实际尺度约 6 倍
   （距离 47 才把整个房间收进画面；按声明包围盒反解到 9 时相机直接钻进模型内部、画面全黑）。
   **换重建产物必须重调这个系数。** 详见 §4.7。

### P2 — 收尾

6. 字体子集化：`public/fonts/` 两个 HarmonyOS TTF 各约 8 MB。
7. `src/pages/MumaiDashboard/map/` 是早期地图实现，已被 `mapDemo/` 取代，
   现为死代码（但 `SiteMarker` / `status` / `store` 仍被 `mapDemo` 使用，不能整目录删）。
8. `data.ts` 的 legacy `workOrders`（5 条）只服务已下线的旧单页，是第三份工单数据。
9. 仓库体积：`public/model/sog/gs.sog` 31 MB + 原有 `public/model/glb/turbine.glb` 34 MB。
   介意的话改 Git LFS，代价是克隆方要装 LFS。
10. **知识库「相似度检索」页签的默认查询命不中**：默认词「五月巡检 Z04 渗水」最高
    相似度只有 0.0619，低于 `KNOWLEDGE_META.noHitThreshold`（0.15），一进这一页就是
    「未达命中阈值，仅作参考」。**不是这一轮引入的**（检索走 `lib.searchKnowledge`，
    这一轮没碰），但演示时第一眼不好看 —— 要么换一条能命中的默认词，要么下调阈值。

### 需要团队给数据才能继续的（不是代码问题）

11. **高斯泼溅产物是室内工作台扫描，不是古建筑木构。** 答辩时要拿它当「示例寺木构重建」讲，
    评委一眼能看出是办公室。有真正扫古建/木柱的 SOG 就替换（改 `splat.ts` 的路径 + §4.7 的系数）。
12. **版本矩阵的 changelog、采集数据包的大小/帧数、训练任务的 run id** 都是 Mac 侧编的。
    量级合理、彼此对得上，但被追问背景容易露馅。有真实发版记录/采集清单就替换。
13. **两个终端脚本的技术栈与平台口径不一致**：脚本写的是 EFCW-YOLO v3.6 / RadarNet /
    Jetson-Orin-NX / 768 图像输入，平台是 DEMO-M02 / ESP32-S3 / 1×420 频谱向量。
    Mac 侧只做忠实移植，**没有改脚本内容**。要讲成同一个东西得统一口径。
14. **交付页的「下载」只记录一条取用记录，不会真的产生文件下载**（产物文件是虚构的）。
    两个做法：放真实占位产物到 `public/`；或前端把元信息打成一个清单文件下载（不需要仓库文件）。
15. **知识库的关系链是「分块」粒度的，不是「词」粒度的。** 用户原话是「三维显示各个 Token
    的关系链」，实现上每个节点 = 一个分块（向量库里的一条向量）。如果评委按「词」理解，
    要能解释清楚：库里的检索单位就是分块，余弦相似度是分块之间的。

---

## 4. 必须知道的坑

每条都是这一轮实际踩出来的。前四条是环境/框架级的，后面是这次新写代码时踩的。

### 4.1 机器负载高时 WebGL 渲染不出来

机器 load average 到 16 时（浏览器开着大页面就会），数字孪生页整页黑屏 ——
**不是代码问题**。演示 `/twin` 前把无关的大页面关掉。
这一条我排查了很久才定位到，先看 `uptime` 再看代码。

### 4.2 React StrictMode 会打穿「首次渲染不执行」的 ref 守卫

挂载期 effect 会跑两遍，第二遍就当成用户操作了。我的「首次不运镜」守卫就是这么失效的
（现象：只点了个图层开关，镜头自己动了）。**要表达「只在用户动作时发生」，用一个显式的
请求状态（`X | null`，初始 null），不要用 ref 计数。**

### 4.3 `useMemo` 依赖里不要放内联箭头函数

调用方每次渲染都新建一次函数，依赖每帧都变，`useMemo` 里的对象就被**每帧重建**。
我这边的现象极具误导性：31 MB 文件下完了、进度停在 100%，**画面却一直是黑的**，
而且 `initialized` 永远等不到完成。**把手回调放进 ref，`useMemo` 只依赖真正的内容键。**

### 4.4 不要在 `setState` 的 updater 里调其他 `setState`

React 会报「Cannot update a component while rendering a different component」，
而且 StrictMode 下 updater 被调用两次，事件会推两遍。
**先把下一份状态算出来，再一次性提交。**

### 4.5 无头 Chrome 的截图有坑

- rAF 只有约 1fps，入场动画可能看起来没播完 —— 环境限制，不是代码问题。
- 改文件会触发 HMR 重放入场，截图前要静置，`--wait` 给足（首页至少 22s）。
- **合成帧会滞后**：我遇到过截图显示「epoch 1/30」但曲线已经画满的情况。
  **验证状态别靠肉眼看截图，用 DOM 探针**（`--eval` 读 DOM，见 §5）。

### 4.6 用 `console.warn` 而不是 `console.info` 做临时探针

`tools/shot.mjs` 只把 `error` / `warning` / `log` 冒到 stdout。`console.info` 会被吞掉，
你会以为探针没执行。**排查完记得删掉探针再构建** —— 我漏删过一次，debug 语句进了 `dist`。

### 4.7 高斯泼溅（3DGS）的四个反直觉点

1. **`SplatMesh.getBoundingBox()` 在 `lod: true` 下永远返回空盒。** Spark 的实现靠
   `mesh.splats.forEachSplat` 遍历，而 LoD 源没有把它暴露出来；轮询 3 秒也拿不到。
   改用产物自己声明的 `meta.json` 的 `means.mins/maxs`（写在 `splat.ts` 里）。
2. **声明的包围盒 ≠ 渲染尺度。** 见 §3 第 5 条。
3. **画面偏模糊是正常的，不是取景 bug。** 3DGS 只在接近采集视角时才清晰，
   站远看几百万个高斯会叠成色块。**用户已明确说不用管。**
4. **Canvas 卸载会抛一个接不住的 `Uncaught (in promise)`**（无 message、无 stack，
   `unhandledrejection` 也接不到）。先后去掉 `SplatMesh.dispose()` 与
   `SparkRenderer.dispose()` 都没用 —— 根因是 R3F 销毁 WebGL 上下文时 Spark 还有
   异步任务在等它。**解法：两个视图都常驻挂载，隐藏的那一边 `frameloop="never"`。**

### 4.8 其它零碎的

- **全角空格（U+3000）会被 eslint 的 `no-irregular-whitespace` 拦下**，用普通分隔符。
- **超过 double 精度的数字字面量会被 `no-loss-of-precision` 拦下**，截到 7 位有效数字。
- **中文串里用 `×` 而不是 `x`**（我从终端脚本移植时把 `3.46×` 写成了 `3.46x`，是错的）。
- 原来 4 条 `console.warning` 里的 `THREE.Clock is deprecated` 是 Spark / drei 内部发的，
  **不是我们代码的问题**，`accept.mjs` 已过滤。

---

## 5. 验收

```bash
npx tsc --noEmit -p tsconfig.app.json    # 基线 0
npx eslint src                            # 基线 0
node tools/accept.mjs                     # 全 9 路由，console 必须干净，退出码 0

node tools/accept.mjs --w 1280 --h 800 --routes "/twin,/firmware"   # 窄档
node tools/copy-audit.mjs                 # 文案审计
node tools/panel-titles.mjs               # 面板标题审计
```

`accept.mjs` 现在**会真的注入会话打开业务页**（`--init` 会写 `mumai.session`），
并且会把「最终停在 `#/login`」判为失败。报告在 `tmp-shot/accept-<宽>/report.md`。

**截图验证状态要用 DOM 探针，不要靠肉眼**：

```bash
node tools/shot.mjs --url "http://localhost:5173/#/twin" --out tmp-shot/a.png --wait 22000 \
  --init "localStorage.setItem('mumai.session', JSON.stringify({accountId:'shi',login:'shi'}))" \
  --eval "(() => new Promise(r => setTimeout(() => r(JSON.stringify({...})), 1500)))()" \
  --evalWait 3000
```

**DOM 探针读不到 canvas，三维视图要发真实指针事件**（`--drag` 只能从画面正中开始，
而面板既不铺满整页、又必须拾取才有反应）。Windows 侧给 `shot.mjs` 补了两个参数：

```bash
node tools/shot.mjs --url "http://localhost:5173/#/knowledge" --out tmp-shot/kb.png --wait 22000 \
  --init "localStorage.setItem('mumai.session', JSON.stringify({accountId:'shi',login:'shi'}))" \
  --move 577,759 --click 577,759 --clickWait 1500
```

- `--move x,y` / `--click x,y` 是**页面坐标**（CSS 像素），和 `--clip` 同一套坐标系。
- 想验证拾取但不知道节点在哪，可以在 `--eval` 里派发合成 `PointerEvent` 扫一遍网格 ——
  **但必须自己把 `offsetX` / `offsetY` 定义上去**（R3F 读的是这两个，
  合成事件的 offsetX 默认是 0），并且每次派发后让出一个 tick 等 React 落 DOM。

---

## 7. Windows 侧这一轮做了什么

顶点 `c35465c` → 完成后见 `git log`。这一轮只做了一件事：**P0 第 1 条，向量库可视化三维化**。

### 7.1 算法层（`knowledge/logic.ts`）

- `pcaTop2` → **`pcaTop3`**：三个主成分都用幂迭代求，第 k 个在对前 k−1 个方向
  做 deflation 后的算子上迭代。
- **顺手修掉一个一直在骗人的数**：原来「前两个主成分解释方差比」的分母是
  *这两个主成分之和*，所以屏幕上永远显示成 `50.4% + 49.8%` —— 看着像解释了 100%。
  现在分母改成去中心化总方差（协方差矩阵的迹），三个主成分的真实占比大约
  **10.5% / 10.4% / 9.3%**，累计 30.2%。**数字小了很多，但它是真的。**
- 新增 `buildTokenGraph()`：
  1. 逐对算**全 768 维空间**的余弦相似度（不是降维后的距离）；
  2. 每点连最相似的 4 个点，无向去重（同一条边两个方向都可能选中，取较大的读数）；
  3. 以 PCA 三个主成分的投影为**初值**，跑 3D 力导向（斥力 k²/d + 边弹簧 d²/k +
     向心），320 次迭代，最后按包围盒中心居中并缩放到半径 1。
- **全程没有随机数**：初值来自 PCA，迭代只有确定性算术。同一份知识库刷新多少次都是同一张图
  —— 这条和原来散点图的口径一致，页面文案也还写着「不是随机撒点」。

### 7.2 渲染层（`knowledge/TokenGraph3D.tsx`，新增）

- 节点 `InstancedMesh` + 球体，边一条 `LineSegments`；与焦点相连的边单独一组高亮。
- 悬停 / 点选走 R3F 的实例拾取（`event.instanceId`），悬停看邻居、点选把块摘要带出来。
- 检索引擎命中的块会亮，没命中的压暗 —— 和「相似度检索」页签联动。
- 无人操作时缓慢自转（0.16 rad/s），用户一拖就停。**转的是图的 group**，
  不是 scene：scene 里还有方向光，转 scene 会把光的方位一起转掉，明暗会飘。
- 面板里放不下就加了个「放大」按钮，弹窗里 846×520 看结构。

### 7.3 面板布局

原来的散点图是「统计一行 + 图 228px + 图例 + 提示」竖着堆，加起来超过面板主体高度。
三维图要画幅，所以改成 **`.kb3d` 铺满面板主体（254px），统计 / 图例 / 读数做成浮层压在画布上**，
浮层一律 `pointer-events: none`（否则挡住 OrbitControls 拖拽），只有邻居按钮单独打开指针事件。

### 7.4 这一轮新踩的坑

1. **`linewidth` 在 WebGL 下是被忽略的**（`LineBasicMaterial`）。想用粗细表达相似度是没有的，
   只能把权重编进**颜色明暗**，配 `AdditiveBlending` —— 加法混合下「暗」就等于「弱」，
   连半透明通道都不用开。
2. **`instanceColor` 是 `setColorAt` 第一次调用时才创建的，而材质走不走实例色是编译期决定的。**
   不重编一次材质，节点会全是默认白。判断「刚创建」要看 `instance.instanceColor === null`，
   **不要自己记一个 ref** —— 分块数变化时 `args` 会换掉整个 `InstancedMesh`，ref 记不住这件事。
   （这条是上传资料后节点数从 13 变 19 时才暴露的。）
3. **三维取景要按「最坏自转角度」反解，而且要带透视。** 按当前这一帧取景，
   转到某个角度就切边；只按包围球拟合又会缩得太远（包围球半径由最远那个节点决定，
   而云的实际投影范围通常小得多）。正解是对一圈角度采样，逐点解
   `a + perp/tan(半视角)`（`a` 是朝相机的分量、`perp` 是垂直视线的分量）取最大值。
   这一条把画幅从 68% 提到了 ~80%，而且任何角度都不出画。
4. **给浮层加暗底会让设计规范审计多一个背景色。** `accept`/`--audit` 会数
   「去重后的背景色数量」：这一页原本是 13，随手写一个 `rgba(3,8,18,.74)`
   就变成 14。改成复用面板自己的 `var(--panel-surface)`（本来就在计数里）就回到 13。
   **改完记得跑一次 `--audit` 对比，别只看 `tsc` / `eslint`。**
5. **页面在 940 / 720 高度本来就会滚动**（`.kb-body` 的 `scrollHeight` 大于 `clientHeight`：
   428+12+296+12+138 = 886 > 801）。这是既有的高度配置问题，不是这一轮引入的；
   三维图因为 `height: 100%` 反而比原来那张写死 240px 的柱图更适应小高度。

---

## 8. 再下一轮：共享服务 + 评审 P0 业务闭环（`b98c515`）

这一轮按《木脉智检平台评审与修改建议》§5「第一批」做开发侧：**统一会话、配置、文件与
事件服务**，跑通沈发布 → 饶接收 → 史查看。逐条依据、验证与遗留都写在 `b98c515` 的提交
正文里，这里只留接手必需的几条。

### 8.1 最重要的一条：后端不是 FastAPI

PRD §5.1 写的是 FastAPI＋SQLite＋WebSocket，但**这台机器 pip 连不上 PyPI**
（SSL 直接断），FastAPI 装不上、跑不起来、更没法验证。npm 是通的，Node 24 自带
`node:sqlite`，所以后端改用 Node 实现，**API 路径、请求体、错误码与 PRD §12 逐条对齐**，
只换实现语言。若日后要回到 FastAPI，`server/api/http.mjs` 的路由表就是接口清单。

### 8.2 跑起来

```bash
pnpm run preflight      # 先体检：运行时 / SQLite / 会话 / 演示包 / 素材 / 端口
pnpm run server         # 共享服务，8000（四端要连的是「提供页面的那台机器」）
pnpm run dev            # 页面，5173；/api 与 /ws 由 Vite 代理到 8000
```

`start-demo.cmd` 已改成把共享服务另开一个窗口再起 Vite。内网演示用
`pnpm run build` + `pnpm run server:static`（单进程同时提供页面与接口，
前端不用改任何地址 —— 请求都是同源相对路径）。

`server/data/` 与 `server/assets/` 已进 .gitignore：那是**运行期状态**，
入库会把「本机演示到哪一步」带进仓库，换台机器反而对不上。

### 8.3 这一轮实测出来的两个坑

1. **导航式下载带不上 `Authorization` 头。** `<a href="/api/files/…/download">` 点了没反应：
   href 正确，但请求被 401 拒 —— 浏览器导航不发送自定义头。改成 `fetch` 取字节 +
   `URL.createObjectURL` 保存，文件名从 `Content-Disposition` 的 `filename*` 解析。
   **以后任何「点了下载没反应」先查这一条。**
2. **快照的排序方向会被前端当成业务语义。** 服务端 `ORDER BY updated_at`
   （默认升序）时，前端把**最老**的那条当「当前版本」—— 发布了 CFG-03，页面还显示
   CFG-02。前端一律把每种实体的第一条当当前版本，所以排序必须是 `DESC`。
   同一个文件里还有第二个坑：选择器写 `state.entities[kind] ?? []`，每次返回新数组，
   React 判定快照一直在变，抛 “getSnapshot should be cached” 并无限重渲染 ——
   空列表必须复用同一个冻结常量。

### 8.4 还没做

- **F06 孪生场景的检查/发布还没接服务端**（`Twin.tsx` 本轮未动）。
- F05 小木项目槽位与未知意图、F09 取用记录的操作者与 `elapsedMs` 口径、
  F11 归档按真实字节校验、F12 排练控制台、F13 展示窗口 viewType。
- **v1.1 的正文字号与知识库首屏重排整轮未动**：现在全站正文仍是 11–13px，
  三维关系链的 HUD / 图例 / 读数用的也是 11px 辅助字号。
- 融合规则 UI 仍读 `seed/scenario.ts` 的 `FUSION_RULES`（3 条），没有走重写后的
  `fuseByRule`，所以「待补充 / 本次未提示异常」两行在界面上还看不到。

---

## 6. 提交约定

```bash
git checkout RAO                 # 确认在 RAO 上
git add -A
git commit -m "feat(twin): …"     # 提交信息写「为什么」，不只是「做了什么」
git push origin RAO
```

- **不要 push 到 `main`，也不要把 RAO 合并进 `main`。**
- 提交信息用中文，参考 `git log` 现有风格 —— Mac 侧这 17 条的正文都写清了动机、
  排查过程和验证方式，可以直接照着写。
- 推送前至少跑 `tsc` 与 `eslint`，两者基线都是 **0**。

> 仓库的 remote 在 Mac 上配的是 SSH（HTTPS 无凭据推不上去）。Windows 上如果
> `git push` 报 `could not read Username`，改用 SSH：
> `git remote set-url origin git@github.com:SanWuCN/Wood-Grain-Quality-Inspection-Smart-Platform.git`
