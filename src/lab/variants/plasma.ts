/**
 * 方案 05 · 等离子 / 能量球（内部噪声流动 + 加色发光）
 *
 * ── 怎么做出"渐变半透明" ──────────────────────────────────────────
 * 这一版是**纯发光**路线：球体本身几乎不"挡光"，颜色全部由加色混合叠出来。
 *   ① 内部体积噪声：3 组错频三角函数在球体**内部坐标**（vP，半径 < 1）上
 *      采样出一个标量场，再做 `pow(field, k)` 取"脊线" —— 得到一缕缕
 *      像等离子弧一样的光丝，随时间向内/向外卷动。
 *   ② 加色混合（`blending: AdditiveBlending`）：光丝只往亮里叠、不产生
 *      灰边。这也是"半透明"的来源 —— 加色本质上就是"这个像素透过去加了点光"。
 *   ③ 外发光两圈：球体外面再套两张径向渐变的 billboard，
 *      负责参考图那种"球外一圈柔光"。
 *   ④ 五官用发光材质画（眼是青色发光椭圆、嘴是发光弧线），
 *      加色会让它天然融进光晕里，不会像贴纸。
 *
 * ── 与 03 的区别 ──────────────────────────────────────────────────
 * 03 的亮带是"球面上扫过的光"，球本身有明确的壳与轮廓；
 * 这一版**没有壳**，轮廓完全由密度场自己长出来，气质是"能量"不是"琉璃"。
 *
 * ── 开销 ──────────────────────────────────────────────────────────
 * 中。片元里 3 组三角函数 × 全屏覆盖，属于"片元密集"；
 * 但只有两次绘制、没有离屏缓冲，格子态下开销可以忽略。
 */

import { AdditiveBlending, Color, Mesh, MeshBasicMaterial, ShaderMaterial, SphereGeometry } from "three";
import {
  PALETTE,
  applyBlink,
  blinkScale,
  buildFace,
  canvasTexture,
  disposeTempMesh,
  makeCanvas,
  makeContactShadow,
  makeHalo,
  type Stage,
} from "../shared.ts";
import type { LabVariant, VariantOptions, VariantRuntime } from "../types.ts";

const VERT = /* glsl */ `
varying vec3 vN;
varying vec3 vP;
void main() {
  vN = normalize(normalMatrix * normal);
  vP = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAG = /* glsl */ `
uniform float uTime;
uniform vec3 uHot;
uniform vec3 uMid;
uniform vec3 uDeep;
varying vec3 vN;
varying vec3 vP;

/**
 * 内部标量场。
 * 三组频率不同的三角函数相加，再乘一个"离球心越远越弱"的包络 ——
 * 包络是必须的：没有它，光丝会一路糊到球的轮廓上，球的边界就没了。
 */
float field(vec3 p, float t) {
  float f = sin(p.x * 4.1 + t * 1.15)
          * sin(p.y * 3.6 - t * 0.92)
          * sin(p.z * 4.6 + t * 1.31);
  f += 0.6 * sin((p.x + p.y) * 6.3 - t * 1.7);
  f += 0.45 * sin((p.z - p.y) * 7.4 + t * 2.05);
  f += 0.3 * sin(length(p * 3.0) * 5.2 - t * 2.6);
  return f * 0.5 + 0.5;
}

void main() {
  vec3 p = normalize(vP);
  vec3 N = normalize(vN);
  vec3 V = normalize(cameraPosition - vP);

  float f = field(p, uTime);
  // 取脊线：pow 把连续的场收成"一缕缕"，这才是"等离子弧"而不是"一团雾"
  float ribbon = pow(f, 3.4);
  float glow = pow(f, 1.15);

  // 中心热、外层冷 = 渐变
  float depth = clamp(length(vP), 0.0, 1.0);
  vec3 col = mix(uHot, uMid, smoothstep(0.0, 0.62, depth));
  col = mix(col, uDeep, smoothstep(0.55, 1.0, depth));

  col *= 0.55 + glow * 1.1;
  col += uHot * ribbon * 1.35;

  // 边缘一圈更亮的壳（体积发光体的自然表现）
  float fres = pow(1.0 - abs(dot(N, V)), 2.6);
  col += uMid * fres * 1.15;

  // 加色混合下 alpha 只作为"叠多少"的权重
  float alpha = clamp(0.42 + glow * 0.42 + ribbon * 0.3, 0.0, 1.0);
  gl_FragColor = vec4(col, alpha);
}
`;

/**
 * 发光版眼睛：比常规版更亮、更青，白高光点更大。
 * 加色混合下**深色几乎不可见** —— 所以发光脸的眼睛必须"由亮构成"，
 * 不能沿用常规版的深海军蓝（那会变成两个黑洞甚至消失）。
 */
function glowEyeTexture() {
  const { canvas, ctx } = makeCanvas(128, 160);
  const cx = 64;
  const cy = 80;
  const g = ctx.createRadialGradient(cx - 18, cy - 24, 2, cx, cy, 62);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.34, "rgba(150,225,255,0.95)");
  g.addColorStop(0.74, "rgba(60,140,235,0.8)");
  g.addColorStop(1, "rgba(30,90,190,0.06)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(cx, cy, 42, 54, 0, 0, Math.PI * 2);
  ctx.fill();
  return canvasTexture(canvas);
}

/** 发光版嘴：青色发光弧线（shadowBlur 就是"发光"本身，不用额外做后期） */
function glowSmileTexture() {
  const { canvas, ctx } = makeCanvas(256, 128);
  ctx.strokeStyle = "rgba(220,245,255,0.95)";
  ctx.lineWidth = 12;
  ctx.lineCap = "round";
  ctx.shadowColor = "rgba(140,220,255,0.95)";
  ctx.shadowBlur = 16;
  ctx.beginPath();
  ctx.moveTo(256 * 0.3, 128 * 0.44);
  ctx.quadraticCurveTo(256 * 0.5, 128 * 0.72, 256 * 0.7, 128 * 0.44);
  ctx.stroke();
  return canvasTexture(canvas);
}

export const plasma: LabVariant = {
  id: "05",
  name: "等离子能量球",
  oneLiner: "没有壳，光丝在球里自己卷动，最「有生命」的一版",
  tech: "ShaderMaterial + AdditiveBlending：内部标量场取脊线（pow）+ 球心到球面的三段色渐变 + 双层外发光",
  cost: "中：单次绘制但片元密集（3 组三角 × 全屏），无离屏",
  fidelity: "low",
  fidelityNote: "只借了参考图的配色与「球里在流动」，轮廓与材质气质完全不同（能量 vs 琉璃），所以只算低",
  needsWebGL: true,
  create(_host: HTMLElement, _opts: VariantOptions, stage: Stage): VariantRuntime {
    const geo = new SphereGeometry(1, 80, 56);
    const mat = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uHot: { value: new Color(0xdff3ff) },
        uMid: { value: new Color(PALETTE.cyan) },
        uDeep: { value: new Color(0x2f6fd0) },
      },
    });
    const ball = new Mesh(geo, mat);
    ball.renderOrder = 8;

    // 两张外发光：内圈紧、外圈散，合起来才是"能量在往外溢"
    const haloInner = makeHalo(PALETTE.cyan, 2.45, 0.42);
    haloInner.position.z = -0.1;
    const haloOuter = makeHalo(0x7fd6ff, 3.3, 0.24);
    haloOuter.position.z = -0.3;
    const haloInnerMat = haloInner.material as MeshBasicMaterial;
    const haloOuterMat = haloOuter.material as MeshBasicMaterial;

    // 发光五官：贴图单独持有，dispose 时手动清（buildFace 只管它自己那套）
    const eyeTex = glowEyeTexture();
    const mouthTex = glowSmileTexture();

    const face = buildFace({
      radius: 1.04,
      eyeMaterial: () =>
        new MeshBasicMaterial({ map: eyeTex, transparent: true, depthWrite: false, blending: AdditiveBlending }),
      mouthMaterial: () =>
        new MeshBasicMaterial({ map: mouthTex, transparent: true, depthWrite: false, blending: AdditiveBlending }),
    });
    face.group.renderOrder = 7;

    const shadow = makeContactShadow();

    stage.scene.add(shadow, stage.floatGroup);
    stage.tiltGroup.add(ball, haloInner, haloOuter);
    stage.floatGroup.add(face.group);

    return {
      update: (t) => {
        mat.uniforms.uTime.value = t;
        ball.rotation.y = t * 0.16;
        ball.rotation.x = Math.sin(t * 0.27) * 0.28;
        const s = 1 + Math.sin(t * 1.45) * 0.045;
        ball.scale.setScalar(s);
        face.group.scale.setScalar(s);
        stage.floatGroup.position.y = Math.sin(t * 1.05 + 1.1) * 0.025;
        haloInner.scale.setScalar(1 + Math.sin(t * 1.45) * 0.07);
        haloOuter.scale.setScalar(1 + Math.sin(t * 1.1 + 0.8) * 0.09);
        haloInnerMat.opacity = 0.66 + Math.sin(t * 2.1) * 0.16;
        haloOuterMat.opacity = 0.5 + Math.sin(t * 1.3 + 1.4) * 0.14;
        applyBlink(face, blinkScale(t));
      },
      dispose: () => {
        geo.dispose();
        mat.dispose();
        face.dispose();
        eyeTex.dispose();
        mouthTex.dispose();
        disposeTempMesh(haloInner);
        disposeTempMesh(haloOuter);
        disposeTempMesh(shadow);
      },
    };
  },
};
