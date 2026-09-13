# 木脉智检 UI 图标与视觉素材交付包

版本：v2.0  
日期：2026-09-13  
交付范围：木脉智检桌面平台，不包含 800×400/480 触屏前端。

## 建议先看

1. `previews/platform-page-fit-overview.png`：1600×1000 平台端整页静态试装，覆盖一级导航、设备与采集、数字孪生、模型适配、知识库与小木。
2. `previews/comparisons/P0-P1-eight-samples-before-after.png`：PRD 指定 8 项 P0/P1 图标的新旧、16/20/24px 对照。
3. `previews/status-and-interaction-states.png`：默认、悬停、选中、禁用和六种语义状态。
4. `previews/icons-v2-theme-comparison.png`：全部标准图标的深色平台与浅色底反差回归。
5. `previews/small-variants-comparison.png`：5 枚专用 16px 简化版。
6. `previews/illustrations-v2-platform-dark.jpg`：全部插图在平台深色卡片上的主体比例。
7. `previews/I04-two-candidates.jpg`：小木助手 A/B 两版候选；A 为默认交付。

## 交付内容

- `icons/common/`：33 枚通用图标，包含新增 `status-device-offline`。
- `icons/business/`：11 枚业务图标，包含扫描仪两版简化轮廓。
- `icons/small/`：5 枚针对 16px 重画的简化图标。
- `illustrations/`：I01–I06 透明 PNG 母版与 WebP 网页副本；I04 含两版候选；另有小木 24/32px 线性版。
- `tokens.css`：桌面平台深色主题变量。
- `asset-manifest.csv`：逐文件用途、变体、来源、版本、页面位置和验收状态。
- `CHANGELOG.md`：全量修改记录。
- `QA.md`：自动、视觉与页面检查结果。

## 关键结论

- 设置图标已从“太阳”改为简化齿轮；人工标记已从地图针改为笔尖与标记点。
- 服务离线继续使用断云，设备离线改为断开连接，两者不再混用。
- 样本分组、木柱、材料适配、模型导航、高斯场景、多模态均按小尺寸结构重画。
- 小木去除机甲身体、十字装饰和夸张镀铬，默认使用圆角头像；16/24px 使用线性图标。
- I03 依据用户提供的旧版 PPT 第 11 页右侧白色立柱三脚扫描仪制作，没有改成扫码枪或触屏设备。
- I02 仍是概念占位，等待真实巡检车照片替换。

## 接入边界

本包已经完成平台端静态试装，但项目目录中没有可修改的实际前端源代码，因此不能把静态预览写成“真实页面已接入通过”。接入时建议整体复制到前端 `public/ui-assets/`，由统一 Icon/Illustration 组件按清单调用。

所有业务文字、数字、状态、进度和检测结果必须由前端渲染，不得烘焙进插图。装饰图标设置 `aria-hidden="true"`；纯图标按钮提供可访问名称；设备/服务状态同时保留图形和文字，不只依赖颜色。
