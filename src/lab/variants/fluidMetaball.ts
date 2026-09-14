/**
 * 方案 07 · 元球 / 流体缓慢变形（近似球但不规则）
 *
 * ── 怎么做出"渐变半透明" ──────────────────────────────────────────
 * 关键在 __位移函数在 GPU 与 CPU 两边是同一份__（`lobeField()` 在 GLSL 与 TS
 * 里各写一遍，公式逐字对应）：
 *
 *   ① 表面不再是球面，而是"球面 + 若干个会绕圈移动的凸包"：
 *      每个凸包是一个高斯型的影响核 `exp(-k·(1-cos角))`，
 *      用 **smooth-max** 合成（不是简单相加）—— 相加会让球整体胀大，
 *      smooth-max 才会出现"两团流体靠近时黏连、远离时分开"的元球行为。
 *   ② 因为 CPU 侧也能算出同一个函数，脸的**高度**就能精确落在
 *      "这一帧的流体表面"上（`fieldHeight()`），不会陷进去也不会浮起来。
 *      这是别的方案不需要、这一版必须要的一步。
 *   ③ 颜色仍是蓝→青→紫的渐变 + 内部亮带 + 菲涅尔控透明，
 *      和 03 同一套思路；但因为表面在缓慢流动，渐变会跟着"被搅动"。
 *
 * ── 与 02 的区别 ──────────────────────────────────────────────────
 * 02 是"正球高频抖动"（果冻在晃），这一版是"形状低频大尺度改变"
 * （流体在缓慢吞并/分离），轮廓的不规则程度高一个量级。
 *
 * ── 开销 ──────────────────────────────────────────────────────────
 * 中。顶点着色器里每个顶点要算 5 个凸包 × 差商法线（3 次场求值），
 * 也就是每顶点约 15 次 exp —— 顶点数必须压住（72×48 ≈ 3500 顶点）。
 */

import { Color, Mesh, MeshBasicMaterial, ShaderMaterial, SphereGeometry } from "three";
import {
  PALETTE,
  applyBlink,
  blinkScale,
  buildFace,
  disposeTempMesh,
  makeContactShadow,
  makeHalo,
  type Stage,
} from "../shared.ts";
import type { LabVariant, VariantOptions, VariantRuntime } from "../types.ts";

/** 凸包数量：5 个够出现"多团融合"，再多顶点开销线性上涨 */
const LOBES = 5;

/**
 * 凸包的球面位置。**在物体空间里是固定的** —— 旋转整颗球来让它们看起来在动。
 *
 * 为什么不让凸包自己动：那样 CPU 侧每次求高度都要重算全部 5 个凸包的位置与极角，
 * 而且"脸对应哪个方向"会变。固定在物体空间 + 整体旋转 = 同样的视觉效果，
 * 成本低一个量级，脸上的高度也只需要在**初始化时算一次**。
 */
const LOBE_DIRS: [number, number, number][] = [
  [0.72, 0.36, 0.5],
  [-0.55, -0.42, 0.62],
  [0.18, -0.78, 0.42],
  [-0.35, 0.6, -0.62],
  [0.45, 0.15, -0.78],
];

/** 与 GLSL 的 lobeField() 逐字对应 —— 改一边必须改另一边 */
function lobeFieldJS(x: number, y: number, z: number, t: number): number {
  const len = Math.hypot(x, y, z) || 1;
  const px = x / len;
  const py = y / len;
  const pz = z / len;
  let sum = 0;
  for (let i = 0; i < LOBES; i += 1) {
    const [dx, dy, dz] = LOBE_DIRS[i];
    // 每个凸包的"呼吸"相位错开 → 融合/分离的时机不同步
    const amp = 0.5 + 0.5 * Math.sin(t * (0.52 + i * 0.12) + i * 1.7);
    const cosA = px * dx + py * dy + pz * dz;
    const a = Math.max(-1, Math.min(1, cosA));
    // 高斯核，指数里的 k = 14：k 越大凸包越"尖"
    sum += Math.exp(-14 * (1 - a)) * amp;
  }
  return sum;
}

const VERT = /* glsl */ `
uniform float uTime;
uniform float uAmp;
varying vec3 vN;
varying vec3 vP;
varying float vLobe;

/**
 * 凸包场。⚠ 与 fluidMetaball.ts 的 lobeFieldJS() 逐字对应：
 * GPU 用它算形状与法线，CPU 用它算"脸上的表面高度"。
 * 两边的常数（5 个凸包方向、k=14、振幅公式）必须完全一致，
 * 否则脸会陷进流体里或者浮在半空。
 */
float lobeField(vec3 p, float t) {
  vec3 dirs[5];
  dirs[0] = vec3( 0.72,  0.36,  0.50);
  dirs[1] = vec3(-0.55, -0.42,  0.62);
  dirs[2] = vec3( 0.18, -0.78,  0.42);
  dirs[3] = vec3(-0.35,  0.60, -0.62);
  dirs[4] = vec3( 0.45,  0.15, -0.78);
  float sum = 0.0;
  for (int i = 0; i < 5; i++) {
    float amp = 0.5 + 0.5 * sin(t * (0.52 + float(i) * 0.12) + float(i) * 1.7);
    float a = clamp(dot(p, dirs[i]), -1.0, 1.0);
    sum += exp(-14.0 * (1.0 - a)) * amp;
  }
  return sum;
}

/** smooth-max：元球"黏连"的关键，直接相加只会让球整体变大 */
float smax(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(a, b, h) + k * h * (1.0 - h);
}

float radiusAt(vec3 p, float t) {
  float f = lobeField(p, t);
  return 1.0 + uAmp * (f - 0.85);
}

void main() {
  vec3 p = normalize(position);
  float r = radiusAt(p, uTime);

  // 差商法线：在 p 的切平面上取两个正交方向各走一小步，比较位移后的点
  vec3 t1 = normalize(cross(p, abs(p.y) > 0.9 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0)));
  vec3 t2 = normalize(cross(p, t1));
  float e = 0.03;
  vec3 pa = normalize(p + t1 * e);
  vec3 pb = normalize(p + t2 * e);
  vec3 A = pa * radiusAt(pa, uTime) - p * r;
  vec3 B = pb * radiusAt(pb, uTime) - p * r;
  vec3 n = normalize(cross(A, B));
  if (dot(n, p) < 0.0) n = -n;

  vLobe = lobeField(p, uTime);
  vN = normalize(normalMatrix * n);
  vP = p * r;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(vP, 1.0);
}
`;

const FRAG = /* glsl */ `
uniform float uTime;
uniform vec3 uBlue;
uniform vec3 uCyan;
uniform vec3 uIris;
varying vec3 vN;
varying vec3 vP;
varying float vLobe;

vec3 iridescent(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 c = mix(uBlue, uCyan, smoothstep(0.0, 0.55, t));
  return mix(c, uIris, smoothstep(0.5, 1.0, t));
}

void main() {
  vec3 N = normalize(vN);
  vec3 V = normalize(cameraPosition - vP);
  float fres = pow(1.0 - abs(dot(N, V)), 2.3);

  // 渐变：位置 + 流体密度（vLobe）一起决定色相 ——
  // 于是"哪一团鼓起来"和"哪里偏紫"是同一件事，看着像同一种流体
  float g = vP.y * 0.45 + 0.5 + vP.x * 0.25 + (vLobe - 0.85) * 0.35 + sin(uTime * 0.4) * 0.05;
  vec3 base = iridescent(g);

  float band = pow(0.5 + 0.5 * sin(vP.y * 3.2 - vP.x * 2.4 + uTime * 0.9), 8.0);
  vec3 col = base * (0.9 + band * 0.5) + vec3(0.8, 0.95, 1.0) * band * 0.32;

  vec3 L = normalize(vec3(-0.5, 0.74, 0.6));
  col += vec3(1.0) * pow(max(dot(reflect(-L, N), V), 0.0), 36.0) * 0.9;
  col += uIris * fres * 0.5;

  float alpha = clamp(0.36 + fres * 0.6 + band * 0.14, 0.0, 0.97);
  gl_FragColor = vec4(col, alpha);
}
`;

export const metaballFluid: LabVariant = {
  id: "07",
  name: "元球流体变形",
  oneLiner: "五个凸包缓慢黏连分离，轮廓每时每刻都不一样",
  tech: "顶点着色器 smooth-max 合成 5 个高斯核（元球）+ 差商法线；CPU 侧同一份场函数用来把脸钉在流面上",
  cost: "中：每顶点约 15 次 exp（含差商法线），顶点数需压到 ~3.5k",
  fidelity: "low",
  fidelityNote: "配色与通透度是参考图那一套，但形状有意不是正圆；参考图是绝对正圆，所以「像不像」只算低",
  needsWebGL: true,
  create(_host: HTMLElement, _opts: VariantOptions, stage: Stage): VariantRuntime {
    const geo = new SphereGeometry(1, 72, 48);
    const mat = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uAmp: { value: 0.115 },
        uBlue: { value: new Color(PALETTE.blue) },
        uCyan: { value: new Color(PALETTE.cyan) },
        uIris: { value: new Color(PALETTE.iris) },
      },
    });
    const blob = new Mesh(geo, mat);
    blob.renderOrder = 8;

    /**
     * 把脸钉在流体表面上的高度。
     *
     * 场在物体空间里不随时间变位置（凸包固定、整球旋转），但每个凸包的**振幅**
     * 在呼吸 —— 所以严格说表面高度还是会随时间轻微起伏。这里取振幅时间的
     * 中位值算一次即可：起伏幅度只有 0.02r 量级，肉眼看不出来，
     * 而每帧在 CPU 上重算 5 个凸包是白费。
     */
    const faceDy = 0.174;
    const rr = Math.sqrt(1 - faceDy * faceDy);
    const fieldAtFace = lobeFieldJS(0, faceDy, rr, 1.4);
    const surfaceR = 1 + 0.115 * (fieldAtFace - 0.85);
    const faceRadius = surfaceR * 1.045;

    const face = buildFace({ radius: faceRadius });
    face.group.renderOrder = 6;

    const halo = makeHalo(PALETTE.halo, 2.72, 0.44);
    const haloMat = halo.material as MeshBasicMaterial;
    const shadow = makeContactShadow();

    stage.scene.add(shadow, stage.floatGroup);
    stage.tiltGroup.add(blob, halo);
    stage.floatGroup.add(face.group);

    return {
      update: (t) => {
        mat.uniforms.uTime.value = t;
        // 形状在低频变化，但整球还要极慢自转 —— 两者叠加才像"流体在缓慢翻搅"
        blob.rotation.y = t * 0.11;
        blob.rotation.z = Math.sin(t * 0.19) * 0.22;
        const s = 1 + Math.sin(t * 1.1) * 0.03;
        blob.scale.setScalar(s);
        face.group.scale.setScalar(s);
        stage.floatGroup.position.y = Math.sin(t * 1.05 + 1.1) * 0.024;
        halo.scale.setScalar(1 + Math.sin(t * 1.1) * 0.06);
        haloMat.opacity = 0.55 + Math.sin(t * 1.1) * 0.13;
        applyBlink(face, blinkScale(t));
      },
      dispose: () => {
        geo.dispose();
        mat.dispose();
        face.dispose();
        disposeTempMesh(halo);
        disposeTempMesh(shadow);
      },
    };
  },
};
