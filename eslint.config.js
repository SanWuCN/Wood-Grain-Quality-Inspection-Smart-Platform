import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig([
  globalIgnores([
    "dist",
    // 构建期素材缓存（.gitignore 已排除）：放的是第三方素材原包解压结果，
    // 不是本项目源码，lint 不应把它当源码解析。
    ".cache/**",
    /*
      临时验证脚本目录（.gitignore 已排除）：截图、探针、一次性补丁都落在这里，
      里面既有 .mjs 也有随手写的不完整片段。lint 把它当源码解析会把
      `npm run lint` 变成一条永远失败的命令 —— 而 PRD 要求它作为验证入口可用。
      这些文件本来就不进版本库，忽略它不影响任何交付物。
    */
    "tmp-shot/**",
    "src/components/**",
    "src/hooks/**",
    "src/pages/Demo0/**",
    "src/pages/Demo1/**",
    "src/pages/Demo2/**",
    "src/pages/Demo3/**",
    "src/pages/Index/**",
    // 直接沿用 sc-datav Demo2 的地图源码（逐字迁移，只换了数据与接线）。
    // 与上游 Demo2 一样排除在 lint 之外：那里的写法是上游风格，
    // 为了保持与原版一致，不做 prefer-const / 依赖数组之类的本地改写。
    "src/pages/MumaiDashboard/mapDemo/**",
  ]),
  {
    files: ["**/*.{ts,tsx}"],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs["recommended-latest"],
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
  },
  {
    /*
      形象方案展台（src/lab/）的契约实现需要"签名里必须有、但这一版用不到"的参数：
      `LabVariant.create(host, opts, stage)` 是全部方案的**同一个**调用点，
      老方法版（09）不需要 `stage`，但少写一个参数 JS 不报错、只会静默收到
      `undefined`（契约测试 variants.test.ts 正盯着 `create.length === 3`）。
      所以这些参数必须以 `_` 前缀保留下来。
      ⚠ 只对 src/lab 放宽，不是全局 —— 产品代码里未使用的参数仍然应当报错。
    */
    files: ["src/lab/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // context 文件按惯例同时导出 Hook 与它的类型/常量，
    // 这类文件本来就不能做 fast refresh，关掉这条规则即可。
    files: ["src/pages/MumaiDashboard/context.tsx", "src/pages/MumaiDashboard/design.ts"],
    rules: { "react-refresh/only-export-components": "off" },
  },
  {
    /*
      UI 素材 v2.0（2026-09-13）接入后新增的两个模块，与 context.tsx 同一情形：
      Icon / Illustration 组件与它们配套的常量、映射表住在同一个文件里
      （PRD §3 / §5 要求「页面通过资源映射访问文件」，映射表就是接口的一部分）。
      这些模块是站点级基础设施，不是需要热更的页面组件，
      因此和 context.tsx 一样关掉 fast-refresh 这条规则，而不是把映射表拆散。
    */
    files: [
      "src/pages/MumaiDashboard/icons.tsx",
      "src/pages/MumaiDashboard/illustrations.tsx",
    ],
    rules: { "react-refresh/only-export-components": "off" },
  },
]);
