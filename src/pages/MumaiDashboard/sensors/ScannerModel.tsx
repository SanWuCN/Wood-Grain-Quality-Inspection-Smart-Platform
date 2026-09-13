import { Component, Suspense, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, useGLTF, Html } from '@react-three/drei';
import { Box3, Quaternion, Vector3, type Group } from 'three';
import type { OrbitControls as OrbitControlsType } from 'three-stdlib';
import type { Quat } from '../../../../shared/sensortag.mjs';

// Default model dimensions are 75% of the previous capture workspace view.
const INITIAL_MODEL_SCALE = 0.75;

function Model({ quaternion, follow }: { quaternion: Quat; follow: boolean }) {
  const { scene } = useGLTF('/model/scanner/scanner.glb');
  const group = useRef<Group>(null);
  const initial = useRef(new Quaternion(...quaternion));
  const model = useMemo(() => {
    const clone = scene.clone(true);
    const box = new Box3().setFromObject(clone);
    const center = box.getCenter(new Vector3());
    const scale = (3 * INITIAL_MODEL_SCALE) / Math.max(...box.getSize(new Vector3()).toArray());
    clone.position.sub(center);
    return { clone, scale };
  },[scene]);
  const target = useMemo(() => new Quaternion(...quaternion),[quaternion]);
  useFrame((_,dt) => {
    if (group.current && follow) group.current.quaternion.slerp(target,1-Math.exp(-22*Math.min(dt,.1)));
  });
  return <group ref={group} quaternion={initial.current}><group scale={model.scale}><primitive object={model.clone} /></group></group>;
}
function Controls({ reset }: { reset: number }) {
  const control = useRef<OrbitControlsType>(null);
  const lastReset = useRef(reset);
  const { camera, size } = useThree();
  useEffect(() => {
    // Keep the default view inside the narrow portrait viewport on wide screens.
    const distance = Math.max(4.8, 2.86 / Math.max(.2, size.width / size.height));
    camera.position.copy(new Vector3(2.8,1.5,3.6).normalize().multiplyScalar(distance));
    camera.lookAt(0,0,0);
    control.current?.update();
    control.current?.saveState();
  }, [camera, size.width, size.height]);
  useFrame(() => {
    if (lastReset.current !== reset) { control.current?.reset(); lastReset.current=reset; }
  });
  return <OrbitControls ref={control} enablePan={false} minDistance={3} maxDistance={9} makeDefault />;
}
class ModelBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <div className="sensor-model-error">3D 模型加载失败，请刷新重试。传感器读数仍可查看。</div> : this.props.children; }
}
export default function ScannerModel({ quaternion, follow, reset }: { quaternion: Quat; follow: boolean; reset: number }) {
  return <ModelBoundary><Canvas camera={{ position: [2.8,1.5,3.6], fov: 35 }} dpr={[1,1.5]} gl={{ alpha: true, antialias: true }} fallback={<div className="sensor-model-error">当前浏览器不支持 WebGL，请使用支持 3D 的浏览器。</div>}>
    <ambientLight intensity={1.8} /><directionalLight position={[4,6,5]} intensity={3} /><directionalLight position={[-4,2,-2]} intensity={1.5} />
    <Suspense fallback={<Html center><span className="sensor-loading">正在加载扫描枪模型…</span></Html>}><Model quaternion={quaternion} follow={follow} /></Suspense>
    <Controls reset={reset} />
  </Canvas></ModelBoundary>;
}
