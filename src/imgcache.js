// Thumbnail cache for third-party story images. We fetch each source image ONCE (bounded, timed out, SSRF-checked),
// keep only small WebP derivatives for editorial preview, and never store the original. Metadata caching is not a licence to
// republish: the public website only serves rights-cleared uploads (see site.js), never these thumbnails.
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { createHash } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
const MAX_AGE_MS = (+process.env.IMG_CACHE_DAYS || 7) * 864e5; // third-party thumbnails are re-fetched after this long
const fresh = f => existsSync(f) && Date.now() - statSync(f).mtimeMs < MAX_AGE_MS;
import path from 'node:path';
import { db, DATA } from './db.js';
import { safeFetchBuffer } from './feeds.js';

export const WIDTHS = [160, 320, 640, 1024];
const DIR = process.env.IMG_CACHE_DIR || `${DATA}/imgcache`, MAX_SRC = 8 * 1024 * 1024, TIMEOUT = 10000, CONCURRENCY = 3, MAX_CACHE = (+process.env.IMG_CACHE_MB || 300) * 1048576;
mkdirSync(DIR, { recursive: true });
let fetcher = u => safeFetchBuffer(u, { maxBytes: MAX_SRC, timeoutMs: TIMEOUT, accept: 'image/avif,image/webp,image/*;q=0.8' });
export const _setFetcher = f => { fetcher = f; }; // tests only

const keyOf = url => createHash('sha1').update(url).digest('hex').slice(0, 20);
const file = (key, w) => path.join(DIR, `${key}-${w}.webp`);
export const nearestWidth = w => WIDTHS.find(x => x >= (+w || 320)) ?? WIDTHS.at(-1);

// bounded concurrency + one in-flight job per image URL
let active = 0; const waiters = [];
const slot = async fn => { if (active >= CONCURRENCY) await new Promise(r => waiters.push(r)); active++; try { return await fn(); } finally { active--; waiters.shift()?.(); } };
const inflight = new Map(), failures = new Map(); // url -> {n, until}
const BACKOFF = [2 * 6e4, 10 * 6e4, 60 * 6e4, 6 * 36e5];

async function build(url, key) {
  const r = await fetcher(url);
  if (r.status >= 400) throw new Error('HTTP ' + r.status);
  const img = await loadImage(r.buf); // decode failure => caught by caller
  if (img.width * img.height > 40e6) throw new Error('image too large');
  for (const w of WIDTHS) {
    const tw = Math.min(w, img.width), th = Math.max(1, Math.round(tw * img.height / img.width)), c = createCanvas(tw, th), x = c.getContext('2d');
    x.imageSmoothingQuality = 'high'; x.drawImage(img, 0, 0, tw, th);
    writeFileSync(file(key, w), await c.encode('webp', 74));
  }
}
function prune() {
  try {
    const fs = readdirSync(DIR).map(n => { const p = path.join(DIR, n), s = statSync(p); return { p, s: s.size, t: s.mtimeMs }; }); let total = fs.reduce((a, f) => a + f.s, 0);
    for (const f of fs.sort((a, b) => a.t - b.t)) { if (total <= MAX_CACHE * 0.9) break; unlinkSync(f.p); total -= f.s; }
  } catch {}
}
// Returns {buf, key} or throws Error with .status (404 = unavailable right now).
export async function thumbnail(articleId, width) {
  const a = db.prepare('SELECT image_url FROM articles WHERE id=?').get(articleId); if (!a?.image_url) throw Object.assign(new Error('no image'), { status: 404 });
  const url = a.image_url.replace(/^http:\/\//i, 'https://'), key = keyOf(url), w = nearestWidth(width), f = file(key, w);
  if (fresh(f)) return { buf: readFileSync(f), key: `${key}-${w}`, hit: true };
  const fail = failures.get(url); if (fail && Date.now() < fail.until) throw Object.assign(new Error('image host unavailable (cached failure)'), { status: 404 });
  let p = inflight.get(key);
  if (!p) { p = slot(() => build(url, key)).finally(() => inflight.delete(key)); inflight.set(key, p); }
  try { await p; failures.delete(url); } catch (e) {
    const n = (failures.get(url)?.n ?? 0) + 1; failures.set(url, { n, until: Date.now() + BACKOFF[Math.min(n - 1, BACKOFF.length - 1)] });
    throw Object.assign(new Error('image unavailable: ' + e.message), { status: 404 });
  }
  if (Math.random() < 0.05) prune();
  return { buf: readFileSync(f), key: `${key}-${w}`, hit: false };
}

// Idle-time warm-up: pre-build thumbnails for the newest stories so the first page view is already fast.
export async function warmBatch(n = 2) {
  const rows = db.prepare(`SELECT id,image_url FROM articles WHERE image_url IS NOT NULL ORDER BY COALESCE(published_at,fetched_at) DESC LIMIT 60`).all();
  let did = 0;
  for (const r of rows) {
    if (did >= n) break; const url = r.image_url.replace(/^http:\/\//i, 'https://'), key = keyOf(url);
    if (fresh(file(key, 320))) continue; const f = failures.get(url); if (f && Date.now() < f.until) continue;
    try { await thumbnail(r.id, 320); } catch {} did++;
  }
  return did > 0;
}
export const _stats = () => ({ active, inflight: inflight.size, failing: failures.size });

// Public-site photos: our own rights-cleared uploads, resized to WebP on demand. Source is a local file, so no network and no SSRF surface.
export async function assetImage(assetId, srcPath, width) {
  const w = nearestWidth(width), f = path.join(DIR, `a${assetId}-${w}.webp`);
  if (existsSync(f)) return { buf: readFileSync(f), key: `a${assetId}-${w}` };
  const key = `a${assetId}`; let p = inflight.get(key);
  if (!p) {
    p = slot(async () => {
      const img = await loadImage(readFileSync(srcPath));
      for (const ww of WIDTHS) { const tw = Math.min(ww, img.width), th = Math.max(1, Math.round(tw * img.height / img.width)), c = createCanvas(tw, th), x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(img, 0, 0, tw, th); writeFileSync(path.join(DIR, `a${assetId}-${ww}.webp`), await c.encode('webp', 80)); }
    }).finally(() => inflight.delete(key)); inflight.set(key, p);
  }
  await p; return { buf: readFileSync(f), key: `a${assetId}-${w}` };
}

// Fetch a source image with the same bounded, SSRF-safe fetcher the thumbnail cache uses (tests inject a fake).
export const fetchSourceImage = url => fetcher(url.replace(/^http:\/\//i, 'https://'));
