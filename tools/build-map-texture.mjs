/**
 * build-map-texture.mjs — 地图轮廓贴图下载工具
 *
 * 复刻 https://github.com/knight-L/sat-hunter （区域卫星瓦片底图下载工具）的算法：
 *   1. 读取 DataV 区域 GeoJSON，取经纬度包围盒
 *   2. 用 Web Mercator 换算瓦片范围，逐块下载并拼接
 *   3. 按扩展名/边界路径裁剪（destination-in）
 *   4. 导出 PNG
 *
 * 与 sat-hunter 的差异：
 *   - 走 Node 环境，无浏览器跨域限制，可批量生成
 *   - 纯 Node 实现（内置 fetch + zlib），不依赖 sharp/canvas
 *   - 额外输出深色分级版本，供 Three.js 地图材质直接使用
 *
 * 用法：
 *   node tools/build-map-texture.mjs            # 生成全部配置
 *   node tools/build-map-texture.mjs china      # 只生成中国
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync, inflateSync } from "node:zlib";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "src", "assets", "map");
const CACHE_DIR = join(ROOT, ".cache", "tiles");

/* ------------------------------------------------------------------ *
 * 瓦片源（与 sat-hunter 的底图列表一致）
 * ------------------------------------------------------------------ */
const SOURCES = {
  esri_imagery: {
    name: "ESRI 卫星影像",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    maxZoom: 19,
  },
  esri_hill_shade: {
    name: "地形图",
    url: "https://server.arcgisonline.com/arcgis/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}",
    maxZoom: 16,
  },
  esri_light_gray: {
    name: "浅色灰底图",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",
    maxZoom: 16,
  },
  esri_dark_gray: {
    name: "暗色灰底图",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",
    maxZoom: 16,
  },
};

/* ------------------------------------------------------------------ *
 * 生成配置
 * ------------------------------------------------------------------ */
const JOBS = {
  china: {
    // 中国省级轮廓（省级 FeatureCollection），与 src/assets/china.json 同源
    geojson: join(ROOT, "src", "assets", "china.json"),
    source: "esri_imagery",
    // 目标长边像素。实际取整数瓦片网格后再裁到包围盒
    targetLongEdge: 2560,
    // 分级：把卫星影像压成 demo2 那种冷色低饱和地表
    grade: "slate",
    out: join(OUT_DIR, "china_surface.png"),
    meta: join(OUT_DIR, "china_surface.json"),
  },
  shanghai: {
    geojson: join(ROOT, "src", "assets", "shanghai.json"),
    source: "esri_imagery",
    targetLongEdge: 2048,
    grade: "slate",
    out: join(OUT_DIR, "shanghai_surface.png"),
    meta: join(OUT_DIR, "shanghai_surface.json"),
  },
};

/* ------------------------------------------------------------------ *
 * Web Mercator / 瓦片换算（照搬 sat-hunter）
 * ------------------------------------------------------------------ */
const latLonToTile = (lat, lon, zoom) => ({
  x: Math.floor(((lon + 180) / 360) * 2 ** zoom),
  y: Math.floor(
    ((1 -
      Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) /
      2) *
      2 ** zoom,
  ),
});

const project = (lat, lng, zoom) => {
  let siny = Math.sin((lat * Math.PI) / 180);
  siny = Math.min(Math.max(siny, -0.9999), 0.9999);
  return {
    x: (256 * 2 ** zoom * (lng + 180)) / 360,
    y: 256 * 2 ** zoom * (0.5 - Math.log((1 + siny) / (1 - siny)) / (4 * Math.PI)),
  };
};

/* ------------------------------------------------------------------ *
 * 极简 PNG 编解码（只处理 8bit RGB/RGBA，非隔行）
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

  // 统一转 RGBA
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

function encodePng({ width, height, data }, colorType = 6) {
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4;
      const d = y * (stride + 1) + 1 + x * channels;
      raw[d] = data[s];
      raw[d + 1] = data[s + 1];
      raw[d + 2] = data[s + 2];
      if (channels === 4) raw[d + 3] = data[s + 3];
    }
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
 * 画布（RGBA Buffer + 多边形填充/裁剪）
 * ------------------------------------------------------------------ */
class Canvas {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.data = Buffer.alloc(width * height * 4);
  }

  blit(img, dx, dy) {
    const { width: iw, height: ih, data } = img;
    for (let y = 0; y < ih; y++) {
      const ty = dy + y;
      if (ty < 0 || ty >= this.height) continue;
      const copyW = Math.min(iw, this.width - dx);
      if (copyW <= 0) continue;
      data.copy(this.data, (ty * this.width + dx) * 4, y * iw * 4, y * iw * 4 + copyW * 4);
    }
  }

  /** 用奇偶规则填充多路径（含 holes），路径为 [{x,y}] 数组 */
  fillPaths(paths, { r = 0, g = 0, b = 0, a = 255, union = true } = {}) {
    if (!paths.length) return;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const path of paths) {
      for (const p of path) {
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }
    }
    const y0 = Math.max(0, Math.floor(minY));
    const y1 = Math.min(this.height - 1, Math.ceil(maxY));
    const xs = [];
    for (let y = y0; y <= y1; y++) {
      xs.length = 0;
      const cy = y + 0.5;
      for (const path of paths) {
        for (let i = 0; i < path.length; i++) {
          const p1 = path[i];
          const p2 = path[(i + 1) % path.length];
          if (p1.y === p2.y) continue;
          const dir = p1.y < p2.y ? 1 : -1;
          const lo = dir === 1 ? p1 : p2;
          const hi = dir === 1 ? p2 : p1;
          if (cy >= lo.y && cy < hi.y) {
            xs.push({ x: lo.x + ((cy - lo.y) / (hi.y - lo.y)) * (hi.x - lo.x), dir });
          }
        }
      }
      if (!xs.length) continue;
      xs.sort((m, n) => m.x - n.x);
      if (union) {
        // 并集：所有环绕组覆盖区间全部填充
        for (let i = 0; i + 1 < xs.length; i += 2) {
          const xa = Math.max(0, Math.ceil(xs[i].x));
          const xb = Math.min(this.width - 1, Math.floor(xs[i + 1].x));
          for (let x = xa; x <= xb; x++) this.setPixel(x, y, r, g, b, a);
        }
      } else {
        // 奇偶：外环实心，内环镂空
        let inside = false;
        let cursor = 0;
        while (cursor < xs.length) {
          const xStart = xs[cursor].x;
          inside = !inside;
          if (inside) {
            const xa = Math.max(0, Math.ceil(xStart));
            const xb = Math.min(this.width - 1, Math.floor(xs[cursor + 1].x));
            for (let x = xa; x <= xb; x++) this.setPixel(x, y, r, g, b, a);
            cursor += 2;
          } else {
            cursor += 1;
          }
        }
      }
    }
  }

  /** destination-in：保留路径内像素，其余置透明 */
  clipInverse(paths) {
    const keep = new Uint8Array(this.width * this.height);
    if (paths.length) {
      let minY = Infinity;
      let maxY = -Infinity;
      for (const path of paths) {
        for (const p of path) {
          if (p.y < minY) minY = p.y;
          if (p.y > maxY) maxY = p.y;
        }
      }
      const y0 = Math.max(0, Math.floor(minY));
      const y1 = Math.min(this.height - 1, Math.ceil(maxY));
      const xs = [];
      for (let y = y0; y <= y1; y++) {
        xs.length = 0;
        const cy = y + 0.5;
        for (const path of paths) {
          for (let i = 0; i < path.length; i++) {
            const p1 = path[i];
            const p2 = path[(i + 1) % path.length];
            if (p1.y === p2.y) continue;
            const dir = p1.y < p2.y ? 1 : -1;
            const lo = dir === 1 ? p1 : p2;
            const hi = dir === 1 ? p2 : p1;
            if (cy >= lo.y && cy < hi.y) xs.push(lo.x + ((cy - lo.y) / (hi.y - lo.y)) * (hi.x - lo.x));
          }
        }
        xs.sort((m, n) => m - n);
        for (let i = 0; i + 1 < xs.length; i += 2) {
          const xa = Math.max(0, Math.ceil(xs[i]));
          const xb = Math.min(this.width - 1, Math.floor(xs[i + 1]));
          for (let x = xa; x <= xb; x++) keep[y * this.width + x] = 1;
        }
      }
    }
    for (let i = 0; i < this.width * this.height; i++) {
      if (!keep[i]) this.data[i * 4 + 3] = 0;
    }
  }

  setPixel(x, y, r, g, b, a) {
    const i = (y * this.width + x) * 4;
    if (a >= 255) {
      this.data[i] = r;
      this.data[i + 1] = g;
      this.data[i + 2] = b;
      this.data[i + 3] = 255;
      return;
    }
    const t = a / 255;
    this.data[i] = this.data[i] * (1 - t) + r * t;
    this.data[i + 1] = this.data[i + 1] * (1 - t) + g * t;
    this.data[i + 2] = this.data[i + 2] * (1 - t) + b * t;
    this.data[i + 3] = Math.max(this.data[i + 3], a);
  }
}

/* ------------------------------------------------------------------ *
 * 色调分级：把彩色卫星影像压成 demo2 的冷灰蓝色金属地表
 * ------------------------------------------------------------------ */
function gradeSlate(canvas) {
  const { data } = canvas;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const r = data[i] / 255;
    const g = data[i + 1] / 255;
    const b = data[i + 2] / 255;
    let lum = 0.299 * r + 0.587 * g + 0.114 * b;
    // 抬暗部、压高光，保留地表纹理但整体偏暗
    lum = Math.pow(lum, 0.92) * 0.62 + 0.1;
    const contrast = (lum - 0.5) * 1.35 + 0.5;
    const v = Math.min(1, Math.max(0, contrast));
    // 冷色染色：R<G<B，接近 #8fc2ff 的弱化版
    data[i] = Math.round(v * 168 + 6);
    data[i + 1] = Math.round(v * 194 + 12);
    data[i + 2] = Math.round(v * 226 + 22);
  }
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */
const hashKey = (value) => createHash("sha1").update(value).digest("hex").slice(0, 16);

async function fetchTile(url, cacheFile) {
  try {
    const cached = readFileSync(cacheFile);
    if (cached.length > 0) return decodePng(cached);
  } catch {
    /* cache miss */
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "mumai-map-texture/1.0 (+local build tool)" },
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

function collectRings(geojson) {
  const rings = [];
  for (const feature of geojson.features) {
    const geometry = feature.geometry;
    const polygons =
      geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
    for (const polygon of polygons) {
      for (const ring of polygon) {
        if (ring.length >= 3) rings.push(ring.map(([lng, lat]) => [lng, lat]));
      }
    }
  }
  return rings;
}

async function buildJob(key, job) {
  const geojson = JSON.parse(readFileSync(job.geojson, "utf8"));
  const source = SOURCES[job.source] ?? SOURCES.esri_imagery;
  const rings = collectRings(geojson);
  if (!rings.length) throw new Error(`${key}: no rings in geojson`);

  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  for (const ring of rings) {
    for (const [lng, lat] of ring) {
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
  }
  // 留一点边距，避免轮廓贴边
  const padLng = (maxLng - minLng) * 0.01;
  const padLat = (maxLat - minLat) * 0.01;
  minLng -= padLng;
  maxLng += padLng;
  minLat -= padLat;
  maxLat += padLat;

  // 选缩放级别：整幅包围盒宽度不超过 targetLongEdge * 1.15
  let zoom = 1;
  for (let z = 1; z <= source.maxZoom; z++) {
    const a = project(maxLat, minLng, z);
    const b = project(minLat, maxLng, z);
    if (b.x - a.x <= job.targetLongEdge * 1.15) zoom = z;
    else break;
  }

  const nw = project(maxLat, minLng, zoom);
  const se = project(minLat, maxLng, zoom);
  const tMin = latLonToTile(maxLat, minLng, zoom);
  const tMax = latLonToTile(minLat, maxLng, zoom);
  const minX = Math.min(tMin.x, tMax.x);
  const maxX = Math.max(tMin.x, tMax.x);
  const minY = Math.min(tMin.y, tMax.y);
  const maxY = Math.max(tMin.y, tMax.y);
  const tilesX = maxX - minX + 1;
  const tilesY = maxY - minY + 1;
  const total = tilesX * tilesY;

  console.log(
    `[${key}] ${source.name} z=${zoom} tiles=${tilesX}x${tilesY}=${total} ` +
      `bbox=[${minLng.toFixed(3)},${minLat.toFixed(3)},${maxLng.toFixed(3)},${maxLat.toFixed(3)}]`,
  );

  const stitched = new Canvas(tilesX * 256, tilesY * 256);
  let loaded = 0;
  let done = 0;
  let cursor = 0;
  const coords = [];
  for (let x = minX; x <= maxX; x++) for (let y = minY; y <= maxY; y++) coords.push([x, y]);

  const worker = async () => {
    while (cursor < coords.length) {
      const [x, y] = coords[cursor++];
      const url = source.url
        .replace("{z}", String(zoom))
        .replace("{y}", String(y))
        .replace("{x}", String(x));
      const cacheFile = join(CACHE_DIR, `${source.name}-${hashKey(url)}.png`);
      const img = await fetchTile(url, cacheFile);
      if (img) {
        stitched.blit(img, (x - minX) * 256, (y - minY) * 256);
        loaded++;
      }
      done++;
      if (done % 40 === 0 || done === total) {
        process.stdout.write(`\r  tiles ${done}/${total} ok=${loaded}   `);
      }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  process.stdout.write("\n");

  // 裁到经纬度包围盒
  const cropX = Math.max(0, Math.round(nw.x - minX * 256));
  const cropY = Math.max(0, Math.round(nw.y - minY * 256));
  const cropW = Math.min(stitched.width - cropX, Math.round(se.x - nw.x));
  const cropH = Math.min(stitched.height - cropY, Math.round(se.y - nw.y));

  const cropped = new Canvas(cropW, cropH);
  for (let y = 0; y < cropH; y++) {
    stitched.data.copy(
      cropped.data,
      y * cropW * 4,
      ((y + cropY) * stitched.width + cropX) * 4,
      ((y + cropY) * stitched.width + cropX + cropW) * 4,
    );
  }

  // 轮廓裁剪（sat-hunter 的 destination-in）
  const paths = rings.map((ring) =>
    ring.map(([lng, lat]) => {
      const p = project(lat, lng, zoom);
      return { x: p.x - minX * 256 - cropX, y: p.y - minY * 256 - cropY };
    }),
  );
  cropped.clipInverse(paths);

  if (job.grade === "slate") gradeSlate(cropped);

  mkdirSync(dirname(job.out), { recursive: true });
  writeFileSync(job.out, encodePng(cropped, 6));

  const meta = {
    key,
    source: job.source,
    sourceName: source.name,
    zoom,
    width: cropped.width,
    height: cropped.height,
    // 贴图覆盖的经纬度范围，Three.js 侧按同一范围重算 UV
    bounds: {
      west: minLng,
      east: maxLng,
      south: minLat,
      north: maxLat,
    },
    tiles: { total, ok: loaded, minX, maxX, minY, maxY },
    grade: job.grade ?? "none",
    generatedAt: new Date().toISOString(),
  };
  if (job.meta) writeFileSync(job.meta, `${JSON.stringify(meta, null, 2)}\n`);
  console.log(`  -> ${job.out} ${cropped.width}x${cropped.height} (${loaded}/${total} tiles)`);
  return meta;
}

const only = process.argv[2];
const keys = only ? [only] : Object.keys(JOBS);
const results = [];
for (const key of keys) {
  if (!JOBS[key]) {
    console.error(`unknown job: ${key}`);
    process.exit(1);
  }
  results.push(await buildJob(key, JOBS[key]));
}
console.log("\n完成：");
for (const meta of results) {
  console.log(`  ${meta.key}: ${meta.width}x${meta.height} z=${meta.zoom} ${meta.sourceName}`);
}
