import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
process.env.DB_PATH = ':memory:';
const { renderGraphic, parseHighlight, FORMATS } = await import('../src/render.js');
const { sniffImage, cleanSpec, currentHeadline, isStale } = await import('../src/graphic_routes.js');
const sha = b => createHash('sha256').update(b).digest('hex');
const base = { headline: 'राष्ट्रपति पौडेलद्वारा [[शक्तिपीठहरूमा]] पूजाआराधना', subheadline: 'थप विवरण आउन बाँकी' };

test('all three formats render at the right size', async () => {
  for (const [k, f] of Object.entries(FORMATS)) { const r = await renderGraphic({ ...base, format: k }); assert.equal(r.width, f.w); assert.equal(r.height, f.h); assert.ok(r.image.length > 5000); assert.deepEqual(r.warnings.filter(w => w.severity === 'error'), []); }
});
test('rendering is deterministic', async () => { const a = await renderGraphic(base), b = await renderGraphic(base); assert.equal(sha(a.image), sha(b.image)); });
test('overflowing headline is reported, not silently clipped', async () => {
  const r = await renderGraphic({ ...base, headline: 'अत्यन्त लामो शीर्षक '.repeat(40) }); assert.ok(r.warnings.some(w => w.code === 'headline_overflow' && w.severity === 'error'));
  const ok = await renderGraphic(base); assert.ok(!ok.warnings.some(w => w.code.startsWith('headline_'))); assert.equal(ok.metrics.headlineFont, 66);
});
test('long-but-fitting headline shrinks and warns about readability', async () => {
  const r = await renderGraphic({ ...base, headline: 'नेपाल विद्युत प्राधिकरणलाई तीन कम्पनीमा विभाजन गर्ने योजना अन्तिम चरणमा पुगेको र मन्त्रालयले रोडम्याप तयार पार्दै '.repeat(2) }); assert.ok(r.metrics.headlineFont < 66);
});
test('warnings: no photo, placeholder logo, empty headline, unsupported script', async () => {
  const c = (await renderGraphic(base)).warnings.map(w => w.code); assert.ok(c.includes('no_photo') && c.includes('logo_placeholder'));
  assert.ok((await renderGraphic({ ...base, headline: '' })).warnings.some(w => w.code === 'headline_empty'));
  assert.ok((await renderGraphic({ ...base, headline: '汉字标题' })).warnings.some(w => w.code === 'unsupported_characters'));
});
test('subheadline over two lines is truncated with a warning', async () => {
  assert.ok((await renderGraphic({ ...base, subheadline: 'यो धेरै लामो उपशीर्षक हो '.repeat(20) })).warnings.some(w => w.code === 'subheadline_truncated'));
});
test('parseHighlight splits words and flags [[ ]] spans; mid-word highlight stays one word', () => {
  assert.deepEqual(parseHighlight('a [[b c]] d').map(x => [x.w, x.hi]), [['a', false], ['b', true], ['c', true], ['d', false]]);
  const t = parseHighlight('नेपाल [[विद्]]युत तीन'); assert.deepEqual(t.map(x => x.w), ['नेपाल', 'विद्युत', 'तीन']); assert.deepEqual(t[1].segs.map(x => x.hi), [true, false]);
});
test('cleanSpec keeps defaults for absent fields but honours an explicit blank', () => {
  const d = cleanSpec({}); assert.equal(d.badgeLeft, 'BREAKING'); assert.equal(d.badgeRight, 'NEWS'); assert.equal(d.footerText, '', 'no Read More on the image by default'); assert.equal(d.photo.grayscale, true);
  const b = cleanSpec({ badgeLeft: '', badgeRight: '', footerText: '', photo: { grayscale: false } }); assert.equal(b.badgeLeft, ''); assert.equal(b.footerText, ''); assert.equal(b.photo.grayscale, false);
});
test('sniffImage accepts png/jpeg/webp by magic bytes and refuses svg/gif/html', () => {
  assert.deepEqual(sniffImage(Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(40)])), ['image/png', 'png']); assert.deepEqual(sniffImage(Buffer.from('ffd8ffe000104a46', 'hex')), ['image/jpeg', 'jpg']);
  assert.equal(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null); assert.equal(sniffImage(Buffer.from('GIF89a......')), null); assert.equal(sniffImage(Buffer.from('<html><script>')), null);
});
test('cleanSpec bounds and types untrusted input', () => {
  const s = cleanSpec({ format: 'evil', headline: 'x'.repeat(999), colors: { accent: 'url(javascript:1)' }, photo: { zoom: 99, fx: -5, overlay: 5 }, extra: 'ignored' });
  assert.equal(s.format, 'portrait'); assert.equal(s.headline.length, 300); assert.equal(s.colors.accent, '#d62828'); assert.equal(s.photo.zoom, 4); assert.equal(s.photo.fx, 0); assert.equal(s.photo.overlay, 0.7); assert.ok(!('extra' in s));
});
test('graphic goes stale when the approved headline changes', () => {
  const d = { status: 'approved', final_headline: 'नयाँ शीर्षक', headline_options: '["a"]', rec_idx: 0 };
  assert.equal(currentHeadline(d), 'नयाँ शीर्षक'); assert.equal(isStale({ headline_snapshot: 'पुरानो शीर्षक' }, d), true); assert.equal(isStale({ headline_snapshot: 'नयाँ शीर्षक' }, d), false);
  assert.equal(currentHeadline({ status: 'needs_review', edited_headline: null, headline_options: '["rec","b"]', rec_idx: 0 }), 'rec');
  assert.equal(isStale({ headline_snapshot: '[[नयाँ]]  शीर्षक' }, d), false, 'highlight markers and spacing are not a headline change');
  assert.equal(isStale({ headline_snapshot: 'x' }, null), false);
});
