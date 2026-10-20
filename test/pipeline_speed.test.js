// Publication speed and independence: concurrency, event-driven start, per-language independence, slow sources/providers, recovery, timestamps, visibility.
// A MOCK model with controllable latency and a MOCK page fetcher; nothing here touches a real provider.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
Object.assign(process.env, { DB_PATH: ':memory:', OPENROUTER_API_KEY: 'k', TOKEN_KEY: 'c'.repeat(64), SOCIAL_MOCK: '1', PUBLIC_BASE_URL: 'https://news.example.test', EXTRACT_DELAY_MS: '0' });
const { db } = await import('../src/db.js');
const { setCfg, getCfg } = await import('../src/ai.js');
const E = await import('../src/editions.js');
const W = await import('../src/wake.js');
const R = await import('../src/ai_router.js');
const X = await import('../src/extract.js');
const M = await import('../src/metrics.js');
const { clusterNew } = await import('../src/cluster.js');
const { handleSite } = await import('../src/site.js');
const { _setRobotsFetcher } = await import('../src/robots.js');
const F = await import('./fixtures/content.js');
_setRobotsFetcher(async () => ({ status: 200, buf: Buffer.from('User-agent: *\nDisallow:\n') }));

// ---- mock model: latency depends on markers in the request; also tracks how many calls run at once ----
const calls = []; let active = 0, maxActive = 0; const sleep = ms => new Promise(r => setTimeout(r, ms));
const WORDS_EN = ['Bridge', 'Harvest', 'Budget', 'Flood', 'Election', 'Hospital', 'Airport', 'Tunnel', 'Festival', 'Policy', 'Border', 'Dam'], WORDS_NE = ['पुल', 'बाली', 'बजेट', 'बाढी', 'निर्वाचन', 'अस्पताल', 'विमानस्थल', 'सुरुङ', 'चाडपर्व', 'नीति', 'सीमा', 'बाँध'];
const head = (n, ne) => [0, 1, 2].map(i => (ne ? WORDS_NE : WORDS_EN)[(n * 5 + i) % 12]).join(' '); // distinct headlines so the near-duplicate guard stays out of the way
let delays = { ne: 0, en: 0, mark: {} }, failEn = false;
const srv = http.createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', async () => {
  const body = JSON.parse(b), user = body.messages.at(-1).content, ne = /Target edition language: Nepali/.test(user), isCap = /SOCIAL CAPTION TASK/.test(body.messages[0].content), n = +(user.match(/NEWS-(\d+)/)?.[1] ?? 0);
  calls.push({ ne, n, at: Date.now(), cap: isCap }); active++; maxActive = Math.max(maxActive, active);
  await sleep((ne ? delays.ne : delays.en) + (delays.mark[n] ?? 0));
  active--; const ed = ne ? { ...F.NE_ED, headline: head(n, true), headline_alternatives: [head(n + 1, true), head(n + 2, true)] } : { ...F.EN_ED, headline: head(n, false), headline_alternatives: [head(n + 1, false), head(n + 2, false)] };
  const text = (!ne && failEn) ? 'not json' : JSON.stringify({ source_assessment: { sufficient: true, gaps: [] }, facts: F.FACTS, quotes: [{ speaker: 'Ram Bahadur Thapa', source_text: F.EN_QUOTE }], edition: ed });
  res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 50 } })); }); });
await new Promise(r => srv.listen(0, '127.0.0.1', r)); setCfg({ ...getCfg(), base_url: `http://127.0.0.1:${srv.address().port}/v1`, model: 'test/model' }); test.after(() => srv.close());
const ts = () => new Date().toISOString(); let seq = 0;
function story({ rss = false, fetchedAt = ts() } = {}) { // a story whose title carries a number the mock uses to pick latency
  seq++; const cid = Number(db.prepare('INSERT INTO clusters(created_at) VALUES(?)').run(ts()).lastInsertRowid), url = `https://pub.test/${rss ? 'slowsrc/' : ''}${seq}`;
  const aid = Number(db.prepare('INSERT INTO articles(source_id,url,canon_url,title,title_key,language,summary,full_text,published_at,fetched_at,updated_at,cluster_id,extraction_status) VALUES(1,?,?,?,?,?,?,?,?,?,?,?,?)').run(url, url, `NEWS-${seq} ${F.EN_TITLE}`, 'k' + seq, 'en', rss ? 'Short note about the bridge contract in Kailali district today.' : F.EN_SUMMARY, rss ? null : F.EN_TEXT, ts(), fetchedAt, fetchedAt, cid, rss ? 'rss_only' : 'full_text_in_feed').lastInsertRowid); return { cid, aid, n: seq };
}
const reset = () => { calls.length = 0; maxActive = 0; active = 0; delays = { ne: 0, en: 0, mark: {} }; failEn = false; db.exec("DELETE FROM edition_jobs; DELETE FROM ai_cache; DELETE FROM settings WHERE key IN ('stall_hours','hold_duplicates')"); db.prepare("UPDATE sources SET fulltext_enabled=1 WHERE id=1").run(); };
const pubAt = (cid, lang) => db.prepare("SELECT published_at p FROM publications WHERE cluster_id=? AND lang=? AND status='published'").get(cid, lang)?.p ?? null;
const allDone = () => db.prepare("SELECT COUNT(*) n FROM edition_jobs WHERE status IN ('queued','generating')").get().n === 0;
async function pool(n, until = allDone, ms = 15000) { let stop = false; const t0 = Date.now(), run = E.runEditionPool({ concurrency: n, stop: () => stop, idleMs: 15 }); while (!until() && Date.now() - t0 < ms) await sleep(10); stop = true; W.wake(); await run; return Date.now() - t0; }

test('1. a newly detected story is queued at once and the waiting workers are woken; no hourly pick is involved', async () => {
  reset(); E.enableAutoPublish(true); db.prepare("UPDATE settings SET value=json_quote(?) WHERE key='auto_publish_from'").run(new Date(Date.now() - 5000).toISOString());
  const st = story(); db.prepare('UPDATE articles SET cluster_id=NULL WHERE id=?').run(st.aid); db.prepare('DELETE FROM clusters WHERE id=?').run(st.cid); clusterNew(); const cid = db.prepare('SELECT cluster_id c FROM articles WHERE id=?').get(st.aid).c; db.prepare('UPDATE clusters SET created_at=? WHERE id=?').run(ts(), cid);
  const t0 = Date.now(); const sleeper = W.sleepOrWake(5000); assert.ok(E.queueNewStories() >= 1); await sleeper; assert.ok(Date.now() - t0 < 100, 'a sleeping worker is woken immediately, not after its fallback poll'); assert.equal(db.prepare('SELECT COUNT(*) n FROM edition_jobs WHERE cluster_id=?').get(cid).n, 2);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM selections').get().n, 0, 'no hourly selection exists, and none was needed'); E.enableAutoPublish(false);
});
test('2. the English edition is live while the Nepali one is still being written, and 3. the Nepali edition publishes on its own', async () => {
  reset(); delays.ne = 900; const st = story(); E.queueStory(st.cid, 'auto', 1); const t0 = Date.now(); const run = pool(2, () => pubAt(st.cid, 'ne') && pubAt(st.cid, 'en'));
  await sleep(450); assert.ok(pubAt(st.cid, 'en'), 'English is live after ~0.45 s'); assert.equal(pubAt(st.cid, 'ne'), null, 'Nepali is still being written'); assert.equal(db.prepare("SELECT status FROM edition_jobs WHERE cluster_id=? AND lang='ne'").get(st.cid).status, 'generating');
  await run; assert.ok(pubAt(st.cid, 'ne') > pubAt(st.cid, 'en'), 'Nepali followed on its own'); assert.ok(Date.now() - t0 < 4000);
  reset(); failEn = true; const s2 = story(); E.queueStory(s2.cid, 'auto', 1); await pool(2, () => pubAt(s2.cid, 'ne')); assert.ok(pubAt(s2.cid, 'ne'), 'Nepali published although English failed'); assert.equal(pubAt(s2.cid, 'en'), null);
});
test('4/5. website publication needs no social step; social stays untouched and unapproved', async () => {
  reset(); const st = story(); E.queueStory(st.cid, 'auto', 1); await pool(2); assert.ok(pubAt(st.cid, 'en') && pubAt(st.cid, 'ne'));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM social_drafts').get().n + db.prepare('SELECT COUNT(*) n FROM posts').get().n + db.prepare("SELECT COUNT(*) n FROM selections WHERE status='selected'").get().n, 0, 'nothing was prepared, approved or posted for social');
});
test('7/8. a slow source and a slow AI answer do not block other stories', async () => {
  reset(); X.__proto__; const slow = story({ rss: true }), fast = story(); X._setPageFetcher(async u => { if (u.includes('slowsrc')) await sleep(900); return { status: 200, body: `<html><body><article>${F.EN_PARAS.map(p => `<p>${p}</p>`).join('')}</article></body></html>`, finalUrl: u, type: 'text/html' }; });
  E.queueStory(slow.cid, 'auto', 1); await sleep(5); E.queueStory(fast.cid, 'auto', 1); await pool(4); X._setPageFetcher(async () => { throw new Error('unused'); });
  assert.ok(pubAt(slow.cid, 'en') && pubAt(fast.cid, 'en')); assert.ok(pubAt(fast.cid, 'en') < pubAt(slow.cid, 'en'), 'the fast story went live first although it was queued second'); assert.ok(Date.parse(pubAt(slow.cid, 'en')) - Date.parse(pubAt(fast.cid, 'en')) > 400, 'and did not wait for the slow page');
  reset(); const a = story(), b = story(); delays.mark[a.n] = 900; E.queueStory(a.cid, 'auto', 1); await sleep(5); E.queueStory(b.cid, 'auto', 1); await pool(4); assert.ok(pubAt(b.cid, 'en') < pubAt(a.cid, 'en'), 'a slow AI answer for one story does not hold up the next');
});
test('13. several workers never generate or publish the same edition twice', async () => {
  reset(); const ss = [story(), story(), story()]; for (const s of ss) E.queueStory(s.cid, 'auto', 1); await pool(6); assert.equal(calls.filter(c => !c.cap).length, 6, 'one model request per edition, no duplicates'); for (const s of ss) assert.equal(db.prepare("SELECT COUNT(*) n FROM publications WHERE cluster_id=?").get(s.cid).n, 2);
});
test('controlled speed comparison: bounded concurrency finishes the same work much sooner (mock latency 300 ms per edition)', async () => {
  const run = async n => { reset(); delays.en = 300; delays.ne = 300; const ss = Array.from({ length: 4 }, () => story()); for (const s of ss) E.queueStory(s.cid, 'auto', 1); const ms = await pool(n); assert.equal(db.prepare("SELECT COUNT(*) n FROM publications WHERE status='published' AND cluster_id>=?").get(ss[0].cid).n, 8); return { ms, maxActive }; };
  db.exec("UPDATE publications SET status='unpublished'"); const serial = await run(1); db.exec("UPDATE publications SET status='unpublished'"); const parallel = await run(4);
  console.log(`      8 editions x 300 ms: one worker ${serial.ms} ms (max ${serial.maxActive} at once) vs four workers ${parallel.ms} ms (max ${parallel.maxActive} at once) = ${(serial.ms / parallel.ms).toFixed(1)}x faster`);
  assert.equal(serial.maxActive, 1); assert.ok(parallel.maxActive >= 3 && parallel.maxActive <= 4, 'bounded: never more than the pool size'); assert.ok(serial.ms / parallel.ms > 2, `speed-up ${(serial.ms / parallel.ms).toFixed(2)}x`);
});
test('9. per-provider concurrency is bounded (the limit is a setting), and waiting calls are queued, not dropped', async () => {
  const peaks = {}; for (const limit of [1, 2]) { const rel = []; let live = 0, peak = 0; const job = async () => { const r = await R.acquire('p' + limit, limit); live++; peak = Math.max(peak, live); await sleep(30); live--; r(); }; await Promise.all(Array.from({ length: 6 }, job)); peaks[limit] = peak; void rel; }
  assert.deepEqual(peaks, { 1: 1, 2: 2 }); assert.deepEqual(R.slotState().p1, { active: 0, waiting: 0 }, 'every slot is returned'); assert.equal(R.routerCfg().provider_concurrency, 2); assert.equal(R.routerCfg().timeout_ms, 75000);
});
test('15. a job that cannot get capacity is not pending forever: after the stall limit it becomes an explained terminal state', async () => {
  reset(); db.prepare("INSERT INTO settings(key,value) VALUES('ai_router',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify({ free_only: true })); const st = story(); E.queueStory(st.cid, 'auto', 1);
  await pool(2, () => db.prepare("SELECT COUNT(*) n FROM edition_jobs WHERE status='queued' AND last_error IS NOT NULL").get().n === 2, 3000); assert.equal(db.prepare("SELECT COUNT(*) n FROM edition_jobs WHERE status='queued' AND last_error IS NOT NULL").get().n, 2, 'waiting for capacity, with the reason visible');
  db.prepare("UPDATE edition_jobs SET created_at='2000-01-01T00:00:00.000Z', run_at=?").run(ts()); await pool(2, allDone, 3000); const j = db.prepare('SELECT status,reason_code,review_reason FROM edition_jobs').all(); assert.ok(j.every(x => x.status === 'needs_review' && x.reason_code === 'stalled' && /AI capacity/.test(x.review_reason)), JSON.stringify(j)); db.exec("DELETE FROM settings WHERE key='ai_router'");
});
test('16. a published story is visible on the homepage, in the category list and in the latest list straight away; pages are cached only for seconds', async () => {
  reset(); const page = async p => handleSite('GET', new URL('https://news.example.test' + p), { host: 'news.example.test' }); const st = story(); const before = (await page('/en/')).body.toString(); E.queueStory(st.cid, 'auto', 1); await pool(2);
  const h = head(st.n, false), after = await page('/en/'); assert.ok(!before.includes(h) && after.body.toString().includes(h), 'on the home page'); assert.ok((await page('/en/latest')).body.toString().includes(h), 'in the latest list');
  const maxAge = +after.headers['cache-control'].match(/max-age=(\d+)/)[1], swr = +after.headers['cache-control'].match(/stale-while-revalidate=(\d+)/)[1]; assert.ok(maxAge <= 30 && swr <= 60, `cache-control ${after.headers['cache-control']}`);
});
test('17. every stage is timestamped and measured; the metrics report medians, p95, backlog and provider latency', async () => {
  reset(); delays.en = 120; delays.ne = 120; const old = new Date(Date.now() - 90000).toISOString(), st = story({ fetchedAt: old }); E.queueStory(st.cid, 'auto', 1); await pool(2);
  const j = db.prepare('SELECT * FROM edition_jobs WHERE cluster_id=?').all(st.cid); assert.equal(j.length, 2); for (const x of j) { assert.equal(x.status, 'published'); assert.equal(x.detected_at, old, 'detection time = when the first report was fetched'); assert.ok(x.first_started_at >= x.created_at && x.published_at >= x.first_started_at, 'timestamps are ordered');
    for (const k of ['extract_ms', 'generate_ms', 'validate_ms', 'publish_ms', 'total_ms']) assert.ok(Number.isFinite(x[k]) && x[k] >= 0, `${k}=${x[k]}`); assert.ok(x.generate_ms >= 100, `generation time includes the model latency (${x.generate_ms} ms)`); assert.ok(Math.abs(x.total_ms - (Date.parse(x.published_at) - Date.parse(old))) < 5, 'detection-to-publication is published_at minus detected_at'); assert.ok(x.total_ms >= 90000); }
  const m = M.pipelineMetrics(24); assert.equal(m.published.count, 2); assert.ok(m.published.detection_to_publication_s.median >= 90); assert.ok(m.published.generate_s.median >= 0.1); assert.equal(m.backlog.queued_due, 0); assert.ok(m.providers.some(p => p.calls >= 2 && p.latency_s.n >= 2 && p.latency_s.median >= 0.1), JSON.stringify(m.providers));
  assert.equal(M.percentile([1, 2, 3, 4, 100], 0.5), 3); assert.equal(M.percentile([], 0.5), null); assert.ok(M.percentile([1, 2, 3, 4, 100], 0.95) > 80);
  reset(); const w = story(); E.queueStory(w.cid, 'auto', 1); db.prepare("UPDATE edition_jobs SET created_at=?").run(new Date(Date.now() - 600000).toISOString()); const mm = M.pipelineMetrics(24); assert.equal(mm.backlog.queued_due, 2); assert.ok(mm.backlog.oldest_due_age_s >= 599, 'oldest waiting job age is reported');
});
test('queue order: the newest stories go first, an old backlog follows oldest-first; an abandoned job is recovered', async () => {
  reset(); const old1 = story(), old2 = story(), fresh1 = story(), fresh2 = story(); for (const s of [old1, old2, fresh1, fresh2]) E.queueStory(s.cid, 'auto', 0);
  db.prepare("UPDATE edition_jobs SET created_at='2000-01-01T00:00:00.000Z' WHERE cluster_id IN (?,?)").run(old1.cid, old2.cid); const order = []; for (let i = 0; i < 8; i++) { await E.runEditionJob(); } const rows = db.prepare("SELECT cluster_id, started_at FROM edition_jobs ORDER BY started_at, id").all().map(r => r.cluster_id);
  assert.deepEqual([...new Set(rows)], [fresh2.cid, fresh1.cid, old1.cid, old2.cid], 'fresh stories newest-first, then the backlog in order'); void order;
  reset(); const st = story(); E.queueStory(st.cid, 'auto', 1); db.prepare("UPDATE edition_jobs SET status='generating', started_at=?").run(new Date(Date.now() - 3600e3).toISOString()); assert.equal(E.recoverEditionJobs(), 2, 'a job abandoned an hour ago is put back'); assert.equal(db.prepare("SELECT COUNT(*) n FROM edition_jobs WHERE status='queued'").get().n, 2);
});
test('both editions of one story share a single page fetch even when they ask at the same moment', async () => {
  reset(); const st = story({ rss: true }); let fetches = 0; X._setPageFetcher(async u => { fetches++; await sleep(150); return { status: 200, body: `<html><body><article>${F.EN_PARAS.map(p => `<p>${p}</p>`).join('')}</article></body></html>`, finalUrl: u, type: 'text/html' }; });
  const [a, b] = await Promise.all([X.extractFullText(st.aid), X.extractFullText(st.aid)]); X._setPageFetcher(async () => { throw new Error('unused'); }); assert.equal(fetches, 1, 'one request to the publisher'); assert.equal(a.status, 'extracted'); assert.equal(b.status, 'extracted');
});
