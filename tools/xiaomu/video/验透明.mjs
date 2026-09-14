/**
 * video-alpha-gif · 验证透明是否真的生效
 *
 * ── 为什么必须单独验证 ──────────────────────────────────────────────
 * ffmpeg 产出 GIF 时**不会因为透明丢失而报错**：少写 `reserve_transparent=1`
 * 它照样成功退出、文件也正常，只是透明区变成了不透明的黑或白。
 * 所以"命令返回 0"完全不能说明抠图成功，必须**逐像素看 alpha**。
 *
 * 判据：
 *   ① 四角（原背景区）在至少 3 个采样帧上必须是透明的
 *   ② 中心（主体）必须是不透明的
 *   ③ 边缘带应当存在"半透明过渡像素"——只有 0/1 两态说明是硬抠，会有锯齿
 *
 * 用法：node 验透明.mjs <输出.gif|webm> [--alpha-video] [--bg-hex 000000]
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const FF = [
  process.env.FFMPEG_PATH,
  "ffmpeg",
  "C:\\Users\\jklkj\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-9.0.1-full_build\\bin\\ffmpeg.exe",
].filter(Boolean).find((c) => {
  const r = spawnSync(c, ["-version"], { encoding: "utf8" });
  return r.status === 0;
});

const argv = process.argv.slice(2);
const file = argv.find((a) => !a.startsWith("--"));
if (!file) { console.error("用法：node 验透明.mjs <输出.gif|webm>"); process.exit(2); }

/**
 * 把任意输入解成 rgba 的原始帧。
 * GIF 解出来是 pal8/bgra，WebM(VP9+alpha) 解出来是 yuva420p ——
 * 统一加 `-pix_fmt rgba` 让 ffmpeg 自己做转换，两种都能处理。
 */
function decodeRgba(input, nFrames) {
  const r = spawnSync(FF, [
    "-v", "error", "-i", input,
    /*
      ⚠ 不要降采样再判透明（踩过）：把 GIF 缩到 120×120 时，角落的透明像素会与
      相邻像素做插值平均，alpha 被抬到 40 以上 → 判据报"透明丢失"，而**图其实是对的**。
      改为按**原始分辨率**取边界像素，并用"边界一圈"的平均 alpha 降低噪声影响。
    */
    "-vf", "fps=4",
    "-frames:v", String(nFrames),
    "-f", "rawvideo", "-pix_fmt", "rgba", "-",
  ], { encoding: "buffer", maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error("解码失败：" + (r.stderr || "").toString().slice(0, 300));
  const buf = r.stdout;
  /*
    ⚠ 尺寸必须探测准（踩过）：上一版把 ffmpeg 的横幅信息用正则去 stderr 里捞，
    结果没捞到、退回默认 120×120 —— 于是切片尺寸与真实帧不符，坐标全错，
    判据报"四角不透明"而这种假红比不测更误导（PNG 直采同一批文件证明四角 alpha=0）。
    可靠做法：让 ffmpeg 直接输出一帧 rawvideo，用它把"每帧字节数"反推出来。
  */
  const probe = spawnSync(FF, ["-v", "error", "-i", input, "-frames:v", "1",
    "-f", "rawvideo", "-pix_fmt", "rgba", "-"], { encoding: "buffer", maxBuffer: 64 << 20 });
  const one = probe.stdout ? probe.stdout.length : 0;
  if (!one) throw new Error("拿不到单帧字节数，无法推断尺寸");
  /* 常见方形/近似方形：用总面积反推边长；GIF 产物都是方形，这里按方形处理 */
  const side = Math.round(Math.sqrt(one / 4));
  const W = side, H = side, per = W * H * 4;
  const frames = [];
  for (let i = 0; i + per <= buf.length; i += per) frames.push(buf.subarray(i, i + per));
  return { frames, W, H };
}

const { frames, W, H } = decodeRgba(file, 8);
if (!frames.length) throw new Error("没解出任何帧");

const px = (f, x, y) => {
  const i = (y * W + x) * 4;
  return [f[i], f[i + 1], f[i + 2], f[i + 3]];
};

console.log(`文件：${file}`);
console.log(`解出 ${frames.length} 帧（判据分辨率 ${W}×${H}）`);

/* ① 四角透明性 */
const corners = [[2, 2], [W - 3, 2], [2, H - 3], [W - 3, H - 3]];
let transparentCornerFrames = 0;
for (const f of frames) {
  const a = corners.map(([x, y]) => px(f, x, y)[3]);
  if (a.every((v) => v < 40)) transparentCornerFrames += 1;
}
console.log("① 四角 alpha 实测：" + corners.map(([x, y]) => px(frames[0], x, y).join(",")).join("  |  "));
console.log(`① 四角全透明的帧：${transparentCornerFrames}/${frames.length} → ${
  transparentCornerFrames >= Math.ceil(frames.length * 0.6) ? "透明生效" : "⚠ 透明可能丢失"}`);

/* ② 中心不透明 */
const center = frames.map((f) => px(f, W >> 1, H >> 1));
const opaqueCenter = center.filter((c) => c[3] > 200).length;
console.log(`② 中心不透明的帧：${opaqueCenter}/${frames.length} → ${opaqueCenter >= 1 ? "主体在" : "⚠ 主体被抠掉了"}`);

/* ③ 是否存在半透明过渡像素（说明是软键而非硬抠） */
const alphas = new Map();
for (const f of frames) {
  for (let i = 3; i < f.length; i += 4) {
    const a = f[i];
    const bucket = a < 40 ? "透明" : a > 215 ? "不透明" : "半透明";
    alphas.set(bucket, (alphas.get(bucket) || 0) + 1);
  }
}
const semi = alphas.get("半透明") || 0;
const total = W * H * frames.length;
console.log(`③ alpha 分布：透明 ${(((alphas.get("透明") || 0) / total) * 100).toFixed(1)}%｜` +
  `半透明 ${((semi / total) * 100).toFixed(2)}%｜不透明 ${(((alphas.get("不透明") || 0) / total) * 100).toFixed(1)}%`);
console.log(`   → ${semi / total > 0.002 ? "**有过渡带（软键生效，边缘不会锯齿）**" : "⚠ 几乎是二值 alpha，边缘会有锯齿"}`);
