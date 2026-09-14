/**
 * 生成 alpha 映射曲线（.cube 风格但直接用 ffmpeg 的 geq + lutrgb）
 *
 * ── 思路转变（这是这一版的关键）──────────────────────────────────────
 * 前面一直在"量一个背景色 → 算它与每个像素的距离"，但背景本身有**棋盘两格**、
 * 有渐变、有压缩噪声，所以无论怎么调阈值，总有一格背景残留在 6~30 的 alpha 上，
 * 再被 GIF 二值化成不透明色块。
 *
 * 换一个**不依赖"准确背景色"**的判据：直接用**绿度**（归一化后的 g）。
 * 实测：背景绿度 0.427~0.435，蓝白主体 0.33~0.36 —— 两者差 0.07，中间就是边缘。
 * 把绿度线性映射成 alpha：
 *      alpha = clamp((T - greenness) / W, 0, 1)
 *   · T = 0.405（背景偏低的一侧，保证两格背景都在 T 之上 → alpha=0）
 *   · W = 0.05 （过渡带宽度，决定边缘羽化）
 * 这个判据对"背景色具体是多少"不敏感，只要求"背景比主体更绿"。
 *
 * 用法：node tools/video/抠绿幕.mjs <视频> [-o 出.gif] [--t 0.405] [--w 0.05] [--size 240] [--fps 12]
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const FF_LIST = [
  process.env.FFMPEG_PATH,
  "ffmpeg",
  "C:\\Users\\jklkj\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-9.0.1-full_build\\bin\\ffmpeg.exe",
].filter(Boolean);

function ffmpegBin() {
  for (const c of FF_LIST) {
    if (spawnSync(c, ["-version"], { encoding: "utf8" }).status === 0) return c;
  }
  throw new Error("找不到 ffmpeg");
}

export function keyGreenScreen(o) {
  const input = resolve(o.input);
  if (!existsSync(input)) throw new Error("输入不存在：" + input);
  const size = o.size || 240;
  const fps = o.fps || 12;
  const T = o.t ?? 0.405;          // 绿度阈值：高于它 = 背景
  const W = o.w ?? 0.05;           // 过渡带宽
  const out = resolve(o.out || input.replace(/\.[^.]+$/, "") + "-keyed.gif");
  const outWebm = o.outWebm ? resolve(o.outWebm) : out.replace(/\.gif$/, ".webm");
  const seqDir = input.replace(/\.[^.]+$/, "") + "-gseq";
  const f = ffmpegBin();

  mkdirSync(dirname(out), { recursive: true });
  mkdirSync(seqDir, { recursive: true });
  for (const n of readdirSync(seqDir)) if (/\.png$/i.test(n)) rmSync(resolve(seqDir, n), { force: true });

  /*
    geq 的表达式里**不能有逗号**：geq 用 `:` 分隔选项，`,` 会被当成选项分隔符。
    所以全部用 clip/abs/min/max 组合，不用 if(cond,a,b)。
    alpha = 255 * clip((T - greenness)/W, 0, 1)
    其中 greenness = g/(r+g+b)
  */
  const S = "(r(X,Y)+g(X,Y)+b(X,Y)+1e-6)";
  const green = `(g(X,Y)/${S})`;
  const aExpr = `255*clip((${T}-${green})/${W},0,1)`;
  const vf = [
    `fps=${fps}`,
    `scale=${size}:-1:flags=lanczos`,
    "format=rgba",
    `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='${aExpr}'`,
  ].join(",");

  const k1 = spawnSync(f, ["-y", "-v", "error", "-i", input, "-vf", vf, resolve(seqDir, "f%04d.png")], { encoding: "utf8" });
  if (k1.status !== 0) throw new Error("抠像失败：" + (k1.stderr || "").slice(0, 400));
  const frames = readdirSync(seqDir).filter((n) => /\.png$/i.test(n)).length;
  if (!frames) throw new Error("没产出帧");

  const vfGif = "split[a][b];[a]palettegen=reserve_transparent=1:stats_mode=diff[p];" +
    "[b][p]paletteuse=new=1:alpha_threshold=128:dither=none";
  const k2 = spawnSync(f, ["-y", "-v", "error", "-i", resolve(seqDir, "f%04d.png"),
    "-filter_complex", vfGif, "-loop", "0", out], { encoding: "utf8" });
  if (k2.status !== 0) throw new Error("GIF 编码失败：" + (k2.stderr || "").slice(0, 400));

  let webmOk = false;
  if (o.webm !== false) {
    const k3 = spawnSync(f, ["-y", "-v", "error", "-i", resolve(seqDir, "f%04d.png"),
      "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-auto-alt-ref", "0",
      "-alpha_mode", "1", "-b:v", "0", "-crf", "32", outWebm], { encoding: "utf8" });
    webmOk = k3.status === 0 && existsSync(outWebm);
  }

  if (!o.keepSeq) { try { rmSync(seqDir, { recursive: true, force: true }); } catch { /* */ } }
  return { method: "greenness", input, out, outWebm: webmOk ? outWebm : null,
    frames, size, fps, threshold: T, softWidth: W,
    bytes: statSync(out).size, webmBytes: webmOk ? statSync(outWebm).size : 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const argv = process.argv.slice(2);
  const WITH = ["-o", "--out", "--out-webm", "--size", "--fps", "--t", "--w", "--keep-seq"];
  const pos = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (WITH.includes(argv[i])) { i += 1; continue; }
    if (argv[i].startsWith("-")) continue;
    pos.push(argv[i]);
  }
  const val = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  if (!pos[0]) { console.error("用法：node 抠绿幕.mjs <视频> [-o 出.gif] [--t 0.405] [--w 0.05] [--size 240] [--fps 12]"); process.exit(2); }
  console.log(JSON.stringify(keyGreenScreen({
    input: pos[0],
    out: argv.includes("-o") ? argv[argv.indexOf("-o") + 1] : val("--out", undefined),
    outWebm: val("--out-webm", undefined),
    size: +val("--size", 240), fps: +val("--fps", 12),
    t: +val("--t", 0.405), w: +val("--w", 0.05),
    keepSeq: argv.includes("--keep-seq"),
  }), null, 1));
}
