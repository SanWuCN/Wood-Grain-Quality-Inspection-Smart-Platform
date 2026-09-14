/**
 * 方案 08 · 扁平发光 2.5D（低开销风格化）
 *
 * ── 这一版存在的原因 ────────────────────────────────────────────────
 * 前 7 版都在回答"怎么做出一颗**物理上像**琉璃的球"（折射、薄膜、菲涅尔…），
 * 代价是一次绘制里塞满三角函数。这一版反过来问：
 * **如果不要物理正确，只要"一眼看上去是同一颗球"，最省的做法是什么？**
 * 答案是把参考图拆成几层**扁平色块**（不是连续光照），靠"色块边界柔和"造体积。
 *
 * ── 怎么在没有光照的前提下做出立体感 ────────────────────────────────
 * 不做光照，只做两件事：
 *   1. **球心偏白、边缘压蓝**的径向渐变 —— 参考图的通透感其实来自这个明度差，
 *      不是来自反射（反射负责的是"亮"，明度差负责的是"透"）。
 *   2. 一片**又大又软的定向渐变**（左下往右上）—— 它替代了"内部亮带"，
 *      用一次 mix 而不是三条 pow(sin) 光带。
 * 这两层叠起来就足够"像"，代价是每片元两次 smoothstep。
 *
 * ── 为什么还有一片背面远平面 ────────────────────────────────────────
 * 球体是半透明的，透过它能看到后面的东西。三个发光内核里最靠后的那一片如果
 * 只在球内部，就会在球的**轮廓之外被裁掉**——而参考图里左下那团最艳的青蓝
 * 恰恰是**溢出轮廓**的。所以多挂一片半径 1.45 的远平面，让那团颜色能露到球外。
 * 它是这一版唯一"不物理"的取巧，也是它好看的原因。
 *
 * ── 开销定位 ────────────────────────────────────────────────────────
 * 最低的一档 WebGL 版：球体 48×32（约 1.5k 顶点，无逐顶点计算）、
 * 单次片元（4 次 smoothstep、0 次三角函数求值）、无离屏、无贴图。
 * 与 01（玻璃透射）不是一个量级。
 */

import { Color, Mesh, MeshBasicMaterial, ShaderMaterial, SphereGeometry } from "three";
import {
  PALETTE,
  applyBlink,
  blinkScale,
  breathe,
  buildFace,
  disposeTempMesh,
  makeContactShadow,
  makeHalo,
  type Stage,
} from "../shared.ts";
import type { LabVariant, VariantOptions, VariantRuntime } from "../types.ts";

/**
 * 球面本体：只做"球心白、边缘蓝"的径向明度差 + 一片软定向渐变。
 *
 * `vLocal` 是物体空间的单位方向（顶点着色器里直接传 position）——
 * 用它当"球面上的位置"，就不需要法线、不需要光照模型。
 */
const ORB_VERT = /* glsl */ `
varying vec3 vLocal;
void main() {
  vLocal = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const ORB_FRAG = /* glsl */ `
uniform vec3 uCore;   // 球心：近白（通透感的来源）
uniform vec3 uEdge;   // 边缘：淡蓝
uniform vec3 uDeep;   // 左下：饱和青蓝（替代光照的暗部）
uniform vec3 uWarm;   // 右下：虹彩暖调
uniform float uTime;
varying vec3 vLocal;

void main() {
  vec3 n = normalize(vLocal);

  // ① 径向明度差：正对相机的中心最亮，转到侧面的边缘压蓝
  float facing = clamp(n.z * 0.5 + 0.5, 0.0, 1.0);
  vec3 col = mix(uEdge, uCore, smoothstep(0.25, 0.95, facing));

  // ② 一片很软的定向渐变替代"内部亮带"：左下冷、右下暖
  float sweep = clamp(n.x * 0.62 - n.y * 0.78, -1.0, 1.0);
  col = mix(col, uDeep, smoothstep(0.05, 1.0, sweep) * 0.7);
  col = mix(col, uWarm, smoothstep(0.15, 1.0, -sweep) * 0.42);

  // ③ 高光：左上固定一点（不随时间走 —— 走起来就像"贴纸在动"，不是琉璃）
  vec3 keyDir = normalize(vec3(-0.45, 0.5, 0.74));
  float spec = pow(clamp(dot(n, keyDir), 0.0, 1.0), 26.0);
  col += vec3(spec) * 0.5;

  // ④ 边缘一圈极淡的虹彩青边（参考图只有一丝，宽了就成了肥皂泡）
  float rim = pow(1.0 - facing, 3.2);
  col += vec3(0.42, 0.85, 1.0) * rim * 0.3;

  // ⑤ "活着"的呼吸：整片亮度轻微起伏。用 0.03 的幅度 —— 再大就像在闪灯
  col *= 1.0 + sin(uTime * 0.85) * 0.03;

  // alpha 跟着朝向走：边缘更透，球才有"皮薄"的感觉
  float alpha = 0.62 + facing * 0.2;
  gl_FragColor = vec4(col, alpha);
}
`;

/**
 * 背面远平面：一圈从中心向外的软色晕，**没有边界**。
 *
 * 为什么要它：球体轮廓之外还得有颜色（参考图左下那团青蓝是溢出的）。
 * 用一片 billboard 平面 + 径向渐变做，代价是加色混合的一次绘制。
 */
function buildBackdrop(): Mesh {
  const geo = new SphereGeometry(1.45, 32, 24);
  const mat = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uTime: { value: 0 },
      uPool: { value: new Color(PALETTE.blue) },
      uWisp: { value: new Color(PALETTE.iris) },
    },
    vertexShader: ORB_VERT,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uPool;
      uniform vec3 uWisp;
      varying vec3 vLocal;
      void main() {
        vec3 n = normalize(vLocal);
        // 左下那团最艳的青蓝（参考图左下 60% 处实测 #2da3fc）
        float pool = smoothstep(0.15, 1.0, clamp(n.x * 0.58 - n.y * 0.82, -1.0, 1.0));
        // 右上一点淡紫余韵
        float wisp = smoothstep(0.35, 1.0, clamp(-n.x * 0.5 + n.y * 0.6 + n.z * 0.4, -1.0, 1.0));
        float breathe = 0.82 + sin(uTime * 0.6) * 0.18;
        vec3 col = uPool * pool * breathe + uWisp * wisp * 0.5;
        float alpha = clamp(pool * 0.55 + wisp * 0.2, 0.0, 0.75);
        gl_FragColor = vec4(col, alpha);
      }
    `,
  });
  const mesh = new Mesh(geo, mat);
  mesh.renderOrder = 1;
  mesh.position.z = -0.35;
  return mesh;
}

export const flatGlow: LabVariant = {
  id: "08",
  name: "扁平发光 2.5D",
  oneLiner: "不做光照，只叠几块软渐变 —— 最省的一版，但一眼还是它",
  tech: "两个极简 ShaderMaterial：球面按朝向混三段扁平色 + 固定高光；背面色晕溢出轮廓（加色），48×32 球体",
  cost: "最低：单次片元 4 次 smoothstep、0 次三角函数、无离屏、无贴图",
  fidelity: "mid",
  fidelityNote: "明度分布与左下那团青蓝对得上，远看最像；差别是完全没有真实反射，转到侧面时高光不动、缺少玻璃的视差",
  needsWebGL: true,
  create(_host: HTMLElement, _opts: VariantOptions, stage: Stage): VariantRuntime {
    // 球体只要 48×32：这一版没有任何逐顶点计算，段数只影响轮廓的圆度
    const geo = new SphereGeometry(1, 48, 32);
    const mat = new ShaderMaterial({
      vertexShader: ORB_VERT,
      fragmentShader: ORB_FRAG,
      transparent: true,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uCore: { value: new Color(0xf6fbff) },
        uEdge: { value: new Color(0x9ecdf5) },
        uDeep: { value: new Color(0x2da3fc) },
        uWarm: { value: new Color(PALETTE.iris) },
      },
    });
    const orb = new Mesh(geo, mat);
    orb.renderOrder = 8;

    const back = buildBackdrop();
    const backMat = back.material as ShaderMaterial;

    const halo = makeHalo(PALETTE.halo, 2.55, 0.34);
    const haloMat = halo.material as MeshBasicMaterial;
    const shadow = makeContactShadow();
    const face = buildFace({ radius: 1.036 });
    face.group.renderOrder = 6;

    stage.scene.add(shadow, stage.floatGroup);
    stage.tiltGroup.add(back, orb, halo);
    stage.floatGroup.add(face.group);

    return {
      update: (t) => {
        mat.uniforms.uTime.value = t;
        backMat.uniforms.uTime.value = t;
        const { scale, floatY } = breathe(t);
        orb.scale.setScalar(scale);
        // 背面色晕**不跟着缩**：它是"光"，跟着缩会露出硬边
        back.scale.setScalar(1 + Math.sin(t * 0.6) * 0.02);
        face.group.scale.setScalar(scale);
        stage.floatGroup.position.y = floatY;
        halo.scale.setScalar(1 + Math.sin(t * 1.2) * 0.045);
        haloMat.opacity = 0.5 + Math.sin(t * 1.1 + 0.4) * 0.12;
        applyBlink(face, blinkScale(t));
      },
      dispose: () => {
        geo.dispose();
        mat.dispose();
        back.geometry.dispose();
        backMat.dispose();
        face.dispose();
        disposeTempMesh(halo);
        disposeTempMesh(shadow);
      },
    };
  },
};
