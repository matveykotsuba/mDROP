const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { startServer } = require('../server');
const { networkInfo } = require('../network');

async function fixture(t) {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mdrop-test-'));
  const server = await startServer({ port: 0, dataRoot });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dataRoot, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (url, options) => fetch(base + url, options);
  return { dataRoot, server, base, request };
}

test('Wi-Fi has priority; SSTP, virtual, APIPA and public addresses are excluded', () => {
  const addr = (address, netmask = '255.255.255.0') => [{ address, netmask, family: 'IPv4', internal: false }];
  const net = networkInfo({
    'Hide.ME SSTP': addr('10.57.66.51', '255.255.255.255'),
    Ethernet: addr('192.168.20.2'), 'Беспроводная сеть': addr('192.168.10.103'),
    'vEthernet (WSL)': addr('172.20.0.1'), Broken: addr('169.254.1.2'), Public: addr('8.8.8.8'),
  });
  assert.deepEqual(net.candidates.map((a) => a.address), ['192.168.10.103', '192.168.20.2']);
  assert.equal(net.excluded.length, 4);
  assert.equal(networkInfo({ 'Hide.ME SSTP': addr('10.1.1.1') }).candidates.length, 0);
});

test('parallel same-name uploads preserve every payload', async (t) => {
  const { request } = await fixture(t);
  const bodies = Array.from({ length: 12 }, (_, i) => `payload ${i}\n`.repeat(20000));
  const saved = await Promise.all(bodies.map(async (body) => {
    const r = await request('/api/upload', { method: 'POST', headers: { 'X-Filename': encodeURIComponent('фото.txt') }, body });
    assert.equal(r.status, 200);
    return (await r.json()).name;
  }));
  assert.equal(new Set(saved).size, bodies.length);
  for (let i = 0; i < saved.length; i++) {
    assert.equal(await (await request('/api/file/' + encodeURIComponent(saved[i]))).text(), bodies[i]);
  }
});

test('invalid notes and oversized body return 400/413; valid note persists', async (t) => {
  const { request, dataRoot } = await fixture(t);
  for (const body of ['{', 'null', '{"text":42}', '{"text":" "}']) {
    assert.equal((await request('/api/notes', { method: 'POST', body })).status, 400);
  }
  assert.equal((await request('/api/notes', { method: 'POST', body: JSON.stringify({ text: 'x'.repeat(20001) }) })).status, 413);
  assert.equal((await request('/api/notes', { method: 'POST', body: JSON.stringify({ text: 'x'.repeat(300000) }) })).status, 413);
  assert.equal((await request('/api/notes', { method: 'POST', body: JSON.stringify({ text: ' привет ' }) })).status, 200);
  const notes = await (await request('/api/notes')).json();
  assert.equal(notes[0].text, 'привет');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dataRoot, 'data/notes.json'), 'utf8')), notes);
  assert.equal((await request('/api/notes/' + notes[0].id, { method: 'DELETE' })).status, 200);
  assert.deepEqual(await (await request('/api/notes')).json(), []);
});

test('foreign web pages cannot write into mDrop', async (t) => {
  const { request } = await fixture(t);
  assert.equal((await request('/api/notes', { method: 'POST', headers: { Origin: 'https://example.com' }, body: '{"text":"foreign"}' })).status, 403);
});

test('file names, downloads and missing resources', async (t) => {
  const { request } = await fixture(t);
  for (const name of ['CON.txt', 'NUL', 'trailing.', '.part-hidden', 'проверка 😀.txt']) {
    const r = await request('/api/upload', { method: 'POST', headers: { 'X-Filename': encodeURIComponent(name) }, body: 'abc' });
    assert.equal(r.status, 200);
    const saved = (await r.json()).name;
    assert.equal(await (await request('/api/file/' + encodeURIComponent(saved))).text(), 'abc');
    const files = await (await request('/api/files')).json();
    assert.ok(files.some((f) => f.name === saved));
    assert.equal((await request('/api/file/' + encodeURIComponent(saved), { method: 'DELETE' })).status, 200);
  }
  assert.equal((await request('/api/upload', { method: 'POST', headers: { 'X-Filename': '%' }, body: '' })).status, 400);
  assert.equal((await request('/api/file/%ZZ')).status, 400);
  assert.equal((await request('/api/file/missing')).status, 404);
  assert.equal((await request('/api/qr?address=8.8.8.8')).status, 400);
  assert.equal((await request('/')).status, 200);
});

test('aborted upload leaves neither partial nor final file', async (t) => {
  const { base, dataRoot, request } = await fixture(t);
  await new Promise((resolve) => {
    const req = http.request(base + '/api/upload', { method: 'POST', headers: { 'X-Filename': 'abort.bin', 'Content-Length': 1000000 } });
    req.on('error', resolve);
    req.write(Buffer.alloc(50000));
    setTimeout(() => req.destroy(), 60);
  });
  for (let i = 0; i < 50; i++) {
    if ((await fs.readdir(path.join(dataRoot, 'drops'))).length === 0) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.deepEqual(await fs.readdir(path.join(dataRoot, 'drops')), []);
  assert.equal((await request('/api/info')).status, 200);
});

test('corrupt notes do not get silently replaced', async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mdrop-corrupt-'));
  await fs.mkdir(path.join(dataRoot, 'data'));
  const file = path.join(dataRoot, 'data/notes.json');
  await fs.writeFile(file, '{bad');
  try {
    await assert.rejects(async () => {
      const server = await startServer({ port: 0, dataRoot });
      await new Promise((r) => server.close(r));
    });
    assert.equal(await fs.readFile(file, 'utf8'), '{bad');
  } finally { await fs.rm(dataRoot, { recursive: true, force: true }); }
});

test('QR uses selected LAN; only VPN produces no misleading localhost QR', async (t) => {
  const addr = (address, netmask = '255.255.255.0') => [{ address, netmask, family: 'IPv4', internal: false }];
  const mock = t.mock.method(os, 'networkInterfaces', () => ({
    'Беспроводная сеть': addr('192.168.10.103'), Ethernet: addr('192.168.20.2'),
    'Hide.ME SSTP': addr('10.57.66.51', '255.255.255.255'),
  }));
  const { request, server } = await fixture(t);
  const qr = await (await request('/api/qr?address=192.168.20.2')).json();
  assert.equal(qr.url, `http://192.168.20.2:${server.address().port}`);
  assert.ok(qr.qr.startsWith('data:image/png;base64,'));
  assert.equal(qr.candidates.length, 2);
  mock.mock.mockImplementation(() => ({ 'Hide.ME SSTP': addr('10.57.66.51', '255.255.255.255') }));
  const offline = await (await request('/api/qr')).json();
  assert.equal(offline.url, null);
  assert.equal(offline.qr, null);
  assert.deepEqual(offline.candidates, []);
});

test('large binary transfer and interrupted download leave server healthy', async (t) => {
  const { request, base } = await fixture(t);
  const crypto = require('node:crypto');
  const bytes = crypto.randomBytes(16 * 1024 * 1024);
  assert.equal((await request('/api/upload', { method: 'POST', headers: { 'X-Filename': 'large.bin' }, body: bytes })).status, 200);
  const received = Buffer.from(await (await request('/api/file/large.bin')).arrayBuffer());
  assert.equal(crypto.createHash('sha256').update(received).digest('hex'), crypto.createHash('sha256').update(bytes).digest('hex'));
  await new Promise((resolve, reject) => {
    http.get(base + '/api/file/large.bin', (res) => {
      res.once('data', () => { res.destroy(); resolve(); });
      res.on('error', () => {});
    }).on('error', reject);
  });
  assert.equal((await request('/api/info')).status, 200);
});

test('existing notes are loaded after server restart', async (t) => {
  const { request, dataRoot, server } = await fixture(t);
  await request('/api/notes', { method: 'POST', body: '{"text":"Сохранено после перезапуска"}' });
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  const restarted = await startServer({ port: 0, dataRoot });
  try {
    const notes = await (await fetch(`http://127.0.0.1:${restarted.address().port}/api/notes`)).json();
    assert.equal(notes[0].text, 'Сохранено после перезапуска');
  } finally {
    restarted.closeAllConnections();
    await new Promise((resolve) => restarted.close(resolve));
  }
});
