/**
 * 量视频背景（三视频通用）：角落真值、棋盘周期、以及与主体的色距
 *
 * ── 为什么要量到这一步 ──────────────────────────────────────────────
 * 前面把背景当成"一个纯色"来抠，结果抠不干净 —— 因为背景其实是**棋盘格**
 * （think 实测周期约 43px），两个格子颜色都不等于我用的那个平均值。
 * 而且视频有暗角/压缩噪点，背景色在画面上并不均匀。
 * 所以这里把三件事一次量清楚：
 *   ① 四个角各自的颜色（远离主体，是真背景）
 *   ② 沿一条边取一行，看交替周期（判断是不是棋盘、周期多少）
 *   ③ 背景色在画面上的漂移幅度（决定 similarity 要给多大余量）
 *
 * 用法：node tools/video/量背景2.mjs <视频> [...]
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const FF = [
  process.env.FFMPEG_PATH,
  "ffmpeg",
  "C:\\Users\\jklkj\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-9.0.1-full_build\\bin\\ffmpeg.exe",
].filter(Boolean).find((c) => spawnSync(c, ["-version"], { encoding: "utf8" }).status === 0);

/** 取某一帧的整幅 rgb24 */
function frameRgb(input, n, w, h) {
  const r = spawnSync(FF, ["-v", "error", "-i", input, "-vf", `select=eq(n\\,${n})`,
    "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { encoding: "buffer", maxBuffer: 64 << 20 });
  if (!r.stdout || r.stdout.length < w * h * 3) return null;
  return r.stdout;
}
function size(input) {
  const r = spawnSync(FF, ["-v", "error", "-i", input, "-f", "null", "-"], { encoding: "utf8" });
  const m = /(\d{2,5})x(\d{2,5})/.exec(r.stderr || "");
  return m ? { w: +m[1], h: +m[2] } : null;
}

for (const raw of process.argv.slice(2)) {
  const f = resolve(raw);
  if (!existsSync(f)) { console.log("跳过：" + f); continue; }
  const s = size(f) || { w: 720, h: 720 };
  const buf = frameRgb(f, 12, s.w, s.h);
  if (!buf) { console.log("取帧失败：" + f); continue; }
  const at = (x, y) => { const i = (y * s.w + x) * 3; return [buf[i], buf[i + 1], buf[i + 2]]; };
  const k = (p) => `${p[0]},${p[1]},${p[2]}`;

  /* ① 四个角各取 16×16 的平均，且分别看"最亮格子 / 最暗格子" */
  const cornerStats = [];
  for (const [name, cx, cy] of [["左上", 8, 8], ["右上", s.w - 24, 8], ["左下", 8, s.h - 24], ["右下", s.w - 24, s.h - 24]]) {
    let mn = [255, 255, 255], mx = [0, 0, 0], sum = [0, 0, 0], n = 0;
    for (let y = cy; y < cy + 16; y += 1) for (let x = cx; x < cx + 16; x += 1) {
      const p = at(x, y); n += 1;
      for (let c = 0; c < 3; c += 1) { sum[c] += p[c]; if (p[c] < mn[c]) mn[c] = p[c]; if (p[c] > mx[c]) mx[c] = p[c]; }
    }
    cornerStats.push({ name, avg: sum.map((v) => Math.round(v / n)), dark: mn, light: mx });
  }

  /* ② 顶部一行（y=6）取 120 像素，看交替 */
  const row = [];
  for (let x = 4; x < 124; x += 1) row.push(k(at(x, 6)));
  const runs = []; let cur = row[0], len = 1;
  for (let i = 1; i < row.length; i += 1) { if (row[i] === cur) len += 1; else { runs.push({ c: cur, n: len }); cur = row[i]; len = 1; } }
  runs.push({ c: cur, n: len });
  const segs = runs.map((r) => r.n).filter((n) => n >= 2);

  /* ③ 背景漂移：四角平均的通道极差 */
  const drift = [0, 1, 2].map((c) => {
    const vs = cornerStats.map((s2) => s2.avg[c]);
    return Math.max(...vs) - Math.min(...vs);
  });

  console.log("── " + f.split(/[\\/]/).pop() + "  " + s.w + "×" + s.h);
  for (const c of cornerStats) console.log(`   ${c.name}角  平均 rgb(${c.avg.join(",")})  最暗 rgb(${c.dark.join(",")})  最亮 rgb(${c.light.join(",")})`);
  console.log("   背景四角漂移（通道极差）：" + drift.join(" / ") + " → " + (Math.max(...drift) > 8 ? "**背景不均匀，similarity 要留余量**" : "基本均匀"));
  console.log("   顶部一行交替段：" + runs.slice(0, 8).map((r) => r.c + "×" + r.n).join("  "));
  if (segs.length >= 2) {
    const avg = segs.reduce((a, c) => a + c, 0) / segs.length;
    console.log("   平均段长 ≈ " + avg.toFixed(1) + " px → " + (avg >= 4 ? "**棋盘周期约 " + (avg * 2).toFixed(0) + " px**" : "近似纯色/噪点"));
  }
}
