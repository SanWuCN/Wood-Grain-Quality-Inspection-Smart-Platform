/**
 * 小木气泡 · 「关键词提示」显示开关（默认**关**）
 *
 * ── 用户口径（2026-09-28）────────────────────────────────────────────
 * 「平台内置一个比较隐蔽的小木关键词显示开关，我点开能看到，原来在气泡里的太明显了」。
 *
 * 说的是气泡里那张「快捷键一览」每行第三条：**照着说什么**（`shortcutSheetRows().how`
 * 就是 `ScriptShortcutEntry.text`）。25 行关键词一起铺在屏幕上，观众一眼就看到
 * "原来照着念就行"——那正是现场最不该露的东西。所以默认不显示，
 * 由讲解的人自己打开；打开后每行多一条，点它就直接走该轮（不用念、不用按键）。
 *
 * ── 为什么开关放在「一览展开之后」──────────────────────────────────
 * 气泡收起时这块 UI 整块不存在（`XiaomuDock` 的门控），所以它天然"隐蔽"：
 * 得先点开「快捷键一览」才看得到这一行。收起状态下屏幕上**一个字都不多**，
 * 不会出现一个观众可点的东西。
 *
 * ── 为什么存 localStorage ─────────────────────────────────────────
 * 与 `roundSync.FOLLOW_KEY`（跟随讲解机）、`wakeChannel` 的唤醒偏好同一套做法：
 * 这是**这台机器的偏好**，不是业务数据，不该进服务端、也不该跟着会话走。
 * 换台机器打开仍是默认关（对演示是好事）。
 */

/** 存这台机器的偏好；读不到或坏值一律当"关" */
export const KEYWORD_HINT_KEY = "mumai.hint.keywords";

/** 交给 `mumai:script-fire` 事件的下标 → 条目表下标（0 起，与一览表行号一一对应） */
export const KEYWORD_FIRE_EVENT = "mumai:script-fire";

/** 最小的存储接口（`Storage` 与测试用的假实现都满足） */
export type KeyValueStore = Pick<Storage, "getItem" | "setItem">;

/**
 * 关键词提示现在是否显示。
 *
 * 判据是**只有显式写过 `"on"` 才算开**（与 `roundSync.followEnabled()` 的
 * `!== "off"` 相反，这里默认必须是关的）：浏览器隐私模式、localStorage 被禁用、
 * 或者用户从没设置过 —— 三种情况都落在"关"这一边，正是要的默认。
 */
export function keywordHintVisible(storage?: KeyValueStore | null): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(KEYWORD_HINT_KEY) === "on";
  } catch {
    return false;
  }
}

/**
 * 写这台机器的偏好。
 *
 * 返回**写入后的真实状态**（而不是入参）：写不进去时（配额满 / 隐私模式）
 * 界面据它回退，不会出现"我点了打开、下次打开又没了"的静默欺骗。
 */
export function setKeywordHintVisible(visible: boolean, storage?: KeyValueStore | null): boolean {
  if (!storage) return false;
  try {
    storage.setItem(KEYWORD_HINT_KEY, visible ? "on" : "off");
    return visible;
  } catch {
    return false;
  }
}

/** 浏览器里的那份 localStorage；没有（SSR / 被禁用）就给 null，调用方按"关"处理 */
export function browserStore(): KeyValueStore | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}
