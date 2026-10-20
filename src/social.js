import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { db, now, log } from './db.js';
import { encrypt, decrypt } from './secrets.js';
import { PLATFORMS, adapterFor, PublishError, mockEnabled } from './social_adapters.js';
import { isStale, imageChanged, socialHash } from './headline.js';
import { articlePath } from './slug.js';

const MAX_ATTEMPTS = 5, MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export class Refusal extends Error { constructor(message, status = 409, extra = {}) { super(message); this.status = status; Object.assign(this, extra); } }
const backoffMs = attempts => (+process.env.SOCIAL_BACKOFF_BASE_MS || 60000) * 2 ** (attempts - 1);
const keyFor = (postId, accountId) => createHash('sha256').update(`post:${postId}:account:${accountId}`).digest('hex');
const gSetting = (k, d) => { const r = db.prepare('SELECT value FROM settings WHERE key=?').get(k); return r ? JSON.parse(r.value) : d; };
export const maxAccounts = () => gSetting('max_accounts', 10);
export const setMaxAccounts = n => db.prepare("INSERT INTO settings(key,value) VALUES('max_accounts',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(n));

/* ---------- gates: evaluated at approval, at scheduling AND again at the moment of publishing ---------- */
export function checkPublishable(post) {
  const problems = [], d = db.prepare('SELECT * FROM drafts WHERE id=?').get(post.draft_id);
  if (!d || d.status !== 'approved') problems.push('The draft is not approved.');
  const g = post.graphic_id ? db.prepare('SELECT * FROM graphics WHERE id=?').get(post.graphic_id) : null;
  if (post.graphic_id) {
    if (!g || g.status !== 'current') problems.push('That graphic was replaced by a newer one. Select the current graphic.');
    else {
      if (d && g.draft_id !== d.id) problems.push('The graphic belongs to a different draft.');
      else if (d && isStale(g, d)) problems.push('The graphic is outdated: the approved headline changed after it was made. Regenerate it.');
      if (!existsSync(g.path)) problems.push('The graphic file is missing.');
      if (g.photo_asset_id) { const a = db.prepare('SELECT rights_note,cluster_id FROM assets WHERE id=?').get(g.photo_asset_id); if (!a?.rights_note?.trim()) problems.push('The photo used in the graphic has no recorded usage permission.'); if (d && a && a.cluster_id !== d.cluster_id) problems.push('The photo in the graphic belongs to a different story.'); }
      if (d && imageChanged(g, db.prepare('SELECT lead_asset_id FROM clusters WHERE id=?').get(d.cluster_id)?.lead_asset_id ?? null)) problems.push('The story’s lead image changed after the graphic was made. Regenerate the graphic.');
    }
  }
  // a post made from the hourly pick is delivered only while the exact content a person approved is unchanged
  const sd = post.id ? db.prepare('SELECT * FROM social_drafts WHERE post_id=?').get(post.id) : null;
  if (sd && d) { const lead = db.prepare('SELECT lead_asset_id FROM clusters WHERE id=?').get(d.cluster_id)?.lead_asset_id; if (sd.status === 'rejected') problems.push('This social post was rejected.'); else if (sd.status !== 'approved' && sd.status !== 'delivering') problems.push('This social post is not approved.'); else if (sd.approved_hash !== socialHash(sd, d, lead)) problems.push('The approved content changed after approval. Review and approve it again.'); }
  return { ok: !problems.length, problems, draft: d, graphic: g };
}
export function validateTarget(account, caption, graphic) {
  const P = PLATFORMS[account.platform], issues = [], add = (severity, message) => issues.push({ severity, message }), len = [...caption].length;
  if (account.status !== 'connected') add('error', `The account is ${account.status}; reconnect it first.`);
  if (!caption.trim()) add('error', 'Caption is empty.');
  if (len > P.maxCaption) add('error', `Caption is ${len} characters; ${P.label} allows ${P.maxCaption}.`);
  if (P.maxHashtags && (caption.match(/#[\p{L}\p{N}_]+/gu) || []).length > P.maxHashtags) add('error', `More than ${P.maxHashtags} hashtags.`);
  if (P.needsImage && !graphic) add('error', `${P.label} requires an image. Attach a graphic.`);
  if (graphic) {
    const ext = graphic.mime === 'image/jpeg' ? 'jpeg' : 'png';
    if (!P.imageFormats.includes(ext)) add('error', `${P.label} accepts only ${P.imageFormats.join('/').toUpperCase()}; save the graphic as JPEG.`);
    if (graphic.bytes > MAX_IMAGE_BYTES) add('error', 'Image is larger than 8 MB.');
  }
  if (P.mockOnly) add('info', 'Test account: nothing is actually posted.');
  return issues;
}

/* ---------- caption: the article link is the real published URL, never a guess ---------- */
export function articleUrl(clusterId, lang) {
  const p = db.prepare("SELECT * FROM publications WHERE cluster_id=? AND lang=? AND status='published'").get(clusterId, lang), base = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  return p && base ? base + articlePath(p) : null; // no PUBLIC_BASE_URL => no absolute link can be made
}
export function composeCaption(draft, caption) {
  const url = articleUrl(draft.cluster_id, draft.lang); let c = String(caption ?? '').trim();
  if (c && !/[#＃]\S/.test(c)) { let h = []; try { h = JSON.parse(draft.hashtags || '[]'); } catch {} if (h.length) c = `${c}\n${h.slice(0, 4).join(' ')}`; } // the model sometimes omits hashtags: use the ones stored for this edition
  if (c.includes('{{ARTICLE_URL}}')) c = url ? c.split('{{ARTICLE_URL}}').join(url) : c.split('{{ARTICLE_URL}}').join('').replace(/\n{3,}/g, '\n\n').trim();
  else if (url && !c.includes(url)) c = `${c}\n\n${url}`;
  return { caption: c, linked: !!url };
}
export const defaultCaption = (d, platform) => { let fj = {}; try { fj = JSON.parse(d.final_json || '{}'); } catch {} return platform === 'x' && fj.short_caption ? fj.short_caption : (d.final_caption ?? ''); };

/* ---------- accounts ---------- */
export function connectMockAccount(name) {
  if (!mockEnabled()) throw new Refusal('Test accounts are disabled (set SOCIAL_MOCK=1).', 403);
  name = String(name ?? '').trim().slice(0, 60); if (!name) throw new Refusal('Name required.', 400);
  if (db.prepare("SELECT COUNT(*) n FROM social_accounts WHERE status<>'disconnected'").get().n >= maxAccounts()) throw new Refusal(`Account limit reached (${maxAccounts()}). Raise it in Settings or disconnect one.`);
  const ts = now(), ext = 'mock-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  try { return Number(db.prepare("INSERT INTO social_accounts(platform,adapter,display_name,external_id,status,token_enc,created_at,updated_at) VALUES('mock','mock',?,?, 'connected', ?,?,?)").run(name, ext, encrypt('mock-token'), ts, ts).lastInsertRowid); }
  catch { throw new Refusal('An account with that name already exists.'); }
}
export function disconnectAccount(id) {
  const a = db.prepare('SELECT * FROM social_accounts WHERE id=?').get(id); if (!a) throw new Refusal('Account not found.', 404);
  db.exec('BEGIN');
  try {
    const posts = db.prepare("SELECT DISTINCT post_id FROM post_targets WHERE account_id=? AND status IN ('pending','queued')").all(id);
    db.prepare("UPDATE post_targets SET status='cancelled',error='Account disconnected',updated_at=? WHERE account_id=? AND status IN ('pending','queued')").run(now(), id);
    db.prepare("UPDATE social_accounts SET status='disconnected',token_enc=NULL,updated_at=? WHERE id=?").run(now(), id);
    for (const p of posts) rollup(p.post_id); db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  log('social_disconnect', `account ${id}`);
}

/* ---------- posts ---------- */
export function createPost({ draft_id, graphic_id = null, targets = [], repost = false }) {
  const d = db.prepare('SELECT * FROM drafts WHERE id=?').get(+draft_id); if (!d) throw new Refusal('Draft not found.', 404);
  if (!Array.isArray(targets) || !targets.length) throw new Refusal('Choose at least one account.', 400);
  const probe = { draft_id: d.id, graphic_id: graphic_id ? +graphic_id : null }, gate = checkPublishable(probe);
  if (!gate.ok) throw new Refusal(gate.problems.join(' '), 409, { problems: gate.problems });
  const seen = new Set(), rows = [];
  for (const t of targets) {
    const a = db.prepare('SELECT * FROM social_accounts WHERE id=?').get(+t.account_id); if (!a) throw new Refusal('Account not found.', 404);
    if (seen.has(a.id)) throw new Refusal('Each account can be chosen once.', 400); seen.add(a.id);
    const caption = composeCaption(d, t.caption ?? defaultCaption(d, a.platform)).caption, issues = validateTarget(a, caption, gate.graphic), err = issues.find(i => i.severity === 'error');
    if (err) throw new Refusal(`${a.display_name}: ${err.message}`, 422, { issues });
    const dup = db.prepare("SELECT t.post_id FROM post_targets t JOIN posts p ON p.id=t.post_id WHERE p.draft_id=? AND t.account_id=? AND t.status IN ('pending','queued','publishing','published','unknown') LIMIT 1").get(d.id, a.id);
    if (dup && !repost) throw new Refusal(`This story is already posted or queued for ${a.display_name} (post #${dup.post_id}). Tick “post again” to override.`, 409);
    rows.push({ a, caption });
  }
  const ts = now(); db.exec('BEGIN');
  try {
    const id = Number(db.prepare("INSERT INTO posts(cluster_id,draft_id,graphic_id,state,created_at,updated_at) VALUES(?,?,?,'draft',?,?)").run(d.cluster_id, d.id, probe.graphic_id, ts, ts).lastInsertRowid);
    for (const { a, caption } of rows) db.prepare("INSERT INTO post_targets(post_id,account_id,caption,status,idempotency_key,updated_at) VALUES(?,?,?,'pending',?,?)").run(id, a.id, caption, keyFor(id, a.id), ts);
    db.exec('COMMIT'); log('post_created', `post ${id}`); return id;
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
const getPost = id => { const p = db.prepare('SELECT * FROM posts WHERE id=?').get(+id); if (!p) throw new Refusal('Post not found.', 404); return p; };
export function approvePost(id) {
  const p = getPost(id); if (p.state !== 'draft') throw new Refusal(`Post is ${p.state}; only a draft can be approved.`);
  const g = checkPublishable(p); if (!g.ok) throw new Refusal(g.problems.join(' '), 409, { problems: g.problems });
  db.prepare("UPDATE posts SET state='approved',approved_at=?,updated_at=? WHERE id=?").run(now(), now(), p.id); log('post_approved', `post ${p.id}`);
}
export function schedulePost(id, scheduledAt = null) {
  const p = getPost(id); if (p.state !== 'approved') throw new Refusal(`Post is ${p.state}; approve it first.`);
  let when = now(); if (scheduledAt) { const t = Date.parse(scheduledAt); if (Number.isNaN(t)) throw new Refusal('Invalid schedule time.', 400); if (t > Date.now() + 365 * 864e5) throw new Refusal('Schedule time is more than a year away.', 400); when = new Date(Math.max(t, Date.now())).toISOString(); }
  const g = checkPublishable(p); if (!g.ok) throw new Refusal(g.problems.join(' '), 409, { problems: g.problems });
  db.exec('BEGIN');
  try { db.prepare("UPDATE post_targets SET status='queued',next_run_at=?,updated_at=? WHERE post_id=? AND status='pending'").run(when, now(), p.id); db.prepare("UPDATE posts SET state='scheduled',scheduled_at=?,updated_at=? WHERE id=?").run(when, now(), p.id); db.exec('COMMIT'); }
  catch (e) { db.exec('ROLLBACK'); throw e; }
  log('post_scheduled', `post ${p.id} at ${when}`); return when;
}
export function cancelPost(id) {
  const p = getPost(id); if (!['draft', 'approved', 'scheduled'].includes(p.state)) throw new Refusal(`Post is ${p.state} and cannot be cancelled.`);
  db.prepare("UPDATE post_targets SET status='cancelled',updated_at=? WHERE post_id=? AND status IN ('pending','queued')").run(now(), p.id); rollup(p.id); log('post_cancelled', `post ${p.id}`);
}
export function retryTarget(id, { confirmUnknown = false } = {}) {
  const t = db.prepare('SELECT * FROM post_targets WHERE id=?').get(+id); if (!t) throw new Refusal('Target not found.', 404);
  if (t.status === 'unknown' && !confirmUnknown) throw new Refusal('The outcome of this delivery is unknown. Check the platform first; if it is not there, retry with confirmation.', 409);
  if (!['failed', 'unknown'].includes(t.status)) throw new Refusal(`Target is ${t.status}; nothing to retry.`);
  if (t.status === 'failed' && t.error_kind === 'permanent') throw new Refusal('This failure is permanent. Fix the cause (or create a new post) instead of retrying.', 409);
  const a = db.prepare('SELECT * FROM social_accounts WHERE id=?').get(t.account_id); if (a.status !== 'connected') throw new Refusal(`Reconnect ${a.display_name} first (it is ${a.status}).`, 409);
  db.prepare("UPDATE post_targets SET status='queued',attempts=0,next_run_at=?,error=NULL,error_kind=NULL,updated_at=? WHERE id=?").run(now(), now(), t.id);
  db.prepare("UPDATE posts SET state='scheduled',updated_at=? WHERE id=?").run(now(), t.post_id); log('target_retry', `target ${t.id}`);
}
export function markPublishedManually(id, url) {
  const t = db.prepare('SELECT * FROM post_targets WHERE id=?').get(+id); if (!t) throw new Refusal('Target not found.', 404); if (t.status !== 'unknown') throw new Refusal('Only deliveries with an unknown outcome can be confirmed manually.');
  if (!/^https?:\/\//.test(url ?? '')) throw new Refusal('Enter the post URL you verified on the platform.', 400);
  db.prepare("UPDATE post_targets SET status='published',platform_post_id='manual',platform_url=?,published_at=?,error=NULL,updated_at=? WHERE id=?").run(url, now(), now(), t.id); rollup(t.post_id); log('target_manual_confirm', `target ${t.id}`);
}

export function rollup(postId) {
  const p = db.prepare('SELECT state FROM posts WHERE id=?').get(postId); if (!p || ['draft', 'approved'].includes(p.state) && !db.prepare("SELECT 1 FROM post_targets WHERE post_id=? AND status NOT IN ('pending')").get(postId)) return;
  const c = Object.fromEntries(db.prepare('SELECT status, COUNT(*) n FROM post_targets WHERE post_id=? GROUP BY status').all(postId).map(r => [r.status, r.n])), n = k => c[k] ?? 0;
  let state;
  if (n('publishing')) state = 'publishing'; else if (n('queued') || n('pending')) state = n('queued') ? 'scheduled' : p.state;
  else if (n('unknown')) state = 'partial'; else if (n('published') && !n('failed')) state = 'published'; else if (n('published')) state = 'partial'; else if (n('failed')) state = 'failed'; else state = 'cancelled';
  db.prepare('UPDATE posts SET state=?,updated_at=? WHERE id=?').run(state, now(), postId);
}

/* ---------- worker side ---------- */
async function deliver(t, attempts) {
  const post = db.prepare('SELECT * FROM posts WHERE id=?').get(t.post_id), account = db.prepare('SELECT * FROM social_accounts WHERE id=?').get(t.account_id);
  if (post.state === 'cancelled') throw new PublishError('Post was cancelled.', 'permanent');
  const gate = checkPublishable(post); if (!gate.ok) throw new PublishError(gate.problems.join(' '), 'permanent'); // re-checked now: a stale graphic is never posted
  if (account.status !== 'connected') throw new PublishError(`Account is ${account.status}; reconnect it.`, 'auth');
  if (account.token_expires_at && Date.parse(account.token_expires_at) < Date.now()) throw new PublishError('Access token expired; reconnect the account.', 'auth');
  const bad = validateTarget(account, t.caption, gate.graphic).find(i => i.severity === 'error'); if (bad) throw new PublishError(bad.message, 'permanent');
  const adapter = adapterFor(account);
  const existing = await adapter.lookup?.(t.idempotency_key, account); if (existing) return existing; // already delivered (e.g. crash after the platform accepted it)
  return adapter.publish({ account, token: decrypt(account.token_enc), caption: t.caption, imagePath: gate.graphic?.path ?? null, idempotencyKey: t.idempotency_key, attempt: attempts });
}
export async function runPublishJob() {
  const due = db.prepare("SELECT t.id FROM post_targets t JOIN posts p ON p.id=t.post_id WHERE t.status='queued' AND t.next_run_at<=? AND p.state IN ('scheduled','publishing') ORDER BY t.next_run_at,t.id LIMIT 1").get(now());
  if (!due) return false;
  const claimed = db.prepare("UPDATE post_targets SET status='publishing',attempts=attempts+1,updated_at=? WHERE id=? AND status='queued' RETURNING *").get(now(), due.id);
  if (!claimed) return true; // another runner took it: never deliver twice
  db.prepare("UPDATE posts SET state='publishing',updated_at=? WHERE id=?").run(now(), claimed.post_id);
  try {
    const r = await deliver(claimed, claimed.attempts);
    db.prepare("UPDATE post_targets SET status='published',platform_post_id=?,platform_url=?,published_at=?,error=NULL,error_kind=NULL,updated_at=? WHERE id=?").run(r.platformPostId, r.url ?? null, now(), now(), claimed.id);
    log('target_published', `target ${claimed.id}`);
  } catch (e) {
    const kind = e.kind || 'recoverable', msg = String(e.message).slice(0, 500);
    if (kind === 'recoverable' && claimed.attempts < MAX_ATTEMPTS) db.prepare("UPDATE post_targets SET status='queued',next_run_at=?,error=?,error_kind='recoverable',updated_at=? WHERE id=?").run(new Date(Date.now() + (e.retryAfterMs ?? backoffMs(claimed.attempts))).toISOString(), msg, now(), claimed.id);
    else {
      db.prepare("UPDATE post_targets SET status='failed',error=?,error_kind=?,updated_at=? WHERE id=?").run(kind === 'recoverable' ? `${msg} (gave up after ${claimed.attempts} attempts)` : msg, kind, now(), claimed.id);
      if (kind === 'auth') db.prepare("UPDATE social_accounts SET status='expired',last_error=?,updated_at=? WHERE id=?").run(msg, now(), claimed.account_id);
    }
    log('target_error', `target ${claimed.id} ${kind}: ${msg}`);
  }
  rollup(claimed.post_id); return true;
}
// Deliveries left mid-flight by a crash are resolved without ever posting twice. Only deliveries that have been 'publishing' for longer than
// STALE_MS are touched, so a worker that starts (or a periodic sweep) never steals an in-flight delivery from a live worker.
const STALE_MS = () => +process.env.SOCIAL_STALE_MS || 120000;
export async function recoverPublishing() {
  let n = 0;
  for (const t of db.prepare("SELECT * FROM post_targets WHERE status='publishing' AND updated_at<?").all(new Date(Date.now() - STALE_MS()).toISOString())) {
    const a = db.prepare('SELECT * FROM social_accounts WHERE id=?').get(t.account_id), ad = adapterFor(a), found = await ad.lookup?.(t.idempotency_key, a);
    if (found) db.prepare("UPDATE post_targets SET status='published',platform_post_id=?,platform_url=?,published_at=?,updated_at=? WHERE id=?").run(found.platformPostId, found.url ?? null, now(), now(), t.id);
    else if (ad.idempotent) db.prepare("UPDATE post_targets SET status='queued',next_run_at=?,updated_at=? WHERE id=?").run(now(), now(), t.id);
    else db.prepare("UPDATE post_targets SET status='unknown',error='The process stopped while publishing. Check the platform; retry only if the post is not there.',updated_at=? WHERE id=?").run(now(), t.id);
    rollup(t.post_id); n++;
  }
  return n;
}
