import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const dir = mkdtempSync(path.join(tmpdir(), 'imgc-')); process.env.IMG_CACHE_DIR = dir; process.env.DB_PATH = ':memory:';
const { createCanvas } = await import('@napi-rs/canvas');
const { db } = await import('../src/db.js');
const { thumbnail, nearestWidth, _setFetcher, WIDTHS } = await import('../src/imgcache.js');

const png = (w, h) => { const c = createCanvas(w, h), x = c.getContext('2d'); x.fillStyle = '#c33'; x.fillRect(0, 0, w, h); return c.toBuffer('image/png'); };
const t = new Date().toISOString();
const art = (n, url) => db.prepare('INSERT INTO articles(id,source_id,url,canon_url,title,title_key,fetched_at,updated_at,image_url) VALUES(?,1,?,?,?,?,?,?,?)').run(n, 'https://s/' + n, 'https://s/' + n, 't' + n, 't' + n, t, t, url);
const webpSize = async b => { const { loadImage } = await import('@napi-rs/canvas'); const i = await loadImage(b); return [i.width, i.height]; };

test('nearestWidth snaps to the whitelist', () => { assert.deepEqual([nearestWidth(1), nearestWidth(200), nearestWidth(321), nearestWidth(5000), nearestWidth('x')], [160, 320, 640, 1024, 320]); });

test('fetches once, builds every size as WebP, never upscales, stores no original', async () => {
  let calls = 0, asked; _setFetcher(async u => { calls++; asked = u; return { status: 200, buf: png(500, 300) }; });
  art(1, 'http://img.example/a.png');
  const a = await thumbnail(1, 320), b = await thumbnail(1, 640), c = await thumbnail(1, 160);
  assert.equal(calls, 1, 'one remote fetch serves all sizes'); assert.equal(asked, 'https://img.example/a.png', 'http upgraded to https');
  assert.equal(a.hit, false); assert.equal(b.hit, true);
  assert.deepEqual(await webpSize(a.buf), [320, 192]); assert.deepEqual(await webpSize(b.buf), [500, 300], 'source is 500px wide: no upscaling to 640'); assert.deepEqual(await webpSize(c.buf), [160, 96]);
  const files = readdirSync(dir); assert.equal(files.length, WIDTHS.length); assert.ok(files.every(f => f.endsWith('.webp')), 'only derivatives on disk');
  assert.ok(a.buf.length < png(500, 300).length * 2);
});

test('concurrent requests for one image share a single fetch', async () => {
  let calls = 0; _setFetcher(async () => { calls++; await new Promise(r => setTimeout(r, 40)); return { status: 200, buf: png(400, 400) }; });
  art(2, 'https://img.example/b.png'); await Promise.all([1, 2, 3, 4, 5].map(() => thumbnail(2, 320))); assert.equal(calls, 1);
});

test('remote fetches are bounded to 3 at a time', async () => {
  let live = 0, peak = 0; _setFetcher(async () => { live++; peak = Math.max(peak, live); await new Promise(r => setTimeout(r, 40)); live--; return { status: 200, buf: png(300, 200) }; });
  for (let i = 10; i < 20; i++) art(i, `https://img.example/c${i}.png`); await Promise.all([...Array(10)].map((_, i) => thumbnail(10 + i, 160)));
  assert.ok(peak <= 3 && peak >= 2, `peak concurrency ${peak}`);
});

test('a failing host yields a clean 404, is not hammered, and does not break other images', async () => {
  let calls = 0; _setFetcher(async u => { calls++; if (u.includes('dead')) throw new Error('timeout'); return { status: 200, buf: png(300, 200) }; });
  art(30, 'https://dead.example/x.png'); art(31, 'https://ok.example/y.png');
  await assert.rejects(thumbnail(30, 320), e => e.status === 404); const n = calls;
  await assert.rejects(thumbnail(30, 320), e => e.status === 404); assert.equal(calls, n, 'failure is negatively cached (no retry storm)');
  assert.ok((await thumbnail(31, 320)).buf.length > 0, 'other images unaffected');
});

test('HTTP errors, undecodable bodies and missing images are 404s', async () => {
  art(40, 'https://e.example/403.png'); _setFetcher(async () => ({ status: 403, buf: Buffer.alloc(0) })); await assert.rejects(thumbnail(40, 320), e => e.status === 404);
  art(41, 'https://e.example/html.png'); _setFetcher(async () => ({ status: 200, buf: Buffer.from('<html>not an image</html>') })); await assert.rejects(thumbnail(41, 320), e => e.status === 404);
  db.prepare("INSERT INTO articles(id,source_id,url,canon_url,title,title_key,fetched_at,updated_at) VALUES(42,1,'https://s/42','https://s/42','t','t',?,?)").run(t, t); await assert.rejects(thumbnail(42, 320), e => e.status === 404); await assert.rejects(thumbnail(9999, 320), e => e.status === 404);
});
