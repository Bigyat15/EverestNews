// Draft editing, quality gates and approval. One place, used by the API and by the generation worker.
import { db, now, log } from './db.js';
import { runChecks, runBundleChecks, COPY_ERR } from './checks.js';
import { renderGraphic } from './render.js';

const J = s => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
export const copyErrRatio = () => { const r = db.prepare("SELECT value FROM settings WHERE key='copy_error_ratio'").get(); const v = r ? +JSON.parse(r.value) : COPY_ERR; return v > 0 && v <= 1 ? v : COPY_ERR; }; // how much verbatim overlap with the source blocks an article (editorial setting)
export class DraftError extends Error { constructor(message, status = 400, extra = {}) { super(message); this.status = status; Object.assign(this, extra); } }
export const EXTRA_LIMITS = { standfirst: 600, graphic_headline: 120, graphic_description: 300, short_caption: 300, seo_title: 120, meta_desc: 320, alt_text: 300 };

// The value of every editable field as it stands now: the editor's edit if there is one, else what the model produced; the approved snapshot once approved.
export function effective(d) {
  const ej = J(d.edited_json) || {}, fj = J(d.final_json) || {}, ap = d.status === 'approved', opts = J(d.headline_options) || [];
  const pick = (k, fallback) => (ap ? fj[k] : ej[k]) ?? fallback;
  return {
    headline: ap ? d.final_headline : (d.edited_headline ?? opts[d.rec_idx] ?? ''), body: ap ? d.final_body : (d.edited_body ?? d.ai_draft ?? ''), caption: ap ? d.final_caption : (d.edited_caption ?? d.caption ?? ''),
    standfirst: pick('standfirst', d.long_summary ?? ''), short_caption: pick('short_caption', d.short_caption ?? ''), graphic_headline: pick('graphic_headline', d.graphic_headline ?? ''), graphic_description: pick('graphic_description', d.graphic_description ?? ''),
    seo_title: pick('seo_title', d.meta_title ?? ''), meta_desc: pick('meta_desc', d.meta_desc ?? ''), alt_text: pick('alt_text', d.alt_text ?? ''),
    keywords: pick('keywords', J(d.keywords) ?? J(d.secondary_phrases) ?? []), hashtags: pick('hashtags', J(d.hashtags) ?? []),
  };
}

// Does the graphic text fit the real template in all three formats? (layout only, nothing is exported)
export async function graphicFit(ed) {
  const out = []; if (!ed.graphic_headline?.trim()) return out; const seen = new Set();
  for (const format of ['portrait', 'square', 'landscape']) {
    const r = await renderGraphic({ format, headline: ed.graphic_headline, subheadline: ed.graphic_description ?? '' }, { dryRun: true });
    for (const w of r.warnings) if (['headline_overflow', 'headline_small', 'subheadline_truncated', 'unsupported_characters'].includes(w.code) && !seen.has(w.code)) { seen.add(w.code); out.push({ code: 'graphic_' + w.code, severity: w.severity === 'error' ? 'error' : 'warn', message: `Graphic text (${format}): ${w.message}` }); }
  }
  return out;
}

export async function recheckDraft(d) {
  const snap = J(d.source_snapshot) || {}, glossary = db.prepare('SELECT en,ne FROM glossary').all(), ed = effective(d);
  if (!d.bundle_id) return runChecks({ source: `${snap.headline ?? ''}\n${snap.text ?? ''}`, draft: ed.body, translation: d.ai_translation, headlines: [ed.headline], glossary, workflow: d.workflow, lang: d.lang }); // legacy single-language draft
  const other = db.prepare("SELECT * FROM drafts WHERE bundle_id=? AND lang<>? AND status<>'superseded' ORDER BY id DESC LIMIT 1").get(d.bundle_id, d.lang);
  const flags = runBundleChecks({ ed, other: other ? effective(other) : null, lang: d.lang, src: { text: snap.source_text ?? '', words: d.source_words ?? 0, level: d.source_level ?? 'limited', origin: snap.source_origin, otherText: snap.other_texts ?? '', lang: snap.language },
    quotes: J(d.facts_json)?.quotes ?? [], attribution: d.attribution, workflow: d.workflow, glossary, policy: snap.policy ?? null,
    copyErr: copyErrRatio(), headline: snap.headline ?? '', verified: J(d.facts_json)?.verified_facts ?? null, modelFlags: { unsupported: J(d.facts_json)?.unsupported_claims ?? [], reviewRequired: J(d.facts_json)?.review_required === true } });
  const qc = J(d.gen_meta)?.quote_corrections; if (qc?.length) flags.push({ code: 'quote_corrected', severity: 'info', message: `${qc.length} quotation(s) had a small typo and were corrected to the source's exact words: ${qc.map(c => '“' + c.to.slice(0, 40) + '…”').join(', ')}` });
  return flags.concat(await graphicFit(ed));
}
const saveFlags = (id, flags) => db.prepare('UPDATE drafts SET flags=? WHERE id=?').run(JSON.stringify(flags), id);

export async function updateDraft(id, b) {
  const d = db.prepare('SELECT * FROM drafts WHERE id=?').get(id); if (!d) throw new DraftError('not found', 404);
  if (d.status !== 'needs_review') throw new DraftError(`draft is ${d.status}; regenerate or create a new draft`, 400);
  for (const k of ['headline', 'body', 'caption']) if (typeof b[k] !== 'string' || b[k].length > 20000) throw new DraftError(`${k} must be text`);
  const ej = J(d.edited_json) || {}, changed = [];
  for (const [k, max] of Object.entries(EXTRA_LIMITS)) if (b.extra && k in b.extra) { if (typeof b.extra[k] !== 'string' || b.extra[k].length > max) throw new DraftError(`${k} must be text up to ${max} characters`); ej[k] = b.extra[k]; changed.push(k); }
  for (const [k, max] of [['keywords', 12], ['hashtags', 10]]) if (b.extra && k in b.extra) {
    if (!Array.isArray(b.extra[k]) || b.extra[k].length > max || b.extra[k].some(x => typeof x !== 'string' || x.length > 60)) throw new DraftError(`${k} must be a short list of short strings`);
    ej[k] = b.extra[k].map(x => x.trim()).filter(Boolean).map(x => (k === 'hashtags' ? '#' + x.replace(/^#+/, '').replace(/\s+/g, '') : x)); changed.push(k);
  }
  db.prepare('UPDATE drafts SET edited_headline=?,edited_body=?,edited_caption=?,edited_json=? WHERE id=?').run(b.headline, b.body, b.caption, JSON.stringify(ej), d.id);
  db.prepare('INSERT INTO draft_revisions(draft_id,at,headline,body,caption) VALUES(?,?,?,?,?)').run(d.id, now(), b.headline, b.body, b.caption);
  const fresh = db.prepare('SELECT * FROM drafts WHERE id=?').get(d.id), flags = await recheckDraft(fresh); saveFlags(d.id, flags);
  log('draft_edit', `draft ${d.id}${changed.length ? ' fields: ' + changed.join(',') : ''}`); return flags;
}

export async function approveDraft(id, { ack_errors = false } = {}) {
  const d = db.prepare('SELECT * FROM drafts WHERE id=?').get(id); if (!d) throw new DraftError('not found', 404);
  if (d.status !== 'needs_review') throw new DraftError(`draft is ${d.status}`);
  // bundle drafts are re-checked at the moment of approval (the counterpart edition may have changed); legacy drafts use the flags stored with them
  const flags = d.bundle_id ? await recheckDraft(d) : (J(d.flags) || []); if (d.bundle_id) saveFlags(d.id, flags);
  const errors = flags.filter(f => f.severity === 'error');
  if (errors.length && !ack_errors) throw new DraftError(`${errors.length} unresolved error flag(s); fix the text or acknowledge them explicitly`, 400, { flags, errors });
  const ed = effective(d); if (!ed.headline?.trim() || !ed.body?.trim()) throw new DraftError('headline and body required');
  const { headline, body, caption, ...extras } = ed;
  db.exec('BEGIN');
  try {
    db.prepare("UPDATE drafts SET status='approved',final_headline=?,final_body=?,final_caption=?,final_json=?,approved_at=? WHERE id=?").run(headline, body, caption, JSON.stringify(extras), now(), d.id);
    db.prepare("UPDATE articles SET workflow_status='approved' WHERE id=?").run(d.article_id); db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  log('draft_approved', `draft ${d.id}${errors.length ? ' (errors acknowledged: ' + errors.map(e => e.code).join(',') + ')' : ''}`); return { errors };
}
