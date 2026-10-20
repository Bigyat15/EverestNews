// Content-pipeline tests: deterministic fixtures + a MOCK model. They prove our storage, gates and publication rules;
// they do NOT prove that a real model writes good Nepali. Human review remains necessary for originality and quality.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
Object.assign(process.env, { DB_PATH: ':memory:', OPENROUTER_API_KEY: 'k', TOKEN_KEY: 'c'.repeat(64), SOCIAL_MOCK: '1', PUBLIC_BASE_URL: 'https://news.example.test', EXTRACT_DELAY_MS: '0' });
const { createCanvas } = await import('@napi-rs/canvas');
const { db } = await import('../src/db.js');
const { setCfg, getCfg } = await import('../src/ai.js');
const { generateBundle, buildBundlePrompt } = await import('../src/bundle.js');
const { approveDraft, updateDraft, recheckDraft, effective, graphicFit } = await import('../src/drafts.js');
const { publishDraft } = await import('../src/pub_routes.js');
const { handleSite } = await import('../src/site.js');
const { graphicRoute } = await import('../src/graphic_routes.js');
const S = await import('../src/social.js');
const { enqueueDraft, runAiJob } = await import('../src/editorial.js');
const { _setRobotsFetcher } = await import('../src/robots.js');
const F = await import('./fixtures/content.js');

const calls = []; let reply;
const srv = http.createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => { const body = JSON.parse(b); calls.push(body); const r = reply(body); res.writeHead(r.status || 200, { 'content-type': 'application/json' }); res.end(JSON.stringify(r.json)); }); });
await new Promise(r => srv.listen(0, '127.0.0.1', r)); setCfg({ ...getCfg(), base_url: `http://127.0.0.1:${srv.address().port}/v1`, model: 'test/model', price_in: 0.1, price_out: 0.5 });
test.after(() => srv.close());
_setRobotsFetcher(async () => ({ status: 200, buf: Buffer.from('User-agent: *\nDisallow:\n') }));
const ok = obj => () => ({ json: { choices: [{ message: { content: JSON.stringify(obj) } }], usage: { prompt_tokens: 3000, completion_tokens: 2500 } } });
const ts = new Date().toISOString(); let n = 0; S.setMaxAccounts(100);
function story({ lang = 'en', title, summary, content = null, full_text = null, source = 1 }) {
  n++; const cid = Number(db.prepare('INSERT INTO clusters(created_at) VALUES(?)').run(ts).lastInsertRowid);
  const aid = Number(db.prepare('INSERT INTO articles(source_id,url,canon_url,title,title_key,language,summary,content,full_text,published_at,fetched_at,updated_at,cluster_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(source, `https://src.test/${n}`, `https://src.test/${n}`, title, 'k' + n, lang, summary, content, full_text, ts, ts, ts, cid).lastInsertRowid);
  return { cid, aid };
}
const enStory = (o = {}) => story({ lang: 'en', title: F.EN_TITLE, summary: F.EN_SUMMARY, full_text: F.EN_TEXT, ...o });
const neStory = (o = {}) => story({ lang: 'ne', title: F.NE_TITLE, summary: F.NE_SUMMARY, full_text: F.NE_TEXT, ...o });
const drafts = cid => Object.fromEntries(db.prepare("SELECT * FROM drafts WHERE cluster_id=? AND status<>'superseded' AND bundle_id IS NOT NULL").all(cid).map(d => [d.lang, d]));
const gen = async (st, resp, lastCall = true) => { reply = ok(resp); await generateBundle(st.cid); return drafts(st.cid); };
const codes = d => JSON.parse(d.flags).map(f => f.code), errs = d => JSON.parse(d.flags).filter(f => f.severity === 'error').map(f => f.code);
const pngFile = name => { const p = path.join(mkdtempSync(path.join(tmpdir(), 'pl-')), name), c = createCanvas(200, 200); c.getContext('2d').fillRect(0, 0, 200, 200); writeFileSync(p, c.toBuffer('image/jpeg')); return p; };
const page = async p => (await handleSite('GET', new URL('https://news.example.test' + p), { host: 'news.example.test' })).body?.toString?.() ?? '';
const words = t => t.split(/\s+/).filter(Boolean).length;

test('1. English RSS source → original English article + complete Nepali edition, from ONE request; fields stored separately', async () => {
  const st = enStory(), before = calls.length, d = await gen(st, F.bundle('en')); assert.equal(calls.length - before, 1, 'one request per story');
  assert.deepEqual([d.en.workflow, d.ne.workflow], ['en_original', 'translate_en']); assert.equal(d.en.bundle_id, d.ne.bundle_id); assert.equal(d.en.source_level, 'full'); assert.equal(d.en.source_words, words(F.EN_TEXT));
  assert.equal(d.en.ai_draft, F.EN_ED.body); assert.equal(d.ne.ai_draft, F.NE_ED.body); assert.match(d.ne.ai_draft, /[ऀ-ॿ]/); assert.doesNotMatch(d.en.ai_draft, /[ऀ-ॿ]/);
  for (const lang of ['en', 'ne']) { const x = d[lang], vals = [JSON.parse(x.headline_options)[0], x.long_summary, x.graphic_headline, x.graphic_description, x.caption, x.short_caption, x.meta_title, x.meta_desc]; assert.equal(new Set(vals).size, vals.length, `${lang}: every field is its own text`); assert.ok(x.ai_draft.length > 2 * x.caption.length * 0.5); }
  assert.deepEqual(errs(d.en), [], JSON.stringify(JSON.parse(d.en.flags))); assert.deepEqual(errs(d.ne), [], JSON.stringify(JSON.parse(d.ne.flags)));
  const p = calls.at(-1).messages[1].content; assert.match(p, /Primary edition language: English/); assert.match(p, new RegExp(`${words(F.EN_TEXT)} words`)); assert.match(calls.at(-1).messages[0].content, /COMPLETE rendering of the primary/);
  assert.equal(db.prepare('SELECT summary FROM articles WHERE id=?').get(st.aid).summary, F.EN_SUMMARY, 'source record untouched');
});
test('2. Nepali RSS source → original Nepali article + complete English edition', async () => {
  const st = neStory(), d = await gen(st, F.bundle('ne')); assert.deepEqual([d.ne.workflow, d.en.workflow], ['ne_original', 'ne_to_en']); assert.equal(d.ne.source_level, 'full', `source words ${d.ne.source_words}`);
  assert.deepEqual(errs(d.ne), [], JSON.stringify(JSON.parse(d.ne.flags))); assert.deepEqual(errs(d.en), [], JSON.stringify(JSON.parse(d.en.flags))); assert.match(calls.at(-1).messages[1].content, /Primary edition language: Nepali/);
  assert.notEqual(d.ne.ai_draft, d.en.ai_draft); assert.ok(d.en.ai_draft.includes('Mohana River bridge'));
});
test('3. RSS summary only → limited_source_material, never presented as a full article; padding is flagged', async () => {
  const st = enStory({ full_text: null }); db.prepare('UPDATE articles SET summary=? WHERE id=?').run('Officials said on Sunday a Rs 45 million contract was awarded to rebuild the Mohana River bridge in Kailali, which floods washed away on September 28.', st.aid);
  const short = { ...F.EN_ED, body: 'Officials said on Sunday that a Rs 45 million contract has been awarded to rebuild the Mohana River bridge in Kailali, which was washed away by floods on September 28.', standfirst: 'A Rs 45 million contract will rebuild the flood-hit Mohana River bridge in Kailali.', social_caption: 'A Rs 45 million contract has been awarded to rebuild the Mohana River bridge in Kailali, washed away by floods on September 28. {{ARTICLE_URL}} #Kailali #Nepal', graphic_description: 'A Rs 45 million contract will rebuild the flood-hit bridge in Kailali.' };
  const shortNe = { ...F.NE_ED, body: 'अधिकारीहरूका अनुसार सेप्टेम्बर २८ मा बाढीले बगाएको कैलालीको मोहना नदीको पुल पुनर्निर्माणका लागि ४५ मिलियन रुपैयाँको ठेक्का दिइएको छ।', standfirst: 'बाढीले बगाएको कैलालीको मोहना पुल ४५ मिलियन रुपैयाँमा पुनर्निर्माण हुनेछ।', social_caption: 'सेप्टेम्बर २८ मा बाढीले बगाएको कैलालीको मोहना पुल पुनर्निर्माणका लागि ४५ मिलियन रुपैयाँको ठेक्का दिइएको छ। {{ARTICLE_URL}} #कैलाली #नेपाल' };
  let d = await gen(st, F.bundle('en', { en: short, ne: shortNe, quotes: [] })); assert.equal(d.en.source_level, 'limited'); assert.ok(codes(d.en).includes('limited_source_material') && codes(d.ne).includes('limited_source_material'));
  assert.ok(!codes(d.en).includes('padding_suspected'), 'an honest short report is not flagged as padded'); assert.match(calls.at(-1).messages[0].content, /The material is LIMITED/);
  await assert.rejects(approveDraft(d.en.id), /unresolved error flag/); assert.equal(db.prepare('SELECT status FROM drafts WHERE id=?').get(d.en.id).status, 'needs_review');
  // a model that "fills out" the story with details the summary does not contain
  d = await gen(st, F.bundle('en')); assert.ok(codes(d.en).includes('padding_suspected'), 'fabricated length from a summary-only source is caught'); assert.ok(codes(d.en).includes('limited_source_material'));
  await approveDraft(d.en.id, { ack_errors: true }); assert.equal(db.prepare('SELECT status FROM drafts WHERE id=?').get(d.en.id).status, 'approved', 'only an explicit acknowledgement lets it through');
});
test('4. Full permitted material → detailed article; a thin summary of a long source is flagged as missing facts', async () => {
  const st = enStory(), d = await gen(st, F.bundle('en')); assert.ok(!codes(d.en).includes('article_too_short_for_source') && !codes(d.en).includes('article_short_for_source'));
  for (const fact of ['Rs 45 million', '320 households', 'September 28', 'Thapa', '70 percent', '12 km', 'November 10']) assert.ok(d.en.ai_draft.includes(fact), 'English edition keeps: ' + fact);
  for (const fact of ['४५ मिलियन', '३२०', '२८', 'थापा', '७०', '१२', 'नोभेम्बर १०']) assert.ok(d.ne.ai_draft.includes(fact), 'Nepali edition keeps: ' + fact);
  const thin = await gen(enStory(), F.bundle('en', { en: { body: 'A contract was awarded to rebuild the bridge in Kailali after the flood, officials said, and work will start soon on the structure for the villagers.' } }));
  assert.ok(errs(thin.en).includes('article_too_short_for_source'), JSON.stringify(codes(thin.en)));
});
test('5. Different story lengths are judged proportionally (no fixed word count)', async () => {
  const mk = nWords => Array.from({ length: Math.ceil(nWords / 25) }, (_, i) => `Paragraph ${i} reports that the district office recorded figure ${100 + i} in ward ${i + 1} as part of the Mohana bridge works, and officials gave further detail on the schedule and funding for that stage.`).join('\n\n');
  const body = (srcWords, ratio) => Array.from({ length: Math.max(2, Math.round(srcWords * ratio / 25)) }, (_, i) => `The office recorded figure ${100 + i} in ward ${i + 1} for the Mohana bridge works and described the schedule and funding for that stage in detail for readers.`).join('\n\n');
  for (const w of [150, 320, 700]) {
    const text = mk(w), st = enStory({ full_text: text }); const eds = b => ({ ...F.EN_ED, body: b, standfirst: F.EN_ED.standfirst }); const nums = [...new Set(text.match(/\d+/g))].join(' ');
    const d = await gen(st, F.bundle('en', { en: eds(body(words(text), 0.6) + '\n\nRs 45 million 320 households September 28'), ne: { ...F.NE_ED, body: body(words(text), 0.6) + '\n\nRs 45 million 320 households September 28' } }));
    assert.ok(!codes(d.en).some(c => /article_(too_)?short_for_source|padding/.test(c)), `${w}-word source, proportionate article accepted: ${codes(d.en)}`);
    assert.equal(d.en.source_level, 'full'); assert.match(calls.at(-1).messages[1].content, new RegExp(`${words(text)} words`), 'the prompt tells the model the real source size');
  }
  const long = enStory({ full_text: mk(700) }); const thin = await gen(long, F.bundle('en', { en: { body: body(700, 0.1) } })); assert.ok(errs(thin.en).includes('article_too_short_for_source'));
  assert.match(calls.at(-1).messages[0].content, /Never pad/); assert.doesNotMatch(calls.at(-1).messages[0].content, /\b\d+-\d+ words\b.*body/i);
});
test('6. website article, graphic text and social caption are stored, displayed and delivered independently', async () => {
  const st = enStory(), d = await gen(st, F.bundle('en')); const cat = 'national';
  for (const lang of ['ne', 'en']) await approveDraft(d[lang].id);
  const pe = publishDraft(d.en.id, { category: cat }), pn = publishDraft(d.ne.id, { category: cat }); assert.ok(pe.path && pn.path);
  const html = await page(pe.path), htmlNe = await page(pn.path);
  assert.ok(html.includes('We expect the bridge') && html.includes('Work to begin in November') && /<h2>Work to begin in November<\/h2>/.test(html), 'full body with subheading');
  assert.ok(!html.includes(F.EN_ED.graphic_description) && !html.includes('#FloodRecovery') && !html.includes('{{ARTICLE_URL}}'), 'graphic text and social caption never leak into the article');
  assert.ok(html.includes(F.EN_ED.standfirst), 'standfirst is its own field'); assert.ok(!html.includes(F.EN_SUMMARY), 'the raw RSS description is not shown as the article');
  assert.ok(htmlNe.includes('आगामी वर्षको वर्षाअघि') && !htmlNe.includes('We expect the bridge'), 'the Nepali page shows only the Nepali edition');
  assert.match(html, new RegExp(`hreflang="ne" href="https://news.example.test${pn.path}"`)); assert.ok(html.includes(`href="${pn.path}" hreflang="ne"`), 'switcher links to the matching edition');
  const des = (await graphicRoute({ method: 'GET' }, new URL(`http://x/api/design/${st.cid}`))).body.draft;
  assert.equal(des.graphic_headline, F.EN_ED.graphic_headline); assert.equal(des.subheadline, F.EN_ED.graphic_description); assert.notEqual(des.graphic_headline, des.headline, 'the image does not reuse the website headline');
  const acct = S.connectMockAccount('indep ' + n), g = Number(db.prepare("INSERT INTO graphics(cluster_id,draft_id,spec,headline_snapshot,subheadline_snapshot,path,format,mime,width,height,bytes,created_at) VALUES(?,?, '{}',?,?,?,'square','image/jpeg',200,200,100,?)").run(st.cid, d.en.id, F.EN_ED.graphic_headline, F.EN_ED.graphic_description, pngFile('g.jpg'), ts).lastInsertRowid);
  const pid = S.createPost({ draft_id: d.en.id, graphic_id: g, targets: [{ account_id: acct }] }); const cap = db.prepare('SELECT caption FROM post_targets WHERE post_id=?').get(pid).caption;
  assert.ok(cap.includes('Three weeks after floods') && cap.includes(`https://news.example.test${pe.path}`) && !cap.includes('{{ARTICLE_URL}}'), 'caption carries the real article URL'); assert.ok(!cap.includes(F.EN_ED.graphic_description));
  const x = db.prepare("INSERT INTO social_accounts(platform,adapter,display_name,external_id,status,created_at,updated_at) VALUES('x','mock','X test','x-test','connected',?,?)").run(ts, ts).lastInsertRowid; assert.ok(F.EN_ED.short_caption.length <= 280);
  assert.equal(S.defaultCaption(db.prepare('SELECT * FROM drafts WHERE id=?').get(d.en.id), 'x'), F.EN_ED.short_caption, 'X defaults to the short caption');
});
test('7. graphic text fits the real template in every format; overflow is caught and blocks approval', async () => {
  const d = await gen(enStory(), F.bundle('en')); for (const lang of ['en', 'ne']) assert.deepEqual((await graphicFit(effective(d[lang]))).filter(f => f.severity === 'error'), [], lang);
  const long = await gen(enStory(), F.bundle('en', { en: { graphic_headline: 'A very long graphic headline that keeps going well past anything a social template could possibly show legibly to a reader '.repeat(3) } }));
  assert.ok(errs(long.en).includes('graphic_headline_overflow'), JSON.stringify(codes(long.en))); await assert.rejects(approveDraft(long.en.id), /unresolved error flag/);
});
test('8. the caption must say more than the graphic description', async () => {
  const d = await gen(enStory(), F.bundle('en')); assert.ok(!codes(d.en).includes('caption_not_more_informative') && !codes(d.ne).includes('caption_not_more_informative'));
  assert.ok(effective(d.en).caption.length > 4 * effective(d.en).graphic_description.length);
  const lazy = await gen(enStory(), F.bundle('en', { en: { social_caption: F.EN_ED.graphic_description } })); assert.ok(codes(lazy.en).includes('caption_not_more_informative') && codes(lazy.en).includes('caption_duplicates_graphic'));
  const copy = await gen(enStory(), F.bundle('en', { en: { social_caption: F.EN_ED.body } })); assert.ok(codes(copy.en).includes('caption_copies_article'));
});
test('9. translation keeps figures, names, dates and claims; mismatches are errors', async () => {
  const bad = await gen(enStory(), F.bundle('en', { ne: { body: F.NE_ED.body.replace('३२०', '२३०') } })); assert.ok(errs(bad.ne).includes('number_not_in_source'), 'the altered figure is caught against the source, in the edition that has it'); assert.ok(codes(bad.en).includes('edition_number_mismatch') && codes(bad.ne).includes('edition_number_mismatch') && !errs(bad.en).includes('edition_number_mismatch'), 'and flagged on both editions as a warning (each edition is judged against the source on its own)');
  assert.match(JSON.parse(bad.en.flags).find(f => f.code === 'edition_number_mismatch').message, /320|230/);
  const missingPara = await gen(enStory(), F.bundle('en', { ne: { body: F.NE_ED.body.split('\n\n').slice(0, 2).join('\n\n') } })); assert.ok(codes(missingPara.ne).includes('edition_structure_mismatch'), JSON.stringify(codes(missingPara.ne)));
  const leak = await gen(enStory(), F.bundle('en', { ne: { body: F.NE_ED.body + '\n\nThe contractor said the foundation will be finished before the end of the year according to the office.' } })); assert.ok(codes(leak.ne).includes('latin_leakage') || codes(leak.ne).includes('edition_structure_mismatch'));
  const fake = await gen(enStory(), F.bundle('en', { quotes: [{ speaker: 'Ram Bahadur Thapa', source_text: 'The bridge will be finished in two weeks' }] })); assert.ok(errs(fake.en).includes('quote_not_in_source'), 'a quotation that is not in the source is an error');
  const allegation = 'Police said the man was allegedly involved in a Rs 45 million fraud, according to officials in Kailali. Police said 12 suspects may be charged next week after inquiries on September 28.';
  const hedge = await gen(story({ lang: 'en', title: 'Fraud case', summary: allegation, full_text: allegation + ' ' + F.EN_TEXT }), F.bundle('en', { en: { body: 'The man committed a Rs 45 million fraud in Kailali. Twelve suspects will be charged next week after inquiries on September 28, 320 households were affected, and the bridge work starts on November 10 with 60 workers and 70 percent of the foundation done by year end, 12 km upstream.' } }));
  assert.ok(codes(hedge.en).includes('uncertainty_lost'), 'an allegation turned into a stated fact is flagged: ' + codes(hedge.en));
});
test('10. an AI failure (provider error, invalid JSON, out of credit, truncation) leaves an existing draft untouched', async () => {
  const st = enStory(), d = await gen(st, F.bundle('en')); await updateDraft(d.en.id, { headline: 'Editor headline', body: 'Editor body text that the editor wrote by hand and wants to keep.', caption: 'Editor caption', extra: { graphic_headline: 'Editor graphic headline' } });
  const snapshot = ids => ids.map(i => JSON.stringify(db.prepare('SELECT * FROM drafts WHERE id=?').get(i))), before = snapshot([d.en.id, d.ne.id]), count = db.prepare('SELECT COUNT(*) n FROM drafts WHERE cluster_id=?').get(st.cid).n;
  for (const r of [() => ({ status: 500, json: { error: { message: 'upstream down' } } }), () => ({ json: { choices: [{ message: { content: '{not json' } }], usage: {} } }), () => ({ status: 402, json: { error: { message: 'insufficient credits' } } }), () => ({ json: { choices: [{ message: { content: '{}' }, finish_reason: 'length' }], usage: {} } })]) { reply = r; await assert.rejects(generateBundle(st.cid)); }
  assert.deepEqual(snapshot([d.en.id, d.ne.id]), before, 'drafts and the editor’s edits are byte-identical'); assert.equal(db.prepare('SELECT COUNT(*) n FROM drafts WHERE cluster_id=?').get(st.cid).n, count);
  assert.equal(JSON.parse(db.prepare('SELECT edited_json FROM drafts WHERE id=?').get(d.en.id).edited_json).graphic_headline, 'Editor graphic headline');
});
test('11. incomplete or invalid bilingual output cannot be saved or approved by accident', async () => {
  const st = enStory(); const total = db.prepare('SELECT COUNT(*) n FROM drafts').get().n;
  for (const [what, over] of [['English edition missing', { en: undefined }], ['empty Nepali body', { ne: { body: '' } }], ['empty English graphic headline', { en: { graphic_headline: '' } }], ['no caption', { ne: { social_caption: '' } }]]) {
    const resp = F.bundle('en'); if ('en' in over && over.en === undefined) delete resp.en; else for (const [k, v] of Object.entries(over)) resp[k] = { ...resp[k], ...v };
    reply = ok(resp); await assert.rejects(generateBundle(st.cid), /nothing was saved|no complete|empty/, what);
  }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM drafts').get().n, total, 'invalid output never became a draft');
  const d = await gen(enStory(), F.bundle('en')); db.prepare("UPDATE drafts SET ai_draft='' WHERE id=?").run(d.ne.id);
  await assert.rejects(approveDraft(d.ne.id), /unresolved|required/); await assert.rejects(approveDraft(d.ne.id, { ack_errors: true }), /headline and body required/, 'an empty body can never be approved, even with acknowledgement');
  db.prepare("UPDATE drafts SET status='superseded' WHERE id=?").run(d.ne.id); const fl = await recheckDraft(db.prepare('SELECT * FROM drafts WHERE id=?').get(d.en.id)); assert.equal(fl.find(f => f.code === 'edition_missing')?.severity, 'warn', 'editions are independent now: a missing counterpart is a warning, not a blocker');
});
test('12. unapproved content never reaches the public site or the social queue', async () => {
  const st = enStory(), d = await gen(st, F.bundle('en', { en: { headline: 'UNAPPROVEDMARKER headline', body: F.EN_ED.body + '\n\nUNAPPROVEDMARKER' }, ne: { headline: 'अप्रमाणितमार्कर शीर्षक' } })); const acct = S.connectMockAccount('gate ' + n);
  assert.equal(publishDraft(d.en.id, { category: 'national' }).code, 409);
  for (const p of ['/en/', '/ne/', '/en/latest', '/ne/latest', '/en/search?q=UNAPPROVEDMARKER', '/ne/search?q=' + encodeURIComponent('अप्रमाणितमार्कर'), '/sitemap.xml', '/en/category/national']) { const h = await page(p); if (p.includes('search')) assert.ok(!h.includes('/story/'), p + ': no result links'); else assert.ok(!h.includes('UNAPPROVEDMARKER') && !h.includes('अप्रमाणितमार्कर'), p); }
  assert.throws(() => S.createPost({ draft_id: d.en.id, graphic_id: null, targets: [{ account_id: acct, caption: 'x' }] }), /not approved|image/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM publications WHERE cluster_id=?').get(st.cid).n, 0); assert.equal(db.prepare('SELECT COUNT(*) n FROM posts WHERE cluster_id=?').get(st.cid).n, 0);
});
test('13. editing the graphic text makes an old graphic stale and blocks publishing and posting until it is regenerated', async () => {
  const st = enStory(), d = await gen(st, F.bundle('en', { en: { headline: 'Stale graphic scenario: bridge deal' } })), mkG = (draft, h, s) => Number(db.prepare("INSERT INTO graphics(cluster_id,draft_id,spec,headline_snapshot,subheadline_snapshot,path,format,mime,width,height,bytes,created_at) VALUES(?,?, '{}',?,?,?,'square','image/jpeg',200,200,100,?)").run(st.cid, draft, h, s, pngFile('s.jpg'), ts).lastInsertRowid);
  const g1 = mkG(d.en.id, d.en.graphic_headline, d.en.graphic_description), acct = S.connectMockAccount('stale ' + n);
  await updateDraft(d.en.id, { headline: JSON.parse(d.en.headline_options)[0], body: d.en.ai_draft, caption: d.en.caption, extra: { graphic_headline: 'Kailali bridge rebuild approved' } });
  await approveDraft(d.en.id, { ack_errors: true }); const refused = publishDraft(d.en.id, { category: 'national', graphicId: g1, ack_duplicate: true }); assert.equal(refused.code, 409); assert.match(refused.body.error, /outdated/, 'publishing refuses the stale graphic');
  assert.throws(() => S.createPost({ draft_id: d.en.id, graphic_id: g1, targets: [{ account_id: acct, caption: 'x' }] }), /outdated/, 'posting refuses it too');
  db.prepare("UPDATE graphics SET status='superseded' WHERE id=?").run(g1); const g2 = mkG(d.en.id, 'Kailali bridge rebuild approved', d.en.graphic_description);
  assert.ok(publishDraft(d.en.id, { category: 'national', graphicId: g2, ack_duplicate: true }).id, 'regenerated graphic is accepted'); assert.ok(S.createPost({ draft_id: d.en.id, graphic_id: g2, targets: [{ account_id: acct, caption: 'x' }] }));
  const g3 = mkG(d.en.id, 'Kailali bridge rebuild approved', 'Changed description only'); assert.equal(S.checkPublishable({ draft_id: d.en.id, graphic_id: g3 }).ok, false, 'a changed DESCRIPTION also makes the graphic stale');
});
test('14. an inaccessible or restricted full article never breaks drafting: it falls back to the material we already have', async () => {
  const { _setPageFetcher } = await import('../src/extract.js'); db.prepare('UPDATE sources SET fulltext_enabled=1 WHERE id=1').run();
  for (const [what, fetcher, robots] of [['403', async () => ({ status: 403, body: '', type: 'text/html' })], ['timeout', async () => { throw new Error('timeout'); }], ['paywall', async () => ({ status: 200, type: 'text/html', body: '<article><p class="paywall">Subscribe to continue reading this premium article now.</p></article>' })], ['robots', async () => { throw new Error('must not be fetched'); }, 'User-agent: *\nDisallow: /'], ['ai-input no', async () => { throw new Error('must not be fetched'); }, 'User-agent: *\nDisallow:\nContent-Signal: ai-input=no, search=yes']]) {
    _setPageFetcher(fetcher); if (robots) _setRobotsFetcher(async () => ({ status: 200, buf: Buffer.from(robots) })); else _setRobotsFetcher(async () => ({ status: 200, buf: Buffer.from('User-agent: *\nDisallow:\n') }));
    db.prepare('UPDATE sources SET ai_policy=NULL WHERE id=1').run(); const st = story({ lang: 'en', title: F.EN_TITLE, summary: F.EN_TEXT.slice(0, 400) + ' ' + 'x'.repeat(0), content: null });
    reply = ok(F.bundle('en')); if (what === 'ai-input no') { await assert.rejects(generateBundle(st.cid), /may not be used as AI input/); assert.equal(db.prepare('SELECT COUNT(*) n FROM drafts WHERE cluster_id=?').get(st.cid).n, 0, 'no AI drafting from a publisher that forbids it'); continue; }
    await generateBundle(st.cid); const d = drafts(st.cid); assert.ok(d.en && d.ne, what); assert.equal(d.en.source_level, 'limited', what + ': falls back to the RSS text, honestly labelled'); assert.ok(codes(d.en).includes('limited_source_material'));
  }
  _setPageFetcher(null === 1 ? null : async () => ({ status: 200, type: 'text/html', body: '' })); _setRobotsFetcher(async () => ({ status: 200, buf: Buffer.from('User-agent: *\nDisallow:\n') })); db.prepare('UPDATE sources SET fulltext_enabled=0,ai_policy=NULL WHERE id=1').run();
});
test('15. legacy single-language drafts still behave exactly as before', async () => {
  const st = enStory(); db.prepare("INSERT INTO drafts(cluster_id,article_id,workflow,lang,status,created_at,source_snapshot,attribution,ai_draft,headline_options,rec_idx,caption,long_summary,flags) VALUES(?,?,?,?,?,?,?,?,?,?,0,?,?,'[]')").run(st.cid, st.aid, 'translate_en', 'ne', 'needs_review', ts, '{}', 'S: https://x', 'पुरानो मस्यौदा', '["पुरानो शीर्षक"]', 'क्याप्सन', 'सारांश');
  const d = db.prepare('SELECT * FROM drafts WHERE cluster_id=? AND bundle_id IS NULL').get(st.cid); assert.equal(effective(d).headline, 'पुरानो शीर्षक'); await approveDraft(d.id); assert.equal(db.prepare('SELECT final_body FROM drafts WHERE id=?').get(d.id).final_body, 'पुरानो मस्यौदा');
});
test('AI jobs: a bundle job is one request, invalid output retries at most once, and an existing bundle is reused unless forced', async () => {
  const st = enStory(); enqueueDraft(st.cid, 'both'); const before = calls.length; reply = () => ({ json: { choices: [{ message: { content: 'garbage' } }], usage: {} } });
  db.prepare("UPDATE ai_jobs SET run_at='2000-01-01'").run(); await runAiJob(); db.prepare("UPDATE ai_jobs SET run_at='2000-01-01' WHERE cluster_id=?").run(st.cid); await runAiJob(); db.prepare("UPDATE ai_jobs SET run_at='2000-01-01' WHERE cluster_id=?").run(st.cid); await runAiJob();
  assert.equal(calls.length - before, 2, 'invalid output is attempted twice, never three times'); const j = db.prepare('SELECT status,attempts FROM ai_jobs WHERE cluster_id=? ORDER BY id DESC').get(st.cid); assert.deepEqual([j.status, j.attempts], ['failed', 2]);
  const { aiRoute } = await import('../src/ai_routes.js'); reply = ok(F.bundle('en')); const req = { method: 'POST' }; await generateBundle(st.cid);
  const r1 = await aiRoute(req, new URL('http://x/api/drafts'), async () => ({ cluster_id: st.cid })); assert.equal(r1.body.reused, true, 'no silent regeneration'); const r2 = await aiRoute(req, new URL('http://x/api/drafts'), async () => ({ cluster_id: st.cid, force: true })); assert.equal(r2.body.queued, true);
});

test('near-duplicate stories are not published as separate reports', async () => {
  const a = await gen(enStory(), F.bundle('en', { en: { headline: 'Government raises fuel prices by 5 percent across Nepal' }, ne: { headline: 'सरकारले देशभर इन्धनको मूल्य ५ प्रतिशत बढायो' } })), b = await gen(enStory(), F.bundle('en', { en: { headline: 'Government raises fuel prices across Nepal by 5 percent' }, ne: { headline: 'सरकारले इन्धनको मूल्य देशभर ५ प्रतिशत बढायो' } }));
  for (const d of [a.en, b.en, a.ne, b.ne]) await approveDraft(d.id, { ack_errors: true });
  assert.ok(publishDraft(a.en.id, { category: 'economy' }).id); const dup = publishDraft(b.en.id, { category: 'economy' }); assert.equal(dup.code, 409); assert.match(dup.body.error, /already live/); assert.equal(dup.body.duplicates.length, 1);
  assert.ok(publishDraft(b.en.id, { category: 'economy', ack_duplicate: true }).id, 'an editor can confirm it is genuinely a different story');
  assert.ok(publishDraft(a.ne.id, { category: 'economy' }).id, 'duplicate detection is per edition');
});

test('originality: a close copy of the source is an error; an honest rewrite is not; short sources are exempt', async () => {
  const copy = await gen(enStory(), F.bundle('en', { en: { body: F.EN_PARAS.join('\n\n') } })); assert.ok(errs(copy.en).includes('close_to_source_wording'), JSON.stringify(JSON.parse(copy.en.flags)));
  assert.match(JSON.parse(copy.en.flags).find(f => f.code === 'close_to_source_wording').message, /9\d% .* verbatim/); await assert.rejects(approveDraft(copy.en.id), /unresolved error flag/);
  const good = await gen(enStory(), F.bundle('en')); assert.ok(!codes(good.en).includes('close_to_source_wording'), 'an independent rewrite passes');
  const quoteOnly = await gen(enStory(), F.bundle('en')); assert.ok(!codes(quoteOnly.en).includes('close_to_source_wording'), 'a verbatim quotation is allowed to match the source');
  const ne = await gen(neStory(), F.bundle('ne', { ne: { body: F.NE_PARAS.join('\n\n') } })); assert.ok(errs(ne.ne).includes('close_to_source_wording'), 'the check works for Nepali too');
  const { copyOverlap } = await import('../src/checks.js'); assert.equal(copyOverlap('too short', F.EN_TEXT).ratio, 0);
});
test('a close copy triggers at most ONE extra request; the less-copied result is kept; failures never lose the first result', async () => {
  const copyB = F.bundle('en', { en: { body: F.EN_PARAS.join('\n\n') } }), goodB = F.bundle('en');
  let st = enStory(), before = calls.length, k = 0; reply = () => ok(k++ === 0 ? copyB : goodB)(); await generateBundle(st.cid); let d = drafts(st.cid);
  assert.equal(calls.length - before, 2); assert.match(calls.at(-1).messages[1].content, /REVISION REQUIRED: 9\d%/); assert.match(calls.at(-1).messages[1].content, /kailali|Kailali/i); assert.equal(d.en.ai_draft, F.EN_ED.body, 'the rewrite replaced the copy');
  const meta = JSON.parse(d.en.gen_meta); assert.equal(meta.requests, 2); assert.ok(meta.copy_ratio_first > 0.9); assert.deepEqual(errs(d.en), []); assert.equal(meta.usage.prompt_tokens, 6000, 'usage of both requests is recorded');
  st = enStory(); before = calls.length; reply = ok(copyB); await generateBundle(st.cid); d = drafts(st.cid); assert.equal(calls.length - before, 2, 'never a third request'); assert.ok(errs(d.en).includes('close_to_source_wording'), 'still copied → flagged for the editor');
  st = enStory(); before = calls.length; k = 0; reply = () => (k++ === 0 ? ok(copyB)() : { status: 500, json: { error: { message: 'down' } } }); await generateBundle(st.cid); d = drafts(st.cid); assert.ok(d.en && d.ne, 'the first valid result is saved even though the rewrite failed'); assert.ok(errs(d.en).includes('close_to_source_wording'));
  st = enStory(); before = calls.length; k = 0; reply = () => ok(k++ === 0 ? copyB : { not: 'a bundle' })(); await generateBundle(st.cid); assert.equal(drafts(st.cid).en.ai_draft, F.EN_PARAS.join('\n\n'), 'an invalid rewrite does not replace a valid draft');
  db.prepare("INSERT INTO settings(key,value) VALUES('rewrite_on_copy','false')").run(); st = enStory(); before = calls.length; reply = ok(copyB); await generateBundle(st.cid); assert.equal(calls.length - before, 1, 'the rewrite loop can be switched off'); db.prepare("DELETE FROM settings WHERE key='rewrite_on_copy'").run();
  st = enStory(); before = calls.length; reply = ok(goodB); await generateBundle(st.cid); assert.equal(calls.length - before, 1, 'a good first draft costs exactly one request');
});
test('captions: hashtags are added at post time when missing; missing/long captions are flagged', async () => {
  const noTags = await gen(enStory(), F.bundle('en', { en: { social_caption: F.EN_ED.social_caption.replace(/\n#.*$/, ''), hashtags: [] } })); assert.ok(codes(noTags.en).includes('caption_no_hashtags'));
  const longCap = await gen(enStory(), F.bundle('en', { en: { social_caption: F.EN_ED.social_caption + ' ' + 'More verified detail about the event. '.repeat(12) } })); assert.ok(codes(longCap.en).includes('caption_long'));
  const d = await gen(enStory(), F.bundle('en')); const row = db.prepare('SELECT * FROM drafts WHERE id=?').get(d.en.id);
  assert.ok(S.composeCaption(row, 'A caption without any tags.').caption.includes('#Kailali'), 'stored hashtags are appended'); assert.equal(S.composeCaption(row, 'Already tagged #News').caption.includes('#Kailali'), false);
  assert.ok(F.EN_ED.social_caption.includes('{{ARTICLE_URL}}') && !S.composeCaption(row, F.EN_ED.social_caption).caption.includes('{{ARTICLE_URL}}'), 'the link token never reaches a platform');
});
