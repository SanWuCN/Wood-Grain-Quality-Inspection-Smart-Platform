import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { screenStatus, proxyScreen } from '../server/services/capture-screen.mjs';
import { actorFromRequest, issueToken } from '../server/services/auth.mjs';

// Local fake upstream exercises headers, multipart forwarding, disconnect cleanup and failure.
test('authenticated screen relay preserves bytes, closes upstream, and reports outages', async () => {
  const oldUrl = process.env.MUMAI_SCREEN_URL, oldToken = process.env.MUMAI_SCREEN_TOKEN;
  let closed = false, receivedAuth = '';
  const expected = Buffer.from('--frame\r\nContent-Type: image/jpeg\r\n\r\n\xff\xd8test\xff\xd9\r\n', 'latin1');
  const source = createServer((req, res) => {
    receivedAuth = req.headers.authorization;
    if (receivedAuth !== 'Bearer test-device-secret') { res.writeHead(401); res.end(); return; }
    if (req.url === '/status') { res.end(JSON.stringify({ online: true, width: 1024, height: 600, fps: 10 })); return; }
    res.writeHead(200, { 'content-type': 'multipart/x-mixed-replace; boundary=frame' });
    res.write(expected);
    const timer = setInterval(() => res.write(expected), 50);
    res.on('close', () => { closed = true; clearInterval(timer); });
  });
  source.listen(0, '127.0.0.1'); await once(source, 'listening');
  process.env.MUMAI_SCREEN_URL = `http://127.0.0.1:${source.address().port}`;
  process.env.MUMAI_SCREEN_TOKEN = 'test-device-secret';
  const relay = createServer((req, res) => {
    if (!actorFromRequest(req)) { res.writeHead(401); res.end(); return; }
    proxyScreen(req, res);
  });
  relay.listen(0, '127.0.0.1'); await once(relay, 'listening');
  const url = `http://127.0.0.1:${relay.address().port}/api/capture/screen/stream`;
  try {
    assert.deepEqual(await screenStatus(), { configured: true, online: true, width: 1024, height: 600, fps: 10 });
    assert.equal((await fetch(url)).status, 401);
    const controller = new AbortController();
    const response = await fetch(url, { headers: { authorization: `Bearer ${issueToken('rao')}` }, signal: controller.signal });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const { value } = await response.body.getReader().read();
    assert.deepEqual(Buffer.from(value), expected);
    assert.equal(receivedAuth, 'Bearer test-device-secret');
    controller.abort();
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(closed, true);
    process.env.MUMAI_SCREEN_TOKEN = 'wrong';
    assert.deepEqual(await screenStatus(), { configured: true, online: false });
    assert.equal((await fetch(url, { headers: { authorization: `Bearer ${issueToken('rao')}` } })).status, 502);
    process.env.MUMAI_SCREEN_URL = '';
    assert.deepEqual(await screenStatus(), { configured: false, online: false });
  } finally {
    relay.closeAllConnections(); source.closeAllConnections();
    await Promise.all([new Promise(r => relay.close(r)), new Promise(r => source.close(r))]);
    if (oldUrl === undefined) delete process.env.MUMAI_SCREEN_URL; else process.env.MUMAI_SCREEN_URL = oldUrl;
    if (oldToken === undefined) delete process.env.MUMAI_SCREEN_TOKEN; else process.env.MUMAI_SCREEN_TOKEN = oldToken;
  }
});
