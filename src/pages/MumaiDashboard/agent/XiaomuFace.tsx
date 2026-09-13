/**
 * 小木的脸 · 纯内联 SVG（表情由祖先 `.xd[data-state]` 驱动）
 *
 * ── 为什么形象本体不再用 I04 素材（用户诉求的原文）──────────────────
 * 用户的原话是"把小木的数字形象搞精致些，动态不是周围的圈动一动，
 * 而是小木有具体的表情之类的"。位图素材改不了五官 —— 之前七个状态的差别
 * 只能是"整张图在动 + 徽标文字"，因为图片里没有可以被单独选中的眼睛和嘴。
 *
 * ── 三条约束决定了现在的写法 ─────────────────────────────────────
 * 1. **不动 I04 素材本身**。`Illustration id="i04-xiaomu"` 在 AppShell 的
 *    浮标（34px）与 SmallWoodPanel（44px）里还在用，换素材会波及那两处；
 *    它们要的是"一张头像"，而这里要的是"一张会做表情的脸"，需求本来就不同。
 *    所以本文件另画一个矢量角色，眉眼嘴都是真元素，CSS 能直接选中它们。
 * 2. **状态不再往下传一层 props**。`.xd` 根节点上的 `data-state` 已经是
 *    "用户看得见的那七种状态"的唯一来源，CSS 用后代选择器取它就够了。
 *    同一份信息写两遍（store → props → 内联 style）迟早漂移，
 *    本项目在"状态双份"上已经踩过坑（见 XiaomuDock.tsx 里 dockState 的注释）。
 * 3. **关掉动效后仍要能分辨状态**（FR-06 / AC-05）。所以七套五官的**形状本身**
 *    全部写在 CSS 里：静止态是完整的，动画只是在此之上加"活气"。
 *    动画被 `prefers-reduced-motion` 压掉之后，眼睛/眉毛/嘴的形状依然不同。
 *
 * ── 造型与配色 ───────────────────────────────────────────────────
 * 木色圆角木块 + 一片小苗（"木"的身份），五官用深胡桃色而不是纯黑
 * （纯黑在浅色底上过硬，与平台的克制描边不一致）；腮红与木纹都很淡，
 * 只做体积感，不抢表情的注意力。全部造型都在 100×100 的 viewBox 内，
 * 由 `.xd__figure` 的 100% 宽高等比缩放，没有位图、没有新增依赖。
 *
 * 无障碍：整块 SVG 是**装饰**（`aria-hidden`）——"小木在干什么"的语义
 * 由按钮的 aria-label/title 与 `.xd__badge` 的文字承担（FR-06 的文字兜底）。
 * 读屏用户不会因为这里多了几十个图形节点而听到噪音。
 */
export default function XiaomuFace() {
  return (
    <svg
      className="xd__figure xf"
      viewBox="0 0 100 100"
      role="presentation"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        {/* 木块本体：上浅下深的暖木色，纵向渐变给出体积感（不是贴图） */}
        <linearGradient id="xf-wood" x1="0" y1="0" x2="0.18" y2="1">
          <stop offset="0%" stopColor="#f9e8c6" />
          <stop offset="52%" stopColor="#efd4a2" />
          <stop offset="100%" stopColor="#ddb87c" />
        </linearGradient>
        <linearGradient id="xf-leaf" x1="0" y1="0" x2="0.3" y2="1">
          <stop offset="0%" stopColor="#9ecd86" />
          <stop offset="100%" stopColor="#6da457" />
        </linearGradient>
      </defs>

      {/* ── 头顶的小苗：小木的身份（"木"）──
          刻意**不给它加动画**：它在头的正上方、又是画面里唯一的高饱和色块，
          一动就会把注意力从表情上拽走。七个状态里要动的是五官。 */}
      <g className="xf__sprout">
        <path className="xf__stem" d="M50 16 C50 12.5 50 10 50 6.6" />
        <path className="xf__leaf xf__leaf--l" d="M49.4 10.6 C45.6 3.4 38.6 3.2 37.6 7.4 C36.8 11.2 43 12.6 49.4 10.6 Z" />
        <path className="xf__leaf xf__leaf--r" d="M50.6 8.4 C54.2 1.4 61.4 1.4 62.4 5.6 C63.2 9.4 56.8 10.6 50.6 8.4 Z" />
      </g>

      {/* ── 头/身：圆角木块 + 头顶一道高光 + 下巴一道很淡的木纹 ──
          额头刻意**只留高光、不留深色木纹**：眉与眼都在额头上，
          再加一条横向深线会和眉毛抢戏，看起来像多长了一道皱纹。 */}
      <g className="xf__body">
        <rect className="xf__head" x="13" y="14" width="74" height="74" rx="25" />
        <path className="xf__sheen" d="M25 27.5 C34 20.5 66 20.5 75 27.5" />
        <path className="xf__grain" d="M27 78.5 C37 84.5 63 84.5 73 78.5" />
      </g>

      {/* 腮红：很淡，只做气色 */}
      <ellipse className="xf__blush" cx="23.5" cy="62.5" rx="6.4" ry="4.1" />
      <ellipse className="xf__blush" cx="76.5" cy="62.5" rx="6.4" ry="4.1" />

      {/* ── 眉毛：独立元素，才能按状态单独抬高/压低/一头挑 ── */}
      <g transform="translate(35 30.5)">
        <path className="xf__brow xf__brow--l" d="M-9 1.4 Q0 -3 9 1.4" />
      </g>
      <g transform="translate(65 30.5)">
        <path className="xf__brow xf__brow--r" d="M-9 1.4 Q0 -3 9 1.4" />
      </g>

      {/**
       * ── 眼睛：每个眼是"睁眼 / 笑意弧 / 眯眼线"三选一 ──
       *
       * 三层嵌套各有分工，缺一层就会互相打架（这是本次实现的关键）：
       *   .xf__eye-open  静止形的"睁多大" —— 按状态给 scale，不带动画
       *   .xf__lid       主动眨眼 —— 只有它做 scaleY 动画（眼皮合上）
       *   .xf__lid-alt   备用眨眼的第二个周期 —— 与上一层周期互质，
       *                  两次眨眼不会锁成机械节拍（"别像机械"的要求）
       * 眼珠的"看哪"放在 .xf__gaze 上（可动画），瞳孔大小放在 .xf__pupil 上，
       * 这样"左右游移"（动）与"瞳孔放大"（静）可以同时成立、互不覆盖：
       * CSS 动画会整体接管被动画元素的 transform，同元素上再放静止位移就会丢。
       */}
      <g transform="translate(35 47)">
        <g className="xf__eye-open">
          <g className="xf__lid">
            <g className="xf__lid-alt">
              <ellipse className="xf__sclera" rx="10" ry="10.6" />
              <g className="xf__gaze">
                <circle className="xf__pupil" r="5.4" />
                <circle className="xf__glint" cx="-2" cy="-2.4" r="1.9" />
              </g>
            </g>
          </g>
        </g>
        {/* 眨眼合上那一刻压在上面的眼睑线：让"闭眼"是深色一条线，而不是一层白 */}
        <path className="xf__eyelash" d="M-9 0.2 Q0 -2 9 0.2" />
        {/* 笑意眼（speaking）与眯眼线（error）：形状本身不同，关掉动效也认得出 */}
        <path className="xf__eye-arc" d="M-8.8 1.8 Q0 -8.4 8.8 1.8" />
        <path className="xf__eye-flat" d="M-8.4 -2.6 L8.4 2.6" />
      </g>
      <g transform="translate(65 47)">
        <g className="xf__eye-open">
          <g className="xf__lid">
            <g className="xf__lid-alt">
              <ellipse className="xf__sclera" rx="10" ry="10.6" />
              <g className="xf__gaze">
                <circle className="xf__pupil" r="5.4" />
                <circle className="xf__glint" cx="-2" cy="-2.4" r="1.9" />
              </g>
            </g>
          </g>
        </g>
        <path className="xf__eyelash" d="M-9 0.2 Q0 -2 9 0.2" />
        <path className="xf__eye-arc" d="M-8.8 1.8 Q0 -8.4 8.8 1.8" />
        {/* 右眼的眯眼线是左眼的镜像，两条线合成"＼／"（挤眉）而不是平行的两条 */}
        <path className="xf__eye-flat" d="M-8.4 2.6 L8.4 -2.6" />
      </g>

      {/* ── 嘴：七种状态各一条形状，全在 DOM 里，靠 display 择一 ── */}
      <g transform="translate(50 67.5)">
        <path className="xf__mouth xf__mouth--smile" d="M-7.4 -1.2 Q0 4.8 7.4 -1.2" />
        <ellipse className="xf__mouth xf__mouth--o" cx="0" cy="0.6" rx="3.3" ry="4.1" />
        <path className="xf__mouth xf__mouth--pursed" d="M-6.4 1.2 Q-2.6 -2 0.4 0 Q3.4 2 6.4 -1.2" />
        <path className="xf__mouth xf__mouth--flat" d="M-5.2 0 L5.2 0" />
        <g className="xf__mouth xf__mouth--open">
          <ellipse className="xf__mouth-cavity" cx="0" cy="1.6" rx="6.2" ry="5" />
          <ellipse className="xf__tongue" cx="0" cy="3.8" rx="3.8" ry="2.1" />
        </g>
        <path className="xf__mouth xf__mouth--smirk" d="M-7 -0.4 Q-1.2 4.6 7.6 -3.4" />
        <path className="xf__mouth xf__mouth--frown" d="M-7.4 3.6 Q0 -2.6 7.4 3.6" />
      </g>

      {/**
       * ── 状态标记：思考的「?」、等确认的三个点、出错的一滴汗 ──
       * 都画在头外侧（不占五官的位置），并且**静止态就可见** ——
       * 动画只是让它们飘一飘，关掉动效它们仍然是"这个状态在发生什么"的线索。
       *
       * ⚠ 「?」这里**必须**是两层 <g>：外层只负责摆位置（transform 属性），
       * 内层只负责动画（CSS transform）。SVG 的 transform 属性和 CSS 的
       * transform 是**同一条通道** —— 只要内层被 CSS 动画写了 transform，
       * 外层那个 translate 会被整个丢掉，问号就跑到画布原点（左上角）被裁没了。
       * 实测就是这么翻的车：`prefers-reduced-motion` 下动画被关掉、属性生效，
       * 问号在；正常动效下它反而消失。三组标记里只有它需要这层拆分，
       * 因为另外两组动画的是**子元素**（点、汗），不碰带位置的那层。
       *
       * 「?」由三段拼成而不是一个字形：SVG 里没有字体可用（`<text>` 要依赖
       * 系统字体，跨机器不可控），所以钩子是"带缺口的圆"，缺口位置由 CSS 的
       * stroke-dasharray/dashoffset 控制（那边有为什么偏移必须非负的说明）。
       */}
      <g transform="translate(84 13)">
        <g className="xf__mark xf__mark--q">
          <circle className="xf__q-hook" cx="0" cy="-2.7" r="3.5" />
          <path className="xf__q-stem" d="M1.75 0.35 L1.75 2.5" />
          <circle className="xf__q-dot" cx="1.75" cy="4.9" r="1.25" />
        </g>
      </g>
      <g className="xf__mark xf__mark--dots" transform="translate(84 14)">
        <circle className="xf__dot" cx="-5.4" cy="0" r="1.5" />
        <circle className="xf__dot" cx="0" cy="0" r="1.5" />
        <circle className="xf__dot" cx="5.4" cy="0" r="1.5" />
      </g>
      <g className="xf__mark xf__mark--sweat" transform="translate(83 19)">
        <path className="xf__sweat" d="M0 -5.2 C3 0.4 3.6 3.2 1.9 5 C0.4 6.6 -1.6 6.2 -2.6 4.4 C-3.7 2.4 -2.6 -0.6 0 -5.2 Z" />
        <circle className="xf__sweat-glint" cx="-0.9" cy="2.4" r="0.95" />
      </g>
    </svg>
  );
}
