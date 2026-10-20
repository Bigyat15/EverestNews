// The site logo as the default for every social graphic: original kept, trimmed copy used, on a white card, same in the classic and layered renderers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
const dir = mkdtempSync(path.join(tmpdir(), 'bl-'));
Object.assign(process.env, { DB_PATH: ':memory:', DATA_DIR: dir, TOKEN_KEY: 'c'.repeat(64) });
const { createCanvas, loadImage } = await import('@napi-rs/canvas');
const { db } = await import('../src/db.js');
const B = await import('../src/brand_logo.js');
const { renderGraphic, DEFAULT_SPEC } = await import('../src/render.js');
const { renderDoc, docFromSpec } = await import('../src/render_doc.js');
const { graphicRoute } = await import('../src/graphic_routes.js');

// 1000x1000 transparent logo: a dark 300x200 block in the middle (like a real logo with a lot of empty padding)
const logoBuf = (() => { const c = createCanvas(1000, 1000), x = c.getContext('2d'); x.fillStyle = '#111111'; x.fillRect(350, 400, 300, 200); x.fillStyle = '#b01020'; x.fillRect(350, 600, 300, 20); return c.toBuffer('image/png'); })();
const file = path.join(dir, 'logo.png'); writeFileSync(file, logoBuf);
const photo = path.join(dir, 'photo.png'); writeFileSync(photo, (() => { const c = createCanvas(1600, 900), x = c.getContext('2d'); x.fillStyle = '#222a33'; x.fillRect(0, 0, 1600, 900); return c.toBuffer('image/png'); })());
const px = async (buf) => { const im = await loadImage(buf), c = createCanvas(im.width, im.height), x = c.getContext('2d'); x.drawImage(im, 0, 0); const d = x.getImageData(0, 0, im.width, im.height); return { w: im.width, h: im.height, d: d.data, at: (a, b) => [...d.data.slice((b * im.width + a) * 4, (b * im.width + a) * 4 + 4)] }; };

test('registering the logo keeps the original byte for byte and stores a trimmed copy as the default', async () => {
  assert.equal(B.brandLogoId(), null); assert.equal(B.brandLogoPath(), null);
  const r = await B.setBrandLogo(file); assert.deepEqual(r.from, [1000, 1000]); assert.ok(r.to[0] < 400 && r.to[1] < 300, `trimmed to ${r.to}`); assert.ok(r.to[0] >= 300 && r.to[1] >= 220, 'the artwork is all there, with a small margin');
  const o = db.prepare('SELECT * FROM assets WHERE id=?').get(r.original), t = db.prepare('SELECT * FROM assets WHERE id=?').get(r.trimmed); assert.ok(readFileSync(o.path).equals(logoBuf), 'the original file is untouched'); assert.equal(o.sha256, createHash('sha256').update(logoBuf).digest('hex'));
  assert.equal(t.kind, 'logo'); assert.match(t.rights_note, /original is untouched/); assert.equal(B.brandLogoId(), r.trimmed); assert.ok(B.brandLogoPath()); await assert.rejects(B.setBrandLogo(photo.replace('.png', '.txt')), /ENOENT|PNG/);
  const bad = path.join(dir, 'blank.png'); const c = createCanvas(50, 50); writeFileSync(bad, c.toBuffer('image/png')); await assert.rejects(B.setBrandLogo(bad), /fully transparent/); assert.equal(B.brandLogoId(), r.trimmed, 'a failed attempt never replaces the default');
});
test('the classic renderer draws the logo directly on the graphic (no white card), inside the margins, at every format', async () => {
  for (const format of ['portrait', 'square', 'landscape', 'vertical']) {
    const spec = { ...DEFAULT_SPEC, format, headline: 'Headline', photo: { zoom: 1, fx: .5, fy: .5, grayscale: false, overlay: 0 } }, r = await renderGraphic(spec, { photoPath: photo, logoPath: B.brandLogoPath() }), L = r.layout.logo, none = await renderGraphic(spec, { photoPath: photo });
    assert.equal(L.image, true); assert.equal(L.backing, false); assert.ok(!r.warnings.some(w => w.code === 'logo_placeholder')); assert.ok(L.x + L.w <= r.width - 1 && L.x >= r.width * 0.5, 'top-right, inside the canvas');
    const p = await px(r.image), q = await px((await renderGraphic(spec, { photoPath: photo, logoPath: null })).image); void q, none;
    for (const [dx, dy] of [[2, 2], [L.w - 3, 2], [2, L.h - 3]]) assert.ok(p.at(Math.round(L.x + dx), Math.round(L.y + dy))[0] < 120, `${format}: no white card behind the logo (corner is the photo)`);
    let dark = 0; for (let y = Math.round(L.y); y < L.y + L.h; y++) for (let x = Math.round(L.x); x < L.x + L.w; x++) if (p.at(x, y)[0] < 20) dark++; assert.ok(dark > 100, `${format}: the dark artwork is drawn`); assert.ok(L.h <= r.height * 0.17); if (format === 'vertical') assert.ok(L.y >= 1920 * 0.14, 'below the Stories profile bar');
  }
});
test('the white card is still available as an option on the logo layer', async () => {
  const lp = B.brandLogoPath(), base = await docFromSpec({ ...DEFAULT_SPEC, format: 'portrait', headline: 'H', photo: { zoom: 1, fx: .5, fy: .5, grayscale: false, overlay: 0 } }, { photoPath: photo, logoPath: lp, logoAsset: 'logo' }), lg = base.elements.find(e => e.role === 'logo'); assert.equal(lg.backing, false);
  const files = { byRef: r => (r === 'photo' ? photo : lp) }, off = await px((await renderDoc(base, files)).image), card = JSON.parse(JSON.stringify(base)); Object.assign(card.elements.find(e => e.role === 'logo'), { backing: true, pad: 14 }); const on = await px((await renderDoc(card, files)).image);
  assert.ok(off.at(Math.round(lg.x + 2), Math.round(lg.y + 2))[0] < 120 && on.at(Math.round(lg.x + 4), Math.round(lg.y + 4))[0] > 200, 'off = photo shows; on = white card');
});
test('the layered renderer matches the classic one with the logo, and uses the default logo whenever a design has no logo of its own', async () => {
  const spec = { ...DEFAULT_SPEC, format: 'portrait', headline: 'Contract awarded', subheadline: 'Sub', photo: { zoom: 1, fx: .5, fy: .5, grayscale: false, overlay: 0.1 } }, lp = B.brandLogoPath();
  const legacy = await renderGraphic(spec, { photoPath: photo, logoPath: lp }), doc = await docFromSpec(spec, { photoPath: photo, logoPath: lp, logoAsset: 'logo' }), lg = doc.elements.find(e => e.role === 'logo'); assert.equal(lg.backing, false);
  const mine = await renderDoc(doc, { byRef: r => (r === 'photo' ? photo : r === 'logo' ? lp : null) }), a = await px(legacy.image), b = await px(mine.image); let sum = 0; for (let i = 0; i < a.d.length; i += 4) sum += (Math.abs(a.d[i] - b.d[i]) + Math.abs(a.d[i + 1] - b.d[i + 1]) + Math.abs(a.d[i + 2] - b.d[i + 2])) / 3; assert.ok(sum / (a.d.length / 4) < 0.6, `mean difference ${(sum / (a.d.length / 4)).toFixed(3)}/255`);
  // a design whose logo layer has no image of its own picks up the default through the editor routes
  const cid = Number(db.prepare('INSERT INTO clusters(created_at) VALUES(?)').run(new Date().toISOString()).lastInsertRowid); const d2 = JSON.parse(JSON.stringify(doc)); d2.elements.find(e => e.role === 'logo').asset = null;
  const call = async (method, p, body = {}) => { const r = await graphicRoute({ method }, new URL('http://x' + p), async () => body); return { code: r.code ?? 200, ...(r.body ?? r) }; };
  const pv = await call('POST', '/api/graphics/preview-doc', { cluster_id: cid, doc: d2, scale: 0.5 }); assert.ok(pv.png); assert.ok(!pv.warnings.some(w => w.code === 'logo_placeholder'), 'the default logo was found'); const saved = await call('POST', '/api/graphics', { cluster_id: cid, doc: d2 }); assert.ok(saved.id); assert.equal(db.prepare('SELECT logo_asset_id l FROM graphics WHERE id=?').get(saved.id).l, B.brandLogoId(), 'the saved graphic records which logo it used');
  const classic = await call('POST', '/api/graphics/preview', { cluster_id: cid, spec: { ...spec } }); assert.ok(classic.png && !classic.warnings.some(w => w.code === 'logo_placeholder'), 'the classic preview uses it too');
  db.prepare("DELETE FROM settings WHERE key='brand_logo_asset'").run(); const none = await call('POST', '/api/graphics/preview-doc', { cluster_id: cid, doc: d2, scale: 0.5 }); assert.ok(none.warnings.some(w => w.code === 'logo_placeholder'), 'without a default, the placeholder returns (nothing breaks)');
});
