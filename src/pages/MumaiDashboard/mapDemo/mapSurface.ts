/**
 * 地表贴图（纯贴纸路线）
 *
 * 为什么不用「光照 + 法线贴图」那条路：
 *   地图整体绕 X 轴 -90° 旋转后顶面法线朝上（世界 +Y），而 Demo2 唯一的方向光
 *   在 [0, 50, -50]，是从地图**后下方**打过来的。Demo2 只有四川一张图、顶面又贴了
 *   高亮卫星影像，所以看不出问题；换成中国 / 上海两张真地形后，顶面直接吃不到光，
 *   缩到总览就是一片死黑。
 *
 * 所以改成把整幅地图**烤成一张贴图**，顶面用不受光照影响的 MeshBasicMaterial：
 *   1. DEM 高程 → 冷色明暗（低频，缩到总览仍能看出地势）
 *   2. 局部对比拉伸 → 上海这种几乎全是平原的地图也能看出起伏
 *   3. 行政边界 → 亮青描边 + 外发光，总览时也能分辨省 / 区
 *   4. 中心微亮、边缘微暗的渐晕 → 让平面地图有体积
 *
 * 贴图与几何严格对齐：几何的 UV 由「投影后世界坐标 → 线性 0..1」得到
 * （见 shape.tsx），而 d3 的 geoMercator 与 build-terrain.mjs 的 Web Mercator
 * 在裁剪范围内是同一个线性变换，所以这里的经纬度 → 像素映射与 UV 完全一致。
 */

import { CanvasTexture, SRGBColorSpace, type Texture } from "three";

export interface MapSurfaceOptions {
  /** DEM 彩色地形图（已按经纬度包围盒裁好，见 tools/build-terrain.mjs） */
  surface: CanvasImageSource & { width: number; height: number };
  /** 输出长边上限 */
  maxSize?: number;
  /** 低地颜色 */
  lowColor?: [number, number, number];
  /** 高地颜色 */
  highColor?: [number, number, number];
}

/** 取亮度分位数，用来做局部对比拉伸（避免整体偏暗或整体过曝） */
function luminanceRange(data: Uint8ClampedArray, lowPct = 0.02, highPct = 0.985) {
  const hist = new Uint32Array(256);
  let count = 0;
  for (let i = 0; i < data.length; i += 4) {
    const l = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
    hist[l | 0]++;
    count++;
  }
  let acc = 0;
  let lo = 0;
  let hi = 255;
  const loTarget = count * lowPct;
  const hiTarget = count * highPct;
  for (let i = 0; i < 256; i++) {
    acc += hist[i];
    if (acc >= loTarget) {
      lo = i;
      break;
    }
  }
  acc = 0;
  for (let i = 0; i < 256; i++) {
    acc += hist[i];
    if (acc >= hiTarget) {
      hi = i;
      break;
    }
  }
  if (hi - lo < 24) hi = Math.min(255, lo + 24);
  return { lo, hi };
}

export function createMapSurfaceTexture(options: MapSurfaceOptions): Texture {
  const {
    surface,
    maxSize = 2048,
    // 《视觉设计规范 v1.0》§5.2：地图主体 #526B80（冷灰蓝 / 金属蓝灰）、
    // 地图轮廓 #63CBFF。这里把主体色当作色带中值向两端拉开明暗，
    // 既守住规范的中性冷灰蓝基调，又保留地形起伏的可读性。
    lowColor = [45, 63, 79],
    highColor = [150, 178, 200],


  } = options;

  const srcW = surface.width;
  const srcH = surface.height;
  const scale = Math.min(1, maxSize / Math.max(srcW, srcH));
  const w = Math.max(2, Math.round(srcW * scale));
  const h = Math.max(2, Math.round(srcH * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(surface, 0, 0, w, h);

  // 1. 高程 → 冷色明暗。DEM 原图低地几乎和海洋同色，直接贴会比背景还暗，
  //    所以先按分位数拉伸，再映射到「深蓝 → 冰白」这条冷色带。
  const image = ctx.getImageData(0, 0, w, h);
  const px = image.data;
  const { lo, hi } = luminanceRange(px);
  const span = hi - lo;
  for (let i = 0; i < px.length; i += 4) {
    const l = (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000;
    let t = (l - lo) / span;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    // 轻微 gamma，让低海拔平原之间也能拉开层次
    t = Math.pow(t, 0.78);
    px[i] = lowColor[0] + (highColor[0] - lowColor[0]) * t;
    px[i + 1] = lowColor[1] + (highColor[1] - lowColor[1]) * t;
    px[i + 2] = lowColor[2] + (highColor[2] - lowColor[2]) * t;
  }
  ctx.putImageData(image, 0, 0);

  // 2. 中心微亮的渐晕：给平面地图一点体积
  const vignette = ctx.createRadialGradient(
    w / 2,
    h / 2,
    0,
    w / 2,
    h / 2,
    Math.hypot(w, h) / 2,
  );
  vignette.addColorStop(0, "rgba(150,205,250,0.16)");
  vignette.addColorStop(0.6, "rgba(90,150,220,0.04)");
  vignette.addColorStop(1, "rgba(0,0,0,0.16)");
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, w, h);

  /*
   * 行政边界**不再烤进贴图**（⑥）。
   *
   * 这里原来画两层：一层 rgba(64,170,255,0.55) + shadowBlur 的辉光，
   * 一层 #63CBFF 的亮蓝核心 —— 那就是「省界发蓝、发糊」的来源。
   * Demo2 的省界是真实几何（lineSegments + lineBasicMaterial #ffffff），
   * 贴图只负责地形。边界改由 base.tsx 的 <RegionEdges> 画。
   *
   * 顺带省掉两次全图路径描边（2048² 上 shadowBlur 很贵）。
   */

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 8;
  texture.needsUpdate = true;

  return texture;
}
