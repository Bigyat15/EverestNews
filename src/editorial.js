import { db, now, log } from './db.js';
import { complete, getCfg } from './ai.js';
import { runChecks } from './checks.js';

export const DEFAULT_STYLE = `Write natural, standard Nepali as used in Nepali newsrooms (not Hindi-influenced). Use short, clear sentences. Keep names of people and organisations consistent; follow the glossary exactly. Keep numbers, dates, currency and attribution exactly as in the source. Present allegations as allegations (कथित/आरोप) and never state them as fact. No clickbait, no exaggeration, no promises about reach or engagement.`;
export const DEFAULT_STYLE_EN = `Write clear, neutral, standard English news copy for an international reader. Keep names of people and organisations consistent; use standard English spellings of Nepali names and places. Keep numbers, dates, currency and attribution exactly as in the source. Present allegations as allegations ("alleged", "according to") and never state them as fact. No clickbait, no exaggeration, no promises about reach or engagement.`;
export const getStyleEn = () => db.prepare("SELECT value FROM settings WHERE key='style_guide_en'").get()?.value ?? DEFAULT_STYLE_EN;
export const getStyle = () => db.prepare("SELECT value FROM settings WHERE key='style_guide'").get()?.value ?? DEFAULT_STYLE;

const MIN_SOURCE_CHARS = 120, MAX_TEXT = 6000;

export function gather(clusterId) {
  const arts = db.prepare(`SELECT a.*, s.name source FROM articles a JOIN sources s ON s.id=a.source_id WHERE a.cluster_id=?`).all(clusterId);
  if (!arts.length) throw new Error('cluster has no articles');
  const len = a => (a.full_text?.length || 0) + (a.content?.length || 0) + (a.summary?.length || 0);
  arts.sort((a, b) => len(b) - len(a));
  return { lead: arts[0], others: arts.slice(1, 3) };
}

export function buildPrompt({ lead, others }, workflow, glossary, style) {
  const text = (lead.content?.length > lead.summary?.length ? lead.content : lead.summary).slice(0, MAX_TEXT);
  const en = workflow === 'en_original' || workflow === 'ne_to_en';
  const rules = `Use ONLY the facts in the supplied source material; never invent facts, quotes, numbers or names. Preserve meaning, figures, dates, quotations and attribution; preserve uncertainty and allegations. Do not copy the source sentence by sentence: write an original, concise, attributed news summary that synthesises the supplied facts. If something is unclear, leave it out rather than guess.`;
  const keys = lang => `"draft" (original attributed ${lang} news draft, 60-150 words), "headline_options" (3-5 ${lang} headlines), "recommended_index" (0-based), "recommended_reason" (one sentence, English), "caption" (concise ${lang} social caption), "long_summary" (1-2 sentence ${lang} summary), "primary_phrase" (${lang} search phrase), "secondary_phrases" (array), "hashtags" (array, with #), "alt_text" (${lang} image alt text, descriptive and generic, do not invent what a photo shows), "meta_title" (<=60 chars), "meta_description" (<=160 chars)`;
  const system = en
    ? `You are a careful English-language news editor for an independent Nepali news publication. ${rules}\nStyle guide: ${style}\nRespond with ONE JSON object only, with keys: ${keys('English')}.`
    : `You are a careful Nepali news editor. ${rules}\nStyle guide: ${style}\nGlossary (English → Nepali, mandatory): ${glossary.map(g => `${g.en} → ${g.ne}`).join('; ') || '(none)'}\nRespond with ONE JSON object only, with keys: ${workflow === 'translate_en' ? '"translation" (faithful Nepali translation of at most the first 150 words of the source text, internal review aid), ' : ''}${keys('Nepali')}.`;
  const extra = others.map(o => `- ${o.source}: ${o.title} — ${o.summary.slice(0, 300)}`).join('\n');
  const task = { translate_en: 'English source → Nepali', ne_original: 'Nepali source → original Nepali editorial draft (do NOT translate; rewrite as original reporting-style summary)', en_original: 'English source → original English editorial draft (rewrite in your own words; do NOT copy sentences)', ne_to_en: 'Nepali source → English editorial draft (convey the facts in natural English; keep names, numbers and attribution exact)' }[workflow];
  const user = `Workflow: ${task}
Source outlet: ${lead.source}
Source URL: ${lead.url}
Published: ${lead.published_at || 'unknown'}
Original headline: ${lead.title}
Source text:
${text}
${extra ? `\nOther outlets' headlines/summaries on the same event (context only; do not merge facts that conflict, mention disagreements):\n${extra}` : ''}`;
  return { system, user };
}

export function parseModelJson(text) {
  const t = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''); let j;
  try { j = JSON.parse(t); } catch { throw new Error('model did not return valid JSON'); }
  const str = k => typeof j[k] === 'string' ? j[k].trim() : '';
  const arr = k => Array.isArray(j[k]) ? j[k].filter(x => typeof x === 'string' && x.trim()).map(x => x.trim()) : [];
  const out = { translation: str('translation'), draft: str('draft'), headlines: arr('headline_options'), rec: Number.isInteger(j.recommended_index) ? j.recommended_index : 0,
    reason: str('recommended_reason'), caption: str('caption'), long: str('long_summary'), primary: str('primary_phrase'), secondary: arr('secondary_phrases'),
    hashtags: arr('hashtags').map(h => (h.startsWith('#') ? h : '#' + h).replace(/\s+/g, '')), alt: str('alt_text'), metaTitle: str('meta_title'), metaDesc: str('meta_description') };
  if (!out.draft) throw new Error('model response missing "draft"');
  if (out.headlines.length < 3) throw new Error('model returned fewer than 3 headline options');
  if (out.rec < 0 || out.rec >= out.headlines.length) out.rec = 0;
  return out;
}

// Never fabricates: unsupported languages and thin sources are recorded as manual work, with no model call.
export async function generateDraft(clusterId, lang = 'ne') {
  if (!['ne', 'en'].includes(lang)) throw Object.assign(new Error('unsupported edition language'), { permanent: true });
  const g = gather(clusterId), { lead } = g;
  const workflow = lang === 'en' ? (lead.language === 'en' ? 'en_original' : lead.language === 'ne' ? 'ne_to_en' : null) : (lead.language === 'en' ? 'translate_en' : lead.language === 'ne' ? 'ne_original' : null);
  if (!workflow) throw Object.assign(new Error(`language "${lead.language}" is not supported; handle manually`), { permanent: true });
  const srcText = (lead.content?.length > lead.summary?.length ? lead.content : lead.summary);
  if (lead.title.length + srcText.length < MIN_SOURCE_CHARS) { db.prepare("UPDATE articles SET extraction_status='insufficient_for_drafting' WHERE id=?").run(lead.id); throw Object.assign(new Error('insufficient source text for a faithful draft (headline + summary too short); full-article extraction not yet available'), { permanent: true }); }
  const glossary = db.prepare('SELECT en,ne FROM glossary').all();
  const { system, user } = buildPrompt(g, workflow, glossary, lang === 'en' ? getStyleEn() : getStyle());
  const { text, model } = await complete({ system, user, purpose: 'draft' });
  const o = parseModelJson(text);
  const source = [lead.title, srcText].join('\n');
  const flags = runChecks({ source, draft: o.draft, translation: o.translation, headlines: o.headlines, glossary, workflow, lang });
  const snapshot = { headline: lead.title, summary: lead.summary, text: srcText.slice(0, MAX_TEXT), url: lead.url, source: lead.source, published_at: lead.published_at, language: lead.language };
  const attribution = [lead, ...g.others].map(a => `${a.source}: ${a.url}`).join('\n');
  db.exec('BEGIN');
  try {
    db.prepare("UPDATE drafts SET status='superseded' WHERE cluster_id=? AND lang=? AND status='needs_review'").run(clusterId, lang);
    const id = Number(db.prepare(`INSERT INTO drafts(cluster_id,article_id,workflow,model,created_at,source_snapshot,attribution,ai_translation,ai_draft,headline_options,rec_idx,rec_reason,caption,long_summary,primary_phrase,secondary_phrases,hashtags,alt_text,meta_title,meta_desc,flags)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(clusterId, lead.id, workflow, model, now(), JSON.stringify(snapshot), attribution, o.translation || null, o.draft, JSON.stringify(o.headlines), o.rec, o.reason, o.caption, o.long,
      o.primary, JSON.stringify(o.secondary), JSON.stringify(o.hashtags), o.alt, o.metaTitle, o.metaDesc, JSON.stringify(flags)).lastInsertRowid);
    db.prepare('UPDATE drafts SET lang=? WHERE id=?').run(lang, id);
    db.prepare("UPDATE articles SET workflow_status='needs_review' WHERE id=?").run(lead.id);
    db.exec('COMMIT'); log('draft', `draft ${id} for cluster ${clusterId} (${workflow}, ${flags.length} flags)`); return id;
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

export function enqueueDraft(clusterId, lang = 'ne') {
  db.prepare('INSERT OR IGNORE INTO ai_jobs(cluster_id,lang,run_at,created_at) VALUES(?,?,?,?)').run(clusterId, lang, now(), now());
}
export async function runAiJob() {
  const job = db.prepare("SELECT * FROM ai_jobs WHERE status='queued' AND run_at<=? ORDER BY id LIMIT 1").get(now());
  if (!job) return false;
  db.prepare("UPDATE ai_jobs SET status='running',attempts=attempts+1 WHERE id=?").run(job.id);
  try { if (job.lang === 'both') { /* two independent requests, never one translated from the other */ const { generateEdition } = await import('./editions.js'); for (const l of ['ne', 'en']) await generateEdition(job.cluster_id, l); } else await generateDraft(job.cluster_id, job.lang); db.prepare("UPDATE ai_jobs SET status='done',finished_at=?,error=NULL WHERE id=?").run(now(), job.id); }
  catch (e) {
    const retry = !e.permanent && job.attempts + 1 < (e.maxAttempts ?? 3); // invalid model output gets one retry at most, so it cannot burn credits
    db.prepare('UPDATE ai_jobs SET status=?,run_at=?,error=?,finished_at=? WHERE id=?').run(retry ? 'queued' : 'failed', new Date(Date.now() + 2 ** (job.attempts + 1) * 60000).toISOString(), e.message, retry ? null : now(), job.id);
  }
  return true;
}
