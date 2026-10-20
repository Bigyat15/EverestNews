// The site's default logo for every social graphic. The uploaded original is stored untouched; graphics use a trimmed copy (transparent padding removed)
// so the artwork is not tiny inside a large empty square. Stored as ordinary 'logo' assets; the default is the setting brand_logo_asset.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { db, now, log, DATA } from './db.js';

const getSetting = () => { const r = db.prepare("SELECT value FROM settings WHERE key='brand_logo_asset'").get(); try { return r ? +JSON.parse(r.value) : null; } catch { return null; } };
export function brandLogoId() { const id = getSetting(); return id && db.prepare("SELECT 1 FROM assets WHERE id=? AND kind='logo'").get(id) ? id : null; }
export function brandLogoPath() { const id = brandLogoId(), a = id && db.prepare('SELECT path FROM assets WHERE id=?').get(id); return a && existsSync(a.path) ? a.path : null; }

const store = (buf, name, rights, cid = null) => {
  const sha = createHash('sha256').update(buf).digest('hex'), dir = path.join(DATA, 'uploads'); mkdirSync(dir, { recursive: true }); const p = path.join(dir, `${sha.slice(0, 24)}.png`); if (!existsSync(p)) writeFileSync(p, buf);
  return loadImage(buf).then(im => Number(db.prepare("INSERT INTO assets(kind,cluster_id,path,orig_name,mime,bytes,width,height,sha256,created_at,rights_note) VALUES('logo',?,?,?,?,?,?,?,?,?,?)").run(cid, p, name, 'image/png', buf.length, im.width, im.height, sha, now(), rights).lastInsertRowid));
};
// bounding box of the visible (non-transparent) pixels, plus a small margin
export async function trimmedPng(buf, { alpha = 10, margin = 0.03 } = {}) {
  const im = await loadImage(buf), c = createCanvas(im.width, im.height), x = c.getContext('2d'); x.drawImage(im, 0, 0); const d = x.getImageData(0, 0, im.width, im.height).data; let x0 = im.width, y0 = im.height, x1 = -1, y1 = -1;
  for (let y = 0; y < im.height; y++) for (let xx = 0; xx < im.width; xx++) if (d[(y * im.width + xx) * 4 + 3] > alpha) { if (xx < x0) x0 = xx; if (xx > x1) x1 = xx; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) throw new Error('the logo is fully transparent');
  const m = Math.round(Math.max(x1 - x0, y1 - y0) * margin), sx = Math.max(0, x0 - m), sy = Math.max(0, y0 - m), sw = Math.min(im.width, x1 + m + 1) - sx, sh = Math.min(im.height, y1 + m + 1) - sy, o = createCanvas(sw, sh); o.getContext('2d').drawImage(im, sx, sy, sw, sh, 0, 0, sw, sh);
  return { png: o.toBuffer('image/png'), box: { x: sx, y: sy, w: sw, h: sh }, width: im.width, height: im.height };
}
export async function setBrandLogo(file) {
  const buf = readFileSync(file); if (!(buf.length > 12 && buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG')) throw new Error('the logo must be a PNG file');
  const original = await store(buf, path.basename(file), 'Brand logo supplied by the site owner (original, untouched)'), t = await trimmedPng(buf);
  const trimmed = await store(t.png, 'logo-trimmed.png', `Brand logo supplied by the site owner: transparent padding removed from asset #${original}; the original is untouched`);
  db.prepare("INSERT INTO settings(key,value) VALUES('brand_logo_asset',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(trimmed)); log('brand_logo', `original ${original} trimmed ${trimmed}`);
  return { original, trimmed, from: [t.width, t.height], to: [t.box.w, t.box.h] };
}
