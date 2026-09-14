/**
 * 方案 01 · 玻璃透射球（真实折射，MeshPhysicalMaterial 全参数）
 *
 * ── 怎么做出"渐变半透明" ──────────────────────────────────────────
 * 这一版**不写着色器**，材质全部交给 three 的 PBR：
 *   · `transmission: 1` + `ior: 1.45` + `thickness: 0.85`
 *     → 玻璃后面的东西会被真实采样并**按折射率偏移**，球体内部的
 *       内核与空气背景透过球壁时产生真实的位移与放大 —— 琉璃球"通透"的来源。
 *   · `iridescence: 0.6` + `iridescenceIOR: 1.4`
 *     → three 内置的薄膜干涉，专门负责参考图上那一圈蓝→青→紫的虹彩边。
 *   · `attenuationColor` + `attenuationDistance`
 *     → **真正的"渐变"在这里**：玻璃越厚的地方颜色越浓。球心看过去的玻璃最厚，
 *       所以球心染上淡淡的蓝；边缘最薄，几乎无色 —— 这正是"渐变半透明"的物理成因，
 *       比拿一张渐变贴图贴上去真得多。
 *   · `setEnvironment`（程序化环境贴图）+ clearcoat
 *     → 左上那片大面积高光、右上第二处镜面点。
 *
 * 渐变不是画上去的，是**厚度差 + 薄膜干涉**自然长出来的。
 *
 * ── 开销 ──────────────────────────────────────────────────────────
 * 最高的一档。`transmission` 会让每个渲染器**每帧多渲染一遍整个场景**到
 * 一张 `transmissionResolutionScale` 指定的离屏贴图上（这里按画布尺寸自适应，
 * 格子态 110px 时约 96×96，放大态 1024px 时约 512×512）。
 * 8 块画布并排时它是最吃 GPU 的一版，但格子态下仍然跑得动（实测见对照表）。
 */

import { Color, Mesh, MeshBasicMaterial, MeshPhysicalMaterial, SphereGeometry } from "three";
import {
  PALETTE,
  applyBlink,
  blinkScale,
  breathe,
  buildFace,
  disposeTempMesh,
  makeContactShadow,
  makeHalo,
  withEnv,
  type Stage,
} from "../shared.ts";
import type { LabVariant, VariantOptions, VariantRuntime } from "../types.ts";

export const glassTransmission: LabVariant = {
  id: "01",
  name: "玻璃透射球",
  oneLiner: "一颗真正会折射的琉璃球，最贴参考图的通透感",
  tech: "MeshPhysicalMaterial：transmission=1 / ior=1.45 / thickness / iridescence / attenuation 厚度染色 + 程序化环境贴图",
  cost: "偏高：每帧多渲一遍场景进 transmission 离屏缓冲",
  fidelity: "high",
  fidelityNote: "厚度染色 + 薄膜干涉就是参考图那套物理成因，左上高光与虹彩边位置一致；差别是本版偏\"清玻璃\"，参考图的青蓝更艳（靠 attenuation 调浓）",
  needsWebGL: true,
  create(_host: HTMLElement, _opts: VariantOptions, stage: Stage): VariantRuntime {
    const glass = buildGlass(stage);
    const coreMat = glass.core.material as MeshBasicMaterial;
    const haloMat = glass.halo.material as MeshBasicMaterial;
    return {
      update: (t) => {
        // 画布尺寸会变（格子态 ↔ 放大态），折射分辨率每帧跟着走一次，代价是两次比较
        refitRefraction(stage);
        const { scale, floatY } = breathe(t);
        glass.glass.scale.setScalar(scale);
        glass.group.position.y = floatY;
        // 内核缓慢自转 → 透过球壁看到的内部结构在动（折射会把它放大、位移）
        glass.core.rotation.y = t * 0.34;
        glass.core.rotation.x = Math.sin(t * 0.24) * 0.5;
        // 内核呼吸式明暗：玻璃球看起来"里面有东西在活"
        coreMat.opacity = 0.5 + Math.sin(t * 0.9) * 0.14;
        glass.halo.scale.setScalar(1 + Math.sin(t * 1.35) * 0.05);
        haloMat.opacity = 0.62 + Math.sin(t * 1.35) * 0.14;
        applyBlink(glass.face, blinkScale(t));
      },
      dispose: () => {
        glass.dispose();
      },
    };
  },
};

interface GlassParts {
  glass: Mesh;
  group: ReturnType<typeof buildFace>["group"];
  core: Mesh;
  halo: Mesh;
  face: ReturnType<typeof buildFace>;
  dispose: () => void;
}

/**
 * 折射离屏缓冲的分辨率：**跟着画布尺寸走**。
 *
 * 格子态（约 110px）用 96~128 就够 —— 那么小的额外一遍渲染几乎免费；
 * 放大态（约 1024px）才提到 512。写死一个值的话，要么格子态白烧 GPU、
 * 要么放大态糊成一片。
 *
 * ⚠ 2026-09-14 修正：three 0.183 **把 `transmissionResolutionScale` 从
 * `MeshPhysicalMaterial` 挪到了 `WebGLRenderer`**（源码位置：`WebGLRenderer.js:289`
 * 的默认值 + `:1979` 的 `setSize` 消费点）。写在材质上**编译不过**；
 * 而如果写成 `(mat as any).xxx = n` 就会静默失效 —— 那种错只在放大看细节时
 * 才被发现。所以现在写在 renderer 上，并且每帧重算（画布尺寸会变）。
 */
function refitRefraction(stage: Stage): void {
  const longest = Math.max(stage.size.width, stage.size.height) || 1;
  const target = Math.max(96, Math.min(512, Math.round(longest * 0.75)));
  const scale = target / longest;
  if (Math.abs(stage.renderer.transmissionResolutionScale - scale) > 0.01) {
    stage.renderer.transmissionResolutionScale = scale;
  }
}

function buildGlass(stage: Stage): GlassParts {
  // 球体网格：64×48 段足够让虹彩边缘平滑（参考图那颗球轮廓是绝对正圆）
  const geo = new SphereGeometry(1, 64, 48);

  const mat = withEnv(
    new MeshPhysicalMaterial({
      color: new Color(0xffffff),
      metalness: 0,
      roughness: 0.055,
      // 透射：1 = 完全当玻璃处理（背后内容会被折射采样）
      transmission: 1,
      ior: 1.45,
      thickness: 0.85,
      // 厚度染色：球心看过去玻璃最厚 → 染上淡蓝；边缘最薄 → 近无色
      attenuationColor: new Color(PALETTE.blue),
      attenuationDistance: 1.15,
      // 薄膜干涉：参考图边缘那圈蓝→青→紫
      iridescence: 0.62,
      iridescenceIOR: 1.42,
      iridescenceThicknessRange: [120, 640],
      // 清漆：让左上高光更"脆"，像抛过光的琉璃
      clearcoat: 0.65,
      clearcoatRoughness: 0.08,
      specularIntensity: 1,
      transparent: true,
      opacity: 1,
    }),
    stage,
    1.5,
  );

  /**
   * 折射离屏缓冲的分辨率：**跟着画布尺寸走**。
   * 格子态（110px 左右）用 128 就够 —— 128² 的额外一遍渲染几乎免费；
   * 放大态（1024px）才提到 512。写死一个值的话，要么格子态浪费、
   * 要么放大态糊成一片。
   */
  const glass = new Mesh(geo, mat);
  glass.renderOrder = 10;

  // 内部发光核：不写 shader，一个自发光小球 + 加色 halo 就够（简约但有效）
  const coreGeo = new SphereGeometry(0.42, 32, 24);
  const coreMat = new MeshBasicMaterial({
    color: new Color(PALETTE.cyan),
    transparent: true,
    opacity: 0.6,
    depthWrite: false,
  });
  const core = new Mesh(coreGeo, coreMat);
  core.renderOrder = 2;

  const halo = makeHalo(PALETTE.halo, 2.62, 0.5);
  halo.position.z = -0.2;
  // 渲染次序：先外发光 → 再内核 → 再脸 → 最后球壳。
  // 球壳必须最后画（它的 transmission 采样要求背后的东西已经就位）。
  halo.renderOrder = 0;

  const face = buildFace({ radius: 1.034 });
  face.group.renderOrder = 6;

  const shadow = makeContactShadow();

  stage.scene.add(shadow, stage.floatGroup);
  stage.tiltGroup.add(glass, core, halo);
  stage.floatGroup.add(face.group);

  return {
    glass,
    group: face.group,
    core,
    halo,
    face,
    dispose: () => {
      geo.dispose();
      coreGeo.dispose();
      coreMat.dispose();
      mat.dispose();
      face.dispose();
      disposeTempMesh(halo);
      disposeTempMesh(shadow);
    },
  };
}
