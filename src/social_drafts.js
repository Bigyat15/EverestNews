// Social content for the hourly pick: one draft per edition, each reviewed and approved on its own. Approval is bound to the exact content (socialHash).
import { db, now, log } from './db.js';
import { effective } from './drafts.js';
import { createGraphic, autoAdoptImage } from './graphic_routes.js';
import { socialHash, graphicHeadline, graphicDescription } from './headline.js';
import { createPost, approvePost, schedulePost, Refusal } from './social.js';
import { queueStory } from './editions.js';
import { languageOk } from './editions.js';

const J = s => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
const leadOf = cid => db.prepare('SELECT lead_asset_id FROM clusters WHERE id=?').get(cid)?.lead_asset_id ?? null;
const get = id => { const sd = db.prepare('SELECT * FROM social_drafts WHERE id=?').get(+id); if (!sd) throw new Refusal('Social draft not found.', 404); return sd; };
const edition = lang => cid => db.prepare("SELECT * FROM drafts WHERE cluster_id=? AND lang=? AND status IN ('approved','needs_review') ORDER BY (status='approved') DESC, id DESC").get(cid, lang);

// Render the card for this edition from the story's lead image. A failure leaves the draft without a graphic (and unapprovable) rather than guessing.
async function makeGraphic(sd, d) {
  await autoAdoptImage(d.cluster_id).catch(() => {}); // a story from a publisher with automatic images gets its image before the card is drawn
  const t = db.prepare('SELECT spec FROM templates ORDER BY id LIMIT 1').get(), lead = leadOf(d.cluster_id), photo = lead ? db.prepare('SELECT id,rights_note FROM assets WHERE id=?').get(lead) : null;
  const r = await createGraphic({ cluster_id: d.cluster_id, draft_id: d.id, template_id: 1, photoAssetId: photo?.rights_note?.trim() ? photo.id : null, spec: { ...(J(t?.spec) ?? {}), format: 'portrait', headline: graphicHeadline(d), subheadline: graphicDescription(d) } });
  return r.id ?? null;
}
function warningsFor(sd, d) {
  const w = [], ed = effective(d), g = sd.graphic_id ? db.prepare('SELECT status FROM graphics WHERE id=?').get(sd.graphic_id) : null;
  if (!languageOk(sd.caption, sd.lang)) w.push({ severity: 'error', message: `The caption is not in ${sd.lang === 'ne' ? 'Nepali' : 'English'}.` });
  if ([...sd.caption].length > 900) w.push({ severity: 'error', message: 'Caption is longer than 900 characters.' });
  if (!sd.graphic_id || g?.status !== 'current') w.push({ severity: 'error', message: 'No current graphic. Regenerate it.' });
  if (d.status !== 'approved') w.push({ severity: 'error', message: 'The website edition is not approved yet; approve it in the Studio first.' });
  if (!ed.graphic_headline?.trim()) w.push({ severity: 'error', message: 'The edition has no graphic text.' });
  return w;
}
function refresh(sd, d) { // recompute hash + warnings; approval survives only if the hash is unchanged
  const hash = socialHash(sd, d, leadOf(d.cluster_id)), w = warningsFor(sd, d), keep = sd.status === 'approved' && sd.approved_hash === hash;
  db.prepare('UPDATE social_drafts SET content_hash=?,warnings=?,status=?,updated_at=? WHERE id=?').run(hash, JSON.stringify(w), sd.status === 'approved' && !keep ? 'draft' : sd.status, now(), sd.id);
}

// Idempotent: UNIQUE(selection_id, lang). Needs the edition draft of that language; never calls the model itself.
export async function prepareSocialDrafts(selectionId) {
  const s = db.prepare("SELECT * FROM selections WHERE id=? AND status='selected'").get(selectionId); if (!s) return 0; let made = 0;
  for (const lang of ['ne', 'en']) {
    if (db.prepare('SELECT 1 FROM social_drafts WHERE selection_id=? AND lang=?').get(s.id, lang)) continue;
    const d = edition(lang)(s.cluster_id);
    if (!d) { if (db.prepare("SELECT value FROM settings WHERE key='select_auto_draft'").get()?.value === 'true') queueStory(s.cluster_id, 'selection', 0); continue; }
    const ed = effective(d), ts = now();
    const id = Number(db.prepare("INSERT OR IGNORE INTO social_drafts(selection_id,cluster_id,lang,edition_draft_id,caption,graphic_headline,graphic_description,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run(s.id, s.cluster_id, lang, d.id, ed.caption, ed.graphic_headline, ed.graphic_description, ts, ts).lastInsertRowid);
    if (!id) continue; made++;
    try { const gid = await makeGraphic({}, d); db.prepare('UPDATE social_drafts SET graphic_id=? WHERE id=?').run(gid, id); } catch (e) { log('social_graphic_error', `social draft ${id}: ${e.message}`); }
    refresh(get(id), d);
  }
  return made;
}
export async function prepareAll() { let n = 0; for (const s of db.prepare("SELECT id FROM selections WHERE status='selected' AND (SELECT COUNT(*) FROM social_drafts WHERE selection_id=selections.id)<2 ORDER BY id DESC LIMIT 5").all()) n += await prepareSocialDrafts(s.id); return n; }

export async function regenerate(id) {
  const sd = get(id); if (sd.post_id) throw new Refusal('Already sent to delivery.'); const d = edition(sd.lang)(sd.cluster_id); if (!d) throw new Refusal('The edition no longer exists.');
  const ed = effective(d); const gid = await makeGraphic(sd, d);
  db.prepare("UPDATE social_drafts SET edition_draft_id=?,caption=?,graphic_headline=?,graphic_description=?,graphic_id=?,status='draft',approved_hash=NULL,approved_by=NULL,approved_at=NULL,rejected_reason=NULL WHERE id=?").run(d.id, ed.caption, ed.graphic_headline, ed.graphic_description, gid, sd.id);
  refresh(get(id), d); log('social_regenerated', `social draft ${id}`);
}
export function editCaption(id, caption) {
  const sd = get(id); if (sd.post_id) throw new Refusal('Already sent to delivery.'); if (typeof caption !== 'string' || !caption.trim() || caption.length > 2200) throw new Refusal('Caption must be text up to 2200 characters.', 400);
  db.prepare("UPDATE social_drafts SET caption=?,status='draft',approved_hash=NULL,approved_by=NULL,approved_at=NULL WHERE id=?").run(caption.trim(), sd.id);
  refresh(get(id), db.prepare('SELECT * FROM drafts WHERE id=?').get(sd.edition_draft_id)); log('social_edited', `social draft ${id}`);
}
export function approve(id, by = 'admin') {
  const sd = get(id); if (sd.status === 'rejected') throw new Refusal('Rejected; regenerate it first.'); const d = db.prepare('SELECT * FROM drafts WHERE id=?').get(sd.edition_draft_id);
  refresh(sd, d); const fresh = get(id), errs = JSON.parse(fresh.warnings).filter(w => w.severity === 'error'); if (errs.length) throw new Refusal(errs.map(e => e.message).join(' '), 409, { problems: errs.map(e => e.message) });
  db.prepare("UPDATE social_drafts SET status='approved',approved_hash=content_hash,approved_by=?,approved_at=? WHERE id=?").run(by, now(), id); log('social_approved', `social draft ${id}`);
}
export function reject(id, reason = '') { const sd = get(id); if (sd.post_id) throw new Refusal('Already sent to delivery.'); db.prepare("UPDATE social_drafts SET status='rejected',rejected_reason=?,approved_hash=NULL,approved_at=NULL,approved_by=NULL,updated_at=? WHERE id=?").run(String(reason).slice(0, 300), now(), sd.id); log('social_rejected', `social draft ${id}`); }

// Only an approved, unchanged draft becomes a post. With no connected account nothing is queued and the reason is returned.
export function deliver(id, accountIds) {
  const sd = get(id); const d = db.prepare('SELECT * FROM drafts WHERE id=?').get(sd.edition_draft_id); refresh(sd, d);
  const f = get(id); if (f.post_id) throw new Refusal(`Already sent to delivery (post #${f.post_id}).`);
  if (f.status !== 'approved' || f.approved_hash !== f.content_hash) throw new Refusal('Approve the current content first.');
  if (!accountIds?.length) throw new Refusal('Choose at least one connected account.', 400);
  const postId = createPost({ draft_id: d.id, graphic_id: f.graphic_id, targets: accountIds.map(a => ({ account_id: a, caption: f.caption })) });
  db.prepare("UPDATE social_drafts SET post_id=?,status='delivering',updated_at=? WHERE id=?").run(postId, now(), id);
  approvePost(postId); return schedulePost(postId);
}
export function listSocialDrafts() {
  return db.prepare("SELECT * FROM social_drafts ORDER BY selection_id DESC, lang").all().map(sd => {
    const d = db.prepare('SELECT * FROM drafts WHERE id=?').get(sd.edition_draft_id), live = socialHash(sd, d, leadOf(sd.cluster_id));
    return { ...sd, warnings: J(sd.warnings), approval_valid: sd.status === 'approved' && sd.approved_hash === live, title: d.final_headline ?? d.edited_headline ?? J(d.headline_options)?.[0] ?? '',
      targets: sd.post_id ? db.prepare('SELECT t.id,t.status,t.error,t.platform_url,t.published_at,a.display_name,a.adapter FROM post_targets t JOIN social_accounts a ON a.id=t.account_id WHERE t.post_id=?').all(sd.post_id).map(t => ({ ...t, isTest: t.adapter === 'mock' })) : [] };
  });
}
