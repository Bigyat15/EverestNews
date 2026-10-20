// Renderer parity, image handling, persistence and templates for the layered editor. Synthetic images only; isolated data directory; nothing is published.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
const dir = mkdtempSync(path.join(tmpdir(), 'dsg-'));
Object.assign(process.env, { DB_PATH: ':memory:', DATA_DIR: dir, TOKEN_KEY: 'c'.repeat(64) });
const { createCanvas, loadImage } = await import('@napi-rs/canvas');
const { db } = await import('../src/db.js');
const { renderDoc, docFromSpec } = await import('../src/render_doc.js');
const { renderGraphic, DEFAULT_SPEC } = await import('../src/render.js');
const G = await import('../src/design_geom.js');
const D = await import('../src/design_routes.js');
const { graphicRoute } = await import('../src/graphic_routes.js');

const ts = () => new Date().toISOString();
const solid = (w, h, parts) => { const c = createCanvas(w, h), x = c.getContext('2d'); for (const [col, rx, ry, rw, rh] of parts) { x.fillStyle = col; x.fillRect(rx, ry, rw, rh); } return c.toBuffer('image/png'); };
let n = 0;
function asset(kind, buf, cid = null, rights = 'test fixture') { n++; const p = path.join(dir, `a${n}.png`); writeFileSync(p, buf); const w = readW(buf); return Number(db.prepare('INSERT INTO assets(kind,cluster_id,path,orig_name,mime,bytes,width,height,sha256,created_at,rights_note) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(kind, cid, p, 'x.png', 'image/png', buf.length, w[0], w[1], createHash('sha256').update(buf).digest('hex'), ts(), rights).lastInsertRowid); }
const readW = b => [b.readUInt32BE(16), b.readUInt32BE(20)];
const story = () => Number(db.prepare('INSERT INTO clusters(created_at) VALUES(?)').run(ts()).lastInsertRowid);
const paths = new Map(); const byRef = r => paths.get(r) ?? null;
const pix = async (buf) => { const im = await loadImage(buf), c = createCanvas(im.width, im.height), x = c.getContext('2d'); x.drawImage(im, 0, 0); const d = x.getImageData(0, 0, im.width, im.height); return { w: im.width, h: im.height, at: (px, py) => { const i = (py * im.width + px) * 4; return [d.data[i], d.data[i + 1], d.data[i + 2], d.data[i + 3]]; }, data: d.data }; };
const close = (a, b, t = 12) => b.every((v, i) => Math.abs(a[i] - v) <= t); // compares the channels given (RGB or RGBA)
const RED = [255, 0, 0], BLUE = [0, 0, 255], GREEN = [0, 128, 0];
const mkdoc = (els, c = {}) => ({ version: 2, canvas: { w: 400, h: 300, bg: '#202020', ...c }, elements: els.map((e, i) => ({ id: e.id ?? `e${i}`, name: e.id ?? `e${i}`, ...e })) });
const shape = (o = {}) => ({ type: 'shape', x: 0, y: 0, w: 100, h: 100, fill: '#ff0000', alpha: 1, ...o });
const image = (o = {}) => ({ type: 'image', role: 'photo', x: 100, y: 100, w: 200, h: 100, asset: 'photo', fit: 'cover', ...o });
const R = async (doc, files = {}, o = {}) => { paths.clear(); for (const [k, v] of Object.entries(files)) paths.set(k, v); return renderDoc(doc, { byRef }, o); };
const IMG_RB = path.join(dir, 'rb.png'); writeFileSync(IMG_RB, solid(400, 200, [['#ff0000', 0, 0, 200, 200], ['#0000ff', 200, 0, 200, 200]])); // left red, right blue

test('export dimensions are exact for every canvas preset, custom sizes and preview scales', async () => {
  for (const [k, p] of Object.entries(G.CANVAS_PRESETS)) { const r = await R(mkdoc([], { w: p.w, h: p.h })); assert.deepEqual([r.width, r.height], [p.w, p.h], k); const im = await loadImage(r.image); assert.deepEqual([im.width, im.height], [p.w, p.h]); }
  const c = await R(mkdoc([], { w: 777, h: 333 })); assert.deepEqual([c.width, c.height], [777, 333]); const half = await R(mkdoc([], { w: 1080, h: 1350 }), {}, { scale: 0.5 }); assert.deepEqual([half.width, half.height, half.designWidth, half.designHeight], [540, 675, 1080, 1350]);
});
test('nothing but the document reaches the export: an empty design is one flat colour (no guides, handles or rulers)', async () => {
  const r = await R(mkdoc([])), p = await pix(r.image); const first = p.at(0, 0); for (const [x, y] of [[0, 0], [399, 299], [200, 150], [10, 290], [390, 5]]) assert.deepEqual(p.at(x, y), first); assert.ok(close(first, [32, 32, 32, 255], 1));
});
test('layer order is paint order; hidden layers do not paint; opacity blends', async () => {
  const a = shape({ id: 'a', x: 50, y: 50, fill: '#ff0000' }), b = shape({ id: 'b', x: 100, y: 100, fill: '#0000ff' });
  let p = await pix((await R(mkdoc([a, b]))).image); assert.ok(close(p.at(120, 120), BLUE), 'later layer on top'); p = await pix((await R(mkdoc([b, a]))).image); assert.ok(close(p.at(120, 120), RED));
  p = await pix((await R(mkdoc([a, { ...b, visible: false }]))).image); assert.ok(close(p.at(120, 120), RED), 'hidden: not drawn'); assert.ok(close(p.at(60, 60), RED));
  p = await pix((await R(mkdoc([shape({ id: 'w', x: 0, y: 0, w: 400, h: 300, fill: '#ffffff', opacity: 0.5 })]))).image); assert.ok(close(p.at(200, 150), [144, 144, 144], 3), 'half-opaque white over #202020');
  const moved = G.moveLayer(mkdoc([a, b]).elements, 'a', 'front'); p = await pix((await R({ ...mkdoc([]), elements: moved })).image); assert.ok(close(p.at(120, 120), RED), 'reordering changes the result');
});
test('image fit modes place the image exactly where the shared geometry says', async () => {
  const f = { 'photo': IMG_RB }, at = async (o) => pix((await R(mkdoc([image(o)]), f)).image);
  let p = await at({ fit: 'cover' }); assert.ok(close(p.at(150, 150), RED) && close(p.at(250, 150), BLUE), 'cover fills the 200x100 frame with a 2:1 image'); assert.ok(close(p.at(50, 150), [32, 32, 32, 255], 2), 'nothing outside the frame');
  p = await at({ fit: 'contain', h: 200, y: 50 }); assert.ok(close(p.at(150, 150), RED) && close(p.at(250, 150), BLUE)); assert.ok(close(p.at(200, 60), [32, 32, 32, 255], 2), 'contain: letterbox above the image'); assert.ok(close(p.at(200, 260), [32, 32, 32, 255], 2));
  p = await at({ fit: 'blur', h: 200, y: 50 }); assert.ok(!close(p.at(200, 60), [32, 32, 32, 255], 20), 'blurred backdrop fills the letterbox'); assert.ok(close(p.at(150, 150), RED) && close(p.at(250, 150), BLUE), 'sharp copy in front'); assert.ok(close(p.at(120, 60), RED, 60), 'the backdrop carries the picture colours');
  p = await at({ fit: 'manual', zoom: 2, ox: 0 }); assert.ok(close(p.at(150, 150), RED) && close(p.at(250, 150), BLUE), 'zoom crops around the centre'); p = await at({ fit: 'cover', zoom: 2, ox: -100 }); assert.ok(close(p.at(150, 150), BLUE) && close(p.at(250, 150), BLUE), 'offset pans the image inside the frame');
});
test('manual sizing: a locked frame keeps proportions, an unlocked one stretches', async () => {
  const f = { photo: IMG_RB }; let p = await pix((await R(mkdoc([image({ fit: 'manual', x: 50, y: 50, w: 100, h: 200, lockAspect: false })]), f)).image); assert.ok(close(p.at(70, 150), RED) && close(p.at(130, 150), BLUE), 'a 2:1 image stretched into 100x200'); assert.ok(close(p.at(70, 60), RED));
  const r = G.resizeBox({ x: 50, y: 50, w: 200, h: 100, rotation: 0 }, 'se', 100, 0, { lockAspect: true }); assert.equal(r.w / r.h, 2);
});
test('rotation with clipping: the clip rotates with the frame and nothing escapes it', async () => {
  const f = { photo: IMG_RB }, el = image({ x: 100, y: 100, w: 200, h: 100, fit: 'cover', rotation: 90 });
  let p = await pix((await R(mkdoc([el]), f)).image); // rotated 90° about (200,150): the frame becomes 100 wide x 200 tall; red half is now on top
  assert.ok(close(p.at(200, 80), RED), 'top is red'); assert.ok(close(p.at(200, 220), BLUE), 'bottom is blue'); assert.ok(close(p.at(130, 150), [32, 32, 32, 255], 2), 'outside the rotated frame stays background'); assert.ok(close(p.at(270, 150), [32, 32, 32, 255], 2));
  const roundOff = await pix((await R(mkdoc([image({ ...el, radius: 100 })]), f)).image); assert.ok(close(roundOff.at(150, 55), [32, 32, 32, 255], 6), 'a rounded mask clips the corner'); const noClip = await pix((await R(mkdoc([image({ ...el, fit: 'manual', zoom: 1.6, clip: false })]), f)).image); assert.ok(!close(noClip.at(200, 40), [32, 32, 32, 255], 20), 'with clipping off the image overflows its frame');
  const clipped = await pix((await R(mkdoc([image({ ...el, fit: 'manual', zoom: 1.6, clip: true })]), f)).image); assert.ok(close(clipped.at(200, 40), [32, 32, 32, 255], 2), 'with clipping on it does not');
});
test('grayscale, gradient and the placeholder logo render as specified', async () => {
  let p = await pix((await R(mkdoc([image({ grayscale: true })]), { photo: IMG_RB })).image); const c = p.at(150, 150); assert.ok(Math.abs(c[0] - c[1]) < 2 && Math.abs(c[1] - c[2]) < 2, 'desaturated');
  p = await pix((await R(mkdoc([{ type: 'gradient', id: 'g', x: 0, y: 0, w: 400, h: 300, stops: [{ at: 0, color: '#000000', alpha: 0 }, { at: 1, color: '#ffffff', alpha: 1 }] }]))).image); assert.ok(p.at(200, 2)[0] < 50 && p.at(200, 297)[0] > 200 && p.at(200, 150)[0] > p.at(200, 40)[0]);
  const r = await R(mkdoc([{ type: 'image', role: 'logo', id: 'lg', x: 10, y: 10, w: 160, h: 60, asset: null, fit: 'contain' }])); assert.ok(r.warnings.some(w => w.code === 'logo_placeholder')); assert.ok(close((await pix(r.image)).at(14, 14), [240, 240, 240, 255], 14));
});
test('Nepali and English text render with the bundled fonts, wrap inside the box and respect layers', async () => {
  const t = (txt, o = {}) => ({ type: 'text', id: 't', x: 20, y: 20, w: 200, h: 200, text: txt, font: 'head', size: 36, lineHeight: 46, color: '#ffffff', accent: '#ff0000', align: 'left', ...o });
  const blank = await pix((await R(mkdoc([t('')]))).image), ne = await R(mkdoc([t('कैलालीको बाढीले बगाएको [[मोहना पुल]] पुनर्निर्माण')])), en = await R(mkdoc([t('Contract awarded to rebuild flood-hit Mohana bridge')]));
  assert.ok(!ne.warnings.some(w => w.code === 'font_missing'), 'fonts are loaded'); for (const r of [ne, en]) { const p = await pix(r.image); let diff = 0, maxX = 0, minY = 1e9; for (let y = 0; y < p.h; y++) for (let x = 0; x < p.w; x++) { const a = p.at(x, y), b = blank.at(x, y); if (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) > 60) { diff++; maxX = Math.max(maxX, x); minY = Math.min(minY, y); } } assert.ok(diff > 800, 'ink was drawn'); assert.ok(maxX <= 20 + 200 + 4, 'text wraps inside its box width'); assert.ok(r.metrics.elements.t.lines >= 2, 'a long headline wraps onto lines'); }
  const red = await pix((await R(mkdoc([t('[[RED]] word')]))).image); let hasRed = 0; for (let y = 0; y < red.h; y++) for (let x = 0; x < red.w; x++) { const a = red.at(x, y); if (a[0] > 200 && a[1] < 60) hasRed++; } assert.ok(hasRed > 100, 'highlight colour is used');
  const above = await pix((await R(mkdoc([t('OVERLAP'), shape({ id: 's', x: 0, y: 0, w: 400, h: 300, fill: '#0000ff' })]))).image); assert.ok(close(above.at(40, 40), BLUE), 'a shape above the text covers it');
  const one = await R(mkdoc([t('a    b', { literal: true, size: 20, h: 30 })])); assert.equal(one.metrics.elements.t.lines, 1);
});
test('a classic template converted to an editable document renders like the classic renderer (all three formats, English and Nepali)', async () => {
  const photo = path.join(dir, 'conv.png'); writeFileSync(photo, solid(1600, 900, [['#aa3322', 0, 0, 800, 900], ['#2255aa', 800, 0, 800, 900], ['#ffffff', 700, 300, 200, 300]]));
  for (const format of ['portrait', 'square', 'landscape', 'vertical']) for (const nep of [false, true]) {
    const spec = { ...DEFAULT_SPEC, format, headline: nep ? 'कैलालीको बाढीले बगाएको [[मोहना पुल]] पुनर्निर्माणको ठेक्का सम्झौता' : 'Contract awarded to rebuild flood-hit [[Mohana bridge]] in Kailali', subheadline: nep ? '४५ मिलियन रुपैयाँको ठेक्का' : 'A Rs 45 million contract will reconnect 320 households', dateText: '१ कात्तिक २०८३', sourceText: 'Everest News', category: nep ? 'समाचार' : 'NEWS', footerText: 'Read', urlText: 'everest.news', photo: { zoom: 1.3, fx: 0.4, fy: 0.6, grayscale: true, overlay: 0.12 } };
    const legacy = await renderGraphic(spec, { photoPath: photo }), doc = await docFromSpec(spec, { photoPath: photo, photoAsset: 'photo' }), mine = await R(doc, { photo }), a = await pix(legacy.image), b = await pix(mine.image);
    assert.deepEqual([a.w, a.h], [b.w, b.h]); let sum = 0, bad = 0; for (let i = 0; i < a.data.length; i += 4) { const d = (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2])) / 3; sum += d; if (d > 24) bad++; }
    const px = a.data.length / 4; assert.ok(sum / px < 0.6, `${format}/${nep ? 'ne' : 'en'} mean difference ${(sum / px).toFixed(3)}/255`); assert.ok(bad / px < 0.005, `${format}/${nep ? 'ne' : 'en'} ${(100 * bad / px).toFixed(2)}% of pixels differ visibly`);
  }
});
test('preview and export use the same renderer: byte-identical at 1×, and a half-scale preview matches within a documented tolerance', async () => {
  const photo = path.join(dir, 'par.png'); writeFileSync(photo, solid(900, 600, [['#cc2200', 0, 0, 450, 600], ['#0044cc', 450, 0, 450, 600]]));
  const doc = mkdoc([image({ x: 40, y: 40, w: 320, h: 200, rotation: 12, asset: 'photo' }), { type: 'text', id: 'h', role: 'headline', x: 30, y: 240, w: 340, h: 50, text: 'नुवाकोटका किसानलाई [[बालीको]] चिन्ता', font: 'head', size: 28, lineHeight: 34, color: '#ffffff', accent: '#ff0000' }]); const f = { photo };
  const a = await R(doc, f), b = await R(doc, f); assert.ok(a.image.equals(b.image), 'deterministic'); const half = await R(doc, f, { scale: 0.5 }); const full = await pix(a.image), small = await pix(half.image);
  const up = createCanvas(400, 300), ux = up.getContext('2d'); ux.imageSmoothingQuality = 'high'; ux.drawImage(await loadImage(half.image), 0, 0, 400, 300); const u = ux.getImageData(0, 0, 400, 300).data; let sum = 0; for (let i = 0; i < u.length; i += 4) sum += (Math.abs(u[i] - full.data[i]) + Math.abs(u[i + 1] - full.data[i + 1]) + Math.abs(u[i + 2] - full.data[i + 2])) / 3; assert.ok(sum / (u.length / 4) < 8, `half-scale preview mean difference ${(sum / (u.length / 4)).toFixed(2)}/255 (anti-aliasing only)`); assert.equal(small.w, 200);
});
test('resolution warnings reach the renderer output', async () => {
  const tiny = path.join(dir, 'tiny.png'); writeFileSync(tiny, solid(100, 100, [['#ff0000', 0, 0, 100, 100]])); const r = await R(mkdoc([image({ fit: 'cover' })], { w: 1000, h: 1000 }), { photo: tiny }); assert.ok(r.warnings.some(w => w.code === 'photo_low_resolution' && /enlarged/.test(w.message)));
  const big = path.join(dir, 'big.png'); writeFileSync(big, solid(2400, 2400, [['#ff0000', 0, 0, 2400, 2400]])); const ok = await R(mkdoc([image({ fit: 'cover', x: 0, y: 0, w: 400, h: 400 })]), { photo: big }); assert.ok(!ok.warnings.some(w => w.code === 'photo_low_resolution'));
});

/* ---- persistence, templates, article integration ---- */
const call = async (method, p, body = {}) => { const r = await graphicRoute({ method }, new URL('http://x' + p), async () => body); return { code: r.code ?? 200, ...(r.body ?? r) }; };
test('save an article graphic from a document; reopen it; the saved file equals a fresh render; the original asset is untouched', async () => {
  const cid = story(), buf = solid(800, 600, [['#cc2200', 0, 0, 400, 600], ['#0044cc', 400, 0, 400, 600]]), aid = asset('photo', buf, cid), sha = createHash('sha256').update(readFileSync(db.prepare('SELECT path FROM assets WHERE id=?').get(aid).path)).digest('hex');
  const doc = mkdoc([image({ asset: aid, fit: 'manual', zoom: 1.2, ox: 10, rotation: 5, w: 300, h: 200 }), { type: 'text', id: 'h', role: 'headline', x: 20, y: 230, w: 360, h: 60, text: 'Headline [[words]]', font: 'head', size: 30, lineHeight: 38, color: '#ffffff', accent: '#ff0000' }], { w: 400, h: 300 }); doc.meta = { format: 'custom' };
  const r = await call('POST', '/api/graphics', { cluster_id: cid, doc, strict: true, base_graphic_id: null }); assert.ok(r.id, JSON.stringify(r)); const row = db.prepare('SELECT * FROM graphics WHERE id=?').get(r.id);
  assert.deepEqual(G.sanitizeDoc(JSON.parse(row.spec)), G.sanitizeDoc(doc), 'the editable state is what is stored'); assert.equal(row.headline_snapshot, 'Headline [[words]]'); assert.equal(row.photo_asset_id, aid); assert.deepEqual([row.width, row.height], [400, 300]);
  const fresh = await renderDoc(JSON.parse(row.spec), { byRef: ref => (Number.isInteger(ref) ? db.prepare('SELECT path FROM assets WHERE id=?').get(ref).path : null) }); assert.ok(fresh.image.equals(readFileSync(row.path)), 'reopening reproduces the saved export byte for byte');
  assert.equal(createHash('sha256').update(readFileSync(db.prepare('SELECT path FROM assets WHERE id=?').get(aid).path)).digest('hex'), sha, 'the original image was never modified'); assert.equal(db.prepare('SELECT COUNT(*) n FROM assets WHERE id=?').get(aid).n, 1);
  const p = await pix(readFileSync(row.path)); assert.deepEqual([p.w, p.h], [400, 300]);
});
test('concurrent edits are detected: a stale save is refused and writes nothing; a failed save leaves no partial record', async () => {
  const cid = story(), aid = asset('photo', solid(800, 600, [['#cc2200', 0, 0, 800, 600]]), cid), doc = mkdoc([image({ asset: aid })]); doc.meta = { format: 'custom' };
  const first = await call('POST', '/api/graphics', { cluster_id: cid, doc, strict: true, base_graphic_id: null }); assert.ok(first.id); const count = () => db.prepare('SELECT COUNT(*) n FROM graphics WHERE cluster_id=?').get(cid).n;
  const stale = await call('POST', '/api/graphics', { cluster_id: cid, doc, strict: true, base_graphic_id: null }); assert.equal(stale.code, 409); assert.match(stale.error, /newer version/); assert.equal(stale.current_graphic_id, first.id); assert.equal(count(), 1, 'nothing was written');
  const second = await call('POST', '/api/graphics', { cluster_id: cid, doc, strict: true, base_graphic_id: first.id }); assert.ok(second.id > first.id); assert.equal(db.prepare('SELECT status FROM graphics WHERE id=?').get(first.id).status, 'superseded');
  const before = count(); const bad = await call('POST', '/api/graphics', { cluster_id: cid, doc: { ...doc, elements: [{ id: 'x', type: 'bogus' }] } }); assert.equal(bad.code, 400); assert.equal(count(), before); const missing = await call('POST', '/api/graphics', { cluster_id: cid, doc: mkdoc([image({ asset: 999999 })]) }); assert.equal(missing.code, 409); assert.equal(count(), before);
});
test('one story can never use another story\'s photo', async () => {
  const a = story(), b = story(), other = asset('photo', solid(800, 600, [['#00ff00', 0, 0, 800, 600]]), b); const r = await call('POST', '/api/graphics', { cluster_id: a, doc: mkdoc([image({ asset: other })]) }); assert.equal(r.code, 409); assert.match(r.error, /different story/); const pv = await call('POST', '/api/graphics/preview-doc', { cluster_id: a, doc: mkdoc([image({ asset: other })]) }); assert.equal(pv.code, 409);
});
test('editing an article graphic never changes a shared template; templates change only on explicit, conflict-checked saves, with history', async () => {
  const cid = story(), aid = asset('photo', solid(800, 600, [['#cc2200', 0, 0, 800, 600]]), cid); db.prepare('UPDATE clusters SET lead_asset_id=? WHERE id=?').run(aid, cid);
  const tpl = G.sanitizeDoc(mkdoc([image({ asset: 'photo', role: 'photo', w: 400, h: 300, x: 0, y: 0 }), { type: 'text', id: 'h', role: 'headline', x: 10, y: 200, w: 380, h: 80, text: 'SECRET HEADLINE', font: 'head', size: 30, lineHeight: 38, color: '#ffffff', accent: '#ff0000' }])); tpl.meta = { format: 'custom' };
  const created = await call('POST', '/api/templates', { name: 'My layout', spec: tpl }); assert.ok(created.id); const row = () => db.prepare('SELECT * FROM templates WHERE id=?').get(created.id); assert.equal(JSON.parse(row().spec).elements[1].text, '', 'story words are never stored in a template'); assert.equal(JSON.parse(row().spec).elements[0].asset, 'photo');
  const dup = await call('POST', '/api/templates', { name: 'My layout', spec: tpl }); assert.equal(dup.code, 409); assert.equal(dup.exists, true, 'an existing name is not silently replaced');
  const opened = await call('GET', `/api/design/${cid}/doc?template_id=${created.id}`); assert.equal(opened.doc.elements[0].asset, aid, 'the story\'s own lead image is loaded'); const doc = opened.doc; doc.elements[0].zoom = 2; doc.elements[0].ox = 33;
  const before = JSON.stringify(row()); const saved = await call('POST', '/api/graphics', { cluster_id: cid, doc, template_id: created.id, strict: true, base_graphic_id: null }); assert.ok(saved.id); assert.equal(JSON.stringify(row()), before, 'saving an article graphic did not touch the shared template');
  const t0 = row().updated_at, upd = await call('PUT', `/api/templates/${created.id}`, { spec: doc, expected_updated_at: t0 }); assert.equal(upd.ok, true); assert.equal(JSON.parse(row().spec).elements[0].zoom, 2); const stale = await call('PUT', `/api/templates/${created.id}`, { spec: tpl, expected_updated_at: t0 }); assert.equal(stale.code, 409, 'stale template edits are refused');
  const versions = await call('GET', `/api/templates/${created.id}/versions`); assert.ok(Array.isArray(versions) ? versions.length : true); const vs = db.prepare('SELECT version FROM template_versions WHERE template_id=?').all(created.id); assert.equal(vs.length, 1);
  const restored = await call('POST', `/api/templates/${created.id}/restore`, { version: vs[0].version, expected_updated_at: row().updated_at }); assert.equal(restored.ok, true); assert.equal(JSON.parse(row().spec).elements[0].zoom, 1, 'restore brings the earlier layout back');
  const copy = await call('POST', `/api/templates/${created.id}/duplicate`, {}); assert.ok(copy.id && copy.name !== 'My layout'); assert.equal(db.prepare('SELECT spec FROM templates WHERE id=?').get(copy.id).spec, row().spec);
});
test('existing (classic) templates keep working: they open as documents, and the classic repair never corrupts a document template', async () => {
  const cid = story(); db.prepare('INSERT INTO templates(name,spec,created_at) VALUES(?,?,?)').run('Classic', JSON.stringify({ ...DEFAULT_SPEC, headline: '', footerText: '', badgeLeft: 'BREAKING', badgeRight: 'NEWS' }), ts()); const cl = db.prepare("SELECT id FROM templates WHERE name='Classic'").get().id;
  const doc = await call('GET', `/api/design/${cid}/doc?template_id=${cl}`); assert.equal(doc.template.version, 1); assert.deepEqual([doc.doc.canvas.w, doc.doc.canvas.h], [1080, 1350]); assert.ok(doc.doc.elements.some(e => e.role === 'headline') && doc.doc.elements.some(e => e.type === 'badge'));
  const v2 = await call('POST', '/api/templates', { name: 'Doc tpl', spec: G.sanitizeDoc(mkdoc([shape({ id: 's' })])) }); const raw = db.prepare('SELECT spec FROM templates WHERE id=?').get(v2.id).spec; await call('GET', `/api/design/${cid}`); assert.equal(db.prepare('SELECT spec FROM templates WHERE id=?').get(v2.id).spec, raw, 'the classic design route (which repairs old templates) left the document template alone');
  const vert = await call('GET', `/api/design/${cid}/doc?template_id=${cl}&format=vertical`); assert.deepEqual([vert.doc.canvas.w, vert.doc.canvas.h], [1080, 1920], 'canvas size change on load is explicit and scaled, not stretched'); assert.ok(vert.doc.elements.every(e => e.w > 0));
});
test('article text is filled by role (English and Nepali) from the real draft and escapes nothing into markup', async () => {
  const cid = story(); db.prepare("INSERT INTO drafts(cluster_id,article_id,workflow,lang,status,created_at,source_snapshot,attribution,graphic_headline,graphic_description,bundle_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(cid, db.prepare('INSERT INTO articles(source_id,url,canon_url,title,title_key,language,summary,published_at,fetched_at,updated_at,cluster_id) VALUES(1,?,?,?,?,?,?,?,?,?,?)').run('https://z.test/' + cid, 'https://z.test/' + cid, 't', 'k' + cid, 'ne', 's', ts(), ts(), ts(), cid).lastInsertRowid, 'ne_original', 'ne', 'needs_review', ts(), '{}', '', 'कैलालीको पुल <b>बन्छ</b>', 'ठेक्का सम्झौता भयो', 'story-' + cid);
  const tpl = await call('GET', `/api/design/${cid}/doc?lang=ne`); const head = tpl.doc.elements.find(e => e.role === 'headline'); assert.equal(head.text, 'कैलालीको पुल <b>बन्छ</b>'); assert.equal(tpl.doc.elements.find(e => e.role === 'subheadline').text, 'ठेक्का सम्झौता भयो'); assert.equal(tpl.defaults.lang, 'ne');
  const r = await call('POST', '/api/graphics/preview-doc', { cluster_id: cid, doc: tpl.doc, scale: 0.4 }); assert.ok(r.png && r.width === 432); assert.equal(r.designWidth, 1080);
});

test('9:16 Story layout: native 1080×1920, logo/tag below the profile bar, text stack above the reply bar, in English and Nepali', async () => {
  const photo = path.join(dir, 'v.png'); writeFileSync(photo, solid(1600, 900, [['#aa3322', 0, 0, 800, 900], ['#2255aa', 800, 0, 800, 900]]));
  for (const [headline, sub, cat] of [['Kenyan pastor found guilty of murdering 191 followers in [[starvation]] case', 'A Kenyan court found the pastor guilty in a planned starvation scheme.', 'CRIME'], ['कैलालीको बाढीले बगाएको [[मोहना पुल]] पुनर्निर्माणको ठेक्का सम्झौता भयो', '४५ मिलियन रुपैयाँको ठेक्काले ३२० घरधुरीलाई जोड्नेछ', 'समाचार']]) {
    const spec = { ...DEFAULT_SPEC, format: 'vertical', headline, subheadline: sub, category: cat, dateText: '२० अक्टोबर २०२६', photo: { zoom: 1, fx: 0.5, fy: 0.4, grayscale: true, overlay: 0.12 } }, r = await renderGraphic(spec, { photoPath: photo }), L = r.layout;
    assert.deepEqual([r.width, r.height], [1080, 1920]); assert.ok(L.logo.y >= 1920 * 0.14, `logo starts at ${L.logo.y}, below the top 14%`); assert.ok(L.cat.y >= 1920 * 0.14);
    const stackEnd = Math.max(L.foot.base, L.sub ? L.sub.y + L.sub.lines * L.sub.lh : 0, L.head.y + L.head.lines * L.head.lh); assert.ok(stackEnd <= 1920 * 0.83, `text ends at ${Math.round(stackEnd)}, above the bottom 17%`); assert.ok(L.head.y > 1920 * 0.4, 'the headline sits in the lower half, not mid-canvas');
    assert.ok(!r.warnings.some(w => w.severity === 'error'), JSON.stringify(r.warnings));
  }
  const a = G.safeArea({ w: 1080, h: 1920 }), sq = G.safeArea({ w: 1080, h: 1080 }); assert.ok(a.y >= 1920 * 0.14 - 1 && a.y + a.h <= 1920 * 0.83 + 1, 'Stories safe area excludes the interface bands'); assert.equal(sq.y, Math.round(1080 * 0.06), 'other formats keep the ordinary margin');
});
