/**
 * 展台单文件打包配置（只用于 `npm run build:lab`，不影响产品构建）
 *
 * ── 为什么不直接改 vite.config.ts ───────────────────────────────────
 * 产品构建（`npm run build`）走的是 `tsc -b && vite build`，入口是 index.html，
 * 产物进 `dist/`，8000 的静态服务吃它。展台是**选型工装**，它的产物不该混进
 * 产品包 —— 混进去的后果是这个只有 9 个球的页面被打进演示包，
 * 而 PRD 里根本没有这一页。所以单开一份配置、单开一个产物目录。
 *
 * ── 为什么要 `inlineDynamicImports` + 相对 base ────────────────────
 * 目标是**一个 html 文件**：把 js/css 全部内联进去，这样它可以被丢到任何地方
 * （本地文件、U 盘、同事的静态服务器）直接打开，不需要 node_modules、不需要 5173。
 * `base: "./"` 保证万一有没内联干净的资源引用也不会指到绝对路径上。
 */
import { defineConfig } from "vite";

export default defineConfig({
  // 只从仓库根找 xiaomu-lab.html，不扫 index.html（那是产品入口）
  root: process.cwd(),
  // ⚠ 不要把 public/ 整个拷进产物：展台是单文件、自带 three，
  //    不需要仓库的 voice/model/fonts（那是产品页面的资源，几百 MB）。
  publicDir: false,
  base: "./",
  build: {
    outDir: "dist-lab",
    emptyOutDir: true,
    // 单文件产物不做代码分割：动态 import 会把 js 拆成多块，内联脚本就失效了
    rollupOptions: {
      input: "xiaomu-lab.html",
      output: { inlineDynamicImports: true },
    },
    /*
      ⚠ 不要写 `minify: "esbuild"`：本仓库是 vite@8 + rolldown，
      而 `esbuild` 并没有被安装（只有 rolldown 自带的那套）。显式指定会让
      `vite build` 直接以 `Cannot find package 'esbuild'` 失败 —— 而这个配置
      本身完全没问题，是"多写一句优化选项"引进来的。压缩走默认即可。
    */
    assetsInlineLimit: 1024 * 1024,
  },
});
