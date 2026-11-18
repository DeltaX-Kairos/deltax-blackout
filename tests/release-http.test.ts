import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from '../src/server.js';
import { WorkspaceService } from '../src/workspace-service.js';

function post(port: number, host: string, origin: string): Promise<{ status: number; cookies: string[] }> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ scenarioName: 'queue-storm', seed: 42 });
    const req = http.request({ hostname: '127.0.0.1', port, path: '/api/session', method: 'POST',
      headers: { Host: host, Origin: origin, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
      res.resume(); res.on('end', () => resolve({ status: res.statusCode ?? 0, cookies: res.headers['set-cookie'] ?? [] }));
    });
    req.setTimeout(2000, () => req.destroy(new Error('Local HTTP test deadline')));
    req.on('error', reject); req.end(body);
  });
}

test('configured HTTPS proxy origin retains Host/Origin checks and Secure cookies', async () => {
  const saved = process.env.BLACKOUT_PUBLIC_ORIGIN;
  process.env.BLACKOUT_PUBLIC_ORIGIN = 'https://blackout.example.com';
  const service = new WorkspaceService();
  let server: http.Server | undefined;
  try {
    server = createServer(service, undefined, null);
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const good = await post(port, 'blackout.example.com', 'https://blackout.example.com');
    assert.equal(good.status, 201);
    assert.equal(good.cookies.length, 2);
    assert.ok(good.cookies.every(c => /; Secure(?:;|$)/.test(c) && /HttpOnly/.test(c) && /SameSite=Strict/.test(c)));
    assert.equal((await post(port, 'attacker.example.com', 'https://blackout.example.com')).status, 403);
    assert.equal((await post(port, 'blackout.example.com', 'https://attacker.example.com')).status, 403);
    assert.equal((await post(port, 'blackout.example.com', 'http://blackout.example.com')).status, 403);
  } finally {
    service.close();
    if (server?.listening) await new Promise<void>(resolve => server!.close(() => resolve()));
    if (saved === undefined) delete process.env.BLACKOUT_PUBLIC_ORIGIN; else process.env.BLACKOUT_PUBLIC_ORIGIN = saved;
  }
});

test('invalid deployment origin fails before listening without echoing credentials', () => {
  const saved = process.env.BLACKOUT_PUBLIC_ORIGIN;
  process.env.BLACKOUT_PUBLIC_ORIGIN = 'https://user:canary-private@example.com';
  const service = new WorkspaceService();
  try {
    assert.throws(() => createServer(service, undefined, null), err => err instanceof Error && /Invalid public origin/.test(err.message) && !err.message.includes('canary-private'));
  } finally {
    service.close();
    if (saved === undefined) delete process.env.BLACKOUT_PUBLIC_ORIGIN; else process.env.BLACKOUT_PUBLIC_ORIGIN = saved;
  }
});
