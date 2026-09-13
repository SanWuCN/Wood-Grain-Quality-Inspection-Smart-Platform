/**
 * 极简图片加载 hook —— 地图里的贴图一律用它，**不要**用 drei 的 useTexture。
 *
 * 为什么：useTexture 走 suspend-react，加载期间会抛 Promise 让最近的 <Suspense>
 * 挂起。只要有一个子组件的加载永远不 resolve，整个边界就永远不 commit ——
 * 现象是「地图整块消失，只剩 Canvas 自己的背景」，而且**完全静默**
 * （没有报错、没有异常，只是画不出来）。这一条坑掉了很多轮排查。
 *
 * 改成普通 state：加载完成前返回 null，调用方先渲染一个占位颜色，
 * 加载完成后再换成真贴图。永远不会把地图卡死。
 */

import { useEffect, useState } from "react";

export function useImageState(url: string) {
  const [result, setResult] = useState<{
    url: string;
    image: HTMLImageElement | null;
    settled: boolean;
  }>({ url, image: null, settled: false });

  useEffect(() => {
    let alive = true;
    const el = new Image();
    el.decoding = "async";
    const finish = (image: HTMLImageElement | null) => {
      if (!alive) return;
      alive = false;
      window.clearTimeout(timeout);
      setResult({ url, image, settled: true });
    };
    // A missing image falls back to plain map materials instead of an endless loader.
    const timeout = window.setTimeout(() => finish(null), 12000);
    el.onload = () => finish(el);
    el.onerror = () => finish(null);
    el.src = url;
    return () => {
      alive = false;
      window.clearTimeout(timeout);
      el.onload = null;
      el.onerror = null;
    };
  }, [url]);

  return result.url === url ? result : { url, image: null, settled: false };
}

export function useImage(url: string): HTMLImageElement | null {
  return useImageState(url).image;
}
