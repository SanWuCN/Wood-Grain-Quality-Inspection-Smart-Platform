/**
 * 方案 02 · 果冻抖动球（顶点噪声位移 + 呼吸缩放）
 *
 * ── 怎么做出"渐变半透明" ──────────────────────────────────────────
 * 顶点着色器里把球面按三层不同频率的正弦叠加做**径向位移**：
 *   低频（1 波）给"整体缓慢鼓动"、中频（2~3 波）给"果冻在晃"、
 *   高频（5~7 波）给表面的细密涟漪。位移后的法线**必须解析求出**
 *   （对位移函数求偏导），否则光照会停在原球面上，抖起来像一张纸在飘。
 *
 * 片元部分：
 *   · 底色 = 用扰动后的法线做蓝→青→紫的三段渐变（`iridescent()`）；
 *   · 边缘发光 = 菲涅尔 —— 视线越掠射越亮越不透明，**正对相机的中心
 *     反而最通透**。这就是"半透明但轮廓清晰"的做法；
 *   · 内部亮带 = 两条沿不同方向流动的宽亮带，用位移后的位置采样。
 *
 * ── 与 01 的区别（为什么要单独占一格）────────────────────────────
 * 01 靠材质的物理参数，形状是死板的绝对正圆；
 * 这一版形状**每帧都在变**，"果冻"的弹性感来自几何本身，不是材质。
 *
 * ── 开销 ──────────────────────────────────────────────────────────
 * 中低。一次绘制、无离屏缓冲、无 transmission；代价在顶点数（96×64≈6000 顶点）
 * 与逐顶点三角函数，属于"GPU 顶点阶段"，实测很轻。
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

const VERTEX = /* glsl */ `
uniform float uTime;
uniform float uAmp;
varying vec3 vNrm;
varying vec3 vPos;

float wobble(vec3 p, float t) {
  return sin(p.y * 3.1 + t * 1.9) * 0.5
       + sin(p.x * 2.3 - t * 1.45) * 0.5
       + sin(p.z * 2.7 + t * 1.2) * 0.5
       + sin(p.x * 5.3 + p.y * 4.1 + t * 2.6) * 0.30
       + sin(p.y * 6.7 - p.z * 5.2 - t * 2.1) * 0.24;
}

// 径向位移量：振幅 uAmp 由 JS 侧呼吸式调制
float disp(vec3 p, float t) {
  return wobble(p, t) * uAmp;
}

void main() {
  vec3 p = normalize(position);
  float d = disp(p, uTime);

  // 解析法线：球面上位移后的曲面，在 p 的切平面上取两个正交方向求差商。
  // 用差商而不是解析偏导 —— 位移函数是多层三角函数的和，手推偏导容易写错，
  // 而差商的精度对 0.05 量级的位移完全够（视觉上看不出）。
  vec3 t1 = normalize(cross(p, vec3(0.0, 1.0, 0.0) + vec3(0.001, 0.0, 0.0)));
  vec3 t2 = normalize(cross(p, t1));
  float e = 0.02;
  vec3 pa = normalize(p + t1 * e);
  vec3 pb = normalize(p + t2 * e);
  float da = disp(pa, uTime);
  float db = disp(pb, uTime);
  vec3 A = pa * (1.0 + da) - p * (1.0 + d);
  vec3 B = pb * (1.0 + db) - p * (1.0 + d);
  vec3 n = normalize(cross(A, B));
  if (dot(n, p) < 0.0) n = -n;

  vNrm = normalize(normalMatrix * n);
  vPos = p * (1.0 + d);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(vPos, 1.0);
}
`;

const FRAGMENT = /* glsl */ `
uniform float uTime;
uniform vec3 uBlue;
uniform vec3 uCyan;
uniform vec3 uIris;
varying vec3 vNrm;
varying vec3 vPos;

// 三段虹彩：蓝 → 青 → 紫，用 t 在 0..1 之间来回插值
vec3 iridescent(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 c = mix(uBlue, uCyan, smoothstep(0.0, 0.5, t));
  return mix(c, uIris, smoothstep(0.5, 1.0, t));
}

void main() {
  vec3 N = normalize(vNrm);
  vec3 V = normalize(cameraPosition - vPos);

  // 渐变的位置参数：用"位移后的位置"同时吃 y 与 x，
  // 于是抖动的时候渐变也跟着被"搅动"，不是贴一张固定的渐变皮
  float g = vPos.y * 0.5 + 0.5 + vPos.x * 0.22 + sin(uTime * 0.5) * 0.06;
  vec3 base = iridescent(g);

  // 两条内部流动亮带：沿不同方向扫过，频率一高一低
  float bandA = pow(0.5 + 0.5 * sin(vPos.y * 3.4 - vPos.x * 2.2 + uTime * 1.15), 7.0);
  float bandB = pow(0.5 + 0.5 * sin(vPos.x * 2.6 + vPos.y * 1.7 - uTime * 0.85), 9.0);
  float band = bandA * 0.75 + bandB * 0.55;

  float fres = pow(1.0 - abs(dot(N, V)), 2.35);

  // 焦散式的高光：左上主光 + 右下回光，跟着抖动一起晃
  vec3 L = normalize(vec3(-0.55, 0.72, 0.62));
  float spec = pow(max(dot(reflect(-L, N), V), 0.0), 42.0);
  float rim = pow(max(dot(N, V), 0.0), 4.0) * 0.12;

  vec3 col = base * (0.86 + band * 0.55);
  col += vec3(0.75, 0.95, 1.0) * band * 0.34;
  col += vec3(1.0) * spec * 0.95;
  col += uCyan * rim;

  // 半透明：中心通透（alpha 低）、边缘厚（alpha 高）。
  // 0.34 的底透明保证"能看见球后面的东西"，这是"半透明"的硬指标。
  float alpha = clamp(0.34 + fres * 0.62 + band * 0.16, 0.0, 0.97);

  gl_FragColor = vec4(col, alpha);
}
`;

export const jellyWobble: LabVariant = {
  id: "02",
  name: "果冻抖动球",
  oneLiner: "形状每帧都在轻轻晃，Q 弹的果冻感来自几何而不是贴图",
  tech: "ShaderMaterial 顶点噪声位移（三层错频正弦）+ 解析法线 + 菲涅尔决定透明度",
  cost: "中低：单次绘制、无离屏；约 6k 顶点的逐顶点三角函数",
  fidelity: "mid",
  fidelityNote: "色相与通透度对得上，但形状有意偏离正圆（参考图是绝对正圆），所以\"像不像那张图\"扣一档",
  needsWebGL: true,
  create(_host: HTMLElement, _opts: VariantOptions, stage: Stage): VariantRuntime {
    const geo = new SphereGeometry(1, 96, 64);
    const mat = new ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uAmp: { value: 0.05 },
        uBlue: { value: new Color(PALETTE.blue) },
        uCyan: { value: new Color(PALETTE.cyan) },
        uIris: { value: new Color(PALETTE.iris) },
      },
    });
    const blob = new Mesh(geo, mat);
    blob.renderOrder = 8;

    const face = buildFace({ radius: 1.045 });
    face.group.renderOrder = 6;

    const halo = makeHalo(PALETTE.halo, 2.66, 0.46);
    const haloMat = halo.material as MeshBasicMaterial;
    const shadow = makeContactShadow();

    stage.scene.add(shadow, stage.floatGroup);
    stage.tiltGroup.add(blob, halo);
    stage.floatGroup.add(face.group);

    return {
      update: (t) => {
        // 呼吸式振幅：果冻"鼓一下、收一下"，而不是恒定抖动
        mat.uniforms.uTime.value = t;
        mat.uniforms.uAmp.value = 0.044 + Math.sin(t * 1.25) * 0.018;
        // 整体呼吸缩放 + 上下浮动
        const s = 1 + Math.sin(t * 1.35) * 0.03;
        blob.scale.set(s, s * (1 + Math.sin(t * 1.35 + 0.6) * 0.022), s);
        face.group.scale.copy(blob.scale);
        stage.floatGroup.position.y = Math.sin(t * 1.05 + 1.1) * 0.022;
        halo.scale.setScalar(1 + Math.sin(t * 1.35) * 0.055);
        haloMat.opacity = 0.6 + Math.sin(t * 1.35) * 0.14;
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
