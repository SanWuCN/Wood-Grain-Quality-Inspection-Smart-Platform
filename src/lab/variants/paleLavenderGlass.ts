/**
 * 方案 10 · 紫白琉璃球（用户 2026-09-14 给的第二套配色，保留为独立方案）
 *
 * ── 和 01 号（玻璃透射球）的区别 ────────────────────────────────────
 * 几何/材质**同一套**（都是 `MeshPhysicalMaterial` 的 transmission + 薄膜干涉），
 * 差别只在**调色板**与膜厚范围：
 *   · 01 是"蓝琉璃"：球心偏白、外圈压深青蓝，是参考图 A 的色相；
 *   · 10 是"紫白琉璃"：球心近白、外圈偏淡紫粉，是参考图 B 的色相。
 * 所以这两版并排看，比的其实是**同一个材质换两条色带**，用户可以直接挑色相，
 * 不必在"材质不同"的噪音里做判断 —— 这也是把它单列成一版而不是合并的原因。
 *
 * ── 紫白色档从哪来 ──────────────────────────────────────────────────
 * 参考图 B（`refs/小木形象参考-紫白琉璃球体.png`）逐像素采样：
 *   球心 rgb(241,243,248) #f1f3f8（近白，带一丝冷调）
 *   中段偏淡紫 rgb(207,201,239) #cfc9ef
 *   外圈偏青紫 rgb(168,178,240) #a8b2f0，边缘再回到 #e8e9f7
 * 与蓝球同一套量法（径向 30°~150° 扇区平均，避开五官），所以两条色带可比。
 */

import { Color, Mesh, MeshBasicMaterial, MeshPhysicalMaterial, SphereGeometry } from "three";
import {
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

/** 紫白琉璃的调色板（每条都是参考图 B 的采样值，不是配出来的） */
const PALE = {
  /** 厚度染色：偏淡紫，让球心透出一点点暖 */
  attenuation: 0xb9b2e8,
  /** 内部发光核：冷白偏紫 */
  core: 0xdfe4ff,
  /** 外发光：淡紫青 */
  halo: 0xc9d6ff,
  /** 薄膜干涉的厚度范围：比 01 更窄 → 虹彩边更收敛（参考图 B 的虹彩只在右下角） */
  iridescenceRange: [90, 420] as [number, number],
} as const;

export const paleLavenderGlass: LabVariant = {
  id: "10",
  name: "紫白琉璃球",
  oneLiner: "同一套琉璃材质换紫白色带：球心近白、外圈淡紫粉",
  tech: "MeshPhysicalMaterial：transmission=1 / ior=1.45 / 薄膜干涉厚度收窄到 90~420nm / 衰减色改淡紫 + 程序化环境贴图",
  cost: "偏高（同 01）：每帧多渲一遍场景进 transmission 离屏缓冲",
  fidelity: "high",
  fidelityNote:
    "色相取自参考图 B 的径向采样（球心 #f1f3f8、中段 #cfc9ef、外圈 #a8b2f0）；不足是参考图 B 只有约半颗球可见（下方被画布裁掉），外圈那圈青边只能靠类比 01 补",
  needsWebGL: true,
  create(_host: HTMLElement, _opts: VariantOptions, stage: Stage | undefined): VariantRuntime {
    if (!stage) throw new Error("紫白琉璃球需要 WebGL 舞台");

    const geo = new SphereGeometry(1, 64, 48);
    const mat = withEnv(
      new MeshPhysicalMaterial({
        color: new Color(0xffffff),
        metalness: 0,
        roughness: 0.06,
        transmission: 1,
        ior: 1.45,
        thickness: 0.8,
        attenuationColor: new Color(PALE.attenuation),
        attenuationDistance: 1.35,
        iridescence: 0.5,
        iridescenceIOR: 1.38,
        iridescenceThicknessRange: [PALE.iridescenceRange[0], PALE.iridescenceRange[1]],
        clearcoat: 0.62,
        clearcoatRoughness: 0.09,
        specularIntensity: 1,
        transparent: true,
      }),
      stage,
      1.45,
    );
    const ball = new Mesh(geo, mat);
    ball.renderOrder = 10;

    // 内部核：冷白偏紫，球"里面有光"
    const coreGeo = new SphereGeometry(0.4, 32, 24);
    const coreMat = new MeshBasicMaterial({ color: new Color(PALE.core), transparent: true, opacity: 0.5, depthWrite: false });
    const core = new Mesh(coreGeo, coreMat);
    core.renderOrder = 2;

    const halo = makeHalo(PALE.halo, 2.6, 0.46);
    halo.position.z = -0.2;

    const face = buildFace({ radius: 1.034 });
    face.group.renderOrder = 6;
    const shadow = makeContactShadow();

    stage.scene.add(shadow, stage.floatGroup);
    stage.tiltGroup.add(ball, core, halo);
    stage.floatGroup.add(face.group);

    return {
      update: (t) => {
        const { scale, floatY } = breathe(t);
        ball.scale.setScalar(scale);
        stage.floatGroup.position.y = floatY;
        core.rotation.y = t * 0.3;
        core.rotation.x = Math.sin(t * 0.22) * 0.45;
        coreMat.opacity = 0.44 + Math.sin(t * 0.85) * 0.12;
        halo.scale.setScalar(1 + Math.sin(t * 1.3) * 0.05);
        (halo.material as MeshBasicMaterial).opacity = 0.56 + Math.sin(t * 1.3) * 0.13;
        applyBlink(face, blinkScale(t));
      },
      dispose: () => {
        geo.dispose();
        mat.dispose();
        coreGeo.dispose();
        coreMat.dispose();
        face.dispose();
        disposeTempMesh(halo);
        disposeTempMesh(shadow);
      },
    };
  },
};
