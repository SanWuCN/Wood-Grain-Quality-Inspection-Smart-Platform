import { useCallback, useEffect, useRef, useState } from 'react';
import { readToken } from '../api/client';
import { useSharedStore } from '../store/shared';
import type { SensorFrame, BridgeStatus } from './types';

export async function sensorRequest<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/sensors/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${readToken() ?? ''}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message ?? '传感器服务连接失败');
  return data as T;
}
export function useSensor(batchId: string) {
  const sessionId = useSharedStore((s) => s.sessionId);
  const online = useSharedStore((s) => s.status === 'online');
  const [frame, setFrame] = useState<SensorFrame | null>(null);
  const [history, setHistory] = useState<SensorFrame[]>([]);
  const [error, setError] = useState('');
  const [bridge, setBridge] = useState<BridgeStatus>({ state: 'idle', message: '未连接 SensorTag' });
  const [revision, setRevision] = useState(0);
  const [now, setNow] = useState(Date.now);
  const latest = useRef<SensorFrame | null>(null);
  const historyAt = useRef(0);
  const accept = useCallback((next: SensorFrame | null) => {
    if (!next || next.batchId !== batchId || next.sessionId !== sessionId) return;
    if (latest.current && next.receivedAt <= latest.current.receivedAt) return;
    latest.current = next;
    setFrame(next);
    if (next.receivedAt-historyAt.current >= 1000) {
      historyAt.current = next.receivedAt;
      setHistory((h) => [...h.filter((v) => v.deviceId === next.deviceId && next.receivedAt-v.receivedAt < 300000),next].slice(-300));
    }
  },[batchId,sessionId]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()),500);
    return () => clearInterval(timer);
  },[]);
  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | null = null;
    let retry = 0;
    let attempt = 0;
    let loading = false;
    let historyDevice = '';
    latest.current = null;
    historyAt.current = 0;
    setFrame(null);
    setHistory([]);
    if (!online) return;
    const query = new URLSearchParams({sessionId,batchId});
    const poll = async () => {
      if (loading || disposed) return;
      loading = true;
      try {
        const [data,status] = await Promise.all([
          sensorRequest<{frame: SensorFrame | null}>(`latest?${query}`),
          sensorRequest<BridgeStatus>('bridge'),
        ]);
        if (!disposed) {
          accept(data.frame); setBridge(status); setError('');
          if (data.frame && historyDevice!==data.frame.deviceId) {
            const deviceId=data.frame.deviceId;
            const saved=await sensorRequest<{frames:SensorFrame[]}>(`history?${new URLSearchParams({sessionId,batchId,deviceId,from:String(Date.now()-300000)})}`);
            if (!disposed) {
              historyDevice=deviceId;
              setHistory((h)=>[...new Map([...saved.frames,...h].filter((f)=>f.deviceId===deviceId).map((f)=>[f.receivedAt,f])).values()].sort((a,b)=>a.receivedAt-b.receivedAt).slice(-300));
            }
          }
        }
      } catch (e) { if (!disposed) setError(e instanceof Error ? e.message : '传感器服务不可用'); }
      finally { loading = false; }
    };
    const connect = () => {
      if (disposed) return;
      socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws?${new URLSearchParams({sessionId,afterSeq:String(useSharedStore.getState().lastSeq)})}`);
      socket.onopen = () => { attempt=0; void poll(); };
      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.kind === 'sensor' && !disposed) accept(data.frame);
        } catch { /* Ignore unrelated workflow events. */ }
      };
      socket.onclose = () => { if (!disposed) retry = window.setTimeout(connect,Math.min(10000,1000*2**attempt++)); };
      socket.onerror = () => socket?.close();
    };
    void poll();
    connect();
    const poller = window.setInterval(poll,2000);
    return () => { disposed=true; clearInterval(poller); clearTimeout(retry); socket?.close(); };
  },[batchId,sessionId,online,accept,revision]);
  return { frame,history,error,bridge,now,sessionId,reconnect: () => setRevision((v)=>v+1) };
}
