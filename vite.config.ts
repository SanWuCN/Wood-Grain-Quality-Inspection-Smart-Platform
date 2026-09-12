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
    // Windows 上依赖预构建 / 编辑器会写临时文件，chokidar 去 watch 这些文件时
    // 会偶发 EBUSY 直接把 dev server 打挂。它们对业务没有任何意义，直接忽略。
    // 形如：.tmp-foo.tsx.1234.abc.tmpdir/foo.tsx.tmp、.geometry.ts.1234.xxx.tmpdir/
    watch: {
      ignored: [
        "**/*.tmpdir/**",
        "**/.tmp-*",
        "**/.tmp-*/**",
        "**/.cache/**",
        "**/tmp-shot/**",
        "**/dist/**",
      ],
    },
  },
});
