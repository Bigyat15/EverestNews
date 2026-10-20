import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { loadImage } from '@napi-rs/canvas';
import { db, now, log, DATA } from './db.js';
import { renderGraphic, FORMATS, DEFAULT_SPEC } from './render.js';
import { robotsDecision } from './robots.js';
import { fetchSourceImage } from './imgcache.js';
import { genericImage } from './images.js';
import { brandLogoPath } from './brand_logo.js';

const MAX_UPLOAD = 12 * 1024 * 1024, MAX_PIXELS = 24e6;
const bad = (m, code = 400) => ({ code, body: { error: m } });
const J = s => (s ? JSON.parse(s) : null);

export function sniffImage(b) {
  if (b.length > 12 && b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') return ['image/png', 'png'];
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return ['image/jpeg', 'jpg'];
  if (b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return ['image/webp', 'webp'];
  return null; // anything else (SVG, GIF, HTML, scripts) is refused
}
const num = (v, lo, hi, d) => { v = +v; return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
const txt = (v, max, d = '') => String(v ?? d).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').slice(0, max);
const hexc = (v, d) => (/^#[0-9a-f]{6}$/i.test(v) ? v : d);
// Only known fields, bounded and typed: the spec is user input.
export function cleanSpec(s = {}) {
  const D = DEFAULT_SPEC;
  return {
    format: FORMATS[s.format] ? s.format : D.format, headline: txt(s.headline, 300), subheadline: txt(s.subheadline, 300), badgeLeft: txt(s.badgeLeft, 24, D.badgeLeft), badgeRight: txt(s.badgeRight, 24, D.badgeRight),
    badgeAlign: s.badgeAlign === 'left' ? 'left' : 'center', category: txt(s.category, 30), dateText: txt(s.dateText, 50), sourceText: txt(s.sourceText, 60), footerText: txt(s.footerText, 30, D.footerText), urlText: txt(s.urlText, 60),
    colors: { accent: hexc(s.colors?.accent, D.colors.accent), badge2: hexc(s.colors?.badge2, D.colors.badge2), text: hexc(s.colors?.text, D.colors.text), sub: hexc(s.colors?.sub, D.colors.sub) },
    photo: { zoom: num(s.photo?.zoom, 1, 4, 1), fx: num(s.photo?.fx, 0, 1, 0.5), fy: num(s.photo?.fy, 0, 1, 0.5), grayscale: s.photo?.grayscale === undefined ? D.photo.grayscale : !!s.photo.grayscale, overlay: num(s.photo?.overlay, 0, 0.7, 0.12) },
  };
}
export { currentHeadline, isStale } from './headline.js';
import { currentHeadline, isStale, graphicHeadline, graphicDescription, imageChanged } from './headline.js';

let chain = Promise.resolve(); // one render at a time: bounded memory on a small VPS
export const serial = fn => (chain = chain.then(fn, fn));

export const assetPath = id => { const a = db.prepare('SELECT * FROM assets WHERE id=?').get(id); return a && existsSync(a.path) ? a.path : null; };
function paths(b, cid = null) {
  const photo = b.photoAssetId ? assetPath(+b.photoAssetId) : null, logo = b.logoAssetId ? assetPath(+b.logoAssetId) : brandLogoPath();
  const a = b.photoAssetId && cid != null ? db.prepare('SELECT cluster_id FROM assets WHERE id=?').get(+b.photoAssetId) : null; // an image from another story can never be used by accident
  return { photo, logo, missing: (b.photoAssetId && !photo) || (b.logoAssetId && !logo), wrongStory: !!a && a.cluster_id !== cid };
}
const WRONG = 'That photo belongs to a different story. Upload or adopt an image for this story.';
const readRaw = req => new Promise((ok, no) => {
  const c = []; let n = 0;
  req.on('data', d => { n += d.length; if (n > 4 * MAX_UPLOAD) req.destroy(); else if (n <= MAX_UPLOAD) c.push(d); }); // oversize bodies are drained, not buffered
  req.on('end', () => n > MAX_UPLOAD ? no(Object.assign(new Error('file too large (max 12 MB)'), { status: 413 })) : ok(Buffer.concat(c))); req.on('error', no);
});

// cut at a word boundary, never mid-word
const shorten = (t, n) => { if (t.length <= n) return t; const c = t.slice(0, n), i = c.lastIndexOf(' '); return (i > n * 0.6 ? c.slice(0, i) : c).replace(/[,;:\s]+$/, '') + '…'; };
export const nepaliDate = () => { const p = Object.fromEntries(new Intl.DateTimeFormat('ne-NP', { timeZone: 'Asia/Kathmandu', day: 'numeric', month: 'long', year: 'numeric' }).formatToParts(new Date()).map(x => [x.type, x.value])); return `${p.day} ${p.month} ${p.year}`; };
const seedTemplate = () => {
  const t = db.prepare('SELECT id,spec FROM templates LIMIT 1').get();
  if (!t) return db.prepare('INSERT INTO templates(name,spec,created_at) VALUES(?,?,?)').run('Breaking News (default)', JSON.stringify(cleanSpec({})), now());
  // earlier versions shipped a "Read More" footer (useless on an image) and a blank-default bug; repair stored templates once
  for (const row of db.prepare('SELECT id,spec FROM templates').all()) { const sp = J(row.spec); if (sp.version === 2) continue; /* editable documents are never touched by the classic repair */ if (sp.footerText === 'Read More' || (!sp.badgeLeft && !sp.footerText)) { sp.footerText = ''; if (!sp.badgeLeft) { sp.badgeLeft = 'BREAKING'; sp.badgeRight = 'NEWS'; } db.prepare('UPDATE templates SET spec=? WHERE id=?').run(JSON.stringify(sp), row.id); } }
};
seedTemplate();

export async function createGraphic(b) {
    if (b.doc) return (await import('./design_routes.js')).saveDocGraphic(b); // layered editor documents
    const cid = +b.cluster_id; if (!db.prepare('SELECT 1 FROM clusters WHERE id=?').get(cid)) return bad('unknown story');
    const spec = cleanSpec(b.spec), p = paths(b, cid); if (p.missing) return bad('A selected image file is missing.'); if (p.wrongStory) return bad(WRONG, 409);
    const draft = b.draft_id ? db.prepare('SELECT * FROM drafts WHERE id=? AND cluster_id=?').get(+b.draft_id, cid) : null; if (b.draft_id && !draft) return bad('unknown draft');
    const outFormat = b.outFormat === 'jpeg' ? 'jpeg' : 'png';
    const r = await serial(() => renderGraphic(spec, { photoPath: p.photo, logoPath: p.logo, outFormat }));
    const blocking = r.warnings.find(w => w.severity === 'error'); if (blocking) return bad(`Cannot save: ${blocking.message}`);
    const dir = path.join(DATA, 'graphics', String(cid)); mkdirSync(dir, { recursive: true });
    db.exec('BEGIN');
    try {
      db.prepare("UPDATE graphics SET status='superseded' WHERE cluster_id=? AND COALESCE(draft_id,0)=COALESCE(?,0) AND format=? AND status='current'").run(cid, draft?.id ?? null, spec.format);
      const id = Number(db.prepare('INSERT INTO graphics(cluster_id,draft_id,template_id,photo_asset_id,logo_asset_id,spec,headline_snapshot,path,format,mime,width,height,bytes,warnings,created_at,subheadline_snapshot) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(cid, draft?.id ?? null, +b.template_id || null, +b.photoAssetId || null, +b.logoAssetId || null, JSON.stringify(spec), spec.headline, '', spec.format, r.mime, r.width, r.height, r.image.length, JSON.stringify(r.warnings), now(), spec.subheadline).lastInsertRowid);
      const file = path.join(dir, `${id}.${outFormat === 'jpeg' ? 'jpg' : 'png'}`); writeFileSync(file, r.image); db.prepare('UPDATE graphics SET path=? WHERE id=?').run(file, id); db.exec('COMMIT');
      log('graphic_saved', `graphic ${id} story ${cid} ${spec.format}`); return { id, warnings: r.warnings, bytes: r.image.length, unapproved: !!draft && draft.status !== 'approved' };
    } catch (e) { db.exec('ROLLBACK'); throw e; }
}

export async function adoptSourceImage(cid, articleId, rightsNote, { confirmGeneric = false } = {}) {
    const a = db.prepare('SELECT * FROM articles WHERE id=?').get(+articleId); if (!db.prepare('SELECT 1 FROM clusters WHERE id=?').get(cid)) return bad('story not found', 404);
    if (!a || a.cluster_id !== cid) return bad('That report is not part of this story, so its image cannot be used for it.', 409); if (!a.image_url) return bad('That report has no image.');
    const rights = String(rightsNote ?? '').trim(); if (rights.length < 8) return bad('State the licence or permission you hold for this image (at least a short sentence); it is stored with the image.');
    if (genericImage(a) && !confirmGeneric) return bad('This looks like the publisher’s default image (the same file appears on several unrelated stories). Confirm only if it really shows this event.', 409);
    const rb = await robotsDecision(a.image_url); if (!rb.known) return bad('The publisher’s robots.txt could not be read; try again shortly.', 503); if (!rb.allowed) return bad('The publisher’s robots.txt does not allow retrieving this image.', 409);
    let r; try { r = await fetchSourceImage(a.image_url); } catch (e) { return bad('The image could not be retrieved: ' + e.message, 502); } if (r.status >= 400) return bad(`The image could not be retrieved (HTTP ${r.status}).`, 502);
    const t = sniffImage(r.buf); if (!t) return bad('The file is not a PNG, JPEG or WebP image.'); let img; try { img = await loadImage(r.buf); } catch { return bad('Image could not be decoded.'); }
    if (img.width * img.height > MAX_PIXELS) return bad('Image is too large.'); if (Math.min(img.width, img.height) < 400) return bad('The image is too small for a social graphic (min 400px).');
    const sha = createHash('sha256').update(r.buf).digest('hex'), dir = path.join(DATA, 'uploads'); mkdirSync(dir, { recursive: true }); const p = path.join(dir, `${sha.slice(0, 24)}.${t[1]}`); if (!existsSync(p)) writeFileSync(p, r.buf);
    const id = Number(db.prepare("INSERT INTO assets(kind,cluster_id,path,orig_name,mime,bytes,width,height,sha256,created_at,rights_note,origin_article_id,origin_url) VALUES('photo',?,?,?,?,?,?,?,?,?,?,?,?)").run(cid, p, path.basename(new URL(a.image_url).pathname).slice(0, 120) || 'source-image', t[0], r.buf.length, img.width, img.height, sha, now(), rights.slice(0, 300), a.id, a.image_url).lastInsertRowid);
    db.prepare('UPDATE clusters SET lead_asset_id=? WHERE id=? AND lead_asset_id IS NULL').run(id, cid); log('image_adopted', `asset ${id} story ${cid} from article ${a.id}`); return { id, width: img.width, height: img.height, origin_url: a.image_url };
}

const R = [
  ['GET', /^\/api\/design\/(\d+)$/, ({ m, url }) => {
    seedTemplate(); const id = +m[1], cl = db.prepare('SELECT * FROM clusters WHERE id=?').get(id); if (!cl) return bad('story not found', 404);
    const arts = db.prepare('SELECT a.id,a.source_id,a.title,a.image_url,a.published_at,a.language,s.name source FROM articles a JOIN sources s ON s.id=a.source_id WHERE a.cluster_id=? ORDER BY COALESCE(a.published_at,a.fetched_at) DESC').all(id);
    const drafts = db.prepare('SELECT id,lang,bundle_id,status,edited_headline,final_headline,headline_options,rec_idx,edited_body,final_body,ai_draft,long_summary,caption,final_caption,edited_caption,graphic_headline,graphic_description,short_caption,edited_json,final_json,created_at FROM drafts WHERE cluster_id=? AND status<>\'superseded\' ORDER BY (status=\'approved\') DESC, id DESC').all(id);
    const want = url?.searchParams?.get('lang'), d = (want && drafts.find(x => x.lang === want)) || drafts[0] || null; // one graphic per edition: ?lang=ne|en picks the edition's own text
    const editions = ['ne', 'en'].map(l => { const x = drafts.find(y => y.lang === l); return x ? { lang: l, draft_id: x.id, status: x.status } : null; }).filter(Boolean);
    const gs = db.prepare("SELECT * FROM graphics WHERE cluster_id=? AND status='current' ORDER BY id DESC").all(id).map(g => { const dr = drafts.find(x => x.id === g.draft_id); const text = isStale(g, dr), img = imageChanged(g, cl.lead_asset_id); return { ...g, spec: J(g.spec), warnings: J(g.warnings), stale: text || img, stale_reason: text ? 'The graphic text changed after this graphic was made. Regenerate it.' : img ? 'The story’s lead image changed after this graphic was made. Regenerate it.' : null }; });
    return {
      cluster: cl, source: arts[0]?.source ?? '', title: arts[0]?.title ?? '', reference_images: arts.filter(a => a.image_url).map(a => ({ id: a.id, source: a.source, generic: genericImage({ ...a, source_id: a.source_id }) })).slice(0, 4),
      draft: d && { id: d.id, lang: d.lang, status: d.status, approved: d.status === 'approved', bundle: !!d.bundle_id, headline: currentHeadline(d),
        // a bundle draft has its own graphic text; only legacy drafts reuse the website headline/summary for the image
        graphic_headline: d.bundle_id ? graphicHeadline(d) : currentHeadline(d), subheadline: d.bundle_id ? graphicDescription(d) : shorten(d.long_summary || '', 150),
        caption: d.final_caption ?? d.edited_caption ?? d.caption },
      date_text: nepaliDate(),
      editions, lead_asset_id: cl.lead_asset_id ?? null, assets: db.prepare("SELECT id,kind,cluster_id,orig_name,width,height,bytes,created_at,rights_note,origin_article_id,origin_url FROM assets WHERE kind='logo' OR (kind='photo' AND cluster_id=?) ORDER BY id DESC LIMIT 60").all(id),
      templates: db.prepare('SELECT id,name,spec,COALESCE(updated_at,created_at) updated_at FROM templates ORDER BY id').all().map(t => ({ ...t, spec: J(t.spec) })), graphics: gs, formats: FORMATS,
    };
  }],
  ['POST', /^\/api\/assets$/, async ({ req, url }) => {
    const kind = url.searchParams.get('kind'); if (!['photo', 'logo'].includes(kind)) return bad('kind must be photo or logo');
    const cid = +url.searchParams.get('cluster_id') || null; if (cid && !db.prepare('SELECT 1 FROM clusters WHERE id=?').get(cid)) return bad('unknown story');
    const buf = await readRaw(req), t = sniffImage(buf); if (!t) return bad('Only PNG, JPEG or WebP images are accepted (SVG/GIF are refused).');
    let img; try { img = await loadImage(buf); } catch { return bad('Image could not be decoded.'); }
    if (img.width * img.height > MAX_PIXELS) return bad(`Image too large (${img.width}×${img.height}); max 24 megapixels. Resize it first.`);
    if (kind === 'photo' && Math.min(img.width, img.height) < 400) return bad('Photo is too small (min 400px on the short side).');
    const sha = createHash('sha256').update(buf).digest('hex'), dir = path.join(DATA, 'uploads'); mkdirSync(dir, { recursive: true });
    const p = path.join(dir, `${sha.slice(0, 24)}.${t[1]}`); if (!existsSync(p)) writeFileSync(p, buf); // original preserved untouched, deduplicated by hash
    const name = txt(url.searchParams.get('name'), 120).replace(/[^\w.\- ()]/g, '_'), rights = txt(url.searchParams.get('rights'), 300);
    const id = Number(db.prepare('INSERT INTO assets(kind,cluster_id,path,orig_name,mime,bytes,width,height,sha256,created_at,rights_note) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(kind, kind === 'photo' ? cid : null, p, name, t[0], buf.length, img.width, img.height, sha, now(), rights).lastInsertRowid);
    if (kind === 'photo' && cid) db.prepare('UPDATE clusters SET lead_asset_id=? WHERE id=? AND lead_asset_id IS NULL').run(id, cid);
    log('asset_upload', `${kind} ${id} ${name} ${img.width}x${img.height}`); return { id, width: img.width, height: img.height, bytes: buf.length };
  }],
  ['POST', /^\/api\/story\/(\d+)\/adopt-image$/, async ({ m, body: b }) => adoptSourceImage(+m[1], b.article_id, b.rights_note, { confirmGeneric: !!b.confirm_generic })],
  ['POST', /^\/api\/story\/(\d+)\/lead-image$/, ({ m, body: b }) => {
    const cid = +m[1], a = db.prepare("SELECT * FROM assets WHERE id=? AND kind='photo'").get(+b.asset_id); if (!a) return bad('photo not found', 404);
    if (a.cluster_id !== cid) return bad(WRONG, 409); if (!a.rights_note?.trim()) return bad('This photo has no recorded usage permission.', 409);
    db.prepare('UPDATE clusters SET lead_asset_id=? WHERE id=?').run(a.id, cid); log('lead_image', `story ${cid} asset ${a.id}`); return { ok: true, lead_asset_id: a.id };
  }],
  ['GET', /^\/api\/assets\/(\d+)\/file$/, ({ m }) => { const a = db.prepare('SELECT * FROM assets WHERE id=?').get(+m[1]); if (!a || !existsSync(a.path)) return bad('not found', 404); return { code: 200, raw: readFileSync(a.path), mime: a.mime }; }],
  ['DELETE', /^\/api\/assets\/(\d+)$/, ({ m }) => {
    const id = +m[1], a = db.prepare('SELECT * FROM assets WHERE id=?').get(id); if (!a) return bad('not found', 404);
    if (db.prepare('SELECT 1 FROM graphics WHERE photo_asset_id=? OR logo_asset_id=?').get(id, id)) return bad('This asset is used by saved graphics and cannot be deleted.');
    db.prepare('DELETE FROM assets WHERE id=?').run(id); if (!db.prepare('SELECT 1 FROM assets WHERE path=?').get(a.path)) try { unlinkSync(a.path); } catch {} return { ok: true };
  }],
  ['POST', /^\/api\/templates$/, async ({ body: b }) => (await import('./design_routes.js')).saveTemplate(b)],
  ['DELETE', /^\/api\/templates\/(\d+)$/, ({ m }) => {
    if (db.prepare('SELECT COUNT(*) n FROM templates').get().n <= 1) return bad('Keep at least one template.');
    if (db.prepare('SELECT 1 FROM graphics WHERE template_id=?').get(+m[1])) return bad('Template is used by saved graphics.'); db.prepare('DELETE FROM templates WHERE id=?').run(+m[1]); return { ok: true };
  }],
  ['POST', /^\/api\/graphics\/preview$/, async ({ body: b }) => {
    const p = paths(b, b.cluster_id ? +b.cluster_id : null); if (p.missing) return bad('A selected image file is missing.'); if (p.wrongStory) return bad(WRONG, 409);
    const r = await serial(() => renderGraphic(cleanSpec(b.spec), { photoPath: p.photo, logoPath: p.logo }));
    return { png: r.image.toString('base64'), width: r.width, height: r.height, warnings: r.warnings, metrics: r.metrics };
  }],
  ['POST', /^\/api\/graphics$/, ({ body: b }) => createGraphic(b)],
  ['GET', /^\/api\/graphics\/(\d+)\/file$/, ({ m, url }) => { const g = db.prepare('SELECT * FROM graphics WHERE id=?').get(+m[1]); if (!g || !existsSync(g.path)) return bad('not found', 404); return { code: 200, raw: readFileSync(g.path), mime: g.mime, name: url.searchParams.has('download') ? `everest-nepal-${g.id}.${g.mime === 'image/jpeg' ? 'jpg' : 'png'}` : undefined }; }],
];

export async function graphicRoute(req, url, readBody) {
  for (const [method, re, fn] of R) {
    if (method !== req.method) continue; const m = url.pathname.match(re); if (!m) continue;
    const isUpload = re.source === '^\\/api\\/assets$';
    const r = await fn({ m, url, req, body: method === 'GET' || method === 'DELETE' || isUpload ? {} : await readBody(req) }); return r?.code ? r : { code: 200, body: r };
  }
  return (await import('./design_routes.js')).designRoute(req, url, readBody);
}

// Automatic use of source images: ONLY for publishers the editor switched on (sources.auto_images). Same checks as the manual route
// (robots.txt, size, publisher default images, provenance stored); a story that already has a lead image is never changed.
export async function autoAdoptImage(cid) {
  const cl = db.prepare('SELECT lead_asset_id FROM clusters WHERE id=?').get(cid); if (!cl) return { adopted: false, reason: 'no such story' }; if (cl.lead_asset_id) return { adopted: false, reason: 'already has a lead image', id: cl.lead_asset_id };
  const rows = db.prepare("SELECT a.id, a.image_url, a.source_id, s.name source, s.auto_images_note note FROM articles a JOIN sources s ON s.id=a.source_id WHERE a.cluster_id=? AND a.image_url IS NOT NULL AND s.auto_images=1 ORDER BY length(COALESCE(a.full_text,'')||COALESCE(a.content,'')||COALESCE(a.summary,'')) DESC, a.id").all(cid);
  const pick = rows.find(r => !genericImage(r)); if (!pick) return { adopted: false, reason: rows.length ? 'only the publisher default image is available' : 'no report from a publisher with automatic images switched on has an image' };
  const r = await adoptSourceImage(cid, pick.id, `Automatic use switched on for ${pick.source}${pick.note ? ': ' + pick.note : ''} (editor decision; original: ${pick.image_url})`);
  if (r?.body?.error || r?.code) return { adopted: false, reason: r.body?.error ?? 'failed' }; log('image_auto', `story ${cid} asset ${r.id} from ${pick.source}`); return { adopted: true, id: r.id, source: pick.source };
}
// Published editions that went out without a photo get one once their publisher is switched on (bounded work per call, each story retried at most every 6 hours).
export async function backfillImages(limit = 3) {
  let n = 0; // stories that already have a usable lead image but whose published pages do not show it yet
  for (const { id } of db.prepare("SELECT DISTINCT c.id FROM clusters c JOIN publications p ON p.cluster_id=c.id AND p.status='published' AND p.photo_asset_id IS NULL JOIN assets a ON a.id=c.lead_asset_id AND TRIM(COALESCE(a.rights_note,''))<>''").all()) n += attachLeadToPublications(id) ? 1 : 0; const cut = new Date(Date.now() - 6 * 36e5).toISOString();
  const rows = db.prepare(`SELECT DISTINCT c.id FROM clusters c JOIN publications p ON p.cluster_id=c.id AND p.status='published' AND p.photo_asset_id IS NULL WHERE c.lead_asset_id IS NULL AND (c.image_tried_at IS NULL OR c.image_tried_at<?)
    AND EXISTS (SELECT 1 FROM articles a JOIN sources s ON s.id=a.source_id WHERE a.cluster_id=c.id AND a.image_url IS NOT NULL AND s.auto_images=1) ORDER BY c.id DESC LIMIT ?`).all(cut, limit);
  for (const { id } of rows) { db.prepare('UPDATE clusters SET image_tried_at=? WHERE id=?').run(now(), id); const r = await autoAdoptImage(id).catch(e => ({ adopted: false, reason: e.message })); if (r.adopted) { attachLeadToPublications(id); n++; } }
  return n;
}
export function attachLeadToPublications(cid) {
  const lead = db.prepare("SELECT c.lead_asset_id l FROM clusters c JOIN assets a ON a.id=c.lead_asset_id WHERE c.id=? AND TRIM(COALESCE(a.rights_note,''))<>''").get(cid)?.l; if (!lead) return 0; const src = db.prepare('SELECT s.name FROM assets a JOIN articles ar ON ar.id=a.origin_article_id JOIN sources s ON s.id=ar.source_id WHERE a.id=?').get(lead)?.name ?? null;
  return db.prepare("UPDATE publications SET photo_asset_id=?, photo_credit=COALESCE(photo_credit,?), updated_at=? WHERE cluster_id=? AND status='published' AND photo_asset_id IS NULL").run(lead, src, now(), cid).changes;
}
