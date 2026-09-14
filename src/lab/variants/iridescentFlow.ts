/**
 * 方案 03 · 虹彩渐变 ShaderMaterial（内部流动亮带）
 *
 * ── 怎么做出"渐变半透明" ──────────────────────────────────────────
 * 全部写在一个片元着色器里，四层叠出来：
 *   ① **流动渐变底**：把球面位置映射成一个连续参数，再过一遍
 *      「蓝→青→紫」的三段插值 —— 这个映射本身在随时间缓慢漂移，
 *      所以"渐变"是活的，不是贴上去的一张皮。
 *   ② **内部流动亮带**：两条宽亮带 + 一条细亮线，各自沿不同方向、
 *      不同速度扫过球面。带宽用 `pow(sin, k)` 收窄 —— 这是"亮带"而不是
 *      "整片发光"的关键（k 越大越像一道光）。
 *   ③ **菲涅尔**：`pow(1-|N·V|, 2.4)`。掠射（球的边缘）处最亮、最不透明，
 *      正对相机的中心最亮通透 —— "半透明但轮廓清晰"就是这一条来实现的。
 *   ④ **脸的保护**：球心正前方锥形范围内把亮带压掉
 *      （`faceMask`），否则光带会扫过眼睛，脸就糊了。
 *      锥体判据和 shared.ts 的 `faceRadiusAt()` 是同一个球面几何。
 *
 * ── 与 01/02 的区别 ──────────────────────────────────────────────
 * 01 的渐变来自物理厚度（真实但淡），02 的渐变跟着几何抖；
 * 这一版的渐变**最艳、最像参考图那张原图的配色**，代价是它不物理 ——
 * 亮带是"画"出来的，转到侧面看不会像真玻璃那样有视差。
 *
 * ── 开销 ──────────────────────────────────────────────────────────
 * 低。单次绘制、纯片元运算、无离屏缓冲、无贴图采样。
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
varying vec3 vN;
varying vec3 vP;
void main() {
  vN = normalize(normalMatrix * normal);
  vP = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAGMENT = /* glsl */ `
uniform float uTime;
uniform vec3 uDeep;
uniform vec3 uBlue;
uniform vec3 uCyan;
uniform vec3 uIris;
uniform vec3 uViolet;
varying vec3 vN;
varying vec3 vP;

// 五段色带：深蓝 → 蓝 → 青 → 淡紫 → 紫。
// 参考图球体是"很淡的白蓝心 + 左下艳青 + 右上淡紫"，所以浅色段占的区间要大。
vec3 palette(float t) {
  t = fract(t);
  float s = t * 5.0;
  float i = floor(s);
  float f = fract(s);
  vec3 c0 = uDeep, c1 = uBlue, c2 = uCyan, c3 = uIris, c4 = uViolet;
  vec3 a = i < 1.0 ? c0 : (i < 2.0 ? c1 : (i < 3.0 ? c2 : c3));
  vec3 b = i < 1.0 ? c1 : (i < 2.0 ? c2 : (i < 3.0 ? c3 : c4));
  return mix(a, b, f);
}

// 脸的锥形保护区：与 shared.ts 的 faceRadiusAt() 同一套球面几何
float faceMask(vec3 p) {
  float dy = p.y - 0.174;
  float r = sqrt(max(0.0, 1.0 - dy * dy));
  vec2 d = p.xz - vec2(0.0, r);
  return smoothstep(0.34, 0.58, length(d));
}

void main() {
  vec3 p = normalize(vP);

  // ① 流动渐变：位置 + 时间 → 色带参数
  float g = p.y * 0.55 + 0.5
          + p.x * 0.30
          + p.z * 0.12
          + sin(uTime * 0.28 + p.y * 1.1) * 0.07;
  vec3 base = palette(g * 1.05 + uTime * 0.02);

  // ② 内部流动亮带（三档频率：宽 / 中 / 细）
  float b1 = pow(0.5 + 0.5 * sin(p.y * 3.6 - p.x * 2.3 + uTime * 0.95), 8.0);
  float b2 = pow(0.5 + 0.5 * sin(p.x * 2.9 + p.z * 2.1 - uTime * 0.72), 10.0);
  float b3 = pow(0.5 + 0.5 * sin(p.y * 7.2 - p.z * 4.4 + uTime * 1.5), 26.0);
  float band = b1 * 0.85 + b2 * 0.7 + b3 * 0.9;

  float fm = faceMask(p);
  band *= fm;                       // 亮带避开脸
  base = mix(vec3(0.86, 0.93, 1.0), base, 0.42 + 0.58 * fm);  // 脸附近压成近白

  // ③ 菲涅尔：边缘亮而厚，中心通透
  float fres = pow(1.0 - abs(dot(normalize(vN), normalize(cameraPosition - p))), 2.4);

  vec3 col = base * (0.95 + band * 0.85);
  col += vec3(0.85, 0.97, 1.0) * band * 0.5;
  col += uIris * fres * 0.55;
  col += uCyan * pow(fres, 3.0) * 0.35;

  // 左上主光的高光：参考图那片大面积反光的位置
  vec3 L = normalize(vec3(-0.5, 0.75, 0.55));
  float spec = pow(max(dot(normalize(vN), L), 0.0), 26.0);
  col += vec3(1.0) * spec * 0.34;

  float alpha = clamp(0.30 + fres * 0.64 + band * 0.2, 0.0, 0.98);
  gl_FragColor = vec4(col, alpha);
}
`;

export const iridescentFlow: LabVariant = {
  id: "03",
  name: "虹彩渐变流动",
  oneLiner: "蓝→青→紫整片流动，内部有三条亮带在扫，配色最贴参考图",
  tech: "ShaderMaterial 片元：五段色带 + 三条 pow(sin) 亮带 + 菲涅尔控透明；锥形遮罩保护五官",
  cost: "低：单次绘制、纯片元运算、无离屏、无贴图",
  fidelity: "high",
  fidelityNote: "配色与亮带走向是照着参考图逐层对的；不足是亮带靠着色器\"画\"，侧看缺少真玻璃的视差",
  needsWebGL: true,
  create(_host: HTMLElement, _opts: VariantOptions, stage: Stage): VariantRuntime {
    const geo = new SphereGeometry(1, 72, 52);
    const mat = new ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uDeep: { value: new Color(PALETTE.deep) },
        uBlue: { value: new Color(PALETTE.blue) },
        uCyan: { value: new Color(PALETTE.cyan) },
        uIris: { value: new Color(PALETTE.iris) },
        uViolet: { value: new Color(0xb48ce8) },
      },
    });
    const orb = new Mesh(geo, mat);
    orb.renderOrder = 8;

    const face = buildFace({ radius: 1.04 });
    face.group.renderOrder = 6;

    const halo = makeHalo(PALETTE.halo, 2.6, 0.52);
    const shadow = makeContactShadow();

    stage.scene.add(shadow, stage.floatGroup);
    stage.tiltGroup.add(orb, halo);
    stage.floatGroup.add(face.group);

    return {
      update: (t) => {
        mat.uniforms.uTime.value = t;
        const s = 1 + Math.sin(t * 1.35) * 0.035;
        orb.scale.setScalar(s);
        face.group.scale.setScalar(s);
        stage.floatGroup.position.y = Math.sin(t * 1.05 + 1.1) * 0.022;
        // 整球极慢自转 → 亮带在球面上"漂"过去（比只让亮带自身移动更像内部在流动）
        orb.rotation.y = t * 0.13;
        halo.scale.setScalar(1 + Math.sin(t * 1.35) * 0.05);
        (halo.material as MeshBasicMaterial).opacity = 0.66 + Math.sin(t * 1.35) * 0.14;
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
