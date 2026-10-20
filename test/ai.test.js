import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
process.env.DB_PATH = ':memory:'; process.env.OPENROUTER_API_KEY = 'test-key-123';
const { db } = await import('../src/db.js');
const { setCfg, getCfg } = await import('../src/ai.js');
const { runChecks, numbersIn } = await import('../src/checks.js');
const { generateDraft, parseModelJson, runAiJob, enqueueDraft } = await import('../src/editorial.js');

const calls = []; let reply;
const srv = http.createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => { calls.push({ auth: req.headers.authorization, body: JSON.parse(b) });
  const r = reply(); res.writeHead(r.status || 200, { 'content-type': 'application/json' }); res.end(JSON.stringify(r.json)); }); });
await new Promise(r => srv.listen(0, '127.0.0.1', r)); const port = srv.address().port;
setCfg({ ...getCfg(), base_url: `http://127.0.0.1:${port}/v1`, model: 'test/model', price_in: 2, price_out: 10, pricing_source: 'manual' });
test.after(() => srv.close());

const good = { draft: 'नेपाल विद्युत प्राधिकरणलाई तीन कम्पनीमा विभाजन गर्ने तयारी अन्तिम चरणमा पुगेको छ। प्राधिकरणका अनुसार १५ प्रतिशत काम सकिएको छ र आगामी महिना निर्णय हुने सम्भावना छ। यो खबर स्रोतका अनुसार तयार गरिएको हो र थप जानकारी आउन बाँकी छ।', translation: 'नेपाल विद्युत प्राधिकरणलाई तीन कम्पनीमा विभाजन गर्ने काम अन्तिम चरणमा पुगेको छ। अनुसार १५ प्रतिशत।',
  headline_options: ['प्राधिकरण तीन कम्पनीमा विभाजन हुने', 'विद्युत प्राधिकरण पुनर्संरचना अन्तिम चरणमा', 'तीन कम्पनी बन्ने तयारी'], recommended_index: 1, recommended_reason: 'Clear and factual', caption: 'प्राधिकरण विभाजन अन्तिम चरणमा', long_summary: 'सारांश', primary_phrase: 'विद्युत प्राधिकरण', secondary_phrases: ['पुनर्संरचना'], hashtags: ['नेपाल', '#बिजुली'], alt_text: 'विद्युत प्राधिकरणको तस्बिर', meta_title: 'शीर्षक', meta_description: 'विवरण' };

function seed(lang, title, summary) {
  const t = new Date().toISOString(); const c = Number(db.prepare('INSERT INTO clusters(created_at) VALUES(?)').run(t).lastInsertRowid);
  const k = Math.random().toString(36).slice(2);
  db.prepare('INSERT OR IGNORE INTO sources(id,name,feed_url) VALUES(1,?,?)').run('TestSrc', 'https://t/feed');
  db.prepare(`INSERT INTO articles(source_id,url,canon_url,title,title_key,language,summary,published_at,fetched_at,updated_at,cluster_id) VALUES(1,?,?,?,?,?,?,?,?,?,?)`).run('https://t/' + k, 'https://t/' + k, title, k, lang, summary, t, t, t, c);
  return c;
}
const EN = 'NEA restructuring into three companies reaches final stage';
const EN_SUM = 'Kathmandu: The restructuring of Nepal Electricity Authority into three companies has reached its final stage, officials said, with 15 percent of work pending and a decision likely next month, according to the authority.';

test('english story -> translation workflow, key only in header, usage recorded with estimated cost', async () => {
  reply = () => ({ json: { choices: [{ message: { content: JSON.stringify(good) } }], usage: { prompt_tokens: 1000, completion_tokens: 500 } } });
  const c = seed('en', EN, EN_SUM); const id = await generateDraft(c);
  const d = db.prepare('SELECT * FROM drafts WHERE id=?').get(id);
  assert.equal(d.workflow, 'translate_en'); assert.equal(d.ai_draft, good.draft); assert.equal(d.rec_idx, 1); assert.ok(d.ai_translation);
  assert.equal(calls.at(-1).auth, 'Bearer test-key-123'); assert.match(calls.at(-1).body.messages[1].content, /English source/);
  assert.deepEqual(JSON.parse(d.hashtags), ['#नेपाल', '#बिजुली']);
  const u = db.prepare('SELECT * FROM ai_usage ORDER BY id DESC').get(); assert.equal(u.tokens_in, 1000); assert.ok(Math.abs(u.cost - 0.007) < 1e-9); assert.equal(u.cost_source, 'estimated');
  assert.equal(db.prepare('SELECT summary FROM articles WHERE cluster_id=?').get(c).summary, EN_SUM, 'source untouched');
});
test('nepali story is NOT retranslated', async () => {
  const n = calls.length; reply = () => ({ json: { choices: [{ message: { content: JSON.stringify({ ...good, translation: undefined }) } }], usage: {} } });
  const c = seed('ne', 'प्राधिकरणको पुनर्संरचना अन्तिम चरणमा', 'नेपाल विद्युत प्राधिकरणको पुनर्संरचना अन्तिम चरणमा पुगेको छ, अधिकारीहरूले जानकारी दिए। १५ प्रतिशत काम बाँकी रहेको र आउँदो महिना निर्णय हुने सम्भावना रहेको प्राधिकरणले बतायो।');
  const id = await generateDraft(c); assert.equal(db.prepare('SELECT workflow,ai_translation FROM drafts WHERE id=?').get(id).workflow, 'ne_original');
  assert.match(calls[n].body.messages[1].content, /do NOT translate/); assert.doesNotMatch(calls[n].body.messages[0].content, /"translation"/);
});
test('thin source and unsupported language make no model call', async () => {
  const n = calls.length;
  await assert.rejects(generateDraft(seed('en', 'Short', 'tiny')), /insufficient/); await assert.rejects(generateDraft(seed('other', 'xxxxxxxxxx'.repeat(20), 'y'.repeat(100))), /not supported/);
  assert.equal(calls.length, n);
});
test('provider error is surfaced, logged, and job retries then fails', async () => {
  reply = () => ({ status: 429, json: { error: { message: 'rate limited' } } });
  const c = seed('en', EN + ' x', EN_SUM); enqueueDraft(c);
  for (let i = 0; i < 3; i++) { db.prepare("UPDATE ai_jobs SET run_at=?").run(new Date(0).toISOString()); await runAiJob(); }
  const j = db.prepare('SELECT status,attempts,error FROM ai_jobs WHERE cluster_id=?').get(c); assert.equal(j.status, 'failed'); assert.equal(j.attempts, 3); assert.match(j.error, /rate limited/);
  assert.ok(db.prepare('SELECT COUNT(*) n FROM ai_usage WHERE ok=0').get().n >= 3);
});
test('parseModelJson rejects bad output and tolerates code fences', () => {
  assert.throws(() => parseModelJson('not json'), /valid JSON/); assert.throws(() => parseModelJson('{"draft":"x","headline_options":["a"]}'), /fewer than 3/);
  assert.equal(parseModelJson('```json\n' + JSON.stringify(good) + '\n```').headlines.length, 3);
});
test('checks: altered numbers, dropped hedging, wrong script, glossary', () => {
  const src = 'Police arrested 5 suspects, allegedly linked to a Rs 2,000,000 fraud, according to officials. "We will investigate," said Ram Sharma.';
  const f = runChecks({ source: src, draft: 'प्रहरीले ७ जनालाई पक्राउ गरेको छ। यो एक ठूलो अपराध हो र दोषी ठहर भइसकेको छ भन्ने कुरा स्पष्ट छ।'.repeat(1), glossary: [{ en: 'Police', ne: 'प्रहरी' }], workflow: 'translate_en', translation: '' });
  const codes = f.map(x => x.code); for (const c of ['number_not_in_source', 'number_missing', 'uncertainty_lost', 'quotes_dropped', 'currency_missing']) assert.ok(codes.includes(c), c);
  assert.ok(runChecks({ source: 'a', draft: 'English only draft that is long enough to pass the length check for sure okay', workflow: 'ne_original' }).some(x => x.code === 'not_nepali'));
  assert.deepEqual([...numbersIn('१,२३,४५६ and five and 7%')].sort(), ['123456', '5', '7']);
  assert.deepEqual([...numbersIn('तीन कम्पनी र पन्ध्र प्रतिशत, पुगेको छ, एक साथ')].sort(), ['15', '3'], 'Nepali number words count; छ and एक do not');
  assert.deepEqual([...numbersIn('no one came; three arrived')], ['3'], '"one" is not treated as a number');
});

/* ---- English edition + multi-language behaviour (mock provider; proves our code paths, not live model quality) ---- */
const goodEn = { draft: 'The government plans to split the Nepal Electricity Authority into three companies, officials said. According to the ministry, 15 percent of the work remains and a decision is likely next month. Details of ownership are still being finalised.', headline_options: ['NEA to be split into three companies', 'Electricity authority restructuring nears final stage', 'Three-company plan for NEA advances'], recommended_index: 0, recommended_reason: 'Clear and factual', caption: 'NEA restructuring reaches its final stage.', long_summary: 'The plan to split NEA is in its final stage.', primary_phrase: 'NEA restructuring', secondary_phrases: ['electricity'], hashtags: ['Nepal', '#Energy'], alt_text: 'Generic news graphic', meta_title: 'NEA restructuring', meta_description: 'NEA is to be split into three companies.' };
const reply1 = o => () => ({ json: { choices: [{ message: { content: JSON.stringify(o) } }], usage: { prompt_tokens: 800, completion_tokens: 300 } } });

test('English edition from an English source: original English draft, no translation key, stored with lang=en', async () => {
  const n = calls.length; reply = reply1(goodEn); const c = seed('en', EN + ' ee', EN_SUM);
  const id = await generateDraft(c, 'en'); const d = db.prepare('SELECT * FROM drafts WHERE id=?').get(id);
  assert.equal(d.lang, 'en'); assert.equal(d.workflow, 'en_original'); assert.equal(d.ai_translation, null); assert.equal(d.ai_draft, goodEn.draft);
  assert.match(calls[n].body.messages[0].content, /English-language news editor/); assert.doesNotMatch(calls[n].body.messages[0].content, /"translation"/); assert.match(calls[n].body.messages[1].content, /English source → original English/);
  assert.deepEqual(JSON.parse(d.flags).filter(f => f.severity === 'error'), [], 'good English output passes the language and number checks');
});
test('English edition from a Nepali source (NE→EN): Devanagari digits in the source match Latin digits in the output', async () => {
  const n = calls.length; reply = reply1(goodEn);
  const c = seed('ne', 'प्राधिकरणको पुनर्संरचना अन्तिम चरणमा', 'नेपाल विद्युत प्राधिकरणलाई तीन कम्पनीमा विभाजन गर्ने पुनर्संरचना अन्तिम चरणमा पुगेको छ। १५ प्रतिशत काम बाँकी रहेको र आउँदो महिना निर्णय हुने सम्भावना रहेको मन्त्रालयले बतायो।');
  const id = await generateDraft(c, 'en'); const d = db.prepare('SELECT * FROM drafts WHERE id=?').get(id), fl = JSON.parse(d.flags);
  assert.equal(d.workflow, 'ne_to_en'); assert.match(calls[n].body.messages[1].content, /Nepali source → English/);
  assert.ok(!fl.some(f => f.code === 'number_not_in_source' || f.code === 'number_missing'), JSON.stringify(fl)); assert.ok(fl.some(f => f.code === 'names_to_verify' && f.severity === 'info'));
});
test('an "English" draft that comes back in Nepali is flagged as an error', async () => {
  reply = reply1({ ...goodEn, draft: good.draft, headline_options: good.headline_options }); const c = seed('en', EN + ' wrong-lang', EN_SUM);
  const d = db.prepare('SELECT flags FROM drafts WHERE id=?').get(await generateDraft(c, 'en')); const codes = JSON.parse(d.flags).map(f => f.code); assert.ok(codes.includes('not_english') && codes.includes('headline_not_english'), codes.join());
});
test('Nepali and English drafts coexist; regenerating one language supersedes only that language', async () => {
  reply = reply1(good); const c = seed('en', EN + ' coexist', EN_SUM); const ne1 = await generateDraft(c, 'ne');
  reply = reply1(goodEn); const en1 = await generateDraft(c, 'en'); const st = id => db.prepare('SELECT status,lang FROM drafts WHERE id=?').get(id);
  assert.deepEqual([st(ne1).status, st(en1).status], ['needs_review', 'needs_review'], 'the English draft did not supersede the Nepali one');
  reply = reply1(good); const ne2 = await generateDraft(c, 'ne'); assert.deepEqual([st(ne1).status, st(ne2).status, st(en1).status], ['superseded', 'needs_review', 'needs_review']);
  enqueueDraft(c, 'ne'); enqueueDraft(c, 'en'); enqueueDraft(c, 'en'); assert.equal(db.prepare("SELECT COUNT(*) n FROM ai_jobs WHERE cluster_id=? AND status='queued'").get(c).n, 2, 'one pending job per language, none duplicated');
});
test('a failed AI request preserves existing drafts and the source record', async () => {
  reply = reply1(good); const c = seed('en', EN + ' preserve', EN_SUM); const keep = await generateDraft(c, 'ne');
  db.prepare("UPDATE drafts SET edited_body='editor work in progress',edited_headline='editor headline' WHERE id=?").run(keep); const before = db.prepare('SELECT * FROM drafts WHERE id=?').get(keep), src = db.prepare('SELECT title,summary FROM articles WHERE cluster_id=?').get(c);
  for (const bad of [() => ({ status: 500, json: { error: { message: 'upstream down' } } }), () => ({ json: { choices: [{ message: { content: 'not json at all' } }], usage: {} } }), () => ({ status: 402, json: { error: { message: 'insufficient credits' } } })]) {
    reply = bad; await assert.rejects(generateDraft(c, 'ne'));
  }
  assert.deepEqual(db.prepare('SELECT * FROM drafts WHERE id=?').get(keep), before, 'draft, edits and status untouched'); assert.equal(db.prepare("SELECT COUNT(*) n FROM drafts WHERE cluster_id=?").get(c).n, 1);
  assert.deepEqual(db.prepare('SELECT title,summary FROM articles WHERE cluster_id=?').get(c), src, 'source material untouched');
});
test('the configured model is never swapped silently (no fallback to another model)', async () => {
  const n = calls.length; reply = () => ({ status: 429, json: { error: { message: 'rate limited' } } }); const c = seed('en', EN + ' nofallback', EN_SUM);
  await assert.rejects(generateDraft(c, 'ne')); const used = new Set(calls.slice(n).map(x => x.body.model)); assert.deepEqual([...used], ['test/model'], 'only the configured model was ever requested');
});
