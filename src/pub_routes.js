import { db, now, log } from './db.js';
import { isStale } from './graphic_routes.js';
import { imageChanged } from './headline.js';
import { articlePath } from './slug.js';
import { assetImage } from './imgcache.js';

export const CATEGORIES = ['politics', 'economy', 'sports', 'crime', 'health', 'disaster', 'national'];
export const toPublicCategory = c => ({ politics: 'politics', election: 'politics', economy: 'economy', sports: 'sports', crime: 'crime', health: 'health', disaster: 'disaster' }[c] ?? 'national');
const bad = (m, code = 400) => ({ code, body: { error: m } });
const J = s => (s ? JSON.parse(s) : null);

function parseAttribution(a) { return String(a).split('\n').map(l => l.trim()).filter(Boolean).map(l => { const i = l.indexOf(': '); return i > 0 ? { source: l.slice(0, i), url: l.slice(i + 2) } : null; }).filter(x => x && /^https?:\/\//.test(x.url)); }

// A graphic may be attached to a publication only while it still matches the draft's headline.
export function graphicFresh(g, draft) { return !!g && g.status === 'current' && g.draft_id === draft.id && !isStale(g, draft) && !imageChanged(g, db.prepare('SELECT lead_asset_id FROM clusters WHERE id=?').get(draft.cluster_id)?.lead_asset_id ?? null); }


const toks = t => new Set(String(t).normalize('NFKC').toLowerCase().split(/[^\p{L}\p{M}\p{N}]+/u).filter(w => w.length > 1));
const jacc = (a, b) => { let i = 0; for (const x of a) if (b.has(x)) i++; const u = a.size + b.size - i; return u ? i / u : 0; };
// An already-live article on a different story with a nearly identical headline is probably the same event reported twice.
export function nearDuplicates(draft, headline) {
  const mine = toks(headline); return db.prepare("SELECT id,headline FROM publications WHERE lang=? AND status='published' AND cluster_id<>? AND published_at>=?").all(draft.lang, draft.cluster_id, new Date(Date.now() - 72 * 36e5).toISOString()).filter(p => jacc(mine, toks(p.headline)) >= 0.6);
}
export function publishDraft(draftId, b) {
  const d = db.prepare('SELECT * FROM drafts WHERE id=?').get(draftId); if (!d) return bad('draft not found', 404);
  if (d.status !== 'approved') return bad('Only an approved draft can be published. Approve it in AI Studio first.', 409);
  if (!d.final_headline?.trim() || !d.final_body?.trim()) return bad('Approved draft has no final headline/body.', 409);
  if (!CATEGORIES.includes(b.category)) return bad('Choose a category.');
  const dups = nearDuplicates(d, d.final_headline); if (dups.length && !b.ack_duplicate) return { code: 409, body: { error: `A very similar article is already live (“${dups[0].headline.slice(0, 70)}”). Publishing both would report one event twice. Confirm if this is a genuinely different story.`, duplicates: dups } };
  // the story has ONE lead image: the website article, its cards and every graphic use it; another story's photo can never be attached
  const lead = db.prepare('SELECT lead_asset_id FROM clusters WHERE id=?').get(d.cluster_id)?.lead_asset_id ?? null, photoId = b.noPhoto ? null : (b.photoAssetId ? +b.photoAssetId : lead);
  if (b.photoAssetId && lead && +b.photoAssetId !== lead) return bad(`This story's lead image is photo #${lead}. Change the lead image first so the article and the graphics stay consistent.`, 409);
  let photo = null; if (photoId) {
    photo = db.prepare("SELECT * FROM assets WHERE id=? AND kind='photo'").get(photoId);
    if (!photo) return bad('Photo not found.'); if (photo.cluster_id !== d.cluster_id) return bad('That photo belongs to a different story.', 409); if (!photo.rights_note?.trim()) return bad('This photo has no recorded usage permission, so it cannot be published.', 409);
  }
  let graphic = null; if (b.graphicId) {
    graphic = db.prepare('SELECT * FROM graphics WHERE id=?').get(+b.graphicId);
    if (!graphicFresh(graphic, d)) return bad('That social graphic is outdated (its text changed) or belongs to another draft. Regenerate it first.', 409);
  }
  const fj = J(d.final_json) || {}, credit = String(b.photoCredit ?? '').slice(0, 120), ts = now(), attr = JSON.stringify(parseAttribution(d.attribution));
  db.exec('BEGIN');
  try {
    const had = db.prepare('SELECT id,published_at FROM publications WHERE cluster_id=? AND lang=?').get(d.cluster_id, d.lang);
    db.prepare(`INSERT INTO publications(cluster_id,lang,draft_id,headline,summary,body,caption,seo_title,meta_desc,alt_text,keywords,category,photo_asset_id,photo_credit,graphic_id,attribution,status,published_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'published',?,?)
      ON CONFLICT(cluster_id,lang) DO UPDATE SET draft_id=excluded.draft_id,headline=excluded.headline,summary=excluded.summary,body=excluded.body,caption=excluded.caption,seo_title=excluded.seo_title,meta_desc=excluded.meta_desc,alt_text=excluded.alt_text,keywords=excluded.keywords,
        category=excluded.category,photo_asset_id=excluded.photo_asset_id,photo_credit=excluded.photo_credit,graphic_id=excluded.graphic_id,attribution=excluded.attribution,status='published',unpublished_at=NULL,updated_at=excluded.updated_at`)
      .run(d.cluster_id, d.lang, d.id, d.final_headline, fj.standfirst ?? d.long_summary, d.final_body, d.final_caption, fj.seo_title ?? d.meta_title, fj.meta_desc ?? d.meta_desc, fj.alt_text ?? d.alt_text, JSON.stringify(fj.keywords ?? J(d.secondary_phrases) ?? []), b.category, photo?.id ?? null, credit || null, graphic?.id ?? null, attr, ts, ts);
    const p = db.prepare('SELECT * FROM publications WHERE cluster_id=? AND lang=?').get(d.cluster_id, d.lang);
    db.exec('COMMIT'); log(had ? 'publication_updated' : 'publication_created', `pub ${p.id} ${p.lang} draft ${d.id}`);
    if (photo) assetImage(photo.id, photo.path, 640).catch(() => {}); // pre-build sizes so the first reader is not the one who waits
    return { id: p.id, lang: p.lang, path: articlePath(p), created: !had };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

const R = [
  ['POST', /^\/api\/drafts\/(\d+)\/publish$/, ({ m, body: b }) => publishDraft(+m[1], b)],
  ['POST', /^\/api\/publications\/(\d+)\/unpublish$/, ({ m }) => {
    const p = db.prepare('SELECT * FROM publications WHERE id=?').get(+m[1]); if (!p) return bad('not found', 404);
    db.prepare("UPDATE publications SET status='unpublished',unpublished_at=? WHERE id=?").run(now(), p.id); log('publication_unpublished', `pub ${p.id}`); return { ok: true };
  }],
  ['GET', /^\/api\/publications$/, () => db.prepare('SELECT id,cluster_id,lang,draft_id,headline,category,status,published_at,updated_at,photo_asset_id,graphic_id FROM publications ORDER BY published_at DESC LIMIT 200').all().map(p => ({ ...p, path: articlePath({ ...p }) }))],
  ['GET', /^\/api\/drafts\/(\d+)\/publication$/, ({ m }) => { const d = db.prepare('SELECT cluster_id,lang FROM drafts WHERE id=?').get(+m[1]); if (!d) return bad('not found', 404); const p = db.prepare('SELECT id,lang,headline,status,draft_id,published_at,updated_at FROM publications WHERE cluster_id=? AND lang=?').get(d.cluster_id, d.lang); return p ? { ...p, path: articlePath(p) } : { none: true }; }],
];
export async function pubRoute(req, url, readBody) {
  for (const [method, re, fn] of R) {
    if (method !== req.method) continue; const m = url.pathname.match(re); if (!m) continue;
    const r = await fn({ m, body: method === 'GET' ? {} : await readBody(req) }); return r?.code ? r : { code: 200, body: r };
  }
  return null;
}
