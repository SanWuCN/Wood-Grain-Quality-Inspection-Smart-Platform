import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';

// Local installation config is ignored by git; no credentials or camera URLs from clients.
export function screenConfig() {
  let local = {};
  try { local = JSON.parse(readFileSync(resolve('server/data/capture-screen.json'), 'utf8')); } catch { /* optional installation */ }
  return { url: process.env.MUMAI_SCREEN_URL ?? local.url,
    token: process.env.MUMAI_SCREEN_TOKEN ?? local.token };
}

export async function screenStatus() {
  const config = screenConfig();
  if (!config.url) return { configured: false, online: false };
  try {
    const response = await fetch(new URL('/status', config.url), {
      headers: { authorization: `Bearer ${config.token ?? ''}` }, signal: AbortSignal.timeout(3000), redirect: 'error',
    });
    if (!response.ok) throw new Error('upstream');
    const status = await response.json();
    return { configured: true, online: Boolean(status.online), width: status.width, height: status.height, fps: status.fps };
  } catch { return { configured: true, online: false }; }
}

export function proxyScreen(req, res) {
  const config = screenConfig();
  if (!config.url) { res.writeHead(503); res.end('Screen is not configured'); return null; }
  const url = new URL('/stream.mjpeg', config.url);
  if (!['http:', 'https:'].includes(url.protocol)) { res.writeHead(503); res.end(); return null; }
  const upstream = (url.protocol === 'https:' ? httpsGet : httpGet)(url, {
    headers: { authorization: `Bearer ${config.token ?? ''}` }, timeout: 8000,
  });
  upstream.on('timeout', () => upstream.destroy(new Error('No screen frame')));
  upstream.on('response', (stream) => {
    if (stream.statusCode !== 200 || !String(stream.headers['content-type']).startsWith('multipart/x-mixed-replace')) {
      stream.resume(); res.writeHead(502); res.end('Screen unavailable'); return;
    }
    res.writeHead(200, { 'content-type': stream.headers['content-type'], 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });
  upstream.on('error', () => {
    if (res.destroyed) return;
    if (!res.headersSent) { res.writeHead(502); res.end('Screen unavailable'); }
    else res.destroy();
  });
  res.on('close', () => upstream.destroy());
  return null;
}
