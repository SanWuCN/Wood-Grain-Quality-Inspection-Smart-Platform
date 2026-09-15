/**
 * 待读取委托的**显式绑定**（防幻觉规则 3 / 12 的载体）
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────
 * 《新工单红头委托与小木联动-AI交接文档 v1.0》把两件事定成了硬规则：
 *   · 第 3 条：不用 `orders[0]` 猜"用户想看哪张"，必须用**显式绑定**的待读取 orderId；
 *   · 第 12 条：连续触发多张工单时，通知 / 预览 / 语音读取 / 详情页必须保持**同一个** id。
 *
 * 旧实现恰好违反这两条：`agent/executor.ts` 的 `scriptEntities()` 写的是
 * `state.orders[0]?.id`（"列表第一条 = 最新 = 用户想读的"）。它在这两处会错：
 *   · 用户点的是**第二条**通知的「查看」，念出来的却是第一条；
 *   · 连按两次快捷键建了两张单，语音永远只读最新那张。
 * 两种都属于"把 A 的委托当 B 的念出来"——本需求里最不能出的错。
 *
 * ── 设计取舍 ────────────────────────────────────────────────────────
 * 这里做成**纯逻辑工厂**（不依赖 React / zustand / DOM），原因是：
 *   · 本仓库的单测跑在 Node 原生 `--test` 下，没有 DOM 也没有渲染环境，
 *     zustand 那类实现测不动；
 *   · "绑定与解析"本来就是可以脱离 UI 讲清的一小段状态机，值得单独钉住。
 * React 侧只做一层薄薄的订阅（见 `store/workOrders.ts` 里的接入），不再重复这套规则。
 */

/** 解析绑定后能得到的三种"可读"状态与两种"不可读"状态 */
export type CommissionResolveState = "can-read" | "restricted" | "unbound" | "missing";

export type CommissionResolveResult = {
  state: CommissionResolveState;
  /** 可导航的目标；不可读时为 null */
  orderId: string | null;
  /** 给用户看的一句话（两种"不可读"的措辞必须不同 —— 见下方注释） */
  message: string;
};

/**
 * 查询一张工单是否存在、是否受限。
 *
 * 做成接口而不是直接依赖 store：调用方（`executor`）拿的是它自己的数据源，
 * 测试拿的是桩。这样"绑定规则"不必跟着数据层一起改。
 */
export type CommissionLookup = {
  describe(orderId: string): Promise<{ orderId: string; restricted: boolean } | null>;
};

export type CommissionBinding = {
  /** 当前绑定的工单 id（未绑定为 null） */
  get(): string | null;
  /** 绑定（空串视为取消绑定） */
  bind(orderId: string): void;
  /**
   * 消费：取出并**清空**绑定。语音读完这条委托后必须调用，
   * 否则下一轮又念到同一条（连按两次快捷键的场景会直接暴露这个问题）。
   */
  consume(): string | null;
  /** 解析：绑定还在不在、有没有权限。**不消费**（读一次不等于用掉） */
  resolve(lookup: CommissionLookup): Promise<CommissionResolveResult>;
};

/** 两种"读不到"的提示措辞 —— 共用一个常量，避免两处文案漂移 */
const REOPEN_HINT = "当前委托无法读取，请重新打开新工单通知";

/**
 * 创建一个绑定器。
 *
 * ⚠ 这是**工厂**而不是模块级单例：模块级单例会在测试之间互相污染
 *   （上一个用例绑的 id 漏到下一个用例），本仓库此前吃过这个亏。
 *   运行时由 `store/workOrders.ts` 持有一个实例。
 */
export function createCommissionBinding(): CommissionBinding {
  let bound: string | null = null;

  return {
    get: () => bound,

    bind(orderId: string) {
      bound = orderId ? orderId : null;
    },

    consume() {
      const current = bound;
      bound = null;
      return current;
    },

    async resolve(lookup) {
      if (!bound) {
        return { state: "unbound", orderId: null, message: REOPEN_HINT };
      }
      const found = await lookup.describe(bound);
      if (!found) {
        /*
          工单不存在（被删了 / 换库了 / 换了账号看不到）→ **清掉绑定**。
          留着一个悬空 id 的危害是具体的：后续导航会带着它跳到
          `/orders?order=<不存在的单>`，页面显示空态，用户以为是平台坏了。
        */
        bound = null;
        return { state: "missing", orderId: null, message: REOPEN_HINT };
      }
      if (found.restricted) {
        /*
          受限 ≠ 读不到：导航目标仍然有效，只是**不给正文与附件**。
          提示措辞必须与上面两种区分开，否则用户会去反复点通知（其实点了也没用，
          是账号权限不够）。
        */
        return {
          state: "restricted",
          orderId: found.orderId,
          message: "当前账号只获准查看摘要，委托正文与附件不展示",
        };
      }
      return { state: "can-read", orderId: found.orderId, message: "" };
    },
  };
}

/**
 * 运行时单例（**挂在 window 上，见下面的坑**）。
 *
 * 谁在用：
 *   · `Shell.tsx`（通知的「查看」）→ `bind(orderId)` + 打开预览；
 *   · `agent/executor.ts` 的 `scriptEntities()` → `get()` 取导航目标；
 *   · 第①轮读完后 → `consume()` 清掉，避免下一轮又念到同一条。
 *
 * ── ⚠ 为什么不用普通的 `export const`（真踩过，一次性排掉）────────────────
 * 模块级单例在 Vite dev 下**可能被实例化多份**：同一个源文件经不同写法引用时
 * （`"../commissionBinding"` 相对引用 vs `/src/pages/MumaiDashboard/commissionBinding`
 * 绝对引用），Vite 会给出**不同的模块实例**。实测后果很隐蔽也很严重：
 *   · 工装/预览侧 `bind("wo-1")` 成功，`get()` 也读得回；
 *   · 但 `executor` 走的是另一份实例，`get()` 返回 `null`；
 *   · 于是第①轮打出「要打开已绑定的工单，但当前没有绑定」→ **不导航**
 *     （防幻觉规则 3 要求此时不许猜单，所以它正确地拒绝跳转，页面纹丝不动）。
 * 把实例挂到 `window` 上之后，无论模块被求值几次，拿到的都是同一份状态。
 * 本仓库既有做法一致（`window.__mumaiAsk`、`window.__mumaiAgent` 同理）。
 */
const BINDING_KEY = "__mumaiCommissionBinding";

type BindingHost = { [BINDING_KEY]?: CommissionBinding };

export const commissionBinding: CommissionBinding = (() => {
  const host = globalThis as unknown as BindingHost;
  return (host[BINDING_KEY] ??= createCommissionBinding());
})();
