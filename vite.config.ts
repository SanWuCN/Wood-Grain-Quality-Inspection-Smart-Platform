import { defineConfig, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";
import { relative, resolve } from "node:path";

/**
 * 给代理加错误处理 —— **这是必须的，不是可选优化**。
 *
 * 实测踩过：被代理的服务不在时，代理层的连接错误会以 `Error: read ECONNRESET`
 * 形式**冒到进程级**，把整个 vite dev server 打挂
 * （日志里能看到 `Emitted 'error' event on Socket instance` 然后进程退出）。
 * 表现极具误导性：页面突然打不开，而真正的原因是"某个后端没起"。
 *
 * 加上它之后，后端不在只会让**那一个请求**返回 502 并打印一行日志，页面照常可用。
 *
 * 参数类型直接取 vite 的 `ProxyOptions["configure"]`，不自己手写结构类型 ——
 * 手写的那版只声明了 `on`，与真实的 `ProxyServer` 不兼容，`tsc -b` 会报
 * TS2769（每个代理一条）。注意 `tsc -b` 覆盖 vite.config.ts，
 * 而平时只跑 `tsc -p tsconfig.app.json` 是看不到这个错的。
 */
function attachProxyErrorHandler(name: string): NonNullable<ProxyOptions["configure"]> {
  return (proxy) => {
    proxy.on("error", (error, _req, res) => {
      console.warn(`[proxy] ${name}不可用：${error.message}`);
      // res 是 ServerResponse（HTTP）或 Socket（WebSocket），两种都要照顾
      const target = res as unknown as {
        writeHead?: (code: number, headers?: Record<string, string>) => void;
        end?: (body?: string) => void;
        destroy?: () => void;
        writable?: boolean;
      };
      if (typeof target.writeHead === "function" && target.writable !== false) {
        target.writeHead(502, { "content-type": "application/json; charset=utf-8" });
        target.end?.(
          JSON.stringify({ code: "UPSTREAM_DOWN", message: `${name}不可用`, fieldErrors: [], retryable: true }),
        );
      } else if (typeof target.destroy === "function") {
        target.destroy();
      }
    });
  };
}

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
     * 开发期把共享服务代理到同源。
     *
     * 页面在 5173、服务在 8000，如果不代理，前端就得写死
     * `http://<这台机器的IP>:8000`，跨电脑演示时那个地址是错的
     * （PRD §5.3：四人的 localhost 不是同一台服务）。
     * 走同源相对路径 `/api`、`/ws` 之后，谁访问页面，请求就自动打到
     * 「提供这个页面的那台机器」上 —— 前提是页面本身也从那台机器的 Vite 提供。
     */
    proxy: {
      "/api": {
        target: process.env.MUMAI_API ?? "http://localhost:8000",
        changeOrigin: true,
      },
      "/ws": {
        target: process.env.MUMAI_API ?? "http://localhost:8000",
        ws: true,
        changeOrigin: true,
      },
      /**
       * 本地语音通道 —— **全部走同源，前端不认识模型的端口**。
       *
       * 为什么不直连 `127.0.0.1:8770`：页面若是 https，浏览器会拦 `ws://`
       * （混合内容），直连必然失败；走同源 `/voice-*` 则 https→wss、
       * http→ws 自动匹配，开发与部署同一套代码。
       *
       * 这两条指向**桥接层**（voice-module/bridge，默认 8780），
       * 由它去连本机的 Python 识别服务（8770）并管它的生命周期。
       *
       * `/voice-asr` 与 `/voice-wake` 是**两条独立连接，不能合并**：
       *   /voice-asr   一次连接 = 一句话，服务端定稿后主动关
       *   /voice-wake  长连接一直在听（唤醒用）
       * 合并会出现"唤醒听着听着连接就没了"。
       */
      "/voice-asr": {
        target: process.env.MUMAI_VOICE ?? "ws://127.0.0.1:8780",
        ws: true,
        rewrite: () => "/voice-asr",
        configure: attachProxyErrorHandler("语音桥接层"),
      },
      "/voice-wake": {
        target: process.env.MUMAI_VOICE ?? "ws://127.0.0.1:8780",
        ws: true,
        rewrite: () => "/voice-wake",
        configure: attachProxyErrorHandler("语音桥接层（唤醒）"),
      },
      "/voice-api": {
        target: process.env.MUMAI_VOICE_HTTP ?? "http://127.0.0.1:8780",
        changeOrigin: true,
        configure: attachProxyErrorHandler("语音桥接层"),
      },
    },

    /**
     * 只 watch 真正参与构建的东西 —— 白名单，不是黑名单。
     *
     * 这个 dev server 已经被 EBUSY 搞挂四次，每次肇事文件都不同：
     *   1. `.tmp-*.tmpdir`（Vite 依赖预构建的临时目录）
     *   2. `~RFxxxx.TMP`（Word/WPS 打开 CSS 时生成的锁文件）
     *   3. `docs/design/视觉设计规范-v1.1.md`（编辑器打开一份文档）
     *   4. `tmp-docx/x/[Content_Types].xml`（解压 docx 的临时目录）
     *
     * 每补一个通配符，下一个新目录又会踩中。根因是 Vite 默认 watch
     * **整个项目根目录**，而 Windows 上只要文件被任何进程锁住，chokidar 就抛
     * EBUSY，Vite 又不捕获它 —— Node 进程直接退出，页面上就是「服务器没了」。
     *
     * 所以改成白名单：只有 src/ 与 public/ 需要 HMR，加上根目录少数几个
     * 配置与入口文件。其余一律不 watch —— 从此在项目根目录里解压什么、
     * 生成什么、用什么编辑器打开什么，都不会再把它弄崩。
     */
    watch: {
      ignored: (watchPath: string) => {
        const rel = relative(process.cwd(), watchPath);
        // 项目根本身必须保留，否则整棵树都不 watch 了
        if (!rel) return false;
        const head = rel.split(/[\\/]/)[0];
        if (head === "src" || head === "public") return false;
        // 根目录下改了需要触发的配置与入口文件
        if (
          /^(index\.html|package\.json|pnpm-lock\.yaml|vite\.config\.[tj]s|tsconfig.*\.json|eslint\.config\.js|\.env.*)$/.test(
            rel,
          )
        ) {
          return false;
        }
        return true;
      },
    },
  },
});
