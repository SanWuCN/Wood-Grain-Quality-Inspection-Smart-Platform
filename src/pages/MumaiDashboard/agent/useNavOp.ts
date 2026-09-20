/**
 * `useNavOp` —— 页面监听「跳转之后的那一下」（见 `navOp.ts` 的词表与时序说明）
 *
 * 用法（页面里一行）：
 *   useNavOp("archive-verify", run);        // ⑱ 跳到归档页后自动跑一次交付文件校验
 *
 * 两条口径：
 *   · **只领一次**：挂载时补领 + 事件领取都走 `takePendingNavOp()`，领到即清空，
 *     所以不会"事件一次 + 挂载补一次"双跑（双跑的后果是校验跑两遍、日志两条）；
 *   · **handler 用 ref 存**：调用方传进来的多半是内联箭头函数，把它写进依赖会让
 *     effect 每次渲染都重挂、进而可能重复领取；这里只认 `op` 变不变。
 */
import { useEffect, useRef } from "react";

import { NAV_OP_EVENT, takePendingNavOp, type NavOp } from "./navOp";

export function useNavOp(op: NavOp, handler: () => void): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    /* 跳转先到、页面后挂：补领一次 */
    if (takePendingNavOp(op)) {
      handlerRef.current();
      return undefined;
    }
    const onEvent = (event: Event) => {
      const detail = (event as CustomEvent<{ op?: string }>).detail;
      if (detail?.op !== op) return;
      if (!takePendingNavOp(op)) return; // 已被领走（例如挂载时补领过），不重复执行
      handlerRef.current();
    };
    window.addEventListener(NAV_OP_EVENT, onEvent);
    return () => window.removeEventListener(NAV_OP_EVENT, onEvent);
  }, [op]);
}
