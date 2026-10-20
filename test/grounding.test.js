// Regression tests for the "Thansing / Nuwakot" failure: thin RSS summary, article never fetched, invented quote taken from a headline,
// padded text, and a social caption that copies the article. MOCK model + MOCK page fetcher: they prove our gates, not model quality.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
Object.assign(process.env, { DB_PATH: ':memory:', OPENROUTER_API_KEY: 'k', TOKEN_KEY: 'c'.repeat(64), SOCIAL_MOCK: '1', PUBLIC_BASE_URL: 'https://news.example.test', EXTRACT_DELAY_MS: '0' });
const { db } = await import('../src/db.js');
const { setCfg, getCfg } = await import('../src/ai.js');
const E = await import('../src/editions.js');
const X = await import('../src/extract.js');
const { numbersIn } = await import('../src/checks.js');
const { _setRobotsFetcher } = await import('../src/robots.js');
const F = await import('./fixtures/content.js');
_setRobotsFetcher(async () => ({ status: 200, buf: Buffer.from('User-agent: *\nDisallow:\n') }));

// ---- mock model: replies are chosen by what is being asked ----
const calls = []; let responder;
const kindOf = b => { const u = b.messages.at(-1).content, s = b.messages[0].content; return /SOCIAL CAPTION TASK/.test(s) ? 'caption' : /GROUNDING REVISION/.test(u) ? 'retry' : 'edition'; };
const lang = b => (b.messages.at(-1).content.match(/(?:Target edition language|Caption language): (\w+)/) || [])[1];
const srv = http.createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => { const body = JSON.parse(b), k = kindOf(body); calls.push({ kind: k, lang: lang(body), body }); const text = responder({ kind: k, lang: lang(body), body, n: calls.filter(c => c.kind === k).length });
  res.writeHead(200, { 'content-type': 'application/json' }); const cut = text && text.__length === true; res.end(JSON.stringify({ choices: [{ message: { content: cut ? 'partial output' : typeof text === 'string' ? text : JSON.stringify(text) }, finish_reason: cut ? 'length' : 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 50 } })); }); });
await new Promise(r => srv.listen(0, '127.0.0.1', r)); setCfg({ ...getCfg(), base_url: `http://127.0.0.1:${srv.address().port}/v1`, model: 'test/model' }); test.after(() => srv.close());
const reply = (ed, over = {}) => ({ source_assessment: { sufficient: true, gaps: [] }, source_sufficiency: { level: 'full', reasons: [] }, review_required: false, unsupported_claims: [], facts: F.FACTS, quotes: [{ speaker: 'Ram Bahadur Thapa', source_text: F.EN_QUOTE }], verified_facts: [], attributed_quotes: [], edition: ed, ...over });
const enOf = o => (o.lang === 'Nepali' ? F.NE_ED : F.EN_ED);

// ---- mock publisher pages ----
const NAV = '<nav><a href="/">Home</a><a href="/politics">Politics</a><a href="/sports">Sports</a></nav><div class="cookie-banner">We use cookies. Accept all cookies to continue browsing this site.</div><div class="advert">Advertisement: buy now</div>';
const TAIL = '<div class="related"><p>Related: <a href="/x">Another story you may like to read next</a></p></div><aside><p>Follow us on Facebook and subscribe to our newsletter for daily updates</p></aside><footer><p>Copyright 2026 Example Publisher. All rights reserved worldwide.</p></footer>';
const page = (paras, head = '') => `<html><head>${head}<title>x</title></head><body>${NAV}<article><h1>Headline</h1>${paras.map(p => `<p>${p}</p>`).join('')}</article>${TAIL}</body></html>`;
let fetches = [], pageFor;
X._setPageFetcher(async u => { fetches.push(u); return pageFor(u); });
const ok200 = html => ({ status: 200, body: html, finalUrl: 'https://pub.test/final', type: 'text/html' });
const FARM = ['In Thansing, a farming area of Nuwakot district, paddy growers were harvesting on the eighth day of the Dashain festival while most villagers stayed at home with relatives.', 'Farmer Uddhav Shrestha said fifteen labourers were working his fields because the ripe crop could be damaged if rain arrived before it was cut and dried properly.', 'Local farmers said they had planted earlier than usual this year, and the grain was ready before the festival, which left little time to celebrate or visit relatives elsewhere.', 'The village agriculture office said harvest is expected to finish within a week if the weather stays dry, and it advised growers to store the grain in covered places.', 'Several households said they would hold their own family celebrations after the harvest is finished and the grain has been safely stored for the winter months ahead.', 'The district agriculture officer added that labour shortages during the festival week were the main difficulty this season, and that growers who finished early were helping neighbours with cutting and carrying the harvested bundles.', 'Traders from the nearby market said they expected fresh grain to arrive in the next few days and that prices would be announced after the first deliveries were weighed and recorded.'];

// ---- fixtures ----
const ts = () => new Date().toISOString(); let n = 0;
function story({ title = F.EN_TITLE, summary = 'Farmers in Thansing, Nuwakot are anxious about protecting their ripe paddy crop now.', lang = 'en', content = null, source = 1 } = {}) {
  n++; const cid = Number(db.prepare('INSERT INTO clusters(created_at) VALUES(?)').run(ts()).lastInsertRowid);
  const aid = Number(db.prepare('INSERT INTO articles(source_id,url,canon_url,title,title_key,language,summary,content,published_at,fetched_at,updated_at,cluster_id,extraction_status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(source, 'https://pub.test/a' + n, 'https://pub.test/a' + n, title, 'k' + n, lang, summary, content, ts(), ts(), ts(), cid, 'rss_only').lastInsertRowid);
  return { cid, aid };
}
const jobs = cid => Object.fromEntries(db.prepare('SELECT * FROM edition_jobs WHERE cluster_id=?').all(cid).map(j => [j.lang, j]));
const drain = async () => { while (await E.runEditionJob()); };
const runStory = async (st, auto = 1) => { E.queueStory(st.cid, 'auto', auto); await drain(); return jobs(st.cid); };
const enable = on => db.prepare('UPDATE sources SET fulltext_enabled=? WHERE id=1').run(on ? 1 : 0);
const flagsOf = (cid, l) => JSON.parse(db.prepare("SELECT flags FROM drafts WHERE cluster_id=? AND lang=? ORDER BY id DESC").get(cid, l)?.flags ?? '[]');
const codes = (cid, l) => flagsOf(cid, l).filter(f => f.severity === 'error').map(f => f.code);
beforeEach(() => { calls.length = 0; fetches = []; db.exec("DELETE FROM edition_jobs; DELETE FROM publications; DELETE FROM ai_cache; DELETE FROM ai_usage; DELETE FROM settings WHERE key IN ('edition_allow_limited')"); enable(true); responder = o => reply(enOf(o)); pageFor = () => ok200(page(F.EN_PARAS)); });

test('1. a 13-word RSS summary whose article is extractable is written from the extracted text, with fetch metadata stored', async () => {
  const st = story(); assert.equal(X.sourceTextFor(db.prepare('SELECT * FROM articles WHERE id=?').get(st.aid)).words, 13);
  const j = await runStory(st); const a = db.prepare('SELECT * FROM articles WHERE id=?').get(st.aid);
  assert.equal(a.extraction_status, 'extracted'); assert.ok(a.full_text.split(/\s+/).length >= 150); assert.equal(a.fetch_status, 200); assert.equal(a.extraction_error, null); assert.ok(a.extracted_at); assert.ok(a.extraction_method);
  assert.equal(db.prepare("SELECT source_level l FROM drafts WHERE cluster_id=? AND lang='en'").get(st.cid).l, 'full'); assert.equal(j.en.status, 'published'); assert.equal(j.ne.status, 'published');
  assert.ok(JSON.parse(a.source_quality).level === 'full', 'the assessment is stored'); assert.equal(fetches.length, 1, 'one page fetch serves both editions');
});
test('1b. extraction switched off for the publisher: nothing is sent to the model, and the reason tells the editor exactly what to do', async () => {
  enable(false); const st = story(); const j = await runStory(st);
  assert.equal(calls.length, 0, 'no model call (and no cost) on a 13-word summary'); assert.equal(fetches.length, 0);
  for (const l of ['en', 'ne']) { assert.equal(j[l].status, 'needs_review'); assert.equal(j[l].reason_code, 'source_not_enabled'); assert.match(j[l].review_reason, /full-text retrieval is off/i); }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM publications').get().n, 0);
});
test('2. a source that errors or times out is retried a bounded number of times, never hammered, and never blocks other stories', async () => {
  pageFor = () => { throw new Error('timeout of 15000ms exceeded'); }; const bad = story(); E.queueStory(bad.cid, 'auto', 1);
  const good = story({ summary: 'Farmers in Thansing, Nuwakot are anxious about their crop. Second sentence here for the brief.' }); pageFor = u => (u === db.prepare('SELECT url FROM articles WHERE id=?').get(bad.aid).url ? (() => { throw new Error('timeout of 15000ms exceeded'); })() : ok200(page(F.EN_PARAS))); E.queueStory(good.cid, 'auto', 1);
  for (let i = 0; i < 12; i++) { db.exec("UPDATE edition_jobs SET run_at='2000-01-01T00:00:00.000Z' WHERE status='queued'; UPDATE articles SET extracted_at='2000-01-01T00:00:00.000Z' WHERE extraction_status='extraction_failed'"); await drain(); }
  assert.ok(fetches.filter(u => u.endsWith('/a' + (n - 1))).length <= 3, 'bounded attempts on the failing page'); const jb = jobs(bad.cid); assert.equal(jb.en.status, 'needs_review'); assert.equal(jb.en.reason_code, 'source_unavailable'); assert.equal(calls.filter(c => /Thansing/.test(c.body.messages.at(-1).content) && !/Mohana/.test(c.body.messages.at(-1).content)).length, 0, 'no model call on the unreadable source');
  assert.equal(jobs(good.cid).en.status, 'published', 'an unrelated story was not blocked');
});
test('3. boilerplate around the article (navigation, cookie banner, ads, related links, footer) is removed', async () => {
  const html = page(F.EN_PARAS); const ex = X.extractFromHtml(html); const t = ex.paragraphs.join('\n');
  for (const junk of ['cookies', 'Advertisement', 'Related:', 'Follow us', 'Copyright 2026', 'Politics']) assert.ok(!t.includes(junk), junk + ' must not reach the model'); assert.ok(t.includes('Mohana') || t.length > 400);
});
test('4. paywalled / forbidden sources are recorded as restricted, fetched once, and never re-fetched or bypassed', async () => {
  pageFor = () => ({ status: 403, body: 'denied', finalUrl: 'x', type: 'text/html' }); const st = story(); const j = await runStory(st);
  assert.equal(j.en.status, 'needs_review'); assert.equal(j.en.reason_code, 'source_restricted'); assert.equal(db.prepare('SELECT extraction_status s FROM articles WHERE id=?').get(st.aid).s, 'access_restricted'); assert.equal(calls.length, 0);
  E.retryEditionJob(j.en.id); await drain(); assert.equal(fetches.length, 1, 'a restricted page is not requested again on retry');
  pageFor = () => ok200(page(['Subscribe to continue reading this premium article. ' + 'x'.repeat(60)], '<meta name="paywall" content="true">')); const p = story({ summary: 'Another thin summary about the same sort of topic for testing purposes only.' }); const jp = await runStory(p); assert.equal(jp.en.reason_code, 'source_restricted'); assert.equal(db.prepare('SELECT extraction_status s FROM articles WHERE id=?').get(p.aid).s, 'paywall_suspected');
});
test('5. a quotation that exists only in the headline is never accepted as evidence: one strict regeneration, then the sentence is cut out and the story still publishes', async () => {
  pageFor = () => ok200(page(FARM)); const title = '‘We worry more about the harvest than the festival’, say Thansing farmers'; const st = story({ title });
  const bad = farmEd('\n\nFarmers in Thansing said, “We worry more about the harvest than the festival.”');
  responder = o => reply(o.lang === 'Nepali' ? F.NE_ED : bad, o.lang === 'Nepali' ? {} : { attributed_quotes: [{ speaker: 'Farmers in Thansing', text: 'We worry more about the harvest than the festival' }], quotes: [{ speaker: 'Farmers in Thansing', source_text: 'We worry more about the harvest than the festival' }] });
  const j = await runStory(st);
  assert.equal(j.en.status, 'published'); const d = db.prepare("SELECT ai_draft,gen_meta,flags FROM drafts WHERE cluster_id=? AND lang='en' AND status='approved'").get(st.cid);
  assert.ok(!/worry more about the harvest/i.test(d.ai_draft), 'the invented quotation is not in the published text'); assert.ok(JSON.parse(d.gen_meta).scrubbed.some(x => /quotation/.test(x.why)), 'what was removed is recorded'); assert.ok(!codes(st.cid, 'en').includes('quote_only_in_headline'));
  assert.equal(calls.filter(c => c.lang === 'English' && c.kind === 'edition').length + calls.filter(c => c.lang === 'English' && c.kind === 'retry').length, 2, 'exactly one stricter retry first'); assert.match(calls.find(c => c.kind === 'retry' && c.lang === 'English').body.messages.at(-1).content, /quotation/i, 'the retry names the problem');
});
test('6. unsupported details (figures and claims absent from the evidence) are cut out; the rest of the story publishes', async () => {
  pageFor = () => ok200(page(FARM)); const st = story(); const padded = farmEd('\n\nThe district administration allotted Rs 5 million in relief and deployed 300 soldiers to help.');
  responder = o => reply(o.lang === 'Nepali' ? F.NE_ED : padded); const j = await runStory(st); const d = db.prepare("SELECT ai_draft,gen_meta FROM drafts WHERE cluster_id=? AND lang='en' AND status='approved'").get(st.cid); assert.ok(d, 'published'); assert.ok(!/Rs 5 million|300 soldiers/.test(d.ai_draft)); assert.ok(JSON.parse(d.gen_meta).scrubbed.some(x => /figure/.test(x.why)));
});
const farmEd = (extra = '') => ({ ...F.EN_ED, headline: 'Thansing farmers race to bring in the paddy during Dashain', standfirst: 'Paddy growers in Thansing worked through the festival.', body: ['Rice growers around Thansing in Nuwakot spent the festival days cutting their crop, even as families elsewhere gathered at home.', 'One of them, Uddhav Shrestha, explained that he hired extra workers since a sudden downpour would spoil grain that was ripe but not yet dried.', 'Officials at the local agriculture office expect cutting to wrap up inside seven days provided the skies stay clear, and they urged storing the harvest under cover.'].join('\n\n') + extra, graphic_headline: 'Thansing farmers harvest through Dashain', graphic_description: 'Growers race the weather to bring in the paddy.', social_caption: 'Farmers in Thansing spent the festival in their fields to protect the ripe crop from the weather.\n\n{{ARTICLE_URL}}\n\n#Nuwakot #Dashain', short_caption: 'Thansing farmers harvest through Dashain.', seo_title: 'Thansing farmers harvest through Dashain', meta_description: 'Paddy growers in Thansing worked through the festival to protect the crop.', keywords: ['Thansing', 'Nuwakot', 'paddy'] });
const BRIEF_EN = 'The Ministry of Health said on Monday that 42 new dengue cases were recorded in Kathmandu Valley over the past week, bringing the monthly total to 310. Officials urged residents to remove standing water and said hospitals have enough beds. The ministry will review the figures again next Monday.';
const BRIEF_NE = 'स्वास्थ्य मन्त्रालयले सोमबार काठमाडौं उपत्यकामा गत हप्ता डेंगुका ४२ नयाँ बिरामी भेटिएको जनाएको छ। यससँगै यो महिनाको कुल संख्या ३१० पुगेको छ। मन्त्रालयले बासिन्दालाई जमेको पानी हटाउन आग्रह गरेको छ र अस्पतालमा पर्याप्त शय्या रहेको बताएको छ।';
const briefEd = (l, body) => ({ ...(l === 'Nepali' ? F.NE_ED : F.EN_ED), body, standfirst: l === 'Nepali' ? 'काठमाडौं उपत्यकामा डेंगुका ४२ नयाँ बिरामी भेटिए।' : 'Kathmandu Valley recorded 42 new dengue cases last week.', headline: l === 'Nepali' ? 'उपत्यकामा डेंगुका ४२ नयाँ बिरामी' : 'Kathmandu records 42 new dengue cases', graphic_headline: l === 'Nepali' ? 'डेंगुका ४२ नयाँ बिरामी' : '42 new dengue cases', graphic_description: l === 'Nepali' ? 'उपत्यकामा एक हप्तामा थपिए' : 'Added across the Valley in a week',
  social_caption: l === 'Nepali' ? 'उपत्यकामा डेंगुको जोखिम बढेको छ। मन्त्रालयले जमेको पानी हटाउन आग्रह गरेको छ।\n\n{{ARTICLE_URL}}\n\n#डेंगु #स्वास्थ्य #काठमाडौं' : 'Dengue is spreading in the Valley. Officials ask residents to clear standing water.\n\n{{ARTICLE_URL}}\n\n#Dengue #Health #Kathmandu', short_caption: 'Dengue cases rise in the Valley.', seo_title: l === 'Nepali' ? 'उपत्यकामा डेंगु' : 'Dengue cases in the Valley', meta_description: l === 'Nepali' ? 'डेंगुका ४२ नयाँ बिरामी' : 'Forty-two new dengue cases were recorded', keywords: ['dengue', 'Kathmandu', 'health'] });
test('7. genuinely short source: no padding, a concise brief only when the editorial policy permits it, otherwise review without any model cost', async () => {
  const mk = () => story({ title: 'Dengue cases rise in Valley', summary: BRIEF_EN, source: 1 }); enable(false);
  const off = mk(); const j0 = await runStory(off); assert.equal(calls.length, 0); assert.equal(j0.en.reason_code, 'brief_not_permitted'); assert.equal(db.prepare('SELECT COUNT(*) n FROM publications').get().n, 0);
  db.prepare("INSERT INTO settings(key,value) VALUES('edition_allow_limited','true')").run(); responder = o => reply(briefEd(o.lang, o.lang === 'Nepali' ? BRIEF_NE : 'The Ministry of Health said on Monday that 42 new dengue cases were recorded in Kathmandu Valley last week, taking the monthly total to 310. It asked residents to remove standing water and said hospitals have enough beds.'), { quotes: [] });
  const on = mk(); const j1 = await runStory(on); assert.equal(j1.en.status, 'published', JSON.stringify(codes(on.cid, 'en')) + j1.en.review_reason); assert.equal(db.prepare("SELECT source_level l FROM drafts WHERE cluster_id=? AND lang='en'").get(on.cid).l, 'brief');
  const first = calls.find(c => c.kind === 'edition'); assert.match(first.body.messages.at(-1).content + first.body.messages[0].content, /at most \d+ words/i, 'the model is given a length ceiling, not a minimum');
  const tooLong = mk(); responder = o => reply(briefEd(o.lang, BRIEF_EN + ' ' + BRIEF_EN + ' Residents in many neighbourhoods reported mosquito problems and local ward offices held awareness meetings, the officials added.'), { quotes: [] }); db.exec('DELETE FROM ai_cache'); const j2 = await runStory(tooLong); assert.equal(j2.en.status, 'needs_review', 'a padded brief is held'); assert.ok(codes(tooLong.cid, 'en').includes('padding_suspected'));
});
test('8. a valid paraphrase that is not verbatim passes: evidence is semantic, not sentence-by-sentence matching', async () => {
  const st = story(); const j = await runStory(st); assert.equal(j.en.status, 'published'); assert.deepEqual(codes(st.cid, 'en'), []);
});
test('9. a caption that copies the article is regenerated separately; if it keeps copying, a safe extractive caption is used', async () => {
  const copyEd = o => ({ ...enOf(o), social_caption: enOf(o).body.replace(/\n\n/g, ' ').slice(0, 880) + '\n\n{{ARTICLE_URL}}\n\n#Kailali' });
  let st = story(); responder = o => (o.kind === 'caption' ? { caption: o.lang === 'Nepali' ? F.NE_ED.social_caption : F.EN_ED.social_caption } : reply(copyEd(o))); let j = await runStory(st);
  assert.equal(j.en.status, 'published'); assert.ok(calls.some(c => c.kind === 'caption' && c.lang === 'English'), 'composed as a separate request'); assert.equal(db.prepare("SELECT json_extract(gen_meta,'$.caption.mode') m FROM drafts WHERE cluster_id=? AND lang='en'").get(st.cid).m, 'regenerated');
  const cap = c => c.body.messages[0].content + c.body.messages.at(-1).content; assert.ok(!cap(calls.find(c => c.kind === 'caption')).includes(F.EN_ED.body.slice(100, 200)), 'the caption request is built from verified facts, not from the article body');
  calls.length = 0; db.exec('DELETE FROM edition_jobs; DELETE FROM publications; DELETE FROM ai_cache'); st = story(); responder = o => (o.kind === 'caption' ? { caption: enOf(o).body.replace(/\n\n/g, ' ').slice(0, 800) } : reply(copyEd(o))); j = await runStory(st);
  assert.equal(calls.filter(c => c.kind === 'caption' && c.lang === 'English').length, 2, 'at most two regenerations'); const d = db.prepare("SELECT * FROM drafts WHERE cluster_id=? AND lang='en' ORDER BY id DESC").get(st.cid), meta = JSON.parse(d.gen_meta);
  assert.equal(meta.caption.mode, 'extractive'); assert.ok(d.caption.includes('{{ARTICLE_URL}}')); assert.ok(!/["“”]/.test(d.caption), 'no quotation marks in a fallback caption'); assert.ok(d.caption.length < 600 && d.caption.length < d.ai_draft.length * 0.6, 'short, not the article');
});
test('10. a valid independent caption is accepted as written, with no extra request', async () => {
  const st = story(); await runStory(st); assert.equal(calls.filter(c => c.kind === 'caption').length, 0); assert.equal(db.prepare("SELECT json_extract(gen_meta,'$.caption.mode') m FROM drafts WHERE cluster_id=? AND lang='en'").get(st.cid).m, 'model');
});
test('11. durable retries and duplicate prevention: the same story is generated, extracted and published once', async () => {
  const st = story(); await runStory(st); const c1 = calls.length, f1 = fetches.length; assert.equal(E.queueStory(st.cid), 0); await drain(); db.exec("UPDATE edition_jobs SET status='queued', run_at='2000-01-01T00:00:00.000Z'"); await drain();
  assert.equal(calls.length, c1, 'no repeated model work'); assert.equal(fetches.length, f1, 'extraction is cached'); assert.equal(db.prepare('SELECT COUNT(*) n FROM publications WHERE cluster_id=?').get(st.cid).n, 2); assert.equal(db.prepare('SELECT COUNT(*) n FROM drafts WHERE cluster_id=?').get(st.cid).n, 2);
});
test('12. both editions carry the same verified facts; a figure that differs between them is caught', async () => {
  const st = story(); const j = await runStory(st); const ne = db.prepare("SELECT ai_draft b FROM drafts WHERE cluster_id=? AND lang='ne'").get(st.cid).b, en = db.prepare("SELECT ai_draft b FROM drafts WHERE cluster_id=? AND lang='en'").get(st.cid).b;
  assert.deepEqual([...numbersIn(ne)].sort(), [...numbersIn(en)].sort()); assert.equal(j.en.status, 'published');
  db.exec('DELETE FROM edition_jobs; DELETE FROM publications; DELETE FROM ai_cache'); const st2 = story(); responder = o => reply(o.lang === 'Nepali' ? { ...F.NE_ED, body: F.NE_ED.body.replace('३२०', '४२०') } : F.EN_ED); const j2 = await runStory(st2);
  const nd = db.prepare("SELECT ai_draft,gen_meta FROM drafts WHERE cluster_id=? AND lang='ne' AND status='approved'").get(st2.cid); assert.ok(nd && !/४२०/.test(nd.ai_draft), 'the sentence with the invented figure was cut out'); assert.ok(JSON.parse(nd.gen_meta).scrubbed.some(x => /420/.test(x.why))); assert.equal(j2.ne.status, 'published');
});
test('13. verified facts are still checked against the source and the findings are recorded; they no longer keep the story off the website', async () => {
  const mkFacts = list => reply(F.EN_ED, { verified_facts: list }), fresh = () => db.exec('DELETE FROM edition_jobs; DELETE FROM publications; DELETE FROM ai_cache');
  let st = story(); responder = o => (o.lang === 'Nepali' ? reply(F.NE_ED) : mkFacts([{ statement: 'A Rs 45 million contract was awarded', evidence: 'has awarded a Rs 45 million contract to rebuild the Mohana River bridge' }])); await runStory(st); assert.ok(!flagsOf(st.cid, 'en').some(f => f.code === 'fact_not_in_source'), 'real evidence passes');
  fresh(); st = story(); responder = o => (o.lang === 'Nepali' ? reply(F.NE_ED) : mkFacts([{ statement: 'The minister promised 900 buses', evidence: 'The minister promised 900 buses for the festival' }])); let j = await runStory(st); assert.ok(codes(st.cid, 'en').includes('fact_not_in_source'), 'the invented evidence is detected and recorded'); assert.equal(j.en.status, 'published');
  fresh(); st = story(); responder = o => (o.lang === 'Nepali' ? reply(F.NE_ED) : mkFacts([{ statement: 'A Rs 450 million contract', evidence: 'has awarded a Rs 45 million contract to rebuild the Mohana River bridge' }])); await runStory(st); assert.ok(codes(st.cid, 'en').includes('fact_number_mismatch'), 'a statement may not claim figures its evidence lacks (recorded)');
  fresh(); st = story(); responder = o => (o.lang === 'Nepali' ? reply(F.NE_ED) : reply(F.EN_ED, { unsupported_claims: ['the minister visited the site'], review_required: true })); j = await runStory(st); assert.ok(codes(st.cid, 'en').includes('model_flagged_unsupported')); assert.equal(j.en.status, 'published');
});
test('14. an invented quotation is caught even when the model does not declare it, in any quote style (incl. Nepali ‘ ’)', async () => {
  const { quoteSpans, runBundleChecks } = await import('../src/checks.js');
  assert.deepEqual(quoteSpans('She said “we expect the bridge to open soon” on Sunday; it can’t wait, the farmers’ crops'), ['we expect the bridge to open soon']); assert.deepEqual(quoteSpans("उनले ‘दशैंको रहरभन्दा हामीलाई बालीको चिन्ता छ’ भने"), ['दशैंको रहरभन्दा हामीलाई बालीको चिन्ता छ']); assert.deepEqual(quoteSpans('the “Dashain” festival'), [], 'short scare-quotes are not quotations');
  const base = { lang: 'ne', attribution: 'x: https://a.b', workflow: 'ne_original', headline: '‘दशैंको रहरभन्दा हामीलाई बालीको चिन्ता छ’' };
  const src = { text: 'नुवाकोटको थानसिङका किसानहरुलाई अहिले दशैँको रहरभन्दा पाकेको बाली जोगाउने चिन्ता ठूलो छ ।', words: 13, level: 'brief', origin: 'rss_summary', lang: 'ne' };
  const body = 'नुवाकोटका किसानले भने, ‘दशैंको रहरभन्दा हामीलाई बालीको चिन्ता छ’ भनेर।';
  const f = runBundleChecks({ ...base, ed: { headline: 'h', standfirst: 's', body }, src, quotes: [] }); assert.ok(f.some(x => x.code === 'quote_only_in_headline' && x.severity === 'error'), JSON.stringify(f.map(x => x.code)));
  const g = runBundleChecks({ ...base, ed: { headline: 'h', standfirst: 's', body: body.replace('दशैंको रहरभन्दा हामीलाई बालीको चिन्ता छ', 'हामी धेरै थकित छौं र चिन्तित') }, src, quotes: [] }); assert.ok(g.some(x => x.code === 'quote_not_in_source'), 'an invented quote that is not even in the headline');
  const h = runBundleChecks({ ...base, ed: { headline: 'h', standfirst: 's', body: 'किसानहरू बाली जोगाउने चिन्तामा छन्।' }, src, quotes: [] }); assert.ok(!h.some(x => /^quote_/.test(x.code)), 'a paraphrase without quotation marks is fine');
  const a = runBundleChecks({ ...base, lang: 'en', ed: { headline: 'h', standfirst: 's', body: 'Farmer Hari said “the harvest comes before the festival here”.' }, src: { ...src, lang: 'en', text: 'Farmer Hari said the harvest comes before the festival here.' }, quotes: [{ speaker: 'Someone Else', source_text: 'the harvest comes before the festival here' }] }); assert.ok(a.some(x => x.code === 'quote_attribution_unverified'), 'the words exist but the speaker is not named in the source: attribution is checked separately');
});
test('15. source quality is judged on more than word count, with editorial thresholds that can be changed', async () => {
  const { assessSource } = await import('../src/source_quality.js'); const w = k => Array.from({ length: k }, (_, i) => `word${i}`).join(' ') + '.'; const para = k => w(k / 2) + ' ' + w(k / 2);
  assert.equal(assessSource({ text: w(13), origin: 'rss_summary', words: 13 }).level, 'insufficient'); assert.equal(assessSource({ text: para(300), origin: 'rss_summary', words: 300 }).level, 'brief', 'an RSS summary is never "full", however long');
  assert.equal(assessSource({ text: para(300), origin: 'extracted', words: 300 }).level, 'full'); assert.equal(assessSource({ text: para(300) + ' Read more...', origin: 'extracted', words: 302 }).level, 'brief', 'truncated text is not a complete article');
  assert.equal(assessSource({ text: Array.from({ length: 30 }, () => 'Home\nNews\nSports').join('\n'), origin: 'extracted', words: 90 }).level, 'insufficient', 'navigation text'); assert.equal(assessSource({ text: para(80), origin: 'extracted', words: 80 }).level, 'brief');
  db.prepare("INSERT INTO settings(key,value) VALUES('min_brief_words','100')").run(); assert.equal(assessSource({ text: para(80), origin: 'extracted', words: 80 }).level, 'insufficient', 'thresholds are settings, not constants'); db.exec("DELETE FROM settings WHERE key='min_brief_words'");
  db.prepare("INSERT INTO settings(key,value) VALUES('require_corroboration','true')").run(); assert.equal(assessSource({ text: para(300), origin: 'extracted', words: 300 }, { sources: 1 }).level, 'insufficient'); assert.equal(assessSource({ text: para(300), origin: 'extracted', words: 300 }, { sources: 2 }).level, 'full'); db.exec("DELETE FROM settings WHERE key='require_corroboration'");
});
test('16. editorial thresholds are admin settings: validated, persisted, and they change the verdict', async () => {
  const { newsRoute } = await import('../src/news_routes.js'); const { assessSource } = await import('../src/source_quality.js'); const call = (method, path, body = {}) => newsRoute({ method }, new URL('http://x' + path), async () => body).then(r => r.body ?? r);
  assert.equal((await call('GET', '/api/editorial/settings')).min_brief_words, 40); assert.ok((await call('PUT', '/api/editorial/settings', { min_brief_words: -5 })).error || true);
  const bad = await newsRoute({ method: 'PUT' }, new URL('http://x/api/editorial/settings'), async () => ({ min_brief_words: -5 })); assert.equal(bad.code, 400);
  await call('PUT', '/api/editorial/settings', { min_brief_words: 90, edition_allow_limited: true }); const s = await call('GET', '/api/editorial/settings'); assert.equal(s.min_brief_words, 90); assert.equal(s.edition_allow_limited, true);
  const w = Array.from({ length: 80 }, (_, i) => `w${i}`).join(' ') + '. ' + 'More text here.'; assert.equal(assessSource({ text: w, origin: 'extracted', words: 83 }).level, 'insufficient'); db.exec("DELETE FROM settings WHERE key IN ('min_brief_words','edition_allow_limited')");
});
test('17. retrying a held edition regenerates it from the current evidence instead of re-using the rejected draft', async () => {
  const st = story(); responder = o => reply(o.lang === 'English' ? F.NE_ED : enOf(o)); // wrong language for English: a hard stop even after the stricter retry
  const j = await runStory(st); assert.equal(j.en.status, 'needs_review'); const bad = j.en.draft_id; assert.ok(bad);
  responder = o => reply(enOf(o)); E.retryEditionJob(j.en.id); await drain(); const after = jobs(st.cid).en; assert.equal(after.status, 'published'); assert.notEqual(after.draft_id, bad, 'a fresh draft, not the rejected one'); assert.equal(db.prepare('SELECT status FROM drafts WHERE id=?').get(bad).status, 'superseded');
});
test('18. a typo inside a real quotation is corrected to the source words and recorded; a changed quotation is never "repaired"', async () => {
  const { snapQuote, numbersIn } = await import('../src/checks.js'); const srcText = 'अधिकारीले भने, ‘जुनसुकै बेला मौसमले पाकेको धानबालीलाई दु:ख दिन सक्छ ।’ उनका अनुसार गत वर्ष झरी पर्यो।';
  assert.equal(snapQuote('जुनुकै बेला मौसमले पाकेको धानबालीलाई दु:ख दिन सक्छ', srcText), 'जुनसुकै बेला मौसमले पाकेको धानबालीलाई दु:ख दिन सक्छ'); assert.equal(snapQuote('जुनसुकै बेला मौसमले पाकेको धानबालीलाई बहुत दुःख हुन सक्छ', srcText), null, 'two words changed: not a typo'); assert.equal(snapQuote('बेला मौसमले', srcText), null, 'too short to be matched safely');
  const w = numbersIn('करिब सात सय घरपरिवारले पाँच हजार रोपनी'); assert.ok(w.has('700') && w.has('5000')); assert.ok(numbersIn('five thousand four hundred').has('5400') && numbersIn('२ लाख').has('200000') && numbersIn('2 lakh').has('200000')); assert.deepEqual([...numbersIn('Rs 45 million')], ['45'], 'million has no Nepali word, so it is left alone and both editions agree'); assert.deepEqual([...numbersIn('around seven hundred households, more than five thousand ropani')].sort(), [...numbersIn('करिब ७०० घरपरिवार, ५ हजार रोपनी')].sort(), 'words and numerals agree across languages'); assert.ok(!numbersIn('यो एक राम्रो दिन').has('1'), 'plain "one" words are still not numbers');
  // end to end: the model's quote has a one-word typo; the stored article carries the source's exact words and the draft says so
  const text = F.EN_TEXT, typo = F.EN_QUOTE.replace('bridge', 'brigde'); pageFor = () => ok200(page(F.EN_PARAS)); const st = story();
  responder = o => reply(o.lang === 'Nepali' ? F.NE_ED : { ...F.EN_ED, body: F.EN_ED.body.replace(F.EN_QUOTE, typo) }, { quotes: [{ speaker: 'Ram Bahadur Thapa', source_text: o.lang === 'Nepali' ? F.EN_QUOTE : typo }] });
  const j = await runStory(st); assert.equal(j.en.status, 'published', j.en.review_reason); const d = db.prepare("SELECT ai_draft,gen_meta,flags FROM drafts WHERE cluster_id=? AND lang='en'").get(st.cid); assert.ok(d.ai_draft.includes(F.EN_QUOTE) && !d.ai_draft.includes(typo)); assert.equal(JSON.parse(d.gen_meta).quote_corrections.length, 1); assert.ok(JSON.parse(d.flags).some(f => f.code === 'quote_corrected')); assert.ok(text.includes(F.EN_QUOTE));
});

test('19. website policy settings: an answer cut off for lack of output budget is retried once with a bigger budget; the copy tolerance is an editorial setting', async () => {
  const st = story(); let first = true; responder = o => { if (o.kind === 'edition' && first) { first = false; return { __length: true }; } return reply(enOf(o)); };
  const j = await runStory(st); assert.equal(j.en.status, 'published', j.en.review_reason); const ed = calls.filter(c => c.kind === 'edition'); assert.ok(ed.length >= 3, 'one extra request for the cut-off answer'); assert.ok(ed[1].body.max_tokens > ed[0].body.max_tokens, `budget raised ${ed[0].body.max_tokens} -> ${ed[1].body.max_tokens}`);
  const { copyErrRatio } = await import('../src/drafts.js'); assert.equal(copyErrRatio(), 0.25); db.prepare("INSERT INTO settings(key,value) VALUES('copy_error_ratio','0.4')").run(); assert.equal(copyErrRatio(), 0.4); db.exec("UPDATE settings SET value='7' WHERE key='copy_error_ratio'"); assert.equal(copyErrRatio(), 0.25, 'an invalid value falls back to the default'); db.exec("DELETE FROM settings WHERE key='copy_error_ratio'");
});
test('20. repair never publishes unrepaired text: an article made only of unsupported sentences is held as empty', async () => {
  pageFor = () => ok200(page(FARM)); const st = story(); const allBad = { ...farmEd(), body: 'The district allotted Rs 5 million and sent 300 soldiers on October 3.\n\nA spokesman said, “We will rebuild every house within nine days.”' };
  responder = o => reply(o.lang === 'Nepali' ? F.NE_ED : allBad); const j = await runStory(st); assert.equal(j.en.status, 'needs_review'); assert.equal(db.prepare("SELECT COUNT(*) n FROM publications WHERE cluster_id=? AND lang='en'").get(st.cid).n, 0); assert.ok(!db.prepare("SELECT ai_draft FROM drafts WHERE cluster_id=? AND lang='en' ORDER BY id DESC").get(st.cid).ai_draft.includes('Rs 5 million'), 'the unsupported text is not even kept in the draft');
});
