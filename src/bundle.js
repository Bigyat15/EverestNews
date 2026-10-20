// One structured request per story -> both complete editions (Nepali + English), the separate graphic text and the separate social caption.
import { randomUUID } from 'node:crypto';
import { db, now, log } from './db.js';
import { complete, getCfg } from './ai.js';
import { gather, getStyle, getStyleEn } from './editorial.js';
import { extractFullText, sourceTextFor } from './extract.js';
import { robotsDecision } from './robots.js';
import { recheckDraft } from './drafts.js';
import { copyOverlap, COPY_ERR } from './checks.js';

export class BundleError extends Error { constructor(message, opts = {}) { super(message); Object.assign(this, opts); } }
const MAX_SRC = 14000, OTHER_CHARS = 1200, LANG_NAME = { ne: 'Nepali', en: 'English' };
const strOf = v => (typeof v === 'string' ? v.trim() : ''), arrOf = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim()) : []);

// What the publisher's robots.txt says about AI use of its content (cached on the source row for a day).
export async function sourcePolicy(sourceId) {
  const s = db.prepare('SELECT feed_url, ai_policy FROM sources WHERE id=?').get(sourceId), cached = s?.ai_policy ? JSON.parse(s.ai_policy) : null;
  if (cached && Date.now() - Date.parse(cached.checkedAt) < 864e5) return cached;
  const d = await robotsDecision(s.feed_url); if (!d.known) return cached ?? { aiInput: null, aiTrain: null, search: null, checkedAt: null };
  const p = { ...d.signals, checkedAt: now() }; db.prepare('UPDATE sources SET ai_policy=? WHERE id=?').run(JSON.stringify(p), sourceId); return p;
}

export function buildBundlePrompt({ lead, others, src, truncated, glossary }) {
  const primary = lead.language, secondary = primary === 'ne' ? 'en' : 'ne', P = LANG_NAME[primary], S = LANG_NAME[secondary];
  const ed = `{ "headline": "", "headline_alternatives": ["", ""], "standfirst": "", "body": "paragraphs separated by a blank line; optional subheadings as lines starting with '## '", "graphic_headline": "", "graphic_description": "", "social_caption": "", "short_caption": "", "seo_title": "", "meta_description": "", "keywords": [""], "hashtags": ["#"], "alt_text": "" }`;
  const system = `You are the senior editor of Everest News, an independent Nepali news publication with a Nepali edition and an English edition. You write ORIGINAL news reports from the source material you are given.

SOURCE RULES
- Use ONLY the supplied source material. No outside knowledge; no assumptions about causes, motives, background or consequences that the source does not state.
- Never invent or alter names, titles, places, dates, numbers, quotations or sources. Keep every figure exactly. Write figures, amounts and dates as numerals.
- Preserve uncertainty: allegations stay allegations; attribute claims to whoever made them ("according to ...", "police said").
- Quotation marks: use them ONLY for a statement that appears in the source, attributed to its speaker. List every such quotation in "quotes" with the speaker and the words exactly as they appear in the source text ("source_text"). Anything else must be paraphrased WITHOUT quotation marks.
- ORIGINALITY: do not copy. No run of 6 or more consecutive words may be taken from the source, except names, official titles, defined terms and quotations. First decide the story's key points, then write them in your own words and sentence structure: combine facts from different paragraphs, change the order, vary the vocabulary. Re-ordering paragraphs while keeping the publisher's sentences is NOT acceptable, and neither is swapping a few synonyms.
- Other outlets are context only: use a fact from them only if it does not contradict the main source, and attribute anything that differs to that outlet.

DEPTH
- The main source has ${src.words} words (${src.origin.replace('_', ' ')}). Cover every material fact it contains, with proportionate context. A long, detailed source deserves a detailed, well-structured article; a short source deserves a short report. Never pad and never speculate to add length.
- ${src.level === 'limited' ? 'The material is LIMITED. Write only what it supports, plainly and briefly. Do not add background or explanation that is not in it.' : 'The material is substantial. Do not reduce it to a short summary: keep the chronology, figures, names, quotations and context that matter.'}

STRUCTURE (each edition)
- headline: clear, factual, no clickbait. headline_alternatives: 2-3 different options. standfirst: 1-2 sentences. body: a lead paragraph (who, what, when, where), then body paragraphs; for 6 or more paragraphs add a few short subheadings as lines starting with "## ".
- The PRIMARY edition is in the source language (${P}); write it first. The SECONDARY edition (${S}) must be a COMPLETE rendering of the primary edition: the same facts, the same figures, the same paragraphs and subheadings, natural ${S} idiom rather than word-for-word. Do not omit anything and do not add anything.
- Nepali: natural, professional newsroom Nepali in Devanagari with Devanagari numerals; no unnecessary English words; no Hindi-influenced phrasing. Style: ${getStyle()}${glossary.length ? `\\n  Glossary (mandatory): ${glossary.map(g => `${g.en} → ${g.ne}`).join('; ')}` : ''}
- English: natural, professional newsroom English. Style: ${getStyleEn()}

SOCIAL (each edition; these are separate pieces of writing, NOT the website text)
- graphic_headline: at most 60 characters, punchy, different wording from the headline. graphic_description: ONE sentence, at most 130 characters, stating the central development.
- social_caption: 450-900 characters (hard limit 900). A strong first sentence; what happened; the key verified facts, figures, dates and places; why it matters ONLY if the source says so; then, on its own line, the exact token {{ARTICLE_URL}}; then 3-5 relevant hashtags. It must add information beyond the graphic text and must not reproduce the article.
- short_caption: at most 230 characters for X, with the key fact, no link, at most 2 hashtags.
- seo_title (at most 60 characters), meta_description (at most 155), keywords (4-8), hashtags (3-6, starting with #), alt_text (a generic description of a news graphic; never invent what a photograph shows).

OUTPUT: exactly one JSON object and nothing else:
{ "source_assessment": { "sufficient": true, "gaps": [] }, "facts": [ { "kind": "number|date|name|place|claim", "value": "as written in the source" } ], "quotes": [ { "speaker": "", "source_text": "" } ], "${primary}": ${ed}, "${secondary}": ${ed} }`;
  const extra = others.map(o => `- ${o.source}: ${o.title}${o.text ? ' — ' + o.text : ''}`).join('\n');
  const user = `Primary edition language: ${P} (the language of the main source)
Main source outlet: ${lead.source}
URL: ${lead.url}
Published: ${lead.published_at || 'unknown'}${lead.author ? `\nAuthor: ${lead.author}` : ''}
Original headline: ${lead.title}
Source text: ${src.origin.replace('_', ' ')}, ${src.words} words${truncated ? ' (truncated to fit)' : ''}
=== MAIN SOURCE TEXT ===
${src.text.slice(0, MAX_SRC)}
=== END ===
${extra ? `\nOther outlets covering the same event (context only):\n${extra}` : ''}`;
  return { system, user };
}

export function parseBundleJson(text) {
  const t = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''); let j;
  try { j = JSON.parse(t); } catch { throw new BundleError('model did not return valid JSON', { maxAttempts: 2 }); }
  const out = { assessment: j.source_assessment ?? null, facts: Array.isArray(j.facts) ? j.facts.slice(0, 40) : [], quotes: Array.isArray(j.quotes) ? j.quotes.filter(q => q && typeof q.source_text === 'string').slice(0, 20) : [] };
  for (const lang of ['ne', 'en']) {
    const o = j[lang]; if (!o || typeof o !== 'object') throw new BundleError(`the response has no complete "${lang}" edition`, { maxAttempts: 2 });
    const e = { headline: strOf(o.headline), alternatives: arrOf(o.headline_alternatives), standfirst: strOf(o.standfirst), body: strOf(o.body), graphic_headline: strOf(o.graphic_headline), graphic_description: strOf(o.graphic_description), social_caption: strOf(o.social_caption), short_caption: strOf(o.short_caption),
      seo_title: strOf(o.seo_title), meta_description: strOf(o.meta_description), keywords: arrOf(o.keywords), hashtags: arrOf(o.hashtags).map(h => '#' + h.replace(/^#+/, '').replace(/\s+/g, '')), alt_text: strOf(o.alt_text) };
    for (const k of ['headline', 'standfirst', 'body', 'graphic_headline', 'graphic_description', 'social_caption', 'seo_title', 'meta_description']) if (!e[k]) throw new BundleError(`the "${lang}" edition has an empty ${k}; nothing was saved`, { maxAttempts: 2 });
    out[lang] = e;
  }
  return out;
}

export async function generateBundle(clusterId) {
  const g = gather(clusterId); let lead = g.lead;
  if (!['ne', 'en'].includes(lead.language)) throw Object.assign(new Error(`The source language "${lead.language}" has no tested translation path; send this story to an editor for manual handling.`), { permanent: true });
  const policy = await sourcePolicy(lead.source_id);
  if (policy.aiInput === 'no') throw Object.assign(new Error(`${lead.source} declares in robots.txt that its content may not be used as AI input. AI drafting from it is blocked; write it manually or get the publisher's permission.`), { permanent: true });
  try { await extractFullText(lead.id); } catch (e) { log('extract_error', `article ${lead.id}: ${e.message}`); } // never fatal: we fall back to what we already have
  lead = { ...lead, ...db.prepare('SELECT full_text, author, extraction_status FROM articles WHERE id=?').get(lead.id) };
  const src = sourceTextFor(lead);
  if (lead.title.length + src.text.length < 120) { db.prepare("UPDATE articles SET extraction_status='insufficient_for_drafting' WHERE id=?").run(lead.id); throw Object.assign(new Error('insufficient source text for a faithful article (headline + summary too short)'), { permanent: true }); }
  const others = []; let otherText = '';
  for (const o of g.others) { const pol = await sourcePolicy(o.source_id).catch(() => ({})); const t = pol.aiInput === 'no' ? '' : sourceTextFor(o).text.slice(0, OTHER_CHARS); others.push({ source: o.source, title: o.title, text: t }); otherText += '\n' + o.title + '\n' + t; }
  const glossary = db.prepare('SELECT en,ne FROM glossary').all(), truncated = src.text.length > MAX_SRC;
  const { system, user } = buildBundlePrompt({ lead, others, src, truncated, glossary }), cfg = getCfg();
  let r = await complete({ system, user, purpose: 'bundle', maxTokens: cfg.max_tokens_bundle }), b = parseBundleJson(r.text), requests = 1;
  // Originality: if the primary edition is a close copy of the source, spend at most ONE more request asking for a real rewrite; keep whichever result is less copied.
  const first = copyOverlap(b[lead.language].body, src.text, { quotes: b.quotes }), rewriteOn = (() => { const v = db.prepare("SELECT value FROM settings WHERE key='rewrite_on_copy'").get(); return v ? JSON.parse(v.value) !== false : true; })();
  if (rewriteOn && first.ratio >= COPY_ERR) {
    try {
      const note = `\n\nREVISION REQUIRED: ${Math.round(first.ratio * 100)}% of the 7-word phrases in your previous ${LANG_NAME[lead.language]} article were copied verbatim from the source. Write BOTH editions again from scratch: restate every fact in your own words and sentence structure, merge and reorder points, vary the vocabulary, and do not reuse any run of 6+ consecutive words from the source (except names, official titles and quoted statements). Phrases you copied last time, which you must not repeat:\n${first.phrases.map(p => '- ' + p).join('\n')}`;
      const r2 = await complete({ system, user: user + note, purpose: 'bundle_rewrite', maxTokens: cfg.max_tokens_bundle }), b2 = parseBundleJson(r2.text), second = copyOverlap(b2[lead.language].body, src.text, { quotes: b2.quotes });
      requests = 2; if (second.ratio < first.ratio) { r = { ...r2, usage: { prompt_tokens: (r.usage?.prompt_tokens ?? 0) + (r2.usage?.prompt_tokens ?? 0), completion_tokens: (r.usage?.completion_tokens ?? 0) + (r2.usage?.completion_tokens ?? 0) } }; b = b2; } // else keep the first, still flagged by the gate
    } catch (e) { log('bundle_rewrite_failed', e.message); } // the first valid result is never lost
  }
  const primary = lead.language, bundleId = randomUUID(), attribution = [lead, ...g.others].map(a => `${a.source}: ${a.url}`).join('\n');
  const snapshot = { headline: lead.title, summary: lead.summary, text: src.text.slice(0, 6000), source_text: src.text.slice(0, MAX_SRC), source_origin: src.origin, other_texts: otherText, url: lead.url, source: lead.source, published_at: lead.published_at, language: lead.language, author: lead.author ?? null, policy, truncated };
  const meta = { model: r.model, usage: r.usage, max_tokens: cfg.max_tokens_bundle, at: now(), requests, copy_ratio_first: +first.ratio.toFixed(3) }, ids = {};
  db.exec('BEGIN');
  try {
    for (const lang of ['ne', 'en']) {
      const e = b[lang], workflow = lang === 'en' ? (primary === 'en' ? 'en_original' : 'ne_to_en') : (primary === 'en' ? 'translate_en' : 'ne_original');
      db.prepare("UPDATE drafts SET status='superseded' WHERE cluster_id=? AND lang=? AND status='needs_review'").run(clusterId, lang);
      const row = { cluster_id: clusterId, article_id: lead.id, workflow, lang, status: 'needs_review', model: r.model, created_at: now(), source_snapshot: JSON.stringify(snapshot), attribution, ai_draft: e.body, headline_options: JSON.stringify([e.headline, ...e.alternatives]), rec_idx: 0, rec_reason: 'Primary headline',
        caption: e.social_caption, long_summary: e.standfirst, primary_phrase: e.keywords[0] ?? null, secondary_phrases: JSON.stringify(e.keywords), hashtags: JSON.stringify(e.hashtags), alt_text: e.alt_text, meta_title: e.seo_title, meta_desc: e.meta_description,
        flags: JSON.stringify([{ code: 'checks_pending', severity: 'error', message: 'Quality checks have not finished.' }]), bundle_id: bundleId, source_level: src.level, source_words: src.words, graphic_headline: e.graphic_headline, graphic_description: e.graphic_description,
        short_caption: e.short_caption, keywords: JSON.stringify(e.keywords), facts_json: JSON.stringify({ facts: b.facts, quotes: b.quotes, assessment: b.assessment }), gen_meta: JSON.stringify(meta) };
      const cols = Object.keys(row); // placeholders are derived from the column list so they can never get out of step
      ids[lang] = Number(db.prepare(`INSERT INTO drafts(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`).run(...cols.map(c => row[c])).lastInsertRowid);
    }
    db.prepare("UPDATE articles SET workflow_status='needs_review' WHERE id=?").run(lead.id); db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  for (const lang of ['ne', 'en']) { const flags = await recheckDraft(db.prepare('SELECT * FROM drafts WHERE id=?').get(ids[lang])); db.prepare('UPDATE drafts SET flags=? WHERE id=?').run(JSON.stringify(flags), ids[lang]); }
  log('bundle', `cluster ${clusterId}: drafts ${ids.ne}/${ids.en} (${src.level}, ${src.words} source words, ${r.usage?.prompt_tokens ?? '?'}→${r.usage?.completion_tokens ?? '?'} tokens)`);
  return { bundleId, ids, level: src.level };
}
