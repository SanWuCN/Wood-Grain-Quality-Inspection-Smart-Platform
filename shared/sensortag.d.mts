export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];
export type Readings = { accel?: Vec3; gyro?: Vec3; mag?: Vec3; ambientTemp?: number; objectTemp?: number; humidityTemp?: number; humidity?: number; pressure?: number; light?: number; battery?: number; keys?: number; rssi?: number };
export const tiUuid: (id: string) => string;
export const PROFILES: { key: string; service: string; data: string; config: string; period: string; enable: number[]; interval: number }[];
export function decodeSensor(key: string, bytes: DataView | Uint8Array): Readings;
export function multiply(a: Quat, b: Quat): Quat;
export function normalize(q: Quat): Quat;
export class AttitudeFilter { q: Quat; at: number | null; bias: Vec3; calibration: string; calibrate(): void; update(accel: Vec3, gyro: Vec3, at: number): Quat; }

export class PoseSmoother { q: Quat | null; update(input: Quat, at: number): Quat; }
