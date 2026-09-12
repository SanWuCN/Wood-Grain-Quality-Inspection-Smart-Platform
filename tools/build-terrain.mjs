/**
 * build-terrain.mjs — 由真实 DEM 生成地图地表贴图 / 法线贴图 / 高度贴图
 *
 * 数据源：AWS Open Data 上的 Mapzen Terrain Tiles（terrarium 编码，全球覆盖，无需密钥）
 *   https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png
 *   terrarium: height = (R * 256 + G + B / 256) - 32768   （单位：米）
 *
 * 输出（src/assets/map/）：
 *   {key}_surface.png   冷色地表（hillshade × 海拔着色），贴到挤出体的顶面
 *   {key}_normal.png    由 DEM 求梯度得到的法线贴图，给顶面做起伏光照
 *   {key}_terrain.json  元数据（瓦片范围、zoom、包围盒、高程范围）
 *
 * 贴图裁剪范围 = 区域经纬度包围盒（geojson 的全部环），UV 在 Three.js 侧按
 * 「世界坐标 → 经纬度」重算，所以这里只需要保证贴图与经纬度严格线性对应。
 *
 * 用法：
 *   node tools/build-terrain.mjs            # 生成全部
 *   node tools/build-terrain.mjs china      # 只生成中国
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync, inflateSync } from "node:zlib";
import { createHash } from "node:crypto";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "src", "assets", "map");
const CACHE_DIR = join(ROOT, ".cache", "terrain");

const JOBS = {
  china: {
    geojson: join(ROOT, "src", "assets", "map", "china_geo.json"),
    longEdge: 2048,
    maxZoom: 6,
    // 南海诸岛的纬度一直延伸到 3.8°N，会把包围盒拉长、整幅地图压扁；
    // 这些岛礁本身面积很小，贴图里不需要单独覆盖，所以只按大陆范围取景。
    excludeAdcodes: [100000],
    lowCut: -150,
    highCut: 6800,
  },
  shanghai: {
    geojson: join(ROOT, "src", "assets", "map", "shanghai_geo.json"),
    longEdge: 1280,
    maxZoom: 10,
    lowCut: -5,
    highCut: 110,
  },
};

/* ------------------------------------------------------------------ *
 * 极简 PNG 编解码（8bit RGB/RGBA，非隔行）
 * ------------------------------------------------------------------ */
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

const crc32 = (buf) => {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};

const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(PNG_SIG)) throw new Error("not a PNG");
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 8;
  let colorType = 6;
  let interlace = 0;
  const idat = [];
  let palette = null;
  let trns = null;

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("latin1", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "PLTE") {
      palette = Buffer.from(data);
    } else if (type === "tRNS") {
      trns = Buffer.from(data);
    } else if (type === "IDAT") {
      idat.push(Buffer.from(data));
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }

  if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`);
  if (interlace !== 0) throw new Error("interlaced PNG not supported");

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`unsupported color type ${colorType}`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);

  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= channels ? prev[i - channels] : 0;
      let value = line[i];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = value & 0xff;
    }
  }

  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    if (colorType === 6) {
      rgba[i * 4] = out[i * 4];
      rgba[i * 4 + 1] = out[i * 4 + 1];
      rgba[i * 4 + 2] = out[i * 4 + 2];
      rgba[i * 4 + 3] = out[i * 4 + 3];
    } else if (colorType === 2) {
      rgba[i * 4] = out[i * 3];
      rgba[i * 4 + 1] = out[i * 3 + 1];
      rgba[i * 4 + 2] = out[i * 3 + 2];
      rgba[i * 4 + 3] = 255;
    } else if (colorType === 0) {
      const v = out[i];
      rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = v;
      rgba[i * 4 + 3] = 255;
    } else if (colorType === 4) {
      const v = out[i * 2];
      rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = v;
      rgba[i * 4 + 3] = out[i * 2 + 1];
    } else if (colorType === 3) {
      const idx = out[i];
      rgba[i * 4] = palette[idx * 3];
      rgba[i * 4 + 1] = palette[idx * 3 + 1];
      rgba[i * 4 + 2] = palette[idx * 3 + 2];
      rgba[i * 4 + 3] = trns && idx < trns.length ? trns[idx] : 255;
    }
  }
  return { width, height, data: rgba };
}

/** 编码 8bit PNG。pixels 为 RGB 三元组构成的 Buffer */
function encodePng(width, height, pixels, colorType = 2) {
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  return Buffer.concat([
    PNG_SIG,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ *
 * Web Mercator
 * ------------------------------------------------------------------ */
const project = (lat, lng, zoom) => {
  let siny = Math.sin((lat * Math.PI) / 180);
  siny = Math.min(Math.max(siny, -0.9999), 0.9999);
  return {
    x: (256 * 2 ** zoom * (lng + 180)) / 360,
    y: 256 * 2 ** zoom * (0.5 - Math.log((1 + siny) / (1 - siny)) / (4 * Math.PI)),
  };
};

/* ------------------------------------------------------------------ *
 * 取区域所有环 + 包围盒
 * ------------------------------------------------------------------ */
function ringsAndBounds(geojson, excludeAdcodes = []) {
  const rings = [];
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  const regions = geojson.regions ?? geojson.features.map((f) => ({
    polygons: f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates,
  }));
  for (const region of regions) {
    if (region.adcode && excludeAdcodes.includes(region.adcode)) continue;
    for (const polygon of region.polygons) {
      for (const ring of polygon) {
        rings.push(ring);
        for (const [lng, lat] of ring) {
          if (lng < minLng) minLng = lng;
          if (lng > maxLng) maxLng = lng;
          if (lat < minLat) minLat = lat;
          if (lat > maxLat) maxLat = lat;
        }
      }
    }
  }
  return { rings, minLng, minLat, maxLng, maxLat };
}

/* ------------------------------------------------------------------ *
 * 瓦片下载
 * ------------------------------------------------------------------ */
const hashKey = (v) => createHash("sha1").update(v).digest("hex").slice(0, 16);

async function fetchTile(url, cacheFile) {
  try {
    const cached = readFileSync(cacheFile);
    if (cached.length > 0) return decodePng(cached);
  } catch {
    /* cache miss */
  }
  mkdirSync(CACHE_DIR, { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "mumai-terrain/1.0 (+local build tool)" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const img = decodePng(buf);
      writeFileSync(cacheFile, buf);
      return img;
    } catch (error) {
      if (attempt === 2) {
        console.warn(`  ! tile failed ${url} :: ${error.message}`);
        return null;
      }
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  return null;
}

/** 按 terrarium 编码解出高程（米） */
function terrariumToHeight(r, g, b) {
  return r * 256 + g + b / 256 - 32768;
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */
async function buildJob(key, job) {
  const geojson = JSON.parse(readFileSync(job.geojson, "utf8"));
  const { minLng, minLat, maxLng, maxLat } = ringsAndBounds(geojson, job.excludeAdcodes ?? []);

  // 选 zoom：整幅不超过 longEdge
  let zoom = 1;
  for (let z = 1; z <= job.maxZoom; z++) {
    const a = project(maxLat, minLng, z);
    const b = project(minLat, maxLng, z);
    if (b.x - a.x <= job.longEdge * 1.15) zoom = z;
    else break;
  }

  const nw = project(maxLat, minLng, zoom);
  const se = project(minLat, maxLng, zoom);
  const minX = Math.floor(nw.x / 256);
  const minY = Math.floor(nw.y / 256);
  const maxX = Math.floor(se.x / 256);
  const maxY = Math.floor(se.y / 256);
  const tilesX = maxX - minX + 1;
  const tilesY = maxY - minY + 1;
  const total = tilesX * tilesY;

  const cropX = Math.round(nw.x - minX * 256);
  const cropY = Math.round(nw.y - minY * 256);
  const cropW = Math.round(se.x - nw.x);
  const cropH = Math.round(se.y - nw.y);

  console.log(
    `[${key}] z=${zoom} tiles=${tilesX}x${tilesY}=${total} 输出=${cropW}x${cropH} ` +
      `bbox=[${minLng.toFixed(3)},${minLat.toFixed(3)},${maxLng.toFixed(3)},${maxLat.toFixed(3)}]`,
  );

  // 拼接高程
  const stitched = new Float32Array(tilesX * 256 * tilesY * 256);
  const sw = tilesX * 256;
  let ok = 0;
  let done = 0;
  const coords = [];
  for (let x = minX; x <= maxX; x++) for (let y = minY; y <= maxY; y++) coords.push([x, y]);
  let cursor = 0;

  const worker = async () => {
    while (cursor < coords.length) {
      const [x, y] = coords[cursor++];
      const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${zoom}/${x}/${y}.png`;
      const cacheFile = join(CACHE_DIR, `terrarium-${hashKey(url)}.png`);
      const img = await fetchTile(url, cacheFile);
      if (img) {
        const ox = (x - minX) * 256;
        const oy = (y - minY) * 256;
        for (let ty = 0; ty < img.height; ty++) {
          const row = (oy + ty) * sw + ox;
          for (let tx = 0; tx < img.width; tx++) {
            const s = (ty * img.width + tx) * 4;
            stitched[row + tx] = terrariumToHeight(img.data[s], img.data[s + 1], img.data[s + 2]);
          }
        }
        ok++;
      }
      done++;
      if (done % 20 === 0 || done === total) {
        process.stdout.write(`\r  tiles ${done}/${total} ok=${ok}   `);
      }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  process.stdout.write("\n");

  // 裁剪 + 求高程范围
  const height = new Float32Array(cropW * cropH);
  let hMin = Infinity;
  let hMax = -Infinity;
  for (let y = 0; y < cropH; y++) {
    const src = (y + cropY) * sw + cropX;
    const dst = y * cropW;
    for (let x = 0; x < cropW; x++) {
      const v = stitched[src + x];
      height[dst + x] = v;
      if (v < hMin) hMin = v;
      if (v > hMax) hMax = v;
    }
  }
  console.log(`  高程范围 ${hMin.toFixed(0)}m ~ ${hMax.toFixed(0)}m`);

  // 归一化（按可视裁剪范围）
  const lo = Math.max(hMin, job.lowCut);
  const hi = Math.min(hMax, job.highCut);
  const norm = new Float32Array(cropW * cropH);
  for (let i = 0; i < height.length; i++) {
    norm[i] = Math.min(1, Math.max(0, (height[i] - lo) / (hi - lo)));
  }

  // 高斯模糊一点，避免 DEM 噪点让法线太脏
  const smoothed = boxBlur(norm, cropW, cropH, 2);

  // hillshade：光从左上（西北）来
  const lx = -0.6;
  const ly = -0.6;
  const lz = 0.53;
  const surface = Buffer.alloc(cropW * cropH * 3);
  const normal = Buffer.alloc(cropW * cropH * 3);

  // 把归一化高程换算成「近似真实坡度」：一个像素对应的米数
  const metersPerPixel = ((hi - lo) / 1) * 0 + 1; // 占位，下面按经纬跨度算
  void metersPerPixel;
  const latSpan = maxLat - minLat;
  const metersPerDegree = 111320;
  const pxPerDegreeY = cropH / latSpan;
  const elevScale = (hi - lo) / (cropH / pxPerDegreeY) / metersPerDegree; // 竖向夸张系数
  void elevScale;

  // 直接用归一化高程的梯度做光照，竖向夸张靠 normalScale 在材质里调
  const bumpStrength = job.bumpStrength ?? 1.0;

  for (let y = 0; y < cropH; y++) {
    for (let x = 0; x < cropW; x++) {
      const i = y * cropW + x;
      const xm = x > 0 ? i - 1 : i;
      const xp = x < cropW - 1 ? i + 1 : i;
      const ym = y > 0 ? i - cropW : i;
      const yp = y < cropH - 1 ? i + cropW : i;

      const dx = (smoothed[xp] - smoothed[xm]) * bumpStrength;
      const dy = (smoothed[yp] - smoothed[ym]) * bumpStrength;
      const dz = 1 / 12;

      // 法线
      let nx = -dx;
      let ny = -dy;
      let nz = dz;
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl;
      ny /= nl;
      nz /= nl;
      const ni = i * 3;
      normal[ni] = Math.round((nx * 0.5 + 0.5) * 255);
      normal[ni + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      normal[ni + 2] = Math.round((nz * 0.5 + 0.5) * 255);

      // 光照
      const diff = Math.max(0, nx * lx + ny * ly + nz * lz);
      const h = smoothed[i];
      // 地表色调：低地偏深蓝灰，高地偏亮冰蓝白，模拟 demo2 的冷色地形
      const shade = 0.16 + diff * 0.84;
      const ridge = Math.pow(h, 0.75);
      const base = shade * (0.5 + 0.5 * ridge);
      const r = 12 + base * 96 + ridge * ridge * 46;
      const g = 26 + base * 128 + ridge * ridge * 54;
      const b = 44 + base * 158 + ridge * ridge * 62;
      surface[ni] = Math.min(255, Math.round(r));
      surface[ni + 1] = Math.min(255, Math.round(g));
      surface[ni + 2] = Math.min(255, Math.round(b));

    }
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const files = [
    [`${key}_surface.png`, encodePng(cropW, cropH, surface, 2)],
    [`${key}_normal.png`, encodePng(cropW, cropH, normal, 2)],
  ];
  for (const [name, buf] of files) {
    writeFileSync(join(OUT_DIR, name), buf);
    console.log(`  -> ${name} ${cropW}x${cropH} ${(buf.length / 1024).toFixed(0)}KB`);
  }

  const meta = {
    key,
    source: "Mapzen Terrain Tiles (terrarium) via AWS Open Data",
    zoom,
    width: cropW,
    height: cropH,
    bounds: { west: minLng, east: maxLng, south: minLat, north: maxLat },
    elevation: { rawMin: Math.round(hMin), rawMax: Math.round(hMax), lowCut: lo, highCut: hi },
    tiles: { total, ok, minX, maxX, minY, maxY },
    generatedAt: new Date().toISOString(),
  };
  writeFileSync(join(OUT_DIR, `${key}_terrain.json`), `${JSON.stringify(meta, null, 2)}\n`);
  return meta;
}

/** 简单盒式模糊（可分离，两趟） */
function boxBlur(src, width, height, radius) {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const win = radius * 2 + 1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) {
        const xx = Math.min(width - 1, Math.max(0, x + k));
        sum += src[y * width + xx];
      }
      tmp[y * width + x] = sum / win;
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) {
        const yy = Math.min(height - 1, Math.max(0, y + k));
        sum += tmp[yy * width + x];
      }
      out[y * width + x] = sum / win;
    }
  }
  return out;
}

const only = process.argv[2];
const keys = only ? [only] : Object.keys(JOBS);
for (const key of keys) {
  if (!JOBS[key]) {
    console.error(`unknown job: ${key}`);
    process.exit(1);
  }
  await buildJob(key, JOBS[key]);
}
console.log("完成");
