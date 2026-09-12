/**
 * 拿到 <Canvas> 的外层容器节点。
 *
 * R3F 的 Canvas 会把自己的 DOM 结构挂在传入的父节点下，所以
 * `gl.domElement.parentElement` 就是 mapDemo/index.tsx 里那个
 * CanvasWrapper（Demo2 原样：position:absolute; inset:0）。
 *
 * 转场的淡入淡出作用在这个节点上（CSS opacity），而不是 canvas 内部的
 * material.opacity —— 后者和开场时间线抢同一批 uniform，会互相覆盖；
 * 走 DOM 透明度既不影响 Demo2 的任何材质参数，也不用改 CanvasWrapper 的样式。
 */

import { useRef, type RefObject } from "react";

export function useCanvasRoot(): {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  getRoot: () => HTMLDivElement | null;
} {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const getRoot = () =>
    (canvasRef.current?.parentElement as HTMLDivElement | null) ?? null;

  return { canvasRef, getRoot };
}
