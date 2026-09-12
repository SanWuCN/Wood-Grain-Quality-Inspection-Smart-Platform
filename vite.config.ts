import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: "/",
  resolve: {
    alias: {
      "@": resolve("src"),
    },
  },
  server: {
    /**
     * 端口固定成 5173（Vite 默认），不要再各处写不同的数字。
     *
     * 之前 `start-demo.cmd` 提示 5173、而开发时实际用 `--port 5199` 起，
     * 两处不一致，照着脚本点会打不开。
     * 现在以这里为唯一来源：脚本、工具脚本、文档全部对齐 5173。
     */
    port: 5173,
    host: true,
    // 端口被占用时直接失败，而不是悄悄换成 5174 让所有文档失效
    strictPort: true,

    /**
     * 忽略编辑器 / 构建器写出的临时文件。
     *
     * 这不是「优化」，是**必须的**：Windows 上这些文件被占用时 chokidar
     * 会抛 EBUSY，而 Vite 没有捕获它 —— 整个 dev server 进程直接退出。
     * 已经因此崩过两次，第二次是被 Word 打开的 CSS 生成的 `~RFxxxx.TMP` 锁文件搞挂的。
     *
     * 覆盖这几类：
     *   .tmp-xxx.tsx.1234.abc.tmpdir/   Vite 依赖预构建的临时目录
     *   ~RF1d059e6c.TMP                 编辑器（Word/WPS 等）打开文件时的锁文件
     *   ~$document.docx                 同上，Office 系列的锁文件
     *   *.swp / *~                      Vim / Emacs 的交换文件
     */
    watch: {
      ignored: [
        "**/*.tmpdir/**",
        "**/.tmp-*",
        "**/.tmp-*/**",
        "**/*.TMP",
        "**/*.tmp",
        "**/~RF*",
        "**/~$*",
        "**/*.swp",
        "**/*~",
        "**/.cache/**",
        "**/tmp-shot/**",
        "**/dist/**",
      ],
    },
  },
});
