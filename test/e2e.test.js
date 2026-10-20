// End-to-end tests against a REAL server process with an isolated data directory (nothing touches your real DB, uploads or social accounts).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createCanvas } from '@napi-rs/canvas';

const dir = mkdtempSync(path.join(tmpdir(), 'e2e-')), PORT = 4300 + Math.floor(Math.random() * 600), B = `http://127.0.0.1:${PORT}`, PASS = 'e2e-test-password';
let proc, cookie = '', sql;
const sha = b => createHash('sha256').update(b).digest('hex');
const api = async (p, o = {}) => { const r = await fetch(B + '/api/' + p, { ...o, headers: { 'content-type': 'application/json', cookie, ...o.headers }, body: o.body && JSON.stringify(o.body) }); let j = null; try { j = await r.clone().json(); } catch {} return { status: r.status, json: j, res: r }; };
const page = async (p, h = {}) => { const r = await fetch(B + p, { redirect: 'manual', headers: h }); return { status: r.status, text: await r.text(), headers: r.headers }; };
const png = () => { const c = createCanvas(1200, 800), x = c.getContext('2d'); const g = x.createLinearGradient(0, 0, 1200, 800); g.addColorStop(0, '#345'); g.addColorStop(1, '#a98'); x.fillStyle = g; x.fillRect(0, 0, 1200, 800); return c.toBuffer('image/png'); };
const now = new Date().toISOString();

before(async () => {
  proc = spawn(process.execPath, ['src/server.js'], { env: { ...process.env, DATA_DIR: dir, DB_PATH: path.join(dir, 'e2e.db'), PORT: String(PORT), ADMIN_PASSWORD: PASS, PUBLIC_BASE_URL: 'https://news.example.test' }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((ok, no) => { const t = setTimeout(() => no(new Error('server did not start')), 15000); proc.stdout.on('data', d => { if (String(d).includes('on http')) { clearTimeout(t); ok(); } }); proc.on('exit', c => no(new Error('server exited ' + c))); });
  sql = new DatabaseSync(path.join(dir, 'e2e.db')); sql.exec('PRAGMA busy_timeout=5000');
  const r = await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASS }) }); cookie = r.headers.get('set-cookie').split(';')[0];
});
after(() => { proc?.kill(); try { rmSync(dir, { recursive: true, force: true }); } catch {} });

// controlled fixtures: a story with one source article and a needs_review Nepali draft
let n = 0;
function fixture({ headline = 'नेपाल विद्युत प्राधिकरण तीन कम्पनीमा विभाजन हुने', status = 'needs_review', lang = 'ne', cluster } = {}) {
  n++; const cid = cluster ?? Number(sql.prepare('INSERT INTO clusters(created_at) VALUES(?)').run(now).lastInsertRowid);
  const aid = Number(sql.prepare("INSERT INTO articles(source_id,url,canon_url,title,title_key,language,summary,published_at,fetched_at,updated_at,cluster_id) VALUES(1,?,?,?,?,?,?,?,?,?,?)").run(`https://src.test/${n}`, `https://src.test/${n}`, 'Source ' + n, 'k' + n, lang === 'en' ? 'ne' : 'en', 'summary', now, now, now, cid).lastInsertRowid);
  const body = 'पहिलो अनुच्छेद: प्राधिकरणको पुनर्संरचना अन्तिम चरणमा पुगेको छ।\n\nदोस्रो अनुच्छेद: विज्ञहरूले स्पष्ट खाका नभए जटिलता आउन सक्ने चेतावनी दिएका छन्।';
  const did = Number(sql.prepare(`INSERT INTO drafts(cluster_id,article_id,workflow,lang,status,model,created_at,source_snapshot,attribution,ai_draft,headline_options,rec_idx,rec_reason,caption,long_summary,meta_title,meta_desc,alt_text,flags,final_headline,final_body,final_caption,approved_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'[]',?,?,?,?)`).run(cid, aid, 'translate_en', lang, status, 'mock/model', now, JSON.stringify({ headline: 'Source', text: 't', url: 'https://src.test/' + n, source: 'SrcOutlet', language: 'en' }), `SrcOutlet: https://src.test/${n}\nOther: https://other.test/${n}`,
    body, JSON.stringify([headline, 'वैकल्पिक शीर्षक', 'अर्को शीर्षक']), 0, 'r', 'क्याप्सन', 'छोटो सारांश', 'मेटा शीर्षक', 'मेटा विवरण', 'तस्बिर', status === 'approved' ? headline : null, status === 'approved' ? body : null, status === 'approved' ? 'क्याप्सन' : null, status === 'approved' ? now : null).lastInsertRowid);
  return { cid, aid, did, headline, body };
}
const approve = async did => (await api(`drafts/${did}/approve`, { method: 'POST', body: { ack_errors: true } }));

test('E2E stale-headline: save graphic → edit headline → stale → regenerate → fresh; stale graphic cannot be attached to the public article', async () => {
  const f = fixture(), H1 = f.headline, H2 = 'प्राधिकरण विभाजन: मन्त्रालयले रोडम्याप टुंग्याउँदै';
  const up = await fetch(`${B}/api/assets?kind=photo&cluster_id=${f.cid}&name=t.png&rights=test%20fixture`, { method: 'POST', headers: { cookie, 'content-type': 'application/octet-stream' }, body: png() }); assert.equal(up.status, 200); const photo = (await up.json()).id;
  const spec = h => ({ format: 'portrait', headline: h, subheadline: 'छोटो विवरण', category: 'राजनीति', dateText: '१९ अक्टोबर २०२६', sourceText: 'स्रोत: SrcOutlet', photo: { grayscale: true } });
  // 2. graphic from the current headline
  const s1 = await api('graphics', { method: 'POST', body: { cluster_id: f.cid, draft_id: f.did, spec: spec(H1), photoAssetId: photo } }); assert.equal(s1.status, 200);
  let d = (await api('design/' + f.cid)).json; assert.equal(d.graphics.length, 1); assert.equal(d.graphics[0].stale, false, 'fresh right after saving');
  const file1 = Buffer.from(await (await fetch(`${B}/api/graphics/${s1.json.id}/file`, { headers: { cookie } })).arrayBuffer());
  // 3. change + save the headline
  const e = await api('drafts/' + f.did, { method: 'PUT', body: { headline: H2, body: f.body, caption: 'क्याप्सन' } }); assert.equal(e.status, 200);
  // 4. old graphic is stale
  d = (await api('design/' + f.cid)).json; assert.equal(d.draft.headline, H2); assert.equal(d.graphics[0].stale, true); assert.match(d.graphics[0].stale_reason, /Regenerate/);
  // approve and try to publish with the stale graphic: refused
  assert.equal((await approve(f.did)).status, 200);
  const bad = await api(`drafts/${f.did}/publish`, { method: 'POST', body: { category: 'politics', graphicId: s1.json.id } }); assert.equal(bad.status, 409); assert.match(bad.json.error, /outdated/);
  // 5. regenerate; 6. preview == export, new file differs, and equals an independent deterministic render of the NEW headline
  const pv = await api('graphics/preview', { method: 'POST', body: { spec: spec(H2), photoAssetId: photo } }); assert.equal(pv.status, 200);
  const s2 = await api('graphics', { method: 'POST', body: { cluster_id: f.cid, draft_id: f.did, spec: spec(H2), photoAssetId: photo } }); assert.equal(s2.status, 200);
  const file2 = Buffer.from(await (await fetch(`${B}/api/graphics/${s2.json.id}/file`, { headers: { cookie } })).arrayBuffer());
  assert.equal(sha(Buffer.from(pv.json.png, 'base64')), sha(file2), 'exported file is exactly what the preview showed');
  assert.notEqual(sha(file1), sha(file2), 'new headline produced a different image');
  const { renderGraphic } = await import('../src/render.js'); const loadPhoto = path.join(dir, 'uploads');
  const assetPath = sql.prepare('SELECT path FROM assets WHERE id=?').get(photo).path;
  const r1 = await renderGraphic(spec(H1), { photoPath: assetPath }), r2 = await renderGraphic(spec(H2), { photoPath: assetPath });
  assert.equal(sha(r2.image), sha(file2), 'export equals an independent render of the new headline'); assert.equal(sha(r1.image), sha(file1), 'old export equals a render of the old headline'); assert.notEqual(sha(r1.image), sha(r2.image));
  d = (await api('design/' + f.cid)).json; assert.equal(d.graphics.length, 1); assert.equal(d.graphics[0].id, s2.json.id); assert.equal(d.graphics[0].stale, false); assert.equal(sql.prepare('SELECT status FROM graphics WHERE id=?').get(s1.json.id).status, 'superseded');
  // publish with the fresh graphic works; the public page uses the NEW headline and its share image
  const ok = await api(`drafts/${f.did}/publish`, { method: 'POST', body: { category: 'politics', graphicId: s2.json.id, noPhoto: true } }); assert.equal(ok.status, 200); // no photo: the graphic is the share image
  const art = await page(ok.json.path); assert.equal(art.status, 200); assert.ok(art.text.includes(H2)); assert.ok(!art.text.includes(H1.slice(0, 10) + ' तीन कम्पनीमा विभाजन हुने'));
  assert.match(art.text, /property="og:image" content="https:\/\/news\.example\.test\/media\/g\/\d+"/); const og = await fetch(`${B}/media/g/${ok.json.id}`); assert.equal(og.status, 200); assert.equal(sha(Buffer.from(await og.arrayBuffer())), sha(file2));
  // later the approved headline changes → the share image stops being served (never silently outdated)
  sql.prepare('UPDATE drafts SET final_headline=? WHERE id=?').run('पूर्ण रूपमा नयाँ शीर्षक', f.did); sql.prepare('UPDATE publications SET headline=? WHERE id=?').run('पूर्ण रूपमा नयाँ शीर्षक', ok.json.id);
  assert.equal((await fetch(`${B}/media/g/${ok.json.id}`)).status, 404, 'outdated graphic no longer served as share image'); assert.doesNotMatch((await page(ok.json.path)).text, /og:image/);
  assert.equal((await api('design/' + f.cid)).json.graphics[0].stale, true);
});

test('unapproved drafts never appear publicly; approval is enforced by the backend', async () => {
  const f = fixture({ headline: 'अप्रकाशित गोप्य शीर्षक' });
  const pub = await api(`drafts/${f.did}/publish`, { method: 'POST', body: { category: 'politics' } }); assert.equal(pub.status, 409); assert.match(pub.json.error, /approved/);
  for (const p of ['/ne/', '/ne/latest', '/ne/search?q=' + encodeURIComponent('अप्रकाशित'), '/sitemap.xml', '/ne/category/politics']) assert.ok(!(await page(p)).text.includes('अप्रकाशित गोप्य'), p);
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM publications WHERE draft_id=?').get(f.did).n, 0);
  assert.equal((await api(`drafts/${f.did}/publish`, { method: 'POST', body: { category: 'bogus' } })).status, 409, 'status checked before anything else');
});

test('approved story is published once: idempotent, visible in home/category/search/sitemap, canonical URL, hidden after unpublish', async () => {
  const f = fixture({ headline: 'विशेष प्रकाशन परीक्षण शीर्षक', status: 'approved' });
  const a = await api(`drafts/${f.did}/publish`, { method: 'POST', body: { category: 'economy' } }); assert.equal(a.status, 200); assert.equal(a.json.created, true);
  const b = await api(`drafts/${f.did}/publish`, { method: 'POST', body: { category: 'economy' } }); assert.equal(b.json.id, a.json.id); assert.equal(b.json.created, false);
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM publications WHERE cluster_id=? AND lang=?').get(f.cid, 'ne').n, 1, 'no duplicate article');
  // a second approved draft for the same story+edition updates the SAME article (stable URL), it does not create another
  const f2 = fixture({ headline: 'संशोधित प्रकाशन शीर्षक', status: 'approved', cluster: f.cid }); const c = await api(`drafts/${f2.did}/publish`, { method: 'POST', body: { category: 'economy' } }); assert.equal(c.json.id, a.json.id); assert.equal(c.json.created, false);
  const home = await page('/ne/'); assert.ok(home.text.includes('संशोधित प्रकाशन शीर्षक')); assert.ok(!home.text.includes('विशेष प्रकाशन परीक्षण'), 'old text replaced, not duplicated');
  assert.ok((await page('/ne/category/economy')).text.includes('संशोधित प्रकाशन'));
  assert.ok((await page('/ne/search?q=' + encodeURIComponent('प्रकाशन शीर्षक'))).text.includes('संशोधित प्रकाशन शीर्षक')); assert.ok((await page('/sitemap.xml')).text.includes(c.json.path));
  const art = await page(c.json.path); assert.equal(art.status, 200); assert.match(art.text, new RegExp(`rel="canonical" href="https://news.example.test${c.json.path}"`)); assert.match(art.text, /"@type":"NewsArticle"/); assert.match(art.text, /SrcOutlet ↗/); assert.ok(art.text.includes('दोस्रो अनुच्छेद'));
  const wrong = await page(`/ne/story/${a.json.id}-wrong-slug`); assert.equal(wrong.status, 301); assert.equal(wrong.headers.get('location'), c.json.path);
  assert.equal((await page(`/en/story/${a.json.id}`)).status, 404, 'edition mismatch is a 404');
  assert.equal((await api(`publications/${a.json.id}/unpublish`, { method: 'POST' })).status, 200);
  assert.equal((await page(c.json.path)).status, 404); assert.ok(!(await page('/ne/')).text.includes('संशोधित प्रकाशन')); assert.ok(!(await page('/sitemap.xml')).text.includes(c.json.path));
  assert.equal((await api(`drafts/${f2.did}/publish`, { method: 'POST', body: { category: 'economy' } })).json.created, false, 'republishing revives the same article');
  assert.equal((await page(c.json.path)).status, 200);
});

test('Nepali and English editions are stored separately and cross-linked with hreflang; language switcher works', async () => {
  const ne = fixture({ headline: 'नेपाली संस्करणको शीर्षक', status: 'approved' }), en = fixture({ headline: 'English edition headline', status: 'approved', lang: 'en', cluster: ne.cid });
  sql.prepare('UPDATE drafts SET ai_draft=?,final_body=? WHERE id=?').run('English body paragraph one.\n\nParagraph two.', 'English body paragraph one.\n\nParagraph two.', en.did);
  const a = await api(`drafts/${ne.did}/publish`, { method: 'POST', body: { category: 'politics' } }), b = await api(`drafts/${en.did}/publish`, { method: 'POST', body: { category: 'politics' } });
  assert.notEqual(a.json.id, b.json.id); assert.equal(sql.prepare('SELECT COUNT(*) n FROM publications WHERE cluster_id=?').get(ne.cid).n, 2);
  const pn = await page(a.json.path), pe = await page(b.json.path);
  assert.match(pn.text, /<html lang="ne">/); assert.match(pe.text, /<html lang="en">/); assert.ok(pn.text.includes('नेपाली संस्करणको शीर्षक') && !pn.text.includes('English edition headline'));
  assert.match(pn.text, new RegExp(`hreflang="en" href="https://news.example.test${b.json.path}"`)); assert.match(pe.text, new RegExp(`hreflang="ne" href="https://news.example.test${a.json.path}"`));
  assert.ok(pn.text.includes(`href="${b.json.path}" hreflang="en"`), 'switcher points to the English version of the same story'); assert.ok(pe.text.includes('English body paragraph one.'));
  assert.ok(!(await page('/ne/')).text.includes('English edition headline')); assert.ok((await page('/en/')).text.includes('English edition headline'));
  assert.ok((await page('/en/search?q=paragraph')).text.includes('English edition headline'));
});

test('safety: XSS escaped, photo needs recorded permission, only live photos are served, empty/bad inputs handled', async () => {
  const f = fixture({ headline: '<script>alert(1)</script> शीर्षक "quote" & <b>', status: 'approved' });
  const up = await fetch(`${B}/api/assets?kind=photo&cluster_id=${f.cid}&name=ok.png&rights=mine`, { method: 'POST', headers: { cookie }, body: png() }), photo = (await up.json()).id;
  const noRights = Number(sql.prepare("INSERT INTO assets(kind,cluster_id,path,orig_name,mime,bytes,width,height,sha256,created_at,rights_note) SELECT kind,cluster_id,path,'norights.png',mime,bytes,width,height,sha256,created_at,'' FROM assets WHERE id=?").run(photo).lastInsertRowid);
  assert.equal((await api(`drafts/${f.did}/publish`, { method: 'POST', body: { category: 'politics', photoAssetId: noRights } })).status, 409);
  assert.equal((await fetch(`${B}/media/p/99999`)).status, 404, 'no photo for an unknown/unpublished article');
  const ok = await api(`drafts/${f.did}/publish`, { method: 'POST', body: { category: 'politics', photoAssetId: photo, photoCredit: 'Photo: Test' } }); assert.equal(ok.status, 200);
  const art = await page(ok.json.path); assert.ok(!art.text.includes('<script>alert(1)</script>')); assert.ok(art.text.includes('&lt;script&gt;alert(1)&lt;/script&gt;')); assert.ok(!/<script>alert/.test(art.text));
  assert.match(art.text, /<img src="\/media\/p\/\d+\?w=640/); assert.match(art.text, /srcset=/); assert.match(art.text, /fetchpriority="high"/);
  const m = await fetch(`${B}/media/p/${ok.json.id}?w=320`); assert.equal(m.status, 200); assert.equal(m.headers.get('content-type'), 'image/webp'); assert.match(m.headers.get('cache-control'), /immutable/);
  await api(`publications/${ok.json.id}/unpublish`, { method: 'POST' }); assert.equal((await fetch(`${B}/media/p/${ok.json.id}`)).status, 404, 'photo of an unpublished article is not served');
  const s = await page('/ne/search?q=' + 'x'.repeat(500)); assert.equal(s.status, 200); assert.equal((await page('/ne/search?q=a')).status, 200); assert.match((await page('/ne/search?q=a')).text, /कम्तीमा दुई/);
  assert.ok((await page('/ne/search?q=%25_%5C')).text.length > 0, 'LIKE wildcards are escaped');
});

test('admin surface is not reachable without login; public pages leak nothing internal', async () => {
  for (const p of ['sources', 'drafts', 'publications', 'ai/config', 'logs', 'newsroom']) assert.equal((await fetch(`${B}/api/${p}`)).status, 401, p);
  assert.equal((await fetch(`${B}/img/1`)).status, 401); assert.equal((await fetch(`${B}/api/graphics/preview`, { method: 'POST' })).status, 401);
  const robots = await page('/robots.txt'); assert.match(robots.text, /Disallow: \/admin/); assert.match(robots.text, /Disallow: \/api\//);
  const home = await page('/ne/'); for (const bad of ['OPENROUTER', 'password', '/api/', 'ADMIN']) assert.ok(!home.text.includes(bad), bad);
  assert.match(home.headers.get('content-security-policy'), /script-src 'self'/); assert.equal((await page('/')).headers.get('location'), '/ne/'); assert.equal((await page('/', { 'accept-language': 'en-US,en;q=0.9' })).headers.get('location'), '/en/');
});

test('merging two stories that are both live in one edition is refused (no duplicate articles)', async () => {
  const a = fixture({ headline: 'अर्थमन्त्रालयले नयाँ बजेट सार्वजनिक गर्‍यो', status: 'approved' }), b = fixture({ headline: 'काठमाडौंमा भारी वर्षा, बाढीको जोखिम बढ्यो', status: 'approved' });
  await api(`drafts/${a.did}/publish`, { method: 'POST', body: { category: 'national' } }); await api(`drafts/${b.did}/publish`, { method: 'POST', body: { category: 'national' } });
  const aid = sql.prepare('SELECT id FROM articles WHERE cluster_id=?').get(a.cid).id, bid = sql.prepare('SELECT id FROM articles WHERE cluster_id=?').get(b.cid).id;
  const cand = Number(sql.prepare('INSERT INTO cluster_candidates(a_id,b_id,score,reason) VALUES(?,?,0.5,?)').run(aid, bid, 'test').lastInsertRowid);
  const r = await api('candidates/' + cand, { method: 'POST', body: { decision: 'merge' } }); assert.equal(r.status, 409); assert.match(r.json.error, /Unpublish one/);
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM clusters WHERE id IN (?,?)').get(a.cid, b.cid).n, 2, 'nothing was merged');
  // and a merge of an unpublished story carries its drafts across without a foreign-key error
  const c = fixture({ headline: 'राष्ट्रिय क्रिकेट टोलीको घोषणा', status: 'approved' }), caid = sql.prepare('SELECT id FROM articles WHERE cluster_id=?').get(c.cid).id;
  const cand2 = Number(sql.prepare('INSERT INTO cluster_candidates(a_id,b_id,score,reason) VALUES(?,?,0.5,?)').run(caid, aid, 'test').lastInsertRowid);
  const ok = await api('candidates/' + cand2, { method: 'POST', body: { decision: 'merge' } }); assert.equal(ok.status, 200); assert.equal(sql.prepare('SELECT cluster_id FROM drafts WHERE id=?').get(c.did).cluster_id, a.cid);
});
