import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
Object.assign(process.env, { DB_PATH: ':memory:', EXTRACT_DELAY_MS: '0' });
const { db } = await import('../src/db.js');
const { extractFromHtml, extractFullText, sourceTextFor, _setPageFetcher } = await import('../src/extract.js');
const { _setRobotsFetcher, contentSignals, robotsAllows } = await import('../src/robots.js');
const F = await import('./fixtures/content.js');
const ROBOTS_OK = 'User-agent: *\nDisallow: /private\n';
const useRobots = txt => _setRobotsFetcher(async () => ({ status: 200, buf: Buffer.from(txt) }));
const page = body => ({ status: 200, type: 'text/html', body });
const wrap = (inner, head = '') => `<!doctype html><html><head><title>t</title>${head}</head><body><header><nav><a href="/">Home</a></nav></header>${inner}<footer><p>© 2026 Publisher. All rights reserved and some more footer text here.</p></footer></body></html>`;
const ts = new Date().toISOString(); let n = 0;
const article = (o = {}) => { n++; const cid = Number(db.prepare('INSERT INTO clusters(created_at) VALUES(?)').run(ts).lastInsertRowid); return Number(db.prepare('INSERT INTO articles(source_id,url,canon_url,title,title_key,language,summary,content,published_at,fetched_at,updated_at,cluster_id) VALUES(1,?,?,?,?,?,?,?,?,?,?,?)').run(`https://pub.test/a/${n}`, `https://pub.test/a/${n}`, 'T', 'k' + n, 'en', o.summary ?? 'A short RSS summary of the story.', o.content ?? null, ts, ts, ts, cid).lastInsertRowid); };
const row = id => db.prepare('SELECT * FROM articles WHERE id=?').get(id);

test('extractFromHtml keeps the article paragraphs and drops navigation, ads, share/related blocks, comments and boilerplate', () => {
  const html = wrap(`<div class="share"><p>Share this story on social networks and messaging apps today</p></div><article><h1>Headline</h1>${F.EN_PARAS.map(p => `<p>${p}</p>`).join('')}
    <p>Also read: another story you may like from our archive section</p><p><a href="/x">A related link that is mostly link text in this paragraph</a></p><div class="related"><p>Related story paragraph that is long enough to be mistaken for content here</p></div><div class="comments"><p>First! Great article, thanks for sharing the news with everyone here.</p></div><p>Advertisement</p></article>`);
  const r = extractFromHtml(html); assert.equal(r.paragraphs.length, F.EN_PARAS.length); assert.ok(r.paragraphs[0].startsWith('KAILALI')); for (const bad of ['Share this', 'Also read', 'Related story', 'First! Great', 'Advertisement', 'related link']) assert.ok(!r.paragraphs.join(' ').includes(bad), bad);
  assert.match(r.method, /article/);
});
test('extractFromHtml prefers JSON-LD articleBody and reads author and date; works on Nepali markup; falls back to body paragraphs', () => {
  const ld = { '@context': 'https://schema.org', '@type': 'NewsArticle', author: { '@type': 'Person', name: 'Test Reporter' }, datePublished: '2026-10-18T09:00:00+05:45', articleBody: F.EN_TEXT };
  const r = extractFromHtml(wrap('<p>ignored</p>', `<script type="application/ld+json">${JSON.stringify(ld)}</script>`)); assert.equal(r.method, 'jsonld'); assert.equal(r.author, 'Test Reporter'); assert.equal(r.published, '2026-10-18T09:00:00+05:45'); assert.ok(r.paragraphs.join(' ').includes('Mohana'));
  const ne = extractFromHtml(wrap(`<div class="entry-content">${F.NE_PARAS.map(p => `<p>${p}</p>`).join('')}</div>`)); assert.equal(ne.paragraphs.length, F.NE_PARAS.length); assert.match(ne.method, /entry-content/); assert.ok(ne.paragraphs[0].includes('कैलाली'));
  const plain = extractFromHtml(wrap(F.EN_PARAS.map(p => `<p>${p}</p>`).join(''))); assert.equal(plain.paragraphs.length, F.EN_PARAS.length); assert.ok(extractFromHtml('<html><body>{broken <p>x').paragraphs.length === 0, 'malformed html does not throw');
  assert.equal(extractFromHtml(wrap(`<article>${F.EN_PARAS.map(p => `<p>${p}</p>`).join('')}<p>Subscribe to continue reading — this premium content is for members only.</p></article>`)).paywallHint, true);
});
test('robots.txt: path rules, user-agent precedence and Content-Signal declarations', () => {
  assert.equal(robotsAllows('User-agent: *\nDisallow: /private', '/private/x'), false); assert.equal(robotsAllows(ROBOTS_OK, '/news/1'), true);
  assert.deepEqual(contentSignals('User-agent: *\nContent-Signal: search=yes, ai-train=no, ai-input=no'), { search: 'yes', aiInput: 'no', aiTrain: 'no' }); assert.deepEqual(contentSignals('# Content-Signal: ai-input=no (a comment)\nUser-agent: *'), { search: null, aiInput: null, aiTrain: null }, 'comments and absence mean "not declared"');
});
test('extraction is opt-in per source; the RSS summary is never overwritten', async () => {
  useRobots(ROBOTS_OK); let fetched = 0; _setPageFetcher(async () => { fetched++; return page(wrap(`<article>${F.EN_PARAS.map(p => `<p>${p}</p>`).join('')}</article>`)); });
  db.prepare('UPDATE sources SET fulltext_enabled=0 WHERE id=1').run(); const id = article({ summary: 'Original RSS summary text for this story.' });
  assert.equal((await extractFullText(id)).status, 'not_enabled'); assert.equal(fetched, 0, 'nothing is fetched until the editor enables full-text retrieval for the publisher');
  db.prepare('UPDATE sources SET fulltext_enabled=1 WHERE id=1').run(); const r = await extractFullText(id); assert.equal(r.status, 'extracted'); assert.equal(fetched, 1);
  const a = row(id); assert.ok(a.full_text.includes('Mohana')); assert.equal(a.summary, 'Original RSS summary text for this story.', 'summary untouched'); assert.equal(a.content, null, 'feed content untouched'); assert.equal(a.extraction_status, 'extracted'); assert.ok(a.extracted_at);
  assert.equal((await extractFullText(id)).reused, true); assert.equal(fetched, 1, 'a stored extraction is reused, not fetched again');
});
test('robots disallow, ai-input=no, access restrictions, paywalls, short pages and errors are recorded honestly and never bypassed', async () => {
  db.prepare('UPDATE sources SET fulltext_enabled=1 WHERE id=1').run(); const cases = [
    ['robots_disallowed', 'User-agent: *\nDisallow: /a/', async () => { throw new Error('must not fetch'); }], ['ai_input_disallowed', 'User-agent: *\nDisallow:\nContent-Signal: ai-input=no', async () => { throw new Error('must not fetch'); }],
    ['access_restricted', ROBOTS_OK, async () => ({ status: 403, body: '', type: 'text/html' })], ['access_restricted', ROBOTS_OK, async () => ({ status: 402, body: '', type: 'text/html' })],
    ['paywall_suspected', ROBOTS_OK, async () => page(wrap('<article><p>Subscribe to continue reading this premium article for members only, please.</p></article>'))],
    ['too_short', ROBOTS_OK, async () => page(wrap('<article><p>Just one short paragraph of text that is long enough to count as one paragraph.</p></article>'))],
    ['extraction_failed', ROBOTS_OK, async () => { throw new Error('connection reset'); }], ['extraction_failed', ROBOTS_OK, async () => ({ status: 500, body: '', type: 'text/html' })]];
  for (const [status, robots, fetcher] of cases) { useRobots(robots); _setPageFetcher(fetcher); const id = article(); const r = await extractFullText(id); assert.equal(r.status, status); assert.equal(row(id).full_text, null, status + ': nothing stored'); assert.equal(row(id).extraction_status, status); }
  _setRobotsFetcher(async () => { throw new Error('dns'); }); _setPageFetcher(async () => { throw new Error('must not fetch'); }); const id = article(); assert.equal((await extractFullText(id)).status, 'robots_unreadable', 'unreadable robots.txt is "unknown", not "allowed"'); assert.equal(row(id).extracted_at, null, 'and it is retried later');
});
test('a failed extraction is not retried in a loop', async () => {
  db.prepare('UPDATE sources SET fulltext_enabled=1 WHERE id=1').run(); useRobots(ROBOTS_OK); let calls = 0; _setPageFetcher(async () => { calls++; return { status: 500, body: '', type: 'text/html' }; });
  const id = article(); await extractFullText(id); await extractFullText(id); await extractFullText(id); assert.equal(calls, 1); await extractFullText(id, { force: true }); assert.equal(calls, 2, 'an editor can force a retry');
});
test('source text ladder: extracted text > text carried in the feed > RSS summary; "full" is a threshold on real words', () => {
  const a = { summary: 'short summary here', content: null, full_text: null }; assert.deepEqual([sourceTextFor(a).origin, sourceTextFor(a).level], ['rss_summary', 'limited']);
  const feed = { summary: 'short', content: F.EN_TEXT, full_text: null }; assert.deepEqual([sourceTextFor(feed).origin, sourceTextFor(feed).level], ['feed_content', 'full']);
  const ext = { summary: 'short', content: 'x '.repeat(50), full_text: F.EN_TEXT }; assert.equal(sourceTextFor(ext).origin, 'extracted'); assert.equal(sourceTextFor(ext).words, F.EN_TEXT.split(/\s+/).length);
  assert.equal(sourceTextFor({ summary: F.EN_TEXT, content: null, full_text: null }).level, 'limited', 'a long RSS summary is still not a full article');
  db.prepare("INSERT INTO settings(key,value) VALUES('min_full_words','400')").run(); assert.equal(sourceTextFor(ext).level, 'limited', 'the threshold is configurable'); db.prepare("DELETE FROM settings WHERE key='min_full_words'").run();
});
test('migrating a database created with the OLD schema adds the new columns and keeps every row', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mig-')), file = path.join(dir, 'old.db'), old = new DatabaseSync(file);
  old.exec(`CREATE TABLE sources(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, feed_url TEXT NOT NULL, final_url TEXT, enabled INTEGER NOT NULL DEFAULT 1, interval_min INTEGER NOT NULL DEFAULT 60, status TEXT NOT NULL DEFAULT 'unchecked', credibility REAL NOT NULL DEFAULT 0.5);
    CREATE TABLE articles(id INTEGER PRIMARY KEY, source_id INTEGER NOT NULL, guid TEXT, url TEXT NOT NULL, canon_url TEXT NOT NULL UNIQUE, title TEXT NOT NULL, title_key TEXT NOT NULL, language TEXT, summary TEXT, content TEXT, published_at TEXT, fetched_at TEXT NOT NULL, updated_at TEXT NOT NULL, image_url TEXT, category TEXT, extraction_status TEXT NOT NULL DEFAULT 'rss_only', workflow_status TEXT NOT NULL DEFAULT 'collected', cluster_id INTEGER, duplicate_of INTEGER);
    CREATE TABLE clusters(id INTEGER PRIMARY KEY, created_at TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0, rejected INTEGER NOT NULL DEFAULT 0, priority INTEGER NOT NULL DEFAULT 0, category TEXT);
    CREATE TABLE drafts(id INTEGER PRIMARY KEY, cluster_id INTEGER NOT NULL, article_id INTEGER NOT NULL, workflow TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'needs_review', model TEXT, created_at TEXT NOT NULL, source_snapshot TEXT NOT NULL, attribution TEXT NOT NULL, ai_translation TEXT, ai_draft TEXT, headline_options TEXT, rec_idx INTEGER, rec_reason TEXT, caption TEXT, long_summary TEXT, primary_phrase TEXT, secondary_phrases TEXT, hashtags TEXT, alt_text TEXT, meta_title TEXT, meta_desc TEXT, flags TEXT NOT NULL DEFAULT '[]', edited_headline TEXT, edited_body TEXT, edited_caption TEXT, final_headline TEXT, final_body TEXT, final_caption TEXT, approved_at TEXT, lang TEXT NOT NULL DEFAULT 'ne');
    CREATE TABLE graphics(id INTEGER PRIMARY KEY, cluster_id INTEGER NOT NULL, draft_id INTEGER, template_id INTEGER, photo_asset_id INTEGER, logo_asset_id INTEGER, spec TEXT NOT NULL, headline_snapshot TEXT NOT NULL, path TEXT NOT NULL, format TEXT NOT NULL, mime TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, bytes INTEGER NOT NULL, warnings TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'current', created_at TEXT NOT NULL);
    CREATE TABLE publications(id INTEGER PRIMARY KEY, cluster_id INTEGER NOT NULL, lang TEXT NOT NULL, draft_id INTEGER NOT NULL, headline TEXT NOT NULL, summary TEXT, body TEXT NOT NULL, caption TEXT, seo_title TEXT, meta_desc TEXT, alt_text TEXT, category TEXT NOT NULL DEFAULT 'other', photo_asset_id INTEGER, photo_credit TEXT, graphic_id INTEGER, attribution TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'published', published_at TEXT NOT NULL, updated_at TEXT NOT NULL, unpublished_at TEXT, UNIQUE(cluster_id, lang));
    INSERT INTO sources(id,name,feed_url) VALUES(1,'OldSource','https://old.test/feed'); INSERT INTO clusters(id,created_at) VALUES(1,'2026-01-01T00:00:00Z');
    INSERT INTO articles(id,source_id,url,canon_url,title,title_key,language,summary,fetched_at,updated_at,cluster_id) VALUES(1,1,'https://old.test/1','https://old.test/1','पुरानो','k','ne','पुरानो सारांश','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z',1);
    INSERT INTO drafts(id,cluster_id,article_id,workflow,status,created_at,source_snapshot,attribution,ai_draft,headline_options,rec_idx,final_headline,final_body,approved_at) VALUES(1,1,1,'translate_en','approved','2026-01-01T00:00:00Z','{}','x','पुरानो मस्यौदा','["पुरानो"]',0,'पुरानो शीर्षक','पुरानो मस्यौदा','2026-01-01T00:00:00Z');
    INSERT INTO publications(id,cluster_id,lang,draft_id,headline,body,attribution,published_at,updated_at) VALUES(1,1,'ne',1,'पुरानो शीर्षक','पुरानो मस्यौदा','[]','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');`); old.close();
  const r = spawnSync(process.execPath, ['-e', `const m = await import('./src/db.js'); const cols = t => m.db.prepare('PRAGMA table_info('+t+')').all().map(x => x.name);
    console.log(JSON.stringify({ art: cols('articles').filter(c => ['full_text','author','extraction_method','extracted_at'].includes(c)), src: cols('sources').filter(c => ['fulltext_enabled','ai_policy'].includes(c)), dr: cols('drafts').filter(c => ['bundle_id','source_level','graphic_headline','graphic_description','short_caption','edited_json','final_json','facts_json','gen_meta'].includes(c)), gr: cols('graphics').filter(c => c==='subheadline_snapshot'), pub: cols('publications').filter(c => c==='keywords'),
      rows: [m.db.prepare('select title from articles').get().title, m.db.prepare('select final_headline from drafts').get().final_headline, m.db.prepare('select headline from publications').get().headline, m.db.prepare('select name from sources where id=1').get().name] }))`], { env: { ...process.env, DB_PATH: file, DATA_DIR: dir }, cwd: process.cwd(), encoding: 'utf8', input: '' });
  assert.equal(r.status, 0, r.stderr); const o = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(o.art.length, 4); assert.equal(o.src.length, 2); assert.equal(o.dr.length, 9); assert.equal(o.gr.length, 1); assert.equal(o.pub.length, 1); assert.deepEqual(o.rows, ['पुरानो', 'पुरानो शीर्षक', 'पुरानो शीर्षक', 'OldSource'], 'existing rows preserved');
});
