import { useEffect, useRef, useState } from 'react';
import { Panel } from '../Panel';
import { Btn, Modal, StatusChip } from '../ui';
import { Icon } from '../icons';
import { readToken } from '../api/client';

export default function CaptureScreen() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const expandedCanvas = useRef<HTMLCanvasElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [state, setState] = useState<'connecting' | 'live' | 'offline' | 'unconfigured'>('connecting');
  const [retry, setRetry] = useState(0);
  const [fps, setFps] = useState(0);
  const [size, setSize] = useState({ width: 1024, height: 600 });
  useEffect(() => {
    let disposed = false;
    let active: AbortController | undefined;
    let retryTimer: ReturnType<typeof setTimeout>;
    let lastFrame = 0;
    let count = 0;
    let countedAt = Date.now();
    const watchdog = setInterval(() => {
      if (lastFrame && Date.now() - lastFrame > 3000) {
        setState('offline'); setFps(0); active?.abort();
      }
    }, 1000);
    const connect = async () => {
      active = new AbortController();
      const timeout = setTimeout(() => active?.abort(), 6000);
      try {
        const headers = { authorization: `Bearer ${readToken() ?? ''}` };
        const statusResponse = await fetch('/api/capture/screen/status', { headers, signal: active.signal });
        if (!statusResponse.ok) throw new Error('status');
        const status = await statusResponse.json();
        if (!status.configured) { if (!disposed) setState('unconfigured'); return; }
        const response = await fetch('/api/capture/screen/stream', { headers, signal: active.signal });
        if (!response.ok || !response.body) throw new Error('stream');
        const reader = response.body.getReader();
        let buffer = new Uint8Array(0);
        while (!disposed) {
          const { value, done } = await reader.read();
          if (done) throw new Error('ended');
          const next = new Uint8Array(buffer.length + value.length);
          next.set(buffer); next.set(value, buffer.length); buffer = next;
          let start = -1, end = -1;
          // JPEG markers delimit frames independently of HTTP chunk boundaries.
          for (let i = 0; i < buffer.length - 1; i++) {
            if (start < 0 && buffer[i] === 255 && buffer[i + 1] === 216) start = i;
            if (start >= 0 && buffer[i] === 255 && buffer[i + 1] === 217) { end = i + 2; break; }
          }
          while (start >= 0 && end > start) {
            const bitmap = await createImageBitmap(new Blob([buffer.slice(start, end)], { type: 'image/jpeg' }));
            if (!disposed && canvas.current) {
              const element = canvas.current;
              if (element.width !== bitmap.width || element.height !== bitmap.height) {
                element.width = bitmap.width; element.height = bitmap.height;
                setSize({ width: bitmap.width, height: bitmap.height });
              }
              element.getContext('2d')?.drawImage(bitmap, 0, 0);
              if (expandedCanvas.current) {
                const full = expandedCanvas.current;
                if (full.width !== bitmap.width || full.height !== bitmap.height) { full.width = bitmap.width; full.height = bitmap.height; }
                full.getContext('2d')?.drawImage(bitmap, 0, 0);
              }
              lastFrame = Date.now(); count++;
              clearTimeout(timeout);
              setState('live');
              if (lastFrame - countedAt >= 1000) {
                setFps(Math.round(count * 1000 / (lastFrame - countedAt))); count = 0; countedAt = lastFrame;
              }
            }
            bitmap.close(); buffer = buffer.slice(end); start = -1; end = -1;
            for (let i = 0; i < buffer.length - 1; i++) {
              if (start < 0 && buffer[i] === 255 && buffer[i + 1] === 216) start = i;
              if (start >= 0 && buffer[i] === 255 && buffer[i + 1] === 217) { end = i + 2; break; }
            }
          }
          if (buffer.length > 4 * 1024 * 1024) throw new Error('invalid frame');
        }
      } catch {
        if (!disposed) { setState('offline'); setFps(0); }
      } finally {
        clearTimeout(timeout); active?.abort(); lastFrame = 0;
        if (!disposed) retryTimer = setTimeout(() => { void connect(); }, 2000);
      }
    };
    void connect();
    return () => { disposed = true; active?.abort(); clearTimeout(retryTimer); clearInterval(watchdog); };
  }, [retry]);
  const live = state === 'live';
  return <><Panel title="采集设备画面" className="cap-panel cap-panel--screen" extra={<StatusChip text={live ? '实时串流' : state === 'connecting' ? '连接中' : state === 'unconfigured' ? '尚未接入' : '画面已断开'} tone={live ? 'ok' : 'muted'} dot />}>
    <div className="capture-screen-meta"><span>树莓派屏幕</span><span>{size.width} × {size.height}{live ? ` · ${fps || '—'} FPS` : ''}</span></div>
    <div className={`cap-screen${live ? ' is-live' : ''}`} style={{ aspectRatio: `${size.width} / ${size.height}` }}>
      <canvas ref={canvas} width={1024} height={600} className="cap-screen__media" role="img" aria-label="树莓派采集设备实时屏幕" />
      {!live ? <span className="cap-screen__placeholder"><Icon name="nav-capture" size={32} aria-hidden /><b>{state === 'connecting' ? '正在连接采集设备画面' : state === 'unconfigured' ? '采集设备屏幕尚未接入' : '屏幕信号已中断，正在重连'}</b><em>屏幕、姿态与实时数据独立接收。</em></span> : null}
    </div>
    <div className="capture-screen-footer"><span>{live ? '实时桌面 · 只读监看' : '等待设备屏幕信号'}</span><div><Btn tone="ghost" onClick={() => setRetry(v => v + 1)}>重新连接</Btn><Btn tone="ghost" onClick={() => setExpanded(true)}>放大画面</Btn></div></div>
  </Panel>
    {expanded ? <Modal wide title="采集设备画面 · 放大监看" subtitle={`树莓派屏幕 · ${size.width} × ${size.height} · ${live ? '实时串流' : '信号中断，自动重连中'}`} onClose={() => setExpanded(false)}>
      <div className={`capture-screen-expanded${live ? '' : ' is-offline'}`}>
        <canvas ref={expandedCanvas} width={size.width} height={size.height} role="img" aria-label="放大的树莓派实时屏幕" />
        {!live ? <p>屏幕信号已中断，正在重连</p> : null}
      </div>
    </Modal> : null}
  </>;
}
