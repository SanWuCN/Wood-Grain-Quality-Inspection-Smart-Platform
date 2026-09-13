/**
 * 登录页（`/login`）
 *
 * 依据：
 *   - PRD 2.1：四个账号 + 默认工作区（账号与权限的事实来源是 auth.ts / design.ts）
 *   - 视觉设计规范 v1.0：深蓝黑底（BG-00 #030812）、唯一主色 #4EA8FF、
 *     HarmonyOS Sans SC、8px 网格间距、普通面板不发光（§4.1 / §6.1）
 *   - 动效规范 §6.2：开场 easing 只用 power2.out / power3.out，禁止 bounce / elastic
 *
 * 界面纪律（这一版的重点）：
 *   这是一个「真实产品的登录页」，不是演示道具 —— 页面上**不出现任何账号名、
 *   口令或账号清单**，包括 placeholder、提示文字与 console。凭据校验全部留在
 *   auth.ts 里，本文件只负责「输入 → 调 login() → 落盘会话 → 跳转」。
 *
 * 入场动画为什么用 GSAP 而不是 CSS animation：
 *   外壳（entrance.ts）与总览页（usePanelEntrance.ts）都是 GSAP 时间线，
 *   登录页沿用同一套「背景先淡入 → 主体上浮 → 细节依次错开」的节奏，
 *   三者用同一条 easing 曲线，切换时才不会出现两种手感。
 *
 * 这个文件同时导出 `Login` 与 `RequireLogin` 两个组件，不导出常量或类型，
 * 以免触发 eslint 的 react-refresh/only-export-components。
 */

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { Navigate, useLocation, useNavigate } from "react-router";
import { gsap } from "gsap";
import { dropInvalidSession, login, readSession, workspacePath, writeSession } from "../auth";
import { Icon } from "../icons";
import { Illustration } from "../illustrations";
import "../appshell.css";
import "../pages.css";
// UI 视觉素材 v2.0：登录页在外壳之外，需要自己引入主题作用域与图标/插图样式（PRD §4）
import "../styles/ui-assets-v2.css";
import "../ui-assets-v2-icons.css";
import "./login.css";

/** 入场编排：与 --motion-page(560ms) 同一量级，整体 1.0s 收尾（规范 §6.2） */
const DUR_BG = 0.5; // 背景两层
const CARD_AT = 0.12; // 卡片起播时刻
const DUR_CARD = 0.5; // 卡片上浮时长
const STAGGER_AT = 0.34; // 卡片内细节的首个时刻（卡片快落位时接上）
const STEP = 0.06; // 每个元素的错开间隔
const DUR_STEP = 0.34; // 单个元素的淡入时长

/** 降低动效偏好：直接进终态，不播（无障碍要求，规范 §6.2 附注） */
const prefersReducedMotion = () =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/**
 * 古建筑构件意象：纯 SVG 线稿，不引入任何图片资源。
 *
 * 取「四柱 + 额枋 + 斗拱 + 台基」的极简轮廓，只有横竖线，不要弧线与花饰 ——
 * 工业软件的可信感来自精确的直线与等距关系，而不是纹样。
 * 压在页面底部、透明度极低，只作背景骨架，不与表单争注意力（§0 核心原则）。
 */
function EaveFrame() {
  const columns = [80, 240, 400, 560];
  return (
    <svg
      className="login__frame"
      viewBox="0 0 640 240"
      preserveAspectRatio="xMidYMax slice"
      aria-hidden="true">
      {/* 台基 */}
      <path d="M16 196H624" />
      <path d="M40 196v-10h560v10" />
      {/* 四柱：柱础 / 柱身 / 斗拱（三级收分） */}
      {columns.map((x) => (
        <g key={x}>
          <path d={`M${x - 16} 186h32`} />
          <path d={`M${x - 8} 186V86`} />
          <path d={`M${x - 8} 86h16`} />
          <path d={`M${x - 14} 78h28`} />
          <path d={`M${x - 20} 70h40`} />
        </g>
      ))}
      {/* 额枋、檐口、屋脊 */}
      <path d="M60 70H580" />
      <path d="M60 70 24 50H616L580 70" />
      <path d="M60 36h520" />
      <path className="login__frame-ridge" d="M80 36 320 10 560 36" />
      {/* 每柱一条轴测细线 + 交点十字：测绘标注的语汇，克制到几乎只是底纹 */}
      {[80, 240, 400, 560].map((x) => (
        <g key={`axis-${x}`}>
          <path className="login__frame-axis" d={`M${x} 10V196`} />
          <path d={`M${x - 4} 152h8`} />
        </g>
      ))}
      {/* 巡测基准线上的两个定位点 */}
      <circle className="login__frame-node" cx="240" cy="152" r="2.5" />
      <circle className="login__frame-node" cx="400" cy="152" r="2.5" />
    </svg>
  );
}

/**
 * 等高线 / 地形线：三层同心闭合曲线，用正则化的正弦叠加算出来，
 * 所以它「像地形」而不是「像随手画的圈」。仅作背景纹理，透明度极低。
 */
function ContourLines() {
  const rings = [0.42, 0.66, 0.9, 1.12];
  const contour = (scale: number, phase: number) =>
    Array.from({ length: 145 }, (_, index) => {
      const t = (index / 144) * Math.PI * 2;
      const radius = 1 + 0.16 * Math.sin(3 * t + phase) + 0.07 * Math.sin(7 * t + phase * 2);
      const x = 300 + Math.cos(t) * 235 * scale * radius;
      const y = 220 + Math.sin(t) * 152 * scale * radius;
      return `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
    }).join(" ") + " Z";

  return (
    <svg
      className="login__contour"
      viewBox="0 0 600 440"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true">
      {rings.map((scale, index) => (
        <path key={scale} d={contour(scale, index * 0.9)} />
      ))}
    </svg>
  );
}

export function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const from =
    typeof location.state === "object" &&
    location.state !== null &&
    "from" in location.state &&
    typeof (location.state as { from?: unknown }).from === "string"
      ? (location.state as { from: string }).from
      : null;

  const [loginName, setLoginName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLElement | null>(null);
  const terrainRef = useRef<HTMLDivElement | null>(null);
  /**
   * 防重复提交的第一道闸。
   * React 的 setState 在同一个事件循环里不会立刻生效 —— 连点两下时第二次
   * submit 读到的 `pending` 还是 false，只有这个 ref 是同步的，能真正拦住。
   */
  const busyRef = useRef(false);

  /**
   * 入场动画（GSAP 时间线）。
   *
   * 用 useLayoutEffect：在首次绘制前就把起点写进内联样式，不会先以终态闪一帧。
   * 所有元素都在同一个 effect 里 collect，元素缺失就跳过那一步，不会留下
   * 「永远 opacity:0」的死元素。
   */
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    /** 卡片内按阅读顺序依次浮现的元素，每一步一个 (选择器, 时刻) */
    const order: Array<[string, number]> = [
      [".login__meta", STAGGER_AT],
      [".login__mark", STAGGER_AT + STEP],
      [".login__eyebrow", STAGGER_AT + STEP * 2],
      [".login__name", STAGGER_AT + STEP * 3],
      [".login__sub", STAGGER_AT + STEP * 4],
      [".login__facts li", STAGGER_AT + STEP * 5],
      [".login__motto", STAGGER_AT + STEP * 7],
      [".login__form-title", STAGGER_AT + STEP * 2],
      [".login__field", STAGGER_AT + STEP * 3],
      [".login__hint", STAGGER_AT + STEP * 4],
      [".login__submit", STAGGER_AT + STEP * 5],
      [".login__session", STAGGER_AT + STEP * 6],
      [".login__form-note", STAGGER_AT + STEP * 7],
    ];

    const steps: Array<{ els: Element[]; at: number; y: number }> = [];
    for (const [selector, at] of order) {
      const els = Array.from(root.querySelectorAll(selector));
      if (els.length) steps.push({ els, at, y: 10 });
    }
    const bg = [terrainRef.current, root.querySelector(".login__grid")].filter(
      (el): el is HTMLElement => Boolean(el),
    );
    const card = cardRef.current;

    const targets = [...bg, ...(card ? [card] : []), ...steps.flatMap((step) => step.els)];
    if (!targets.length) return;

    // 降低动效偏好：不做任何位移与淡入，直接是终态
    if (prefersReducedMotion()) {
      gsap.set(targets, { opacity: 1, x: 0, y: 0 });
      return;
    }

    /**
     * 入场起点的时间戳，挂在 <html> 的 data 属性上。
     * 纯观测用途：自动化验收要按「时间线起点」而不是「页面导航」分帧，
     * 否则测到的是模块加载耗时，不是动画本身；不影响渲染。
     */
    document.documentElement.dataset.loginAnim = String(performance.now());
    /**
     * 调试钩子：`__MUMAI_LOGIN_DEBUG__ = { timeScale: 4 }`
     * 整体放慢入场（GSAP 的 timeScale，>1 表示更慢）。
     * 无头浏览器主线程被字体与首帧布局占满时，GSAP 会按真实经过时间一次性
     * 补完中间帧，肉眼看到的就是「直接跳到终态」；放慢后才能在截图里逐帧
     * 验收入场编排。只读全局变量，不写全局变量，默认不生效。
     */
    const debugScale = (
      window as unknown as { __MUMAI_LOGIN_DEBUG__?: { timeScale?: number } }
    ).__MUMAI_LOGIN_DEBUG__?.timeScale;
    const timeScale = typeof debugScale === "number" && debugScale > 0 ? debugScale : 1;

    const ctx = gsap.context(() => {
      if (bg.length) {
        gsap.fromTo(
          bg,
          { opacity: 0 },
          { opacity: 1, duration: DUR_BG, ease: "power2.out", clearProps: "opacity" },
        );
      }
      if (card) {
        gsap.fromTo(
          card,
          { opacity: 0, y: 18 },
          {
            opacity: 1,
            y: 0,
            duration: DUR_CARD,
            delay: CARD_AT,
            ease: "power3.out",
            clearProps: "transform,opacity",
          },
        );
      }
      for (const step of steps) {
        gsap.fromTo(
          step.els,
          { opacity: 0, y: step.y },
          {
            opacity: 1,
            y: 0,
            duration: DUR_STEP,
            delay: step.at,
            ease: "power2.out",
            clearProps: "transform,opacity",
          },
        );
      }
      if (timeScale > 1) gsap.globalTimeline.timeScale(timeScale);
    }, root);

    return () => {
      ctx.revert();
      // 调试放慢只对本次入场有效，卸载时恢复，避免影响后续路由
      if (timeScale > 1) gsap.globalTimeline.timeScale(1);
    };
  }, []);

  const submit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (busyRef.current) return; // 已在提交中，忽略重复提交
      busyRef.current = true;
      setPending(true);

      const result = login(loginName, password);
      if (!result.ok) {
        setError(
          result.reason === "unknown-account"
            ? "账号不存在，请核对姓名拼音"
            : "密码错误，请重新输入",
        );
        setPassword("");
        busyRef.current = false;
        setPending(false);
        return;
      }

      writeSession(result.account.id, new Date().toISOString());
      setError("");
      /**
       * 交到微任务里再跳转：让 React 先把「正在登录」这一帧提交出去。
       * busyRef 到这里仍然为 true，所以跳转前连点也不会重复触发登录。
       */
      void Promise.resolve().then(() => {
        navigate(from ?? workspacePath(result.account.id), { replace: true });
      });
    },
    [from, loginName, navigate, password],
  );

  // 已有会话时不再停留在登录页，直接回到该角色的默认工作区；
  // 没有有效会话时顺手把脏数据清掉（坏 JSON / 结构不对 / 未知 accountId）
  const existing = readSession();
  if (existing) {
    return <Navigate to={workspacePath(existing.accountId)} replace />;
  }
  dropInvalidSession();

  /** 输错后输入框转错误态；一旦重新输入就解除（只改边框颜色，不做抖动） */
  const fieldClass = (value: string) =>
    `login__field ${error && !value ? "is-error" : ""}`.trim();

  return (
    <div className="login mumai-ui-v2" ref={rootRef}>
      {/*
        背景各层统一放进 .login__bg：作为一个整体在卡片之下，也整体先淡入。
        UI 素材 v2.0（PRD §5「登录与项目入口：可接 I01 主视觉和低对比背景层，
        登录表单仍是主操作；已有合适布局可少改」）：
          · I01 低对比背景层 —— 铺满视口，只提供木构氛围，对比度不足以抢焦点
          · I01 主视觉      —— 落在卡片左栏（品牌区）之上，压到很低的透明度
        两张图都走 illustrationManifest 的 id，不写文件路径；
        且都是纯装饰，alt 传空字符串（对辅助技术隐藏）。
      */}
      <div className="login__bg" aria-hidden="true">
        <Illustration id="i01-background" backdrop alt="" className="login__photo--bg" />
        <Illustration id="i01-hero" backdrop alt="" className="login__photo--hero" />
        <div className="login__grid" />
        <div className="login__terrain" ref={terrainRef}>
          <ContourLines />
        </div>
        <div className="login__scan" />
        <EaveFrame />
      </div>

      <section className="login__card" ref={cardRef}>
        {/* 右栏底纹：淡蓝图网格，把表单区从大片留白里托起来，不抢焦点 */}
        <div className="login__pattern" aria-hidden="true" />

        <div className="login__brand">
          <p className="login__meta">LOCAL DEMO BUILD · v1.0</p>
          {/*
            团队字标：`public/brand/mumai-wordmark-white.png` —— 团队 logo 原图
            抠掉蓝色背景后重新着白色的完整字标（含前面的符号）。
            这里**只放这一件**：原来旁边还并排放了一个单独的符号，和字标自带的
            那个重复；现在把字标本身放大，它已经包含符号 + 品牌名 + 那套字形，
            就是登录页的主标题。因此下面的 h1 不再重复写品牌名。
            原图只有位图，所以只约束高度、宽度随比例，避免被压扁。
          */}
          <img
            className="login__wordmark"
            src="/brand/mumai-wordmark-white.png"
            alt="木脉智检"
          />
          <p className="login__eyebrow">MUMAI INSPECTION PLATFORM</p>
          <h1 className="login__name">古建筑智能巡检平台</h1>

          <ul className="login__facts">
            <li>四柱 Z01–Z04 统一编号</li>
            <li>巡检 · 重建 · 检测同源数据</li>
            <li>历史资料只读复用</li>
            <li>本轮批次独立记录</li>
          </ul>

          <p className="login__motto">让古建被看见 · 让历史有未来</p>
        </div>

        <form className="login__form" onSubmit={submit} noValidate>
          <div className="login__form-head">
            <h2 className="login__form-title">账号登录</h2>
            <p className="login__form-cap">登录后按角色进入默认工作区</p>
          </div>

          <label className={fieldClass(loginName)}>
            <span>账号（姓名拼音）</span>
            <span className="login__control">
              {/* PRD §3.3：user → identity-user（账号身份） */}
              <Icon className="login__control-icon" name="identity-user" size={16} aria-hidden />
              <input
                name="login"
                value={loginName}
                autoComplete="username"
                spellCheck={false}
                autoFocus
                placeholder="请输入账号"
                aria-invalid={Boolean(error)}
                onChange={(event) => {
                  setLoginName(event.target.value);
                  if (error) setError("");
                }}
              />
            </span>
          </label>

          <label className={fieldClass(password)}>
            <span>密码</span>
            <span className="login__control">
              {/*
                密码字段原本借用 order（工单）图标，语义不对。
                v2 素材提供了 status-lock（锁），是密码输入的标准语义；
                它同时是「状态」类图标，但这里表达的是「需要凭据」，不涉及设备在线状态，
                与 PRD §4「禁用不能代表设备离线」那条约束不冲突。
              */}
              <Icon className="login__control-icon" name="status-lock" size={16} aria-hidden />
              <input
                name="password"
                type="password"
                value={password}
                autoComplete="current-password"
                placeholder="请输入密码"
                aria-invalid={Boolean(error)}
                onChange={(event) => {
                  setPassword(event.target.value);
                  if (error) setError("");
                }}
              />
            </span>
          </label>

          <p className="login__error" role="alert">
            {error ? (
              <>
                {/* PRD §3.3：alert → status-warning；错误用 error tone，同时有文字，不只靠颜色 */}
                <Icon name="status-warning" size={16} tone="error" aria-hidden />
                {error}
              </>
            ) : null}
          </p>

          {/* 说明行：只讲平台会做什么，不出现任何账号信息 */}
          <p className="login__hint">登录后按当前角色的可执行操作开放对应模块</p>

          <button
            type="submit"
            className="btn btn--primary login__submit"
            disabled={pending}
            aria-busy={pending}>
            {pending ? (
              <>
                <span className="login__spinner" aria-hidden="true" />
                正在登录
              </>
            ) : (
              <>
                登录
                {/* PRD §3.3：arrow 保留原图标 */}
                <Icon name="arrow" size={20} aria-hidden />
              </>
            )}
          </button>

          {/* 系统状态区：演示环境与快照批次，属于运维信息，不含凭据 */}
          <div className="login__session">
            <p className="login__session-label">当前环境</p>
            <p className="login__session-line">批次 R-2026-0901</p>
            <p className="login__session-line">数据来源 · 本地快照</p>
          </div>

          <p className="login__form-note">MUMAI INSPECTION PLATFORM · LOCAL BUILD</p>
        </form>
      </section>
    </div>
  );
}

/** 未登录守卫：首次访问或会话丢失时跳到登录页，并把原目标地址带上 */
export function RequireLogin({ children }: { children: ReactNode }) {
  const location = useLocation();
  if (!readSession()) {
    // 脏数据（坏 JSON / 结构不对 / 未知 accountId）在这里清掉：
    // 本组件在没有 Provider 的情况下渲染，不能走 useEffect，写在这里最直接
    dropInvalidSession();
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  return <>{children}</>;
}
