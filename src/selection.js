// Hourly best-story selection. It reuses rankClusters (importance, recency, corroboration, credibility) and only decides WHICH story,
// when, and exactly once. It never publishes anything: a selected story still needs drafts, human approval and an editor's publish action.
import { db, now, log } from './db.js';
import { rankClusters } from './rank.js';
import { clusterNew, tokens, jaccard } from './cluster.js';
import { genericImage } from './images.js';
import { enqueueDraft } from './editorial.js';
import { queueStory } from './editions.js';

export const DEFAULTS = { select_window_min: 60, select_grace_min: 5, select_min_score: 65, select_min_sources: 1, select_lateness_h: 6, select_dup_similarity: 0.6, select_auto_draft: false, select_tz_offset_min: 345 };
const stored = k => { const r = db.prepare('SELECT value FROM settings WHERE key=?').get(k); return r ? JSON.parse(r.value) : undefined; };
const envNum = k => (process.env[k] !== undefined && Number.isFinite(+process.env[k]) ? +process.env[k] : undefined);
// precedence: environment (tests / demos) > settings table (Admin) > defaults
export function cfg() {
  const g = (k, env) => envNum(env) ?? stored(k) ?? DEFAULTS[k];
  return { windowMin: g('select_window_min', 'SELECT_WINDOW_MIN'), graceMin: g('select_grace_min', 'SELECT_GRACE_MIN'), minScore: g('select_min_score', 'SELECT_MIN_SCORE'), minSources: g('select_min_sources', 'SELECT_MIN_SOURCES'),
    latenessH: g('select_lateness_h', 'SELECT_LATENESS_H'), dupSim: g('select_dup_similarity', 'SELECT_DUP_SIM'), tzOffsetMin: g('select_tz_offset_min', 'SELECT_TZ_OFFSET_MIN'), autoDraft: process.env.SELECT_AUTO_DRAFT !== undefined ? process.env.SELECT_AUTO_DRAFT === '1' : (stored('select_auto_draft') ?? DEFAULTS.select_auto_draft) };
}
// The most recent window that has CLOSED at `nowMs`. Windows are aligned to the Nepal wall clock (UTC+5:45) so "hourly" means :00 NST.
export function slotFor(nowMs, windowMin, tzOffsetMin = 345) {
  const w = windowMin * 60000, off = tzOffsetMin * 60000, end = Math.floor((nowMs + off) / w) * w - off; return { start: end - w, end };
}
const iso = ms => new Date(ms).toISOString();

// Choose the best qualifying story that FIRST APPEARED in [start, end). Pure with respect to the database snapshot; no side effects.
export function pickForWindow(startMs, endMs, c = cfg()) {
  const startIso = iso(startMs), endIso = iso(endMs), ranked = rankClusters(endMs, { asOf: endIso });
  const taken = new Set(db.prepare("SELECT cluster_id FROM selections WHERE status='selected'").all().map(r => r.cluster_id));
  const recent = db.prepare("SELECT s.cluster_id id, (SELECT title FROM articles WHERE cluster_id=s.cluster_id ORDER BY length(summary) DESC LIMIT 1) title FROM selections s WHERE s.status='selected' AND s.slot_start>=?").all(iso(endMs - 48 * 36e5)).map(r => ({ ...r, tk: tokens(r.title ?? '') }));
  const pending = db.prepare("SELECT a.cluster_id ac, b.cluster_id bc FROM cluster_candidates c JOIN articles a ON a.id=c.a_id JOIN articles b ON b.id=c.b_id WHERE c.status='pending'").all();
  // website publication does not matter here; a story already delivered (or queued) to social does
  const posted = new Set(db.prepare("SELECT DISTINCT p.cluster_id FROM posts p JOIN post_targets t ON t.post_id=p.id WHERE t.status IN ('queued','publishing','published','unknown')").all().map(r => r.cluster_id));
  const skipped = {}; const skip = (why) => { skipped[why] = (skipped[why] ?? 0) + 1; };
  const eligible = [];
  for (const k of ranked) {
    if (k.rejected) { skip('rejected'); continue; } if (posted.has(k.id)) { skip('already_posted_socially'); continue; } if (taken.has(k.id)) { skip('already_selected'); continue; }
    if (!(k.firstSeen >= startIso && k.firstSeen < endIso)) { skip('not_first_seen_in_window'); continue; } // late arrivals belong to the window in which they arrived
    if (k.latest < iso(startMs - c.latenessH * 36e5)) { skip('too_old'); continue; }                        // a feed backlog is not "news of the last hour"
    if (!['ne', 'en'].includes(k.lead.language)) { skip('unsupported_language'); continue; }
    const pol = db.prepare('SELECT s.ai_policy FROM articles a JOIN sources s ON s.id=a.source_id WHERE a.id=?').get(k.lead.id)?.ai_policy; if (pol && JSON.parse(pol).aiInput === 'no') { skip('publisher_forbids_ai_use'); continue; }
    const tk = tokens(k.lead.title); if (recent.some(r => r.id !== k.id && jaccard(tk, r.tk) >= c.dupSim) || pending.some(p => (p.ac === k.id && taken.has(p.bc)) || (p.bc === k.id && taken.has(p.ac)))) { skip('duplicate_coverage'); continue; }
    eligible.push(k);
  }
  const qualifying = eligible.filter(k => k.score >= c.minScore && k.sources >= c.minSources);
  const order = (a, b) => b.pinned - a.pinned || b.score - a.score || b.sources - a.sources || (a.firstSeen < b.firstSeen ? -1 : a.firstSeen > b.firstSeen ? 1 : 0) || a.id - b.id; // fully deterministic
  qualifying.sort(order); eligible.sort(order);
  const best = qualifying[0] ?? null;
  return { best, eligible: eligible.length, skipped, bestBelow: !best && eligible[0] ? { id: eligible[0].id, score: eligible[0].score, sources: eligible[0].sources } : null };
}
// The image that belongs to this event: its own report's image first, else another report of the same event; never a publisher default image.
export function pickImageArticle(clusterId) {
  const rows = db.prepare("SELECT id,source_id,image_url FROM articles WHERE cluster_id=? AND image_url IS NOT NULL ORDER BY length(COALESCE(full_text,'')||COALESCE(content,'')||COALESCE(summary,'')) DESC, id").all(clusterId);
  return rows.find(r => !genericImage(r))?.id ?? null;
}

export function runSelection(nowMs = Date.now()) {
  const c = cfg(), w = c.windowMin * 60000, { start, end } = slotFor(nowMs - c.graceMin * 60000, c.windowMin, c.tzOffsetMin);
  if (db.prepare('SELECT 1 FROM selections WHERE slot_start=?').get(iso(start))) return null; // already decided: a restart can never decide it twice
  clusterNew();
  const last = db.prepare('SELECT MAX(slot_start) m FROM selections').get().m; // windows skipped while the worker was down are recorded, never back-filled late
  if (last) for (let t = Date.parse(last) + w; t < start && start - t <= 24 * w; t += w) db.prepare("INSERT OR IGNORE INTO selections(slot_start,slot_end,status,reason,created_at) VALUES(?,?, 'missed','worker was not running',?)").run(iso(t), iso(t + w), now());
  const r = pickForWindow(start, end, c);
  const row = r.best ? { status: 'selected', reason: null, cluster_id: r.best.id, score: r.best.score, factors: JSON.stringify(r.best.factors), image: pickImageArticle(r.best.id) }
    : { status: 'none', reason: r.eligible ? `no story reached the threshold (best score ${r.bestBelow.score}, needs ${c.minScore})` : 'no eligible story appeared in this window', cluster_id: null, score: r.bestBelow?.score ?? null, factors: null, image: null };
  try {
    db.prepare('INSERT INTO selections(slot_start,slot_end,status,reason,cluster_id,score,factors,candidates,image_article_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(iso(start), iso(end), row.status, row.reason, row.cluster_id, row.score, row.factors, r.eligible, row.image, now());
  } catch (e) { if (/UNIQUE/.test(e.message)) return null; throw e; } // another process decided first
  log('selection', `${iso(start)}: ${row.status}${row.cluster_id ? ' cluster ' + row.cluster_id + ' score ' + row.score : ' — ' + row.reason}`);
  ensureDraftRequested(c); return { slot: iso(start), ...row, eligible: r.eligible };
}
// optional automation (off by default because each story costs one AI request): idempotent, and it survives a crash between "selected" and "queued"
export function ensureDraftRequested(c = cfg()) {
  if (!c.autoDraft) return 0; let n = 0;
  for (const s of db.prepare("SELECT id,cluster_id FROM selections WHERE status='selected' AND draft_requested_at IS NULL").all()) {
    if (!db.prepare("SELECT 1 FROM drafts WHERE cluster_id=? AND bundle_id IS NOT NULL AND status IN ('needs_review','approved')").get(s.cluster_id)) queueStory(s.cluster_id, 'selection', 0);
    db.prepare('UPDATE selections SET draft_requested_at=? WHERE id=?').run(now(), s.id); n++;
  }
  return n;
}
export const listSelections = (limit = 24) => db.prepare(`SELECT s.*, (SELECT title FROM articles WHERE cluster_id=s.cluster_id ORDER BY length(summary) DESC LIMIT 1) title, (SELECT language FROM articles WHERE cluster_id=s.cluster_id LIMIT 1) language FROM selections s ORDER BY slot_start DESC LIMIT ?`).all(limit);
