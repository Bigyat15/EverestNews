// Independent EN/NE editions, the durable website queue, duplicate audit and the social review gate.
// A MOCK model proves our code paths (separate requests, language validation, gating, persistence); it says nothing about real model quality.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
Object.assign(process.env, { DB_PATH: ':memory:', OPENROUTER_API_KEY: 'k', TOKEN_KEY: 'c'.repeat(64), SOCIAL_MOCK: '1', PUBLIC_BASE_URL: 'https://news.example.test', EXTRACT_DELAY_MS: '0' });
const { db } = await import('../src/db.js');
const { setCfg, getCfg } = await import('../src/ai.js');
const E = await import('../src/editions.js');
const { clusterNew } = await import('../src/cluster.js');
const Sel = await import('../src/selection.js');
const SD = await import('../src/social_drafts.js');
const S = await import('../src/social.js');
const { handleSite } = await import('../src/site.js');
const { _setRobotsFetcher } = await import('../src/robots.js');
const F = await import('./fixtures/content.js');

const calls = []; let reply;
const srv = http.createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => { const body = JSON.parse(b); calls.push(body); const r = reply(body); res.writeHead(r.status || 200, { 'content-type': 'application/json' }); res.end(JSON.stringify(r.json ?? { error: { message: 'x' } })); }); });
await new Promise(r => srv.listen(0, '127.0.0.1', r)); setCfg({ ...getCfg(), base_url: `http://127.0.0.1:${srv.address().port}/v1`, model: 'test/model' });
test.after(() => srv.close());
_setRobotsFetcher(async () => ({ status: 200, buf: Buffer.from('User-agent: *\nDisallow:\n') }));
S.setMaxAccounts(100);
const wantsLang = b => (b.messages.at(-1).content.match(/Target edition language: (\w+)/) || [])[1];
const good = (over = {}) => b => { const l = wantsLang(b); return { json: { choices: [{ message: { content: JSON.stringify({ source_assessment: { sufficient: true, gaps: [] }, facts: F.FACTS, quotes: [{ speaker: 'Ram Bahadur Thapa', source_text: F.EN_QUOTE }], edition: (l === 'Nepali' ? F.NE_ED : F.EN_ED), ...over }) } }], usage: { prompt_tokens: 100, completion_tokens: 100 } } }; };
const ts = () => new Date().toISOString(); let n = 0;
function story({ lang = 'en', title = F.EN_TITLE, summary = F.EN_SUMMARY, full_text = F.EN_TEXT, source = 1, created = ts() } = {}) {
  n++; const cid = Number(db.prepare('INSERT INTO clusters(created_at) VALUES(?)').run(created).lastInsertRowid);
  const aid = Number(db.prepare('INSERT INTO articles(source_id,url,canon_url,title,title_key,language,summary,full_text,published_at,fetched_at,updated_at,cluster_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(source, `https://src.test/${n}`, `https://src.test/${n}`, title, title + n, lang, summary, full_text, ts(), ts(), ts(), cid).lastInsertRowid);
  return { cid, aid };
}
const reset = () => { calls.length = 0; db.exec("DELETE FROM edition_jobs WHERE status IN ('queued','generating')"); db.exec("UPDATE publications SET status='unpublished'"); reply = good(); };
const jobs = cid => Object.fromEntries(db.prepare('SELECT * FROM edition_jobs WHERE cluster_id=?').all(cid).map(j => [j.lang, j]));
const drain = async () => { while (await E.runEditionJob()); };

test('an English story yields BOTH editions from two separate requests; neither edition is the input of the other (the Nepali-only bug)', async () => {
  reset(); const st = story(); E.queueStory(st.cid); await drain();
  const pubs = db.prepare("SELECT lang FROM publications WHERE cluster_id=? AND status='published'").all(st.cid).map(p => p.lang).sort();
  assert.deepEqual(pubs, ['en', 'ne'], 'both locales are on the website');
  assert.equal(calls.length, 2, 'exactly one request per edition');
  const langs = calls.map(wantsLang).sort(); assert.deepEqual(langs, ['English', 'Nepali']);
  for (const c of calls) { const text = c.messages.map(m => m.content).join('\n'); const other = wantsLang(c) === 'Nepali' ? F.EN_ED.body.slice(0, 80) : F.NE_ED.body.slice(0, 40); assert.ok(!text.includes(other), 'a finished edition never appears in the other edition\'s request'); assert.ok(text.includes(F.EN_TEXT.slice(0, 60)), 'both are written from the original source'); }
  const d = db.prepare("SELECT lang,approved_by,gen_meta FROM drafts WHERE cluster_id=?").all(st.cid); assert.ok(d.every(x => x.approved_by === 'auto' && JSON.parse(x.gen_meta).independent));
});
test('a Nepali source also yields both editions (the reverse direction)', async () => {
  reset(); reply = good({ quotes: [{ speaker: 'रामबहादुर थापा', source_text: F.NE_QUOTE }] }); const st = story({ lang: 'ne', title: F.NE_TITLE, summary: F.NE_SUMMARY, full_text: F.NE_TEXT }); E.queueStory(st.cid); await drain();
  assert.equal(db.prepare("SELECT COUNT(*) n FROM publications WHERE cluster_id=? AND status='published'").get(st.cid).n, 2); assert.equal(db.prepare("SELECT workflow FROM drafts WHERE cluster_id=? AND lang='ne'").get(st.cid).workflow, 'ne_original');
});
test('output in the wrong language is blocked: the edition goes to review, nothing is published', async () => {
  reset(); reply = b => wantsLang(b) === 'English' ? good({ edition: F.NE_ED })(b) : good()(b); const st = story(); E.queueStory(st.cid); await drain();
  const j = jobs(st.cid); assert.equal(j.en.status, 'needs_review'); assert.match(j.en.review_reason, /not in English/); assert.ok(JSON.parse(db.prepare('SELECT flags FROM drafts WHERE id=?').get(j.en.draft_id).flags).some(f => f.code === 'wrong_language'), 'the explicit language check fired'); assert.equal(j.ne.status, 'published', 'the other edition is independent');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM publications WHERE cluster_id=? AND lang='en'").get(st.cid).n, 0);
});
test('insufficient source material goes to admin review and the model is never asked to invent', async () => {
  reset(); const st = story({ title: 'Bridge', summary: 'Short.', full_text: null }); E.queueStory(st.cid); await drain();
  assert.equal(calls.length, 0); assert.ok(Object.values(jobs(st.cid)).every(j => j.status === 'needs_review' && ['source_not_enabled', 'insufficient_source'].includes(j.reason_code) && /words/.test(j.review_reason)));
  reset(); reply = good({ source_assessment: { sufficient: false, gaps: ['no figures'] } }); const s2 = story(); E.queueStory(s2.cid); await drain(); assert.ok(Object.values(jobs(s2.cid)).every(j => j.status === 'needs_review'), 'a model that says the source is thin cannot publish');
});
test('transient failures retry with bounded backoff and never double-publish; a permanent give-up is visible and retryable', async () => {
  reset(); reply = () => ({ status: 500, json: { error: { message: 'down' } } }); const st = story(); E.queueStory(st.cid, 'auto', 1);
  await E.runEditionJob(); let j = jobs(st.cid); const first = Object.values(j).find(x => x.attempts === 1); assert.ok(first, 'attempt counted'); assert.equal(first.status, 'queued'); assert.ok(first.run_at > ts(), 'backoff pushes the next try into the future'); assert.match(first.last_error, /./);
  db.prepare("UPDATE edition_jobs SET run_at=?, attempts=4 WHERE cluster_id=?").run(ts(), st.cid); await drain(); j = jobs(st.cid); assert.ok(Object.values(j).every(x => x.status === 'failed'), 'after the maximum attempts the job is failed, not retried forever');
  reply = good(); assert.equal(E.retryEditionJob(j.ne.id), 1); await drain(); assert.equal(jobs(st.cid).ne.status, 'published'); assert.equal(db.prepare("SELECT COUNT(*) n FROM publications WHERE cluster_id=? AND lang='ne'").get(st.cid).n, 1);
});
test('the queue is restart-safe: a job abandoned mid-generation is recovered and publishes exactly once', async () => {
  reset(); const st = story(); E.queueStory(st.cid); db.prepare("UPDATE edition_jobs SET status='generating', started_at=? WHERE cluster_id=?").run(new Date(Date.now() - 3600e3).toISOString(), st.cid);
  assert.equal(await E.runEditionJob() && 1, 1); await drain(); assert.deepEqual(Object.values(jobs(st.cid)).map(j => j.status), ['published', 'published']); assert.equal(db.prepare('SELECT COUNT(*) n FROM publications WHERE cluster_id=?').get(st.cid).n, 2);
  reset(); const live = story(); E.queueStory(live.cid); db.prepare("UPDATE edition_jobs SET status='generating', started_at=? WHERE cluster_id=?").run(ts(), live.cid); await E.runEditionJob(); assert.equal(calls.length, 0, 'a job another worker is running right now is not stolen');
});
test('two workers racing for the same job publish it once', async () => {
  reset(); const st = story(); E.queueStory(st.cid, 'auto', 1); await Promise.all([E.runEditionJob(), E.runEditionJob(), E.runEditionJob(), E.runEditionJob()]); await drain();
  assert.equal(db.prepare('SELECT COUNT(*) n FROM publications WHERE cluster_id=?').get(st.cid).n, 2); assert.equal(calls.length, 2, 'no edition was generated twice');
});
test('repeated queueing / polling the same story creates no second job and no second article', async () => {
  reset(); const st = story(); assert.equal(E.queueStory(st.cid), 2); assert.equal(E.queueStory(st.cid), 0); await drain(); assert.equal(E.queueStory(st.cid), 0); await drain();
  assert.equal(db.prepare('SELECT COUNT(*) n FROM edition_jobs WHERE cluster_id=?').get(st.cid).n, 2); assert.equal(db.prepare('SELECT COUNT(*) n FROM publications WHERE cluster_id=?').get(st.cid).n, 2);
});
test('changed source reporting never silently overwrites a published article', async () => {
  reset(); const st = story(); E.queueStory(st.cid); await drain(); const before = db.prepare("SELECT headline,body FROM publications WHERE cluster_id=? AND lang='en'").get(st.cid);
  db.prepare('UPDATE edition_jobs SET status=?, update_pending=1, run_at=? WHERE cluster_id=?').run('queued', ts(), st.cid); reply = good({ edition: { ...F.EN_ED, headline: 'CHANGED', body: 'CHANGED BODY' } }); await drain();
  assert.deepEqual(db.prepare("SELECT headline,body FROM publications WHERE cluster_id=? AND lang='en'").get(st.cid), before); assert.ok(Object.values(jobs(st.cid)).every(j => j.status === 'needs_review' && /updated/.test(j.review_reason)));
});
test('publication is only reported after the row is confirmed with a timestamp; a refused publication is not "published"', async () => {
  reset(); const a = story(); E.queueStory(a.cid); await drain(); const j = jobs(a.cid).en; assert.equal(j.status, 'published'); const p = db.prepare('SELECT * FROM publications WHERE id=?').get(j.publication_id); assert.equal(p.status, 'published'); assert.ok(p.published_at && j.published_at);
  db.exec("UPDATE publications SET status='published'"); const b = story(); E.queueStory(b.cid); await drain(); // identical headline is live on another story -> the duplicate guard refuses
  assert.ok(Object.values(jobs(b.cid)).every(x => x.status === 'needs_review' && x.publication_id === null), 'refused, therefore not published'); assert.equal(db.prepare('SELECT COUNT(*) n FROM publications WHERE cluster_id=?').get(b.cid).n, 0);
});
test('auto-publish is off by default, and only stories created after it is switched on are queued', async () => {
  reset(); const old = story({ created: '2020-01-01T00:00:00.000Z' }); assert.equal(E.queueNewStories(), 0, 'off by default'); E.enableAutoPublish(true);
  const stale = story({ created: new Date(Date.now() + 4000).toISOString() }); db.prepare('UPDATE articles SET fetched_at=? WHERE cluster_id=?').run('2020-01-01T00:00:00.000Z', stale.cid);
  const fresh = story({ created: new Date(Date.now() + 5000).toISOString() }); assert.ok(E.queueNewStories() >= 1); assert.equal(Object.keys(jobs(fresh.cid)).length, 2); assert.equal(Object.keys(jobs(stale.cid)).length, 0, 'an old article that was only clustered later is not queued'); assert.equal(Object.keys(jobs(old.cid)).length, 0, 'the pre-existing backlog is not flooded onto the site'); assert.equal(E.queueNewStories(), 0, 'idempotent');
  E.enableAutoPublish(false); const later = story({ created: new Date(Date.now() + 9000).toISOString() }); assert.equal(E.queueNewStories(), 0); assert.equal(Object.keys(jobs(later.cid)).length, 0);
});
test('a possible-duplicate link does not stop publication by default; it holds the story only when the editor asks for that', async () => {
  reset(); const a = story(), b = story(); db.prepare("INSERT INTO cluster_candidates(a_id,b_id,score,reason) VALUES(?,?,0.5,'t')").run(a.aid, b.aid); E.queueStory(b.cid); await drain(); assert.ok(Object.values(jobs(b.cid)).every(j => j.status === 'published'), 'the website is not held back by an undecided duplicate link');
  reset(); db.prepare("INSERT INTO settings(key,value) VALUES('hold_duplicates','true')").run(); const c = story(), d = story(); db.prepare("INSERT INTO cluster_candidates(a_id,b_id,score,reason) VALUES(?,?,0.5,'t')").run(c.aid, d.aid); E.queueStory(d.cid); await drain(); db.exec("DELETE FROM settings WHERE key='hold_duplicates'");
  assert.ok(Object.values(jobs(d.cid)).every(j => j.status === 'needs_review' && /duplicate/i.test(j.review_reason))); assert.equal(calls.length, 0, 'no AI cost is spent on a held possible duplicate');
});
// ---- clustering ----
const art = (title, lang, source, cid = null) => { n++; return Number(db.prepare('INSERT INTO articles(source_id,url,canon_url,title,title_key,language,summary,published_at,fetched_at,updated_at,cluster_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(source, `https://c.test/${n}`, `https://c.test/${n}`, title, title + n, lang, 's', ts(), ts(), ts(), cid).lastInsertRowid); };
const clusterOf = id => db.prepare('SELECT cluster_id FROM articles WHERE id=?').get(id).cluster_id;
test('duplicate coverage joins the existing story (no second public article); distinct events with different figures stay separate; every decision is audited', () => {
  const x = art('Parliament passes federal budget of Rs 1800 billion today', 'en', 1), y = art('Parliament passes federal budget of Rs 1800 billion', 'en', 2), z = art('Parliament passes federal budget of Rs 2100 billion today', 'en', 3);
  clusterNew(); assert.equal(clusterOf(x), clusterOf(y), 'same event joins'); assert.notEqual(clusterOf(z), clusterOf(x), 'different figure = different development');
  const au = db.prepare('SELECT action FROM duplicate_decisions WHERE article_id IN (?,?,?) ORDER BY id').all(x, y, z).map(r => r.action); assert.deepEqual(au.sort(), ['joined', 'new_cluster', 'new_cluster']);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM clusters WHERE id IN (?,?)').get(clusterOf(x), clusterOf(z)).n, 2);
});
test('cross-language coverage with matching figures is queued for review, never auto-merged; unusable items never enter the pipeline', () => {
  const en = art('Cabinet allocates Rs 777 million for hospital', 'en', 1), ne = art('मन्त्रिपरिषद्ले अस्पतालका लागि ७७७ करोड छुट्यायो', 'ne', 2);
  db.prepare('UPDATE articles SET title=? WHERE id=?').run('मन्त्रिपरिषद्ले अस्पतालका लागि Rs 777 छुट्यायो', ne); clusterNew();
  assert.notEqual(clusterOf(en), clusterOf(ne), 'not merged automatically'); assert.ok(db.prepare("SELECT 1 FROM cluster_candidates WHERE status='pending' AND ((a_id=? AND b_id=?) OR (a_id=? AND b_id=?))").get(ne, en, en, ne), 'surfaced for a human'); assert.ok(db.prepare("SELECT 1 FROM duplicate_decisions WHERE action='review_candidate' AND article_id=?").get(ne));
  const bad = art('Hi', 'en', 1); db.prepare("UPDATE articles SET ignore_reason='title_too_short' WHERE id=?").run(bad); clusterNew(); assert.equal(clusterOf(bad), null);
});

// ---- hourly selection is independent of website publication; social drafts need explicit, content-bound approval ----
test('a story already on the website is still a candidate for the hourly pick; one already posted to social is not', () => {
  reset(); const st = story(); const t0 = Date.parse('2030-01-01T10:00:00Z'); db.prepare('UPDATE articles SET fetched_at=?, published_at=? WHERE cluster_id=?').run(new Date(t0 + 600000).toISOString(), new Date(t0 + 600000).toISOString(), st.cid);
  const dr0 = db.prepare("INSERT INTO drafts(cluster_id,article_id,workflow,lang,status,created_at,source_snapshot,attribution) VALUES(?,?,?,?,?,?,'{}','')").run(st.cid, st.aid, 'en_original', 'en', 'approved', ts()).lastInsertRowid;
  db.prepare("INSERT INTO publications(cluster_id,lang,draft_id,headline,summary,body,category,status,published_at,updated_at,attribution) VALUES(?,'en',?,'h','s','b','national','published',?,?,'[]')").run(st.cid, dr0, ts(), ts());
  const c = { ...Sel.cfg(), minScore: 0, latenessH: 100000 }; const pick = Sel.pickForWindow(t0, t0 + 3600e3, c); assert.equal(pick.best?.id, st.cid, 'website publication does not remove it from the pool'); assert.ok(!pick.skipped.already_published);
  const dr = dr0;
  const post = db.prepare("INSERT INTO posts(cluster_id,draft_id,state,created_at,updated_at) VALUES(?,?,?,?,?)").run(st.cid, dr, 'scheduled', ts(), ts()).lastInsertRowid; const acct = S.connectMockAccount('t');
  db.prepare("INSERT INTO post_targets(post_id,account_id,caption,status,idempotency_key,updated_at) VALUES(?,?,?,?,?,?)").run(post, acct, 'c', 'published', 'k1', ts());
  const again = Sel.pickForWindow(t0, t0 + 3600e3, c); assert.notEqual(again.best?.id, st.cid); assert.ok(again.skipped.already_posted_socially >= 1);
});
test('selected story -> separate EN and NE social drafts; approval is explicit, content-bound, and the only way to delivery', async () => {
  reset(); db.exec("DELETE FROM post_targets; DELETE FROM posts"); const st = story(); E.queueStory(st.cid); await drain();
  const sel = Number(db.prepare("INSERT INTO selections(slot_start,slot_end,status,cluster_id,created_at) VALUES(?,?,?,?,?)").run('2031-01-01T00:00:00.000Z', '2031-01-01T01:00:00.000Z', 'selected', st.cid, ts()).lastInsertRowid);
  assert.equal(await SD.prepareSocialDrafts(sel), 2); assert.equal(await SD.prepareSocialDrafts(sel), 0, 'idempotent'); const sds = db.prepare('SELECT * FROM social_drafts WHERE selection_id=?').all(sel); assert.deepEqual(sds.map(s => s.lang).sort(), ['en', 'ne']);
  assert.ok(sds.every(s => s.status === 'draft' && s.graphic_id && !s.approved_hash), 'nothing is approved by selection'); const ne = sds.find(s => s.lang === 'ne'), en = sds.find(s => s.lang === 'en');
  assert.match(ne.caption, /\p{Script=Devanagari}/u); assert.doesNotMatch(en.caption, /\p{Script=Devanagari}/u, 'each draft is in its own language');
  const acct = S.connectMockAccount('mock-fb');
  assert.throws(() => SD.deliver(en.id, [acct]), /Approve/, 'unapproved content cannot be delivered');
  SD.approve(en.id); assert.equal(db.prepare('SELECT status FROM social_drafts WHERE id=?').get(ne.id).status, 'draft', 'approving EN does not approve NE');
  SD.editCaption(en.id, en.caption + ' edited'); assert.equal(db.prepare('SELECT status FROM social_drafts WHERE id=?').get(en.id).status, 'draft', 'editing voids the approval'); assert.throws(() => SD.deliver(en.id, [acct]), /Approve/);
  SD.approve(en.id); SD.reject(ne.id, 'no'); assert.throws(() => SD.approve(ne.id), /Rejected/); assert.throws(() => SD.deliver(ne.id, [acct]), /Approve/, 'a rejected post is never delivered');
  assert.throws(() => SD.deliver(en.id, []), /account/, 'approval works with no accounts configured; delivery needs one');
  SD.deliver(en.id, [acct]); const row = db.prepare('SELECT * FROM social_drafts WHERE id=?').get(en.id); assert.ok(row.post_id); assert.equal(db.prepare('SELECT state FROM posts WHERE id=?').get(row.post_id).state, 'scheduled');
  assert.throws(() => SD.deliver(en.id, [acct]), /Already/, 'no second delivery');
});
test('delivery re-checks the approval at send time: content changed after approval is refused', async () => {
  reset(); const st = story(); E.queueStory(st.cid); await drain();
  const sel = Number(db.prepare("INSERT INTO selections(slot_start,slot_end,status,cluster_id,created_at) VALUES(?,?,?,?,?)").run('2032-01-01T00:00:00.000Z', '2032-01-01T01:00:00.000Z', 'selected', st.cid, ts()).lastInsertRowid);
  await SD.prepareSocialDrafts(sel); const en = db.prepare("SELECT * FROM social_drafts WHERE selection_id=? AND lang='en'").get(sel), acct = S.connectMockAccount('m2'); SD.approve(en.id); SD.deliver(en.id, [acct]);
  const post = db.prepare('SELECT * FROM posts WHERE id=(SELECT post_id FROM social_drafts WHERE id=?)').get(en.id); assert.ok(S.checkPublishable(post).ok);
  db.prepare('UPDATE social_drafts SET caption=? WHERE id=?').run('tampered after approval', en.id); const g = S.checkPublishable(post); assert.equal(g.ok, false); assert.match(g.problems.join(' '), /changed after approval/);
  db.prepare('UPDATE social_drafts SET caption=? WHERE id=?').run(en.caption, en.id); assert.ok(S.checkPublishable(post).ok, 'restoring the approved content restores validity'); db.prepare("UPDATE social_drafts SET status='draft' WHERE id=?").run(en.id); assert.match(S.checkPublishable(post).problems.join(' '), /not approved/, 'an unapproved social post is refused by the delivery gate itself'); db.prepare("UPDATE social_drafts SET status='rejected' WHERE id=?").run(en.id); assert.match(S.checkPublishable(post).problems.join(' '), /rejected/);
});
test('with no real adapter configured the review workflow still works and nothing claims real delivery', async () => {
  const rows = SD.listSocialDrafts(); assert.ok(rows.length >= 2); for (const r of rows) for (const t of r.targets) assert.equal(t.isTest, true, 'delivery results are labelled as test/mock deliveries');
});

// ---- public site ----
test('an edition with no counterpart says so clearly instead of silently showing the wrong language', async () => {
  reset(); const st = story(); E.queueStory(st.cid); await drain(); db.prepare("UPDATE publications SET status='unpublished' WHERE cluster_id=? AND lang='ne'").run(st.cid);
  const p = db.prepare("SELECT * FROM publications WHERE cluster_id=? AND lang='en'").get(st.cid); const { articlePath } = await import('../src/slug.js');
  const r = await handleSite('GET', new URL('https://news.example.test' + articlePath(p)), { host: 'news.example.test' }); const html = r.body.toString(); assert.match(html, /data-no-counterpart/); assert.match(html, /not yet available in Nepali/); assert.doesNotMatch(html, /hreflang="ne" href/);
});
