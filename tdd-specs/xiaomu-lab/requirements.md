# Requirements — xiaomu-lab

> 由 `usecases.md` 派生。每条 REQ 显式引用来源 UC；验收标准用 EARS 句式（When/While … the system shall …）。

## UC → REQ 映射

| UseCase | Requirements |
|---|---|
| UC-01 打开展台并看到全部方案在动 | REQ-01, REQ-02, REQ-08 |
| UC-02 放大单看某个方案 | REQ-03 |
| UC-03 全局播放控制 | REQ-04 |
| UC-04 自适应布局 | REQ-05 |
| UC-05 产出挑选依据 | REQ-06 |
| UC-06 选中方案落地产品 | REQ-07 |

---

### REQ-01 展台页与方案注册表

**来源**：由 UC-01 派生

**User Story**: As a 项目负责人（挑选者）, I want to 打开一个页面就看到所有候选方案, so that 我能一次比较完并拍板。

#### Acceptance Criteria (EARS)

1. When 浏览器访问 `/xiaomu-lab.html`, the system shall 加载展台页并读取方案注册表。（UC-01 成功路径 1–2）
2. The system shall 保证注册表**非空**且**变体 id 唯一**；违反时显式报错。（UC-01 备选 4d）
3. While 某变体的渲染初始化抛错, the system shall 只在该格显示错误提示，其余格照常渲染。（UC-01 备选 4b）
4. When 可用 WebGL 上下文达到上限, the system shall 按上限降级渲染并在页面**显式提示**，不得静默少画。（UC-01 备选 4c）
5. While 浏览器不支持 WebGL2, the system shall 对需要 WebGL 的格显示静态占位与提示，整页不白屏。（UC-01 备选 4a）

---

### REQ-02 全部方案同框且持续动画

**来源**：由 UC-01 派生

**User Story**: As a 挑选者, I want 所有方案一次性同框并都在动, so that 我能直观比较动态效果（这是"最好全量展示"的原话要求）。

#### Acceptance Criteria (EARS)

1. When 展台页加载完成, the system shall 在**同一屏内**呈现全部变体（首版 8 个 WebGL + 1 个老方法 = 9 格），不折叠、不懒加载隐藏。（UC-01 成功路径 6）
2. The system shall 让每格显示：编号、一句话特点、技术要点、**实测 FPS**。（UC-01 成功路径 5）
3. While 页面处于播放态, the system shall 保证每格在任意 1.5s 窗口内的**双帧像素差 > 阈值**（证明"确实在动"）。（UC-01 后置条件）
4. The system shall 为每格提供：呼吸缩放、缓慢浮动、渐变/高光流动、**眨眼**（脸部件存在时）。（UC-01 成功路径 4）

---

### REQ-03 放大与还原

**来源**：由 UC-02 派生

**User Story**: As a 挑选者, I want 单独放大看某一版, so that 我能看清质感与细节再决定。

#### Acceptance Criteria (EARS)

1. When 点击某一格, the system shall 将该格放大独显，并将其余格**暂停并缩小**。（UC-02 成功路径 1–2）
2. When 处于放大态 again 点击同一格或按 `Esc`, the system shall 还原格子视图并让全部格恢复动画。（UC-02 成功路径 4）
3. While 处于放大态, the system shall 以放大态重新计量 FPS，不沿用格子态数值。（UC-02 成功路径 3）
4. While 全局处于暂停态, when 用户放大某格, the system shall **保持暂停**（不得偷偷恢复播放）。（UC-02 备选 4b）
5. When 放大态下改变窗口尺寸, the system shall 不溢出、不裁切。（UC-02 备选 4a）

---

### REQ-04 全局播放控制

**来源**：由 UC-03 派生

**User Story**: As a 挑选者, I want 一键暂停/重播全部方案, so that 我能定住某一帧细看。

#### Acceptance Criteria (EARS)

1. When 点击「暂停」, the system shall 让**全页帧不再变化**（同格双帧像素差 ≈ 0）。（UC-03 成功路径 1–2）
2. When 点击「重播」, the system shall 恢复全部格的动画。（UC-03 成功路径 3）
3. The system shall 让控件状态可读且与视觉一致（`aria-pressed`）。（UC-03 成功路径 4）
4. When 快速连点控件, the system shall 不出现"半暂停"（部分格仍在跑）。（UC-03 备选 4a）
5. While 全局暂停, the system shall 优先于单格播放态（全局暂停 > 单格）。（UC-03 备选 4b）

---

### REQ-05 自适应布局

**来源**：由 UC-04 派生

**User Story**: As a 挑选者（笔电或台式）, I want 页面自动适配我的屏幕, so that 我不需要横向拖动就能看全。

#### Acceptance Criteria (EARS)

1. When 视口宽度为 1366 / 1440 / 1920, the system shall 自动换行排布且**无横向滚动条**。（UC-04 成功路径 1–2）
2. When 视口宽度 < 1024, the system shall 单列排布且仍不溢出。（UC-04 备选 4a）
3. The system shall 用**纯函数**由宽度推导列数（便于单测）。（UC-04 路径覆盖 · 输入/校验）
4. While 用户连续缩放窗口, the system shall 不重建渲染上下文，且最终布局收敛到最后一次宽度。（UC-04 路径覆盖 · 状态/并发、时间/恢复）

---

### REQ-06 产出挑选依据与性能门槛

**来源**：由 UC-05 派生

**User Story**: As a 挑选者, I want 拿到并排图、单图、动效证据与对照表, so that 我能有据地挑选。

#### Acceptance Criteria (EARS)

1. The system shall 产出：整页并排大图、每版单图、**同版 1.5s 双帧像素差**、`方案对照表.md`。（UC-05 成功路径 1–4）
2. The system shall 在对照表中给出**实测 FPS**，且**不得虚报**。（UC-05 后置条件）
3. When 某 WebGL 版实测 FPS < 30, the system shall 判定其不合格：优化或标 `[!]` 并写明理由。（UC-05 备选 4a）
4. While 变体为老方法（纯 CSS/SVG，无 WebGL）, the system shall 不参与 FPS 硬门槛，但**必须**通过双帧像素差，并注明「0 WebGL 上下文 + 合成层」。（UC-05 备选 4b）
5. When 截图捕获到空白帧, the system shall 重试并记录，不得把空图当结果。（UC-05 备选 4c）

---

### REQ-07 选中方案落地产品

**来源**：由 UC-06 派生

**User Story**: As a 平台开发者, I want 把选中的方案落进产品形象本体, so that 小木的形象与平台风格一致。

#### Acceptance Criteria (EARS)

1. When 用户给出明确方案 id, the system shall 将该方案落进产品形象本体（`src/pages/MumaiDashboard/agent/`）。（UC-06 成功路径 1）
2. The system shall 保留 7 状态表情（idle/listening/recognizing/thinking/speaking/confirming/error）与 `prefers-reduced-motion` 下的**静态可辨**。（UC-06 成功路径 2）
3. The system shall 保持 `验收界面.mjs` **230/230**、`tsc -b` exit 0、`eslint` 0 error。（UC-06 成功路径 3）
4. When 落地后验收被打破, the system shall **回退并如实报告**。（UC-06 备选 4a）
5. While 产品内小尺寸（120px / 短屏 72px）three 渲染发糊, the system shall 允许退回 CSS/SVG 实现并在提交信息中说明。（UC-06 备选 4b）
6. When 落地完成, the system shall 只推送 `origin/SHI`（不碰 main/RAO），且经本机代理。（UC-06 路径覆盖 · 外部依赖）

---

### REQ-08 老方法版同等动态

**来源**：由 UC-01、UC-05 派生（承载"老方法也一起展示"的原话要求）

**User Story**: As a 挑选者, I want 看到纯 CSS/SVG 路线也能做到同样动态, so that 我能公平地在"轻量实现"与"3D 实现"之间取舍。

#### Acceptance Criteria (EARS)

1. The system shall 在**同一片网格**内展示老方法版，并标注「非 WebGL」。（UC-01 成功路径 2、6）
2. The system shall 让老方法版具备与 WebGL 版**同等强度的动态**：渐变流动、高光游走、呼吸、浮动、眨眼。（UC-01 成功路径 4）
3. The system shall 在对照表中如实标注其优劣势：不占 WebGL 上下文 / 任意尺寸清晰 / 开销低 ↔ 3D 光影真实感有限。（UC-05 备选 4b）
