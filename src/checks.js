// Deterministic QA flags. They point reviewers at risk; they do NOT prove a translation is correct.
const DEV = '०१२३४५६७८९';
// "one", "एक" and "छ" (= "is") are deliberately absent: they are everyday words and would create false numbers
const NE_NUM = { दुई: 2, तीन: 3, चार: 4, पाँच: 5, सात: 7, आठ: 8, नौ: 9, दश: 10, एघार: 11, बाह्र: 12, तेह्र: 13, चौध: 14, पन्ध्र: 15, सोह्र: 16, सत्र: 17, अठार: 18, उन्नाइस: 19, बीस: 20 };
const ENG_NUM = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const NE_MULT = { सय: 100, हजार: 1000, लाख: 100000, करोड: 10000000 }, EN_MULT = { hundred: 100, thousand: 1000, lakh: 100000, crore: 10000000 }, ONES = new Set(['एक', 'one', 'a']);
// Figures as a reader would count them, whatever the spelling: 700, ७००, "seven hundred" and "सात सय" all give 700; "५ हजार", "5 thousand" and "five thousand" all give 5000.
// A unit word before a multiplier is consumed by the group (so "seven hundred" is not also "7"); "एक", "one" and "a" count only inside such a group.
export const numbersIn = s => {
  const t = String(s).replace(/[०-९]/g, c => DEV.indexOf(c)).replace(/(?<=\d),(?=\d)/g, '').toLowerCase(), out = new Set(), toks = t.match(/\d+(?:\.\d+)?|[\p{L}\p{M}]+/gu) || [];
  const val = w => (/^\d/.test(w) ? +w : NE_NUM[w] ?? ENG_NUM[w] ?? null), mult = w => NE_MULT[w] ?? EN_MULT[w] ?? null, unit = w => val(w) ?? (ONES.has(w) ? 1 : null);
  for (let i = 0; i < toks.length; i++) {
    const m = i + 1 < toks.length ? mult(toks[i + 1]) : null, u = m != null ? unit(toks[i]) : val(toks[i]);
    if (u == null) continue;
    if (m == null) { out.add(/^\d/.test(toks[i]) ? toks[i] : String(u)); continue; }
    let total = u * m, last = m; out.add(String(total)); i++; // "पाँच हजार चार सय" -> 5000, 400 and the running total 5400
    while (i + 2 < toks.length) { const u2 = unit(toks[i + 1]), m2 = mult(toks[i + 2]); if (u2 == null || m2 == null || m2 >= last) break; total += u2 * m2; last = m2; out.add(String(u2 * m2)); out.add(String(total)); i += 2; }
  }
  return out;
};
const devRatio = s => { const l = (s.match(/\p{L}/gu) || []).length; return l ? (s.match(/[ऀ-ॿ]/g) || []).length / l : 0; };
const UNCERT_EN = /\b(alleged|allegedly|reportedly|according to|claimed|claims|suspected|likely|may|could|accused|denied)\b/i;
const UNCERT_NE = /कथित|भनिएको|अनुसार|दाबी|आशंका|शंका|सम्भावना|सक्छ|सकिन्छ|आरोप|खण्डन|अभियुक्त/;
const CURR_SRC = /\b(rs\.?|npr|usd|us\$)\b|रु\.?|रुपैयाँ|\$|डलर/i, CURR_OUT = /रु|रुपैयाँ|डलर|\$|अमेरिकी/;

export function runChecks({ source, draft, translation, headlines = [], glossary = [], workflow, lang = 'ne' }) {
  const f = []; const add = (code, severity, message) => f.push({ code, severity, message });
  const body = draft || '';
  if (body.length < 80) add('too_short', 'error', 'Draft is under 80 characters.');
  const en = lang === 'en', latinRatio = t => { const l = (t.match(/\p{L}/gu) || []).length; return l ? (t.match(/[A-Za-z]/g) || []).length / l : 0; };
  if (en) { if (latinRatio(body) < 0.8) add('not_english', 'error', `Draft is only ${(latinRatio(body) * 100).toFixed(0)}% Latin script; expected English text.`); }
  else if (devRatio(body) < 0.6) add('not_nepali', 'error', `Draft is only ${(devRatio(body) * 100).toFixed(0)}% Devanagari; expected Nepali text.`);
  for (const h of headlines) { if (en ? latinRatio(h) < 0.8 : devRatio(h) < 0.6) add(en ? 'headline_not_english' : 'headline_not_nepali', 'error', `Headline option not in ${en ? 'English' : 'Nepali'}: "${h.slice(0, 40)}"`); if (h.length > 120) add('headline_long', 'warn', `Headline over 120 characters (${h.length}).`); }
  for (const [k, t] of Object.entries({ draft: body, translation: translation || '' })) {
    if (/�/.test(t)) add('bad_unicode', 'error', `${k} contains the Unicode replacement character.`);
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(t)) add('control_chars', 'error', `${k} contains control characters.`);
    if (t !== t.normalize('NFC')) add('not_nfc', 'warn', `${k} is not NFC-normalised.`);
  }
  const srcNums = numbersIn(source), outNums = numbersIn(body + ' ' + (translation || ''));
  const missing = [...srcNums].filter(n => !outNums.has(n)), extra = [...outNums].filter(n => !srcNums.has(n));
  if (extra.length) add('number_not_in_source', 'error', `Numbers not found in the source: ${extra.join(', ')} (may be a spelled-out number or calculation; verify).`);
  if (missing.length) add('number_missing', 'warn', `Source numbers not present in the draft: ${missing.slice(0, 12).join(', ')}.`);
  if (/%|percent|प्रतिशत/.test(source) && !(en ? /%|percent/i : /%|प्रतिशत/).test(body)) add('percent_missing', 'warn', 'Source mentions a percentage that the draft omits.');
  if (CURR_SRC.test(source) && !(en ? /rs\.?|npr|usd|\$|rupee|dollar/i : CURR_OUT).test(body)) add('currency_missing', 'warn', 'Source mentions currency/amounts but the draft shows no currency.');
  if (/["“”]/.test(source) && !/["“”]/.test(body)) add('quotes_dropped', 'warn', 'Source contains quotations that the draft does not preserve.');
  if (!/["“”]/.test(source) && /["“”]/.test(body)) add('quote_not_in_source', 'error', 'Draft contains a quotation that is not in the source.');
  if ((UNCERT_EN.test(source) || UNCERT_NE.test(source)) && !(en ? UNCERT_EN : UNCERT_NE).test(body)) add('uncertainty_lost', 'warn', 'Source hedges or attributes a claim; the draft shows no hedging/attribution wording. Check allegations and conditionals.');
  if (workflow === 'translate_en' && translation && translation.length < 0.4 * Math.min(source.length, 900)) add('translation_short', 'warn', `Translation is only ${translation.length} chars vs ${Math.min(source.length, 900)} expected chars (translation covers the first ~150 words); content may be missing.`);
  if (!en) for (const g of glossary) if (source.toLowerCase().includes(g.en.toLowerCase()) && !(body + (translation || '')).includes(g.ne)) add('glossary_term', 'warn', `Glossary: "${g.en}" should appear as "${g.ne}".`);
  if (workflow === 'ne_to_en') add('names_to_verify', 'info', 'Verify the English spelling of Nepali names, places and offices.');
  if (workflow === 'translate_en') {
    const names = [...new Set((source.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+/g) || []))].slice(0, 8);
    if (names.length) add('names_to_verify', 'info', `Verify spelling of names: ${names.join('; ')}.`);
  }
  return f;
}

/* ======================= bilingual editorial bundle gates ======================= */
export const words = t => (String(t ?? '').match(/\S+/g) || []).length;
const isHeading = l => /^##\s+\S/.test(l);
export const paragraphsOf = body => String(body ?? '').split(/\n{2,}/).map(x => x.trim()).filter(Boolean);
const bodyParas = body => paragraphsOf(body).filter(p => !isHeading(p));
const headingCount = body => paragraphsOf(body).filter(isHeading).length;
const qmarks = t => (String(t ?? '').match(/["“”]/g) || []).length;
const normQ = t => String(t ?? '').toLowerCase().replace(/[“”„‟"]/g, '"').replace(/[‘’‚‛']/g, "'").replace(/\s+/g, ' ').trim();
/* ---- quotations and facts: verified against captured evidence, never against the headline or the model's own say-so ---- */
const OPEN = { '“': ['”', '"'], '„': ['“', '”'], '«': ['»'], '‘': ['’'], '"': ['"'] };
// Direct quotations in a text, whatever the quote style (Nepali newsrooms often use ‘ ’). Apostrophes (can’t, farmers’) are not quotation marks.
export function quoteSpans(text, minWords = 3) {
  const t = String(text ?? ''), out = [];
  for (let i = 0; i < t.length; i++) {
    const closers = OPEN[t[i]]; if (!closers) continue; if ((t[i] === '"' || t[i] === '‘') && /[\p{L}\p{N}]/u.test(t[i - 1] ?? '')) continue; // glued to a letter: not an opening quote
    let j = i + 1; for (; j < t.length && j - i < 500; j++) if (closers.includes(t[j]) && !(t[j] === '’' && /\p{L}/u.test(t[j + 1] ?? ''))) break;
    if (j >= t.length || j - i >= 500) continue; const inner = t.slice(i + 1, j).trim(); if (words(inner) >= minWords) out.push(inner); i = j;
  }
  return out;
}
// A quotation that differs from the source by one mistyped word (a model typo) can be corrected to the source's exact words. Anything bigger is not a typo and is never "repaired".
const editDist = (a, b) => { const m = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]); for (let j = 1; j <= b.length; j++) m[0][j] = j; for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return m[a.length][b.length]; };
export function snapQuote(span, srcText, { minWords = 5 } = {}) {
  const q = String(span ?? '').trim().split(/\s+/).filter(Boolean); if (q.length < minWords) return null; const st = String(srcText ?? '').split(/\s+/).filter(Boolean), qb = q.map(bare), sb = st.map(bare), n = q.length;
  for (let i = 0; i + n <= st.length; i++) {
    let bad = -1, cnt = 0; for (let k = 0; k < n && cnt < 2; k++) if (qb[k] !== sb[i + k]) { cnt++; bad = k; } if (cnt !== 1) continue;
    if (editDist(qb[bad], sb[i + bad]) > 2 || qb[bad].length < 3) continue;
    return st.slice(i, i + n).join(' ').replace(/^[‘’“”„«»"'\s]+/u, '').replace(/[,;:।.!?‘’“”„«»"'\s]+$/u, '').trim();
  }
  return null;
}
// Each verified fact needs an evidence snippet that really occurs in the captured source, and its statement may not carry figures the snippet lacks.
export function checkFacts(facts, srcText) {
  const hay = bare(srcText), out = [];
  for (const f of facts ?? []) {
    const ev = bare(f?.evidence), st = String(f?.statement ?? '').slice(0, 80);
    if (ev.length < 8 || !hay.includes(ev)) { out.push({ code: 'fact_not_in_source', message: `A stated fact has no matching evidence in the source: “${st}”.` }); continue; }
    const bad = [...numbersIn(String(f.statement ?? ''))].filter(n => !numbersIn(f.evidence).has(n)); if (bad.length) out.push({ code: 'fact_number_mismatch', message: `A stated fact contains figures (${bad.join(', ')}) that its own evidence does not contain: “${st}”.` });
  }
  return out;
}
// A caption is composed separately from the article: short, no new figures or quotations, and not a copy of the article or the source.
export function captionProblems(caption, body, { src = {}, lang = 'ne', quotes = [] } = {}) {
  const c = String(caption ?? ''), out = [], capLen = [...c].length, bodyLen = [...String(body ?? '')].length; if (!c.trim()) return [{ code: 'caption_empty', severity: 'error', message: 'The caption is empty.' }];
  if (bodyLen && capLen > 0.6 * bodyLen) out.push({ code: 'caption_copies_article', severity: 'warn', message: 'The social caption reproduces most of the article; it should be independently composed.' });
  else if (bodyLen && copyOverlap(c, body).ratio > 0.4) out.push({ code: 'caption_copies_article', severity: 'warn', message: 'Most of the social caption is lifted from the article text; compose it for social reading.' });
  if (src.lang === lang && src.text && copyOverlap(c, src.text, { quotes }).ratio > 0.35) out.push({ code: 'caption_copies_source', severity: 'warn', message: 'The social caption reuses long phrases from the source report.' });
  if (capLen > 900) out.push({ code: 'caption_long', severity: 'warn', message: `The social caption is ${capLen} characters; 450-900 reads best and some platforms truncate long captions.` });
  const known = numbersIn(`${body ?? ''} ${src.text ?? ''}`), fresh = [...numbersIn(c.replace(/\{\{ARTICLE_URL\}\}/g, ''))].filter(n => !known.has(n)); if (fresh.length) out.push({ code: 'caption_new_claim', severity: 'error', message: `The caption contains figures that are not in the article or source: ${fresh.join(', ')}.` });
  const ok = bare(`${body ?? ''}\n${src.text ?? ''}`); for (const q of quoteSpans(c)) if (!ok.includes(bare(q))) { out.push({ code: 'caption_unsupported_quote', severity: 'error', message: `The caption quotes words that are not in the article or source: “${q.slice(0, 50)}”.` }); break; }
  return out;
}
const bare = t => normQ(t).replace(/[\p{P}\p{S}]+/gu, ' ').replace(/\s+/g, ' ').trim(); // punctuation placement inside quotation marks varies between publishers
const toks = t => new Set(String(t ?? '').normalize('NFKC').toLowerCase().split(/[^\p{L}\p{M}\p{N}]+/u).filter(w => w.length > 1));
// share of A's words that already appear in B: a caption made of the graphic's own words is a duplicate however short
const contained = (a, b) => { let i = 0; for (const x of a) if (b.has(x)) i++; return a.size ? i / a.size : 0; };
const jacc = (a, b) => { let i = 0; for (const x of a) if (b.has(x)) i++; const u = a.size + b.size - i; return u ? i / u : 0; };
export const REQUIRED = [['headline', 'headline'], ['standfirst', 'summary/standfirst'], ['body', 'article body'], ['graphic_headline', 'graphic headline'], ['graphic_description', 'graphic description'], ['caption', 'social caption'], ['seo_title', 'SEO title'], ['meta_desc', 'meta description']];

// ed / other: the EFFECTIVE field values of this edition and its counterpart (or null). src: { text, words, level, otherText }.
export function runBundleChecks({ ed, other = null, lang, src, quotes = [], attribution = '', workflow, glossary = [], policy = null, headline = '', verified = null, modelFlags = null, copyErr = COPY_ERR }) {
  const f = []; const add = (code, severity, message) => { if (!f.some(x => x.code === code && x.message === message)) f.push({ code, severity, message }); };
  const en = lang === 'en', L = en ? 'English' : 'Nepali';
  // 1. completeness
  for (const [k, label] of REQUIRED) if (!String(ed[k] ?? '').trim()) add(`missing_${k}`, 'error', `The ${L} ${label} is missing.`);
  if (!other) add('edition_missing', 'warn', `The ${en ? 'Nepali' : 'English'} edition of this story does not exist yet, so the two editions could not be checked against each other.`);
  else for (const [k, label] of REQUIRED) if (!String(other[k] ?? '').trim()) add(`other_missing_${k}`, 'error', `The ${en ? 'Nepali' : 'English'} edition is missing its ${label}.`);
  // 2. base checks on the article body (script, numbers vs source, hedging, glossary...)
  for (const x of runChecks({ source: `${src.text}\n${src.otherText ?? ''}`, draft: ed.body ?? '', translation: '', headlines: [ed.headline ?? ''].filter(Boolean), glossary, workflow, lang })) add(x.code, x.severity, x.message);
  // 3. language leakage in every public text field
  const latinRatio = t => { const l = (String(t).match(/\p{L}/gu) || []).length; return l ? (String(t).match(/[A-Za-z]/g) || []).length / l : 0; }, devRatio = t => { const l = (String(t).match(/\p{L}/gu) || []).length; return l ? (String(t).match(/[ऀ-ॿ]/g) || []).length / l : 0; };
  for (const [k, label] of [['standfirst', 'summary'], ['graphic_headline', 'graphic headline'], ['graphic_description', 'graphic description'], ['caption', 'social caption']]) if (ed[k] && (en ? devRatio(ed[k]) > 0.05 : devRatio(ed[k]) < 0.5)) add(`${k}_wrong_language`, 'error', `The ${L} ${label} is not written in ${L}.`);
  if (en && devRatio(ed.body) > 0.02) add('devanagari_leakage', 'error', 'Devanagari text leaked into the English article.');
  if (!en && latinRatio(ed.body) > 0.12) add('latin_leakage', 'warn', `${Math.round(latinRatio(ed.body) * 100)}% of the Nepali article is Latin script; untranslated English may have leaked in.`);
  // 4. depth proportional to the real source material: never padded, never a thin summary of a long report
  const bw = words(ed.body);
  if (src.level === 'limited' || src.level === 'brief') {
    if (src.level === 'limited') add('limited_source_material', 'error', `Only a limited source was available (${src.words} words${src.origin === 'rss_summary' ? ', RSS summary only' : ''}). The article can only state what that material supports; an editor must verify or add information before publication.`);
    else add('brief_source_material', 'warn', `This is a short brief written from ${src.words} words of source material; it states only what that material supports.`);
    if (bw > Math.max(src.words * 2.2, src.words + 60)) add('padding_suspected', 'error', `The article (${bw} words) is much longer than its limited source (${src.words} words); it may contain details that are not in the source.`);
  } else if (src.words > 0) {
    const r = bw / src.words;
    if (r < 0.2) add('article_too_short_for_source', 'error', `The article (${bw} words) is far shorter than the available source material (${src.words} words); material facts are probably missing.`);
    else if (r < 0.35) add('article_short_for_source', 'warn', `The article (${bw} words) is much shorter than the source material (${src.words} words); check that important facts and context were kept.`);
  }
  if (src.lang === lang && src.words >= 60) { // (a source under 60 words leaves almost no room to differ, so the gate is not applied) the edition written from the source must be the journalist's own words, not the publisher's
    const ov = copyOverlap(ed.body, src.text, { quotes }), pct = Math.round(ov.ratio * 100);
    if (ov.ratio >= copyErr) add('close_to_source_wording', 'error', `${pct}% of the article's 7-word phrases appear verbatim in the source. This is a restructured copy, not original writing; rewrite it in your own words and sentence structure.`);
    else if (ov.ratio >= COPY_WARN) add('close_to_source_wording', 'warn', `${pct}% of the article's 7-word phrases appear verbatim in the source; consider rewording the closest passages.`);
  }
  if (bw && bodyParas(ed.body).length < 2 && bw > 90) add('single_paragraph', 'warn', 'A long article should be split into paragraphs.');
  // 5. cross-edition consistency
  if (other?.body) {
    const na = numbersIn(`${ed.body} ${ed.standfirst ?? ''}`), nb = numbersIn(`${other.body} ${other.standfirst ?? ''}`), onlyHere = [...na].filter(x => !nb.has(x)), onlyThere = [...nb].filter(x => !na.has(x));
    if (onlyHere.length || onlyThere.length) add('edition_number_mismatch', 'warn', `Figures differ between the editions (each edition is still checked against the source on its own). Only in this edition: ${onlyHere.join(', ') || '—'}; only in the other: ${onlyThere.join(', ') || '—'}.`);
    const ob = words(other.body), ratio = ob ? bw / ob : 0; if (ob && (ratio < 0.5 || ratio > 2)) add('edition_length_mismatch', 'warn', `The editions differ greatly in length (${bw} vs ${ob} words); one may be incomplete.`);
    const pa = bodyParas(ed.body).length, pb = bodyParas(other.body).length; if (Math.abs(pa - pb) > Math.max(2, 0.4 * Math.max(pa, pb))) add('edition_structure_mismatch', 'warn', `The editions have different structure (${pa} vs ${pb} paragraphs); a section may be missing.`);
    if (headingCount(ed.body) !== headingCount(other.body)) add('edition_heading_mismatch', 'warn', 'The editions have a different number of subheadings.');
    if (Math.abs(qmarks(ed.body) - qmarks(other.body)) >= 2) add('edition_quote_mismatch', 'warn', 'The editions contain a different number of quotations.');
  }
  // 6. quotations and facts must be traceable to the captured source text; the headline and the model's own claims are not evidence
  const hay = bare(`${src.text}\n${src.otherText ?? ''}`), headN = bare(headline), cross = !!src.lang && src.lang !== lang;
  const missingCode = t => (headN && bare(t).length > 8 && headN.includes(bare(t)) ? 'quote_only_in_headline' : 'quote_not_in_source');
  const where = t => (missingCode(t) === 'quote_only_in_headline' ? 'appears only in the headline, which is not evidence of what anyone said' : 'was not found in the source text');
  for (const q of quotes) if (q?.source_text) {
    if (!hay.includes(bare(q.source_text))) add(missingCode(q.source_text), 'error', `A quotation attributed to ${q.speaker || 'a speaker'} ${where(q.source_text)}: “${String(q.source_text).slice(0, 60)}…”`);
    else if (q.speaker && !cross) { const names = [...toks(q.speaker)].filter(w => w.length > 2); if (names.length && !names.some(w => hay.includes(w))) add('quote_attribution_unverified', 'error', `The speaker "${String(q.speaker).slice(0, 40)}" is not named anywhere in the source.`); }
  }
  const spans = quoteSpans(ed.body), declared = quotes.map(q => bare(q?.source_text)).filter(Boolean);
  if (cross) { if (spans.length > quotes.length) add('quote_not_in_source', 'error', 'A translated edition uses quotation marks for words that are not a verified quotation from the source.'); }
  else for (const sp of spans) if (!hay.includes(bare(sp)) && !declared.some(d => d.includes(bare(sp)) || bare(sp).includes(d))) add(missingCode(sp), 'error', `The article quotes words that ${where(sp)}: “${sp.slice(0, 60)}…”`);
  if (verified) for (const p of checkFacts(verified, src.text)) add(p.code, 'error', p.message); else add('facts_not_traced', 'info', 'The model did not list evidence for its facts; figures and names were checked against the source only.');
  if (modelFlags && (modelFlags.unsupported?.length || modelFlags.reviewRequired)) add('model_flagged_unsupported', 'error', `The model reported claims it could not support${modelFlags.unsupported?.length ? ': ' + modelFlags.unsupported.slice(0, 3).join('; ') : ''}.`);
  // 7. graphic text and social caption are their own pieces of writing
  if (ed.graphic_headline && norm0(ed.graphic_headline) === norm0(ed.headline)) add('graphic_reuses_headline', 'warn', 'The graphic headline is identical to the website headline; write it for the image.');
  if ([...(ed.graphic_headline ?? '')].length > 80) add('graphic_headline_long', 'warn', 'The graphic headline is long for the template.');
  if ([...(ed.graphic_description ?? '')].length > 200) add('graphic_description_long', 'warn', 'The graphic description is long for the template.');
  const capLen = [...(ed.caption ?? '')].length, descLen = [...(ed.graphic_description ?? '')].length;
  if (ed.caption && descLen && capLen < descLen * 1.8) add('caption_not_more_informative', 'warn', 'The social caption is not substantially more informative than the graphic description.');
  if (ed.caption && contained(toks(ed.caption), new Set([...toks(ed.graphic_description), ...toks(ed.graphic_headline)])) > 0.75) add('caption_duplicates_graphic', 'warn', 'The social caption just repeats the graphic text.');
  if (ed.caption) for (const p of captionProblems(ed.caption, ed.body, { src, lang, quotes })) if (p.code !== 'caption_long') add(p.code, p.severity, p.message);
  if (ed.caption && capLen > 900) add('caption_long', 'warn', `The social caption is ${capLen} characters; 450-900 reads best and some platforms truncate long captions.`);
  if (ed.caption && !/[#＃]\S/.test(ed.caption) && !(ed.hashtags ?? []).length) add('caption_no_hashtags', 'warn', 'The caption has no hashtags and none are stored for this edition.');
  if (ed.caption && !ed.caption.includes('{{ARTICLE_URL}}')) add('caption_no_link_token', 'info', 'The caption has no {{ARTICLE_URL}} marker, so the article link will be appended when posting.');
  if ([...(ed.short_caption ?? '')].length > 270) add('short_caption_long', 'warn', 'The short caption is too long for X (280 characters including the link).');
  if ([...(ed.seo_title ?? '')].length > 65) add('seo_title_long', 'warn', 'The SEO title is longer than 65 characters; search engines will truncate it.');
  if ([...(ed.meta_desc ?? '')].length > 160) add('meta_desc_long', 'warn', 'The meta description is longer than 160 characters; search engines will truncate it.');
  if ((ed.hashtags ?? []).length > 6) add('too_many_hashtags', 'warn', 'More than 6 hashtags.');
  if ((ed.keywords ?? []).length < 3) add('few_keywords', 'warn', 'Add at least 3 keywords for SEO.');
  // 8. provenance and source terms
  if (!/https?:\/\/\S+/.test(attribution)) add('missing_provenance', 'error', 'No source URL is recorded for this story.');
  if (policy?.aiInput === 'no') add('source_restricts_ai_use', 'error', 'This publisher declares in robots.txt that its content may not be used as AI input. Do not publish AI-assisted text from it without the publisher’s permission.');
  return f;
}
/* ---- near-copy detection: share of the output's 7-word phrases that appear verbatim in the source (quotations excluded) ---- */
export const COPY_WARN = 0.12, COPY_ERR = 0.25, SHINGLE = 7; // calibrated on real output: an unconstrained model copied 67%; the strict prompt still copied 28%
const wordList = t => String(t ?? '').toLowerCase().replace(/^##\s+.*$/gm, ' ').split(/[^\p{L}\p{M}\p{N}]+/u).filter(Boolean);
export function copyOverlap(out, srcText, { n = SHINGLE, quotes = [] } = {}) {
  let o = String(out ?? ''); for (const q of quotes) if (q?.source_text) o = o.split(q.source_text).join(' '); // verbatim quotations are legitimate
  const ow = wordList(o), sw = wordList(srcText); if (ow.length < n + 10) return { ratio: 0, shingles: 0, phrases: [] };
  const set = new Set(); for (let i = 0; i + n <= sw.length; i++) set.add(sw.slice(i, i + n).join(' '));
  let hit = 0, total = 0, last = -99; const phrases = [];
  for (let i = 0; i + n <= ow.length; i++) { total++; const sh = ow.slice(i, i + n).join(' '); if (set.has(sh)) { hit++; if (phrases.length < 10 && i - last >= n) { phrases.push(sh); last = i; } } }
  return { ratio: total ? hit / total : 0, shingles: total, phrases };
}
const norm0 = t => String(t ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
