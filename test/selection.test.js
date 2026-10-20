// Hourly selection, image continuity and public-copy tests. Deterministic fixtures (fictional stories), injected clocks and fetchers.
// They prove code paths; a real scheduled run is demonstrated separately (test/e2e_selection.test.js runs a real worker process).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
Object.assign(process.env, { DB_PATH: ':memory:', DATA_DIR: mkdtempSync(path.join(tmpdir(), 'sel-')), TOKEN_KEY: 'd'.repeat(64), SOCIAL_MOCK: '1', PUBLIC_BASE_URL: 'https://news.example.test', SELECT_GRACE_MIN: '5', SELECT_WINDOW_MIN: '60', SELECT_TZ_OFFSET_MIN: '345', SELECT_MIN_SCORE: '60', EXTRACT_DELAY_MS: '0' });
const { createCanvas, loadImage } = await import('@napi-rs/canvas');
const { db } = await import('../src/db.js');
const Sel = await import('../src/selection.js');
const { rankClusters } = await import('../src/rank.js');
const { publishDraft } = await import('../src/pub_routes.js');
const { updateDraft, approveDraft } = await import('../src/drafts.js');
const { graphicRoute } = await import('../src/graphic_routes.js');
const { renderGraphic } = await import('../src/render.js');
const { handleSite } = await import('../src/site.js');
const { _setFetcher, warmBatch, thumbnail } = await import('../src/imgcache.js');
const { _setRobotsFetcher } = await import('../src/robots.js');
const S = await import('../src/social.js');
const { genericImage } = await import('../src/images.js');
_setRobotsFetcher(async () => ({ status: 200, buf: Buffer.from('User-agent: *\nDisallow:\n') })); S.setMaxAccounts(100);

const HOUR = 36e5, BASE_END = Date.UTC(2026, 9, 19, 6, 15) /* 12:00 NST */, iso = ms => new Date(ms).toISOString();
const slot = k => ({ start: BASE_END + (k - 1) * HOUR, end: BASE_END + k * HOUR }), at = k => slot(k).end + 6 * 60000; // 6 minutes after the window closed
let n = 0;
const LONG = ' नेपालको राजधानी काठमाडौंमा सम्बन्धित निकायले बुधबार थप जानकारी दिएको छ र आगामी दिनमा निर्णय हुने जनाइएको छ।';
// one cluster, one article per listed source (the first is the lead report)
function story({ title, lang = 'ne', fetched, published = fetched, sources = [1], image = null, summary = title + LONG }) {
  n++; const cid = Number(db.prepare('INSERT INTO clusters(created_at) VALUES(?)').run(iso(fetched)).lastInsertRowid), aids = [];
  sources.forEach((sid, i) => aids.push(Number(db.prepare('INSERT INTO articles(source_id,url,canon_url,title,title_key,language,summary,published_at,fetched_at,updated_at,cluster_id,image_url) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(sid, `https://s${sid}.test/${n}-${i}`, `https://s${sid}.test/${n}-${i}`, title, `k${n}${i}`, lang, summary, iso(published + i * 1000), iso(fetched + i * 60000), iso(fetched), cid, i === 0 ? image : null).lastInsertRowid)));
  return { cid, aids };
}
const sel = k => db.prepare('SELECT * FROM selections WHERE slot_start=?').get(iso(slot(k).start));
const png = (w, h, color = '#456') => { const c = createCanvas(w, h), x = c.getContext('2d'); x.fillStyle = color; x.fillRect(0, 0, w, h); x.fillStyle = '#fff'; x.fillRect(w / 4, h / 4, w / 2, h / 2); return c.toBuffer('image/png'); };
const dir = process.env.DATA_DIR; let fileN = 0;
function asset(cid, w, h, { rights = 'licensed to Everest News (test)', lead = true } = {}) {
  const p = path.join(dir, `a${++fileN}.png`); writeFileSync(p, png(w, h)); const id = Number(db.prepare("INSERT INTO assets(kind,cluster_id,path,orig_name,mime,bytes,width,height,sha256,created_at,rights_note) VALUES('photo',?,?,?,'image/png',1,?,?,?,?,?)").run(cid, p, `p${fileN}.png`, w, h, 'sha' + fileN, iso(BASE_END), rights).lastInsertRowid);
  if (lead) db.prepare('UPDATE clusters SET lead_asset_id=? WHERE id=? AND lead_asset_id IS NULL').run(id, cid); return { id, path: p, w, h };
}
const NE_BODY = 'पहिलो अनुच्छेद यहाँ छ।\n\nदोस्रो अनुच्छेद यहाँ छ।', EN_BODY = 'First paragraph is here.\n\nSecond paragraph is here.';
function draft(cid, lang, o = {}) { // an APPROVED bilingual-bundle draft with its own graphic and caption fields
  const ne = lang === 'ne', aid = db.prepare('SELECT id FROM articles WHERE cluster_id=? LIMIT 1').get(cid).id, h = o.headline ?? (ne ? `नेपाल शीर्षक ${cid}` : `Website headline ${cid}`), gh = o.gh ?? (ne ? `ग्राफिक शीर्षक ${cid}` : `Graphic headline ${cid}`), gd = o.gd ?? (ne ? 'ग्राफिकको छोटो विवरण' : 'Short graphic description'), cap = o.cap ?? (ne ? `नेपालका सम्बन्धित निकायले बुधबार थप जानकारी दिएका छन् र आगामी हप्ता निर्णय हुने सम्भावना छ।\n{{ARTICLE_URL}}\n#नेपाल` : `The relevant agencies gave further details on Wednesday and a decision is expected next week.\n{{ARTICLE_URL}}\n#Nepal`);
  const fj = { standfirst: 'standfirst', graphic_headline: gh, graphic_description: gd, short_caption: 'short', seo_title: 'seo', meta_desc: 'meta', alt_text: 'alt', keywords: ['a', 'b', 'c'], hashtags: ['#Nepal'] };
  return Number(db.prepare(`INSERT INTO drafts(cluster_id,article_id,workflow,lang,status,created_at,source_snapshot,attribution,ai_draft,headline_options,rec_idx,flags,final_headline,final_body,final_caption,final_json,approved_at,bundle_id,graphic_headline,graphic_description,caption,long_summary,hashtags)
    VALUES(?,?,?,?,?,?,'{}','S: https://s1.test/x',?,?,0,'[]',?,?,?,?,?,?,?,?,?,?,?)`).run(cid, aid, 'x', lang, o.status ?? 'approved', iso(BASE_END), ne ? NE_BODY : EN_BODY, JSON.stringify([h]), h, ne ? NE_BODY : EN_BODY, cap, JSON.stringify(fj), iso(BASE_END), 'bundle-' + cid, gh, gd, cap, 'standfirst', JSON.stringify(['#Nepal'])).lastInsertRowid);
}
const call = async (method, p, body = {}) => graphicRoute({ method }, new URL('http://x' + p), async () => body);
const page = async (p, lang) => { const r = await handleSite('GET', new URL('https://news.example.test' + p), { host: 'news.example.test' }); return { status: r.status, text: r.body?.toString?.() ?? '', buf: r.body }; };

test('1. the hourly selection picks the highest-ranked qualifying story of the window and records it', () => {
  const w = slot(1), t = w.start + 20 * 60000;
  const A = story({ title: 'सरकारले नेपाल बजेट सार्वजनिक गर्‍यो अल्फा', fetched: t, sources: [1, 2, 3] }), B = story({ title: 'क्रिकेट टोली घोषणा बिटा', fetched: t, sources: [4] }), C = story({ title: 'मौसम पूर्वानुमान गामा', fetched: t - 600000, sources: [5] });
  const r = Sel.runSelection(at(1)); assert.equal(r.status, 'selected'); assert.equal(r.cluster_id, A.cid, 'the corroborated, higher-ranked story wins'); assert.equal(r.eligible, 3);
  const row = sel(1); assert.equal(row.cluster_id, A.cid); assert.equal(row.status, 'selected'); assert.ok(row.score >= 60); assert.ok(JSON.parse(row.factors).some(f => f.factor === 'corroboration' && f.points > 0), 'ranking factors are stored with the decision');
  assert.equal(row.slot_start, iso(w.start)); assert.equal(row.slot_end, iso(w.end)); assert.equal(Sel.runSelection(at(1)), null, 'a decided window is never decided twice');
  const ranks = rankClusters(w.end, { asOf: iso(w.end) }).filter(c => [A.cid, B.cid, C.cid].includes(c.id)).sort((a, b) => b.score - a.score); assert.equal(ranks[0].id, A.cid, 'the selector reuses the existing ranking function');
});
test('2. windows: first-seen time defines membership; older, future and backlog stories are handled; "nothing qualifies" is a valid outcome', () => {
  const w = slot(2);
  const prev = story({ title: 'पुरानो समाचार डेल्टा', fetched: w.start - 600000, sources: [1, 2] }); // first seen in the PREVIOUS window
  const future = story({ title: 'भविष्यको समाचार इप्सिलन', fetched: w.end + 120000, published: w.end - 60000, sources: [1, 2, 3] }); // arrives after the window closed
  const backlog = story({ title: 'पुरानो ब्याकलग जेटा', fetched: w.start + 600000, published: w.start - 12 * HOUR, sources: [1, 2, 3] }); // fetched now but published 12h ago
  const ok = story({ title: 'सरकारले नयाँ नीति ल्यायो इटा', fetched: w.start + 1800000, sources: [1, 2] });
  const dry = Sel.pickForWindow(slot(2).start, slot(2).end); assert.equal(dry.best.id, ok.cid); assert.ok(dry.skipped.too_old >= 1, 'the 12-hour-old backlog item is rejected as too old'); assert.ok(dry.skipped.not_first_seen_in_window >= 1, 'stories first seen in another window are rejected'); assert.equal(dry.eligible, 1, 'a dry run has no side effects');
  assert.equal(db.prepare('SELECT 1 FROM selections WHERE slot_start=?').get(iso(slot(2).start)), undefined, 'pickForWindow does not record anything');
  const r = Sel.runSelection(at(2)); assert.equal(r.cluster_id, ok.cid); for (const x of [prev, future, backlog]) assert.notEqual(r.cluster_id, x.cid);
  // a window where only a weak story appeared: nothing is forced
  const weak = slot(3); story({ title: 'सानो स्थानीय खबर थेटा', fetched: weak.start + 600000, sources: [6] }); process.env.SELECT_MIN_SCORE = '99'; const none = Sel.runSelection(at(3)); process.env.SELECT_MIN_SCORE = '60';
  assert.equal(none.status, 'none'); assert.match(sel(3).reason, /threshold \(best score/); assert.equal(sel(3).cluster_id, null);
  // a window with no stories at all
  assert.equal(Sel.runSelection(at(4)).status, 'none'); assert.match(sel(4).reason, /no eligible story/); assert.equal(db.prepare("SELECT COUNT(*) n FROM selections WHERE status='none'").get().n >= 2, true);
});
test('3. duplicate coverage never produces a duplicate selection', () => {
  const X = story({ title: 'सरकारले इन्धन मूल्य घटायो कप्पा', fetched: slot(5).start + 600000, sources: [1, 2] }); assert.equal(Sel.runSelection(at(5)).cluster_id, X.cid);
  const Y = story({ title: 'सरकारले इन्धन मूल्य घटायो कप्पा', fetched: slot(6).start + 600000, sources: [7, 8] }); // a separate cluster reporting the same event an hour later
  const r = Sel.runSelection(at(6)); assert.equal(r.status, 'none', 'same event, different cluster: skipped'); assert.notEqual(r.cluster_id, Y.cid);
  db.prepare("INSERT INTO articles(source_id,url,canon_url,title,title_key,language,summary,published_at,fetched_at,updated_at,cluster_id) VALUES(3,'https://s3.test/late','https://s3.test/late','x','xx','ne','x',?,?,?,?)").run(iso(slot(7).start + 60000), iso(slot(7).start + 60000), iso(0), X.cid); // new coverage joins the already-selected story
  const Z = story({ title: 'पूर्ण फरक विषयको समाचार लाम्बडा', fetched: slot(7).start + 900000, sources: [1] }); db.prepare("INSERT INTO cluster_candidates(a_id,b_id,score,reason) VALUES(?,?,0.5,'t')").run(Z.aids[0], X.aids[0]);
  const r7 = Sel.runSelection(at(7)); assert.notEqual(r7.cluster_id, X.cid, 'an already-selected story is not selected again'); assert.notEqual(r7.cluster_id, Z.cid, 'a cluster with an unresolved duplicate link to a selected story is skipped');
  assert.throws(() => db.prepare("INSERT INTO selections(slot_start,slot_end,status,cluster_id,created_at) VALUES('x','y','selected',?,?)").run(X.cid, iso(0)), /UNIQUE/, 'the database itself refuses a second selection of one story');
});
test('4. a late-arriving story follows the documented policy: it belongs to the window in which it arrived', () => {
  const w7 = slot(8), lateStory = story({ title: 'सरकारले नयाँ कानुन ल्यायो मु', fetched: w7.end + 2 * 60000, published: w7.end - 5 * 60000, sources: [1, 2, 3] }); // published inside window 8, fetched 2 minutes after it closed
  const other = story({ title: 'सरकारको अर्को सामान्य निर्णय नु', fetched: w7.start + 600000, sources: [1, 2] });
  const early = Sel.runSelection(at(8)); assert.notEqual(early.cluster_id, lateStory.cid, 'not eligible for the window that had already closed'); assert.equal(early.cluster_id, other.cid);
  const asOfRank = rankClusters(w7.end, { asOf: iso(w7.end) }).find(c => c.id === lateStory.cid); assert.equal(asOfRank, undefined, 'ranking "as of" the close does not see it');
  const next = Sel.runSelection(at(9)); assert.equal(next.cluster_id, lateStory.cid, 'it competes in the next window, still inside the lateness tolerance'); // published ~5 minutes before that window began
  const tooLate = story({ title: 'बहुत पुरानो खबर रु', fetched: slot(10).start + 600000, published: slot(10).start - 20 * HOUR, sources: [1, 2, 3] }); assert.notEqual(Sel.runSelection(at(10)).cluster_id, tooLate.cid, 'older than the tolerance: never "news of the hour"');
});
test('restarts: a restarted worker neither duplicates nor silently back-fills; skipped windows are recorded as missed', () => {
  const before = db.prepare('SELECT COUNT(*) n FROM selections').get().n; assert.equal(Sel.runSelection(at(10)), null); assert.equal(db.prepare('SELECT COUNT(*) n FROM selections').get().n, before);
  story({ title: 'सरकारले बैठक बस्यो सिग्मा', fetched: slot(14).start + 600000, sources: [1, 2] }); const r = Sel.runSelection(at(14)); assert.equal(r.status, 'selected');
  for (const k of [11, 12, 13]) { const row = sel(k); assert.equal(row.status, 'missed', `window ${k}`); assert.equal(row.cluster_id, null); }
  assert.equal(Sel.runSelection(at(14)), null);
  const { slotFor } = Sel; const s = slotFor(Date.UTC(2026, 9, 19, 7, 0), 60, 345); assert.equal(new Date(s.end).toISOString(), '2026-10-19T06:15:00.000Z', 'windows are aligned to :00 Nepal time'); assert.equal(s.end - s.start, HOUR);
});
test('selection never publishes, and optional auto-draft requests one bundle once, even after a crash', () => {
  const pubBefore = db.prepare('SELECT COUNT(*) n FROM publications').get().n, postsBefore = db.prepare('SELECT COUNT(*) n FROM posts').get().n;
  process.env.SELECT_AUTO_DRAFT = '1'; const A = story({ title: 'सरकारले नयाँ योजना घोषणा गर्‍यो ओमेगा', fetched: slot(15).start + 600000, sources: [1, 2] }); const r = Sel.runSelection(at(15)); assert.equal(r.cluster_id, A.cid);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM edition_jobs WHERE cluster_id=? AND auto_publish=0").get(A.cid).n, 2, 'one independent job per edition is queued for the pick, neither auto-publishing'); assert.ok(sel(15).draft_requested_at);
  db.prepare('UPDATE selections SET draft_requested_at=NULL WHERE slot_start=?').run(iso(slot(15).start)); db.prepare('DELETE FROM edition_jobs WHERE cluster_id=?').run(A.cid); assert.equal(Sel.ensureDraftRequested(), 1, 'a crash between "selected" and "queued" is repaired'); assert.equal(Sel.ensureDraftRequested(), 0);
  delete process.env.SELECT_AUTO_DRAFT; assert.equal(db.prepare('SELECT COUNT(*) n FROM publications').get().n, pubBefore); assert.equal(db.prepare('SELECT COUNT(*) n FROM posts').get().n, postsBefore); assert.equal(Sel.cfg().autoDraft, false, 'automation is off by default (each story costs an AI request)');
});
test('5. the selected story keeps its own image: own report first, another report of the SAME event second, never an unrelated or default image', () => {
  const t = slot(20).start + 600000, mine = story({ title: 'सरकारले नयाँ पुल उद्घाटन गर्‍यो पाइ', fetched: t, sources: [1, 2], image: 'https://img.test/mine.jpg' }), other = story({ title: 'अर्कै विषयको खबर रो', fetched: t, sources: [3], image: 'https://img.test/other.jpg' });
  db.prepare('UPDATE articles SET image_url=? WHERE id=?').run('https://img.test/second-report.jpg', mine.aids[1]); assert.equal(Sel.pickImageArticle(mine.cid), mine.aids[0], 'its own report’s image'); assert.notEqual(db.prepare('SELECT cluster_id FROM articles WHERE id=?').get(Sel.pickImageArticle(mine.cid)).cluster_id, other.cid);
  db.prepare('UPDATE articles SET image_url=NULL WHERE id=?').run(mine.aids[0]); assert.equal(Sel.pickImageArticle(mine.cid), mine.aids[1], 'falls back to another report of the same event');
  const generic = 'https://img.test/default-logo.jpg'; const g = [1, 2, 3, 4].map(i => story({ title: `असम्बन्धित खबर ${i} पाउ`, fetched: t - i * 1000, sources: [2], image: generic })); const own = story({ title: 'पाँचौ खबर पाउ', fetched: t, sources: [2, 3], image: generic });
  const art = db.prepare('SELECT * FROM articles WHERE id=?').get(own.aids[0]); assert.equal(genericImage(art), true, 'the same file on several unrelated stories is a publisher default'); assert.equal(Sel.pickImageArticle(own.cid), null, 'no image is better than the wrong image');
  db.prepare('UPDATE articles SET image_url=? WHERE id=?').run('https://img.test/real-photo.jpg', own.aids[1]); assert.equal(Sel.pickImageArticle(own.cid), own.aids[1], 'a genuine image from another report of the event is used instead');
  const st = story({ title: 'चयनित खबर पाउ पाउ', fetched: slot(21).start + 600000, sources: [1, 2], image: 'https://img.test/sel.jpg' }); const r = Sel.runSelection(at(21)); assert.equal(r.cluster_id, st.cid); assert.equal(sel(21).image_article_id, st.aids[0], 'the pick records which report’s image belongs to it');
});
test('6. the story image appears on the approved website article and its cards; another story’s image is refused', async () => {
  const A = story({ title: 'छवि परीक्षण कथा एक', fetched: BASE_END, sources: [1] }), B = story({ title: 'छवि परीक्षण कथा दुई', fetched: BASE_END, sources: [2] });
  const a = asset(A.cid, 800, 400), b = asset(B.cid, 400, 800), dA = draft(A.cid, 'ne', { headline: 'पहिलो कथाको शीर्षक अल्फा' }), dB = draft(B.cid, 'ne', { headline: 'दोस्रो कथाको शीर्षक बिटा' });
  const pa = publishDraft(dA, { category: 'national' }), pb = publishDraft(dB, { category: 'economy' }); assert.ok(pa.id && pb.id);
  assert.equal(db.prepare('SELECT photo_asset_id FROM publications WHERE id=?').get(pa.id).photo_asset_id, a.id, 'the lead image is the default'); assert.equal(db.prepare('SELECT photo_asset_id FROM publications WHERE id=?').get(pb.id).photo_asset_id, b.id);
  const ha = await page(pa.path), hb = await page(pb.path); const hero = t => t.match(/<figure class="hero"><img src="\/media\/p\/(\d+)\?/)?.[1]; assert.equal(hero(ha.text), String(pa.id), 'article A’s lead image is A’s'); assert.equal(hero(hb.text), String(pb.id), 'article B’s lead image is B’s');
  const ma = await page(`/media/p/${pa.id}?w=640`), mb = await page(`/media/p/${pb.id}?w=640`), ia = await loadImage(ma.buf), ib = await loadImage(mb.buf); assert.ok(ia.width / ia.height > 1.9 && ia.width / ia.height < 2.1, 'article A serves A’s 2:1 photo'); assert.ok(ib.height / ib.width > 1.9, 'article B serves B’s 1:2 photo');
  const home = await page('/ne/'); assert.ok(home.text.includes(`/media/p/${pa.id}?`) && home.text.includes(`/media/p/${pb.id}?`), 'cards use the same images');
  const cross = publishDraft(draft(A.cid, 'en'), { category: 'national', photoAssetId: b.id }); assert.equal(cross.code, 409, 'story B’s image cannot be attached to story A'); assert.match(cross.body.error, /different story|lead image/);
  const noRights = asset(A.cid, 500, 500, { rights: '', lead: false }); assert.equal((await call('POST', `/api/story/${A.cid}/lead-image`, { asset_id: noRights.id })).code, 409, 'an image without recorded rights cannot become the lead'); assert.equal((await call('POST', `/api/story/${A.cid}/lead-image`, { asset_id: b.id })).code, 409);
});
test('7+8. the same approved image goes into the correct graphic, and Nepali and English graphics use their own text', async () => {
  const A = story({ title: 'ग्राफिक परीक्षण कथा', fetched: BASE_END, sources: [1] }); const a = asset(A.cid, 900, 700), dNe = draft(A.cid, 'ne', { headline: 'वेबसाइटको नेपाली शीर्षक', gh: 'नेपाली ग्राफिक शीर्षक', gd: 'नेपाली ग्राफिक विवरण' }), dEn = draft(A.cid, 'en', { headline: 'Website English headline', gh: 'English graphic headline', gd: 'English graphic description' });
  const ne = (await call('GET', `/api/design/${A.cid}?lang=ne`)).body, en = (await call('GET', `/api/design/${A.cid}?lang=en`)).body;
  assert.equal(ne.draft.lang, 'ne'); assert.equal(en.draft.lang, 'en'); assert.equal(ne.draft.graphic_headline, 'नेपाली ग्राफिक शीर्षक'); assert.equal(en.draft.graphic_headline, 'English graphic headline'); assert.equal(en.draft.subheadline, 'English graphic description'); assert.notEqual(en.draft.graphic_headline, en.draft.headline, 'the website headline is not copied into the graphic');
  assert.equal(ne.lead_asset_id, a.id); assert.deepEqual(ne.assets.filter(x => x.kind === 'photo').map(x => x.id), [a.id], 'the editor only offers this story’s photos'); assert.deepEqual(ne.editions.map(e => e.lang), ['ne', 'en']);
  const ids = {}; for (const [lang, d, ctx] of [['ne', dNe, ne], ['en', dEn, en]]) { const spec = { headline: ctx.draft.graphic_headline, subheadline: ctx.draft.subheadline, format: 'square', badgeLeft: 'BREAKING', badgeRight: 'NEWS' };
    const r = await call('POST', '/api/graphics', { cluster_id: A.cid, draft_id: d, spec, photoAssetId: ctx.lead_asset_id, outFormat: 'png' }); assert.ok(r.body.id, JSON.stringify(r.body)); ids[lang] = r.body.id; const g = db.prepare('SELECT * FROM graphics WHERE id=?').get(r.body.id);
    assert.equal(g.photo_asset_id, a.id, lang + ': uses the story’s lead image'); assert.equal(g.headline_snapshot, ctx.draft.graphic_headline); assert.equal(g.subheadline_snapshot, ctx.draft.subheadline); assert.equal(g.draft_id, d);
    const offline = await renderGraphic(spec, { photoPath: a.path }); assert.equal(Buffer.compare(readFileSync(g.path), offline.image), 0, lang + ': the exported file is exactly that text on exactly that photo'); }
  assert.notEqual(Buffer.compare(readFileSync(db.prepare('SELECT path FROM graphics WHERE id=?').get(ids.ne).path), readFileSync(db.prepare('SELECT path FROM graphics WHERE id=?').get(ids.en).path)), 0, 'the two graphics differ');
  const B = story({ title: 'अर्को कथा ग्राफिक', fetched: BASE_END, sources: [2] }), other = asset(B.cid, 700, 700); const bad = await call('POST', '/api/graphics', { cluster_id: A.cid, draft_id: dNe, spec: { headline: 'x' }, photoAssetId: other.id }); assert.equal(bad.code, 409); assert.match(bad.body.error, /different story/);
  assert.equal((await call('POST', '/api/graphics/preview', { cluster_id: A.cid, spec: { headline: 'x' }, photoAssetId: other.id })).code, 409, 'previews refuse it too');
});
test('9. each edition’s caption carries more context than its graphic and its OWN article URL', async () => {
  const A = story({ title: 'क्याप्सन परीक्षण कथा', fetched: BASE_END, sources: [1] }); const a = asset(A.cid, 800, 600), dNe = draft(A.cid, 'ne'), dEn = draft(A.cid, 'en');
  const pNe = publishDraft(dNe, { category: 'national' }), pEn = publishDraft(dEn, { category: 'national' }); assert.ok(pNe.path.startsWith('/ne/') && pEn.path.startsWith('/en/'));
  for (const [id, lang, own, other] of [[dNe, 'ne', pNe, pEn], [dEn, 'en', pEn, pNe]]) { const d = db.prepare('SELECT * FROM drafts WHERE id=?').get(id), c = S.composeCaption(d, d.final_caption).caption, tok = t => new Set(t.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(x => x.length > 1));
    assert.ok(c.includes(`https://news.example.test${own.path}`), lang + ': own article URL'); assert.ok(!c.includes(other.path), lang + ': never the other edition’s URL'); assert.ok(!c.includes('{{ARTICLE_URL}}'));
    const g = tok(d.graphic_headline + ' ' + d.graphic_description), extra = [...tok(c)].filter(w => !g.has(w)); assert.ok(extra.length >= 8, `${lang}: ${extra.length} words of context beyond the graphic`); assert.ok([...c].length > 3 * [...d.graphic_description].length); }
  const acct = S.connectMockAccount('cap'), gid = Number(db.prepare("INSERT INTO graphics(cluster_id,draft_id,photo_asset_id,spec,headline_snapshot,subheadline_snapshot,path,format,mime,width,height,bytes,created_at) VALUES(?,?,?, '{}',?,?,?,'square','image/jpeg',200,200,10,?)").run(A.cid, dEn, a.id, 'Graphic headline ' + A.cid, 'Short graphic description', a.path.replace('.png', '.png'), iso(BASE_END)).lastInsertRowid);
  db.prepare("UPDATE graphics SET mime='image/png' WHERE id=?").run(gid); const pid = S.createPost({ draft_id: dEn, graphic_id: gid, targets: [{ account_id: acct }] }); assert.ok(db.prepare('SELECT caption FROM post_targets WHERE post_id=?').get(pid).caption.includes(pEn.path));
});
test('10. changing the lead image (or the graphic text) invalidates graphics and queued posts; nothing outdated is delivered', async () => {
  const A = story({ title: 'अमान्य परीक्षण कथा', fetched: BASE_END, sources: [1] }); const a1 = asset(A.cid, 800, 600), a2 = asset(A.cid, 600, 800, { lead: false }), d = draft(A.cid, 'en', { gh: 'Original graphic headline', gd: 'Original description' });
  const spec = { headline: 'Original graphic headline', subheadline: 'Original description', format: 'square' }, mk = async () => (await call('POST', '/api/graphics', { cluster_id: A.cid, draft_id: d, spec, photoAssetId: a1.id, outFormat: 'jpeg' })).body.id;
  const g1 = await mk(), acct = S.connectMockAccount('inval'); assert.equal((await call('GET', `/api/design/${A.cid}?lang=en`)).body.graphics.find(g => g.id === g1).stale, false);
  const pid = S.createPost({ draft_id: d, graphic_id: g1, targets: [{ account_id: acct, caption: 'caption for the post' }] }); S.approvePost(pid); S.schedulePost(pid);
  assert.equal((await call('POST', `/api/story/${A.cid}/lead-image`, { asset_id: a2.id })).body.lead_asset_id, a2.id);
  const ctx = (await call('GET', `/api/design/${A.cid}?lang=en`)).body, gg = ctx.graphics.find(g => g.id === g1); assert.equal(gg.stale, true); assert.match(gg.stale_reason, /lead image changed/);
  assert.equal(publishDraft(d, { category: 'national', graphicId: g1 }).code, 409, 'publishing refuses the outdated graphic'); assert.throws(() => S.createPost({ draft_id: d, graphic_id: g1, targets: [{ account_id: acct, caption: 'x' }], repost: true }), /lead image changed/);
  await S.runPublishJob(); const t = db.prepare('SELECT * FROM post_targets WHERE post_id=?').get(pid); assert.equal(t.status, 'failed'); assert.match(t.error, /lead image changed/); assert.equal(db.prepare('SELECT COUNT(*) n FROM mock_remote WHERE key=?').get(t.idempotency_key).n, 0, 'the queued post never reached the platform');
  const g2 = await (async () => (await call('POST', '/api/graphics', { cluster_id: A.cid, draft_id: d, spec, photoAssetId: a2.id, outFormat: 'jpeg' })).body.id)(); assert.equal(publishDraft(d, { category: 'national', graphicId: g2 }).id > 0, true, 'a graphic regenerated with the new lead image is accepted');
});
test('11. unapproved drafts and unapproved images cannot be published, and a selection never publishes', async () => {
  const A = story({ title: 'अप्रमाणित कथा परीक्षण', fetched: BASE_END, sources: [1, 2] }); asset(A.cid, 700, 700); const d = draft(A.cid, 'ne', { status: 'needs_review' });
  const r = publishDraft(d, { category: 'national' }); assert.equal(r.code, 409); assert.match(r.body.error, /approved/); for (const p of ['/ne/', '/ne/latest', '/sitemap.xml', '/ne/search?q=' + encodeURIComponent('अप्रमाणित')]) assert.ok(!(await page(p)).text.includes('अप्रमाणित कथा परीक्षण'), p);
  assert.throws(() => S.createPost({ draft_id: d, graphic_id: null, targets: [{ account_id: S.connectMockAccount('un'), caption: 'x' }] }), /not approved|image/);
  const B = story({ title: 'अर्को कथा बिना अधिकार', fetched: BASE_END, sources: [1] }); const bad = asset(B.cid, 700, 700, { rights: '', lead: false }); const dB = draft(B.cid, 'ne', { headline: 'अधिकार नभएको छवि शीर्षक' });
  const nr = publishDraft(dB, { category: 'national', photoAssetId: bad.id }); assert.equal(nr.code, 409); assert.match(nr.body.error, /usage permission|lead image/);
});
test('12. failed image retrieval never crashes the worker and never substitutes another image', async () => {
  const A = story({ title: 'विफल छवि कथा', fetched: BASE_END, sources: [1], image: 'https://dead.test/a.jpg' }), B = story({ title: 'सफल छवि कथा', fetched: BASE_END, sources: [2], image: 'https://ok.test/b.png' });
  _setFetcher(async u => { if (u.includes('dead.test')) throw new Error('connection reset'); return { status: 200, buf: png(800, 600, '#a33') }; });
  await assert.doesNotReject(warmBatch(5)); await assert.rejects(thumbnail(A.aids[0], 320), e => e.status === 404); const tb = await thumbnail(B.aids[0], 320); assert.ok(tb.buf.length > 100, 'the good story still gets its own thumbnail');
  assert.ok(!db.prepare('SELECT image_url FROM articles WHERE id=?').get(A.aids[0]).image_url.includes('ok.test'), 'no other story’s image was substituted');
  const before = db.prepare('SELECT COUNT(*) n FROM assets').get().n; let r = await call('POST', `/api/story/${A.cid}/adopt-image`, { article_id: A.aids[0], rights_note: 'licensed for test use' }); assert.equal(r.code, 502); assert.equal(db.prepare('SELECT COUNT(*) n FROM assets').get().n, before, 'a failed retrieval creates nothing'); assert.equal(db.prepare('SELECT lead_asset_id FROM clusters WHERE id=?').get(A.cid).lead_asset_id, null);
  r = await call('POST', `/api/story/${A.cid}/adopt-image`, { article_id: B.aids[0], rights_note: 'licensed for test use' }); assert.equal(r.code, 409, 'a report from another story cannot be adopted'); r = await call('POST', `/api/story/${B.cid}/adopt-image`, { article_id: B.aids[0], rights_note: '' }); assert.equal(r.code, 400, 'a rights statement is required');
  const ok = await call('POST', `/api/story/${B.cid}/adopt-image`, { article_id: B.aids[0], rights_note: 'licence agreement #123 (test)' }); assert.ok(ok.body.id, JSON.stringify(ok.body)); const a = db.prepare('SELECT * FROM assets WHERE id=?').get(ok.body.id);
  assert.equal(a.origin_article_id, B.aids[0]); assert.equal(a.origin_url, 'https://ok.test/b.png'); assert.equal(a.cluster_id, B.cid); assert.match(a.rights_note, /licence agreement/); assert.equal(db.prepare('SELECT lead_asset_id FROM clusters WHERE id=?').get(B.cid).lead_asset_id, a.id, 'provenance retained and the image becomes the story’s lead');
  _setRobotsFetcher(async () => ({ status: 200, buf: Buffer.from('User-agent: *\nDisallow: /') })); const d2 = story({ title: 'रोबोट्स कथा', fetched: BASE_END, sources: [3], image: 'https://blocked.test/z.png' }); assert.equal((await call('POST', `/api/story/${d2.cid}/adopt-image`, { article_id: d2.aids[0], rights_note: 'licensed for test use' })).code, 409, 'robots.txt is respected'); _setRobotsFetcher(async () => ({ status: 200, buf: Buffer.from('User-agent: *\nDisallow:\n') }));
});
test('13. the generic source-disclosure sentence is gone from every public page, its metadata and the source', async () => {
  const A = story({ title: 'सार्वजनिक पृष्ठ परीक्षण', fetched: BASE_END, sources: [1] }); asset(A.cid, 700, 500); const pubs = [publishDraft(draft(A.cid, 'ne', { headline: 'सार्वजनिक शीर्षक' }), { category: 'politics' }), publishDraft(draft(A.cid, 'en', { headline: 'Public headline' }), { category: 'politics' })];
  const banned = [/editorial summaries/i, /named outlets/i, /based on the reporting of the outlets/i, /सम्पादकीय सारांश/, /स्रोत मिडियाको प्रतिवेदनमा आधारित/, /outlets listed above/i, /prepared with AI assistance/i, /isBasedOn/, /Editorial summary/i, /feed reader|RSS|scrap/i];
  const urls = ['/', '/ne/', '/en/', '/ne/latest', '/en/latest', '/ne/category/politics', '/en/category/politics', '/ne/category/economy', '/ne/search?q=%E0%A4%B8%E0%A4%BE', '/en/search?q=zzzz', '/ne/search?q=a', '/ne/nope', '/robots.txt', '/sitemap.xml', ...pubs.map(p => p.path)];
  for (const u of urls) { const r = await page(u); const t = r.text; for (const re of banned) assert.ok(!re.test(t), `${u} contains ${re}`); if (r.status === 200 && t.includes('<html')) { assert.ok(t.includes('EVEREST'), u + ' is branded EVEREST NEWS'); assert.match(t, /<footer class="ft">.*?© \d{4} Everest News<\/p>/s, u + ': the footer is just the brand'); } }
  const src = readFileSync(new URL('../src/site.js', import.meta.url), 'utf8') + readdirSync(new URL('../site/', import.meta.url)).map(f => f.endsWith('.ttf') ? '' : readFileSync(new URL('../site/' + f, import.meta.url), 'utf8')).join('');
  for (const re of [/editorial summaries based on/i, /named outlets/i, /सम्पादकीय सारांश हुन्/, /outlets listed above/i]) assert.ok(!re.test(src), 'source files no longer contain ' + re);
  const art = (await page(pubs[1].path)).text; assert.ok(/<aside class="src"><h2>Original reporting<\/h2><ul>/.test(art), 'specific per-article source links are kept (provenance), without any generic sentence'); assert.ok(!db.prepare("SELECT COUNT(*) n FROM settings WHERE value LIKE '%editorial summaries%'").get().n);
});
