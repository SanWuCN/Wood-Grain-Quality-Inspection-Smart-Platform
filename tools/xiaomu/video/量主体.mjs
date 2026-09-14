/**
 * 量视频里**主体的几何**（球心与半径，归一化）
 *
 * ── 为什么必须量（踩过）─────────────────────────────────────────────
 * 抠像用了一个"球半径之外强制全透"的空间约束，圆心/半径是照**待机参考图**写死的
 * （0.5, 0.5, 0.42）。但视频里的球**位置与大小并不一样**（新素材那颗偏下、还小一圈），
 * 于是约束圈对不上 —— 圈外那块背景没被强制透明，成品上就露出一块**绿色补丁**。
 * 结论：空间约束的几何**必须从每个视频自己量**。
 *
 * 量法：逐行扫描"非背景"像素（背景色由四角平均得到），
 * 取包围盒 → 圆心 = 包围盒中心，半径 = max(宽,高)/2。
 *
 * 用法：node tools/video/量主体.mjs <视频> [...]
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const FF = [
  process.env.FFMPEG_PATH,
  "ffmpeg",
  "C:\\Users\\jklkj\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-9.0.1-full_build\\bin\\ffmpeg.exe",
].filter(Boolean).find((c) => spawnSync(c, ["-version"], { encoding: "utf8" }).status === 0);

for (const raw of process.argv.slice(2)) {
  const input = resolve(raw);
  if (!existsSync(input)) { console.log("跳过：" + input); continue; }

  const head = spawnSync(FF, ["-v", "error", "-i", input, "-frames:v", "1",
    "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { encoding: "buffer", maxBuffer: 64 << 20 });
  const buf = head.stdout;
  if (!buf || !buf.length) { console.log("取帧失败：" + input); continue; }
  const px4 = buf.length / 4;          // rgba 时按 4 通道；这里用 rgb24 所以是 /3
  const side = Math.round(Math.sqrt(buf.length / 3));
  const W = side, H = side;
  const at = (x, y) => { const i = (y * W + x) * 3; return [buf[i], buf[i + 1], buf[i + 2]]; };
  void px4;

  /* 背景色 = 四角 10×10 平均 */
  let bs = [0, 0, 0], n = 0;
  for (const [cx, cy] of [[4, 4], [W - 14, 4], [4, H - 14], [W - 14, H - 14]]) {
    for (let y = cy; y < cy + 10; y += 1) for (let x = cx; x < cx + 10; x += 1) {
      const p = at(x, y); bs = [bs[0] + p[0], bs[1] + p[1], bs[2] + p[2]]; n += 1;
    }
  }
  const bg = bs.map((v) => Math.round(v / n));
  /*
    ⚠ 判据用**绿度**而不是"距背景色距离"（踩过）：后者太松，背景里的压缩噪声
    就足以越过阈值，包围盒直接铺满整幅（实测给出 r=0.499、明显是噪声撑出来的）。
    这套素材的背景是绿色，主体是蓝白球 —— 用归一化后的"绿通道优势度"分离最稳：
        绿度 = g/(r+g+b)；背景 ≈ 0.43，蓝白主体 ≈ 0.33~0.36
  */
  const greenness = (p) => p[1] / (p[0] + p[1] + p[2] + 1e-6);
  const bgGreen = greenness(bg);
  const isSubj = (p) => greenness(p) < bgGreen - 0.04;

  let minX = W, maxX = -1, minY = H, maxY = -1, cnt = 0;
  for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) {
    if (!isSubj(at(x, y))) continue;
    cnt += 1;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  if (maxX < 0) { console.log("没找到主体：" + input); continue; }
  const cx = (minX + maxX) / 2 / W, cy = (minY + maxY) / 2 / H;
  const r = Math.max(maxX - minX + 1, maxY - minY + 1) / 2 / Math.max(W, H);
  console.log("── " + input.split(/[\\/]/).pop() + "  " + W + "×" + H);
  console.log("   背景色 rgb(" + bg.join(",") + ")　主体像素占比 " + ((cnt * 4) / (W * H) * 100).toFixed(1) + "%");
  console.log("   包围盒 x[" + minX + "," + maxX + "] y[" + minY + "," + maxY + "]");
  console.log("   → 建议参数：--cx " + cx.toFixed(3) + " --cy " + cy.toFixed(3) + " --r " + r.toFixed(3));
}
