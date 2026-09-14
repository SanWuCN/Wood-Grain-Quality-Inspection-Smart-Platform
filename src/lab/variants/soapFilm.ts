/**
 * 方案 06 · 肥皂泡薄膜干涉（thin-film 虹彩，强透明）
 *
 * ── 怎么做出"渐变半透明" ──────────────────────────────────────────
 * 这一版跟其他几版的**根本区别**：虹彩不是"配"出来的，是**算**出来的。
 *
 * 物理模型（薄膜干涉）：
 *   光在膜的上表面和下表面各反射一次，两束光的光程差为
 *       Δ = 2 · n · d · cos(θ_t)
 *   其中 d 是膜厚、n 是折射率、θ_t 是膜内的折射角。
 *   光程差对某个波长 λ 恰好是半波长奇数倍时该波长相消、偶数倍时相长，
 *   所以"反射率"是 Δ/λ 的余弦函数：
 *       R(λ) = 0.5 + 0.5 · cos(2π · Δ/λ)
 *   把 R 分别取 R/G/B 三个波长（650/550/440nm）就得到一条**随膜厚与视角
 *   连续变化**的彩虹色 —— 这正是肥皂泡和油膜上那层流动彩虹的成因。
 *
 * 所以"渐变"在这里的来源是：**膜厚随位置缓慢变化**（一层漂移的噪声）
 * × **视角随球面变化**（cos θ 从中心 1 掉到边缘 0）。
 * 两个变量一起扫过整个可见光谱，于是整颗球是一张活的虹彩渐变，
 * 而它**完全没有用任何渐变贴图或调色板**。
 *
 * 强透明：球心几乎全透（alpha≈0.1），只有掠射的边缘因为光程变短、
 * 干涉更强而变亮变实。
 *
 * ── 与 03 的区别 ──────────────────────────────────────────────────
 * 03 的色带是"我挑的五个颜色"（设计感强、可控、像参考图）；
 * 这一版是"物理算出来的颜色"（不可控、但真实、转到侧面颜色会自然变化）。
 *
 * ── 开销 ──────────────────────────────────────────────────────────
 * 低。单次绘制、纯片元运算（三次 cos 求 RGB）。
 */

import { Mesh, MeshBasicMaterial, ShaderMaterial, SphereGeometry } from "three";
import { applyBlink, blinkScale, buildFace, disposeTempMesh, makeContactShadow, makeHalo, type Stage } from "../shared.ts";
import type { LabVariant, VariantOptions, VariantRuntime } from "../types.ts";

const VERT = /* glsl */ `
varying vec3 vN;
varying vec3 vP;
varying vec3 vView;
void main() {
  vN = normalize(normalMatrix * normal);
  vP = normalize(position);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vView = -mv.xyz;
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */ `
uniform float uTime;
uniform float uThickness;
varying vec3 vN;
varying vec3 vP;
varying vec3 vView;

/**
 * 薄膜干涉 → RGB。
 *
 * 光程差 Δ = 2·n·d·cosθt（θt 是膜内折射角，这里用视线与法线夹角的余弦近似，
 * 对极薄的膜误差可忽略）。取 R/G/B 三个波长代入 R(λ)=0.5+0.5·cos(2πΔ/λ)，
 * 就得到该点的干涉色。除以波长归一化时乘了 1000，把纳米换成"膜厚的单位"。
 */
vec3 thinFilm(float cosTheta, float d) {
  float delta = 2.0 * 1.33 * d * cosTheta;   // n=1.33 近似水的折射率
  vec3 lambda = vec3(650.0, 550.0, 440.0) / 1000.0;
  vec3 phase = 6.2831853 * delta / lambda;
  return 0.5 + 0.5 * cos(phase);
}

void main() {
  vec3 N = normalize(vN);
  vec3 V = normalize(vView);
  float cosT = clamp(dot(N, V), 0.02, 1.0);

  // 膜厚：一层缓慢漂移的噪声 + 一点位置项 —— 泡泡上"厚度不均"才是彩虹会流动的原因
  float d = uThickness
          + sin(vP.y * 2.6 + uTime * 0.55) * 0.16
          + sin(vP.x * 3.4 - vP.z * 2.1 + uTime * 0.42) * 0.13
          + sin(vP.z * 5.1 + uTime * 0.31) * 0.07;
  d = max(d, 0.02);

  vec3 iri = thinFilm(cosT, d);

  // 泡泡本身几乎无色：只有 8% 的白 + 干涉色
  vec3 col = vec3(0.08) + iri * 0.92;

  // 薄膜正面（中心）几乎看不见、掠射（边缘）很亮 —— 泡泡的典型特征
  float fres = pow(1.0 - cosT, 3.0);
  col = mix(col * 0.55, col * 1.35, fres);
  // 边缘再加一道很窄的白色亮环（泡泡边缘的反光）
  col += vec3(1.0) * pow(fres, 2.4) * 0.55;

  // 强透明：球心 alpha≈0.12，边缘收到 0.75
  float alpha = clamp(0.12 + fres * 0.72, 0.0, 0.82);
  gl_FragColor = vec4(col, alpha);
}
`;

export const soapFilm: LabVariant = {
  id: "06",
  name: "肥皂泡薄膜干涉",
  oneLiner: "彩虹是算出来的（薄膜干涉），不是配出来的，转到哪都变",
  tech: "ShaderMaterial 片元：光程差 Δ=2nd·cosθ 代入 R(λ)=0.5+0.5cos(2πΔ/λ) 求 RGB；膜厚用漂移噪声",
  cost: "低：单次绘制、三次 cos、无离屏、无贴图",
  fidelity: "low",
  fidelityNote: "「强透明 + 边缘虹彩」的方向对，但参考图的虹彩只在边缘一丝，这一版整颗都在泛彩虹（更像肥皂泡），色相与参考图有距离",
  needsWebGL: true,
  create(_host: HTMLElement, _opts: VariantOptions, stage: Stage): VariantRuntime {
    const geo = new SphereGeometry(1, 88, 60);
    const mat = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uThickness: { value: 0.52 },
      },
    });
    const bubble = new Mesh(geo, mat);
    bubble.renderOrder = 8;

    // 泡泡里的脸：用半透的深蓝（tint + opacity 在 buildFace 里生效，
    // 贴图仍然是那张标准 kawaii 五官 —— 不要自己传材质，那会把贴图丢掉）
    const face = buildFace({
      radius: 1.05,
      tint: 0x2a4f8f,
      opacity: 0.44,
    });

    const halo = makeHalo(0xcfeaff, 2.62, 0.34);
    const haloMat = halo.material as MeshBasicMaterial;
    const shadow = makeContactShadow();

    stage.scene.add(shadow, stage.floatGroup);
    stage.tiltGroup.add(bubble, halo);
    stage.floatGroup.add(face.group);

    return {
      update: (t) => {
        mat.uniforms.uTime.value = t;
        // 膜厚整体缓慢变厚变薄 → 整颗球的色相在"呼吸"
        mat.uniforms.uThickness.value = 0.52 + Math.sin(t * 0.42) * 0.14;
        bubble.rotation.y = -t * 0.1;
        const s = 1 + Math.sin(t * 1.2) * 0.04;
        bubble.scale.set(s, s * (1 + Math.sin(t * 1.2 + 0.5) * 0.02), s);
        face.group.scale.setScalar(s);
        stage.floatGroup.position.y = Math.sin(t * 1.05 + 1.1) * 0.026;
        halo.scale.setScalar(1 + Math.sin(t * 1.2) * 0.06);
        haloMat.opacity = 0.42 + Math.sin(t * 1.2) * 0.12;
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
