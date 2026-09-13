import type { Quat, Readings } from '../../../../shared/sensortag.mjs';
export type SensorFrame = {
  id?: number; sessionId: string; batchId: string; deviceId: string; deviceName: string; model: string; firmware: string;
  streamId: string; seq: number; sampledAt: number; receivedAt: number; poseAt: number | null;
  readings: Readings; fieldAt: Partial<Record<keyof Readings, number>>; quaternion: Quat | null;
  source: 'ble:sensortag' | 'demo'; heading: 'relative';
  calibrated?: { ambientTemp?: number; light?: number };
  gyroCalibration?: string;
  gyroBias?: [number,number,number];
  calibration?: { temperatureOffset: number; lightScale: number; lightOffset: number; reason: string; actor: string; at: number } | null;
};
export type BridgeStatus = { state: 'idle' | 'connecting' | 'online' | 'reconnecting' | 'error'; message: string; deviceId?: string; batchId?: string; sessionId?: string; warnings?: string[]; profiles?: Record<string,{config:string;period:string}> };
export const freshness = (at: number | null | undefined, now: number) => !at ? '未接入' : now-at > 10000 ? '已离线' : now-at > 3000 ? '数据延迟' : '实时';
