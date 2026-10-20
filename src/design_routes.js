// Server side of the layered graphic editor: build a document for a story, preview it, save it as an article graphic (never touching shared
// templates), and manage templates with explicit overwrite rules and a version history.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { db, now, log, DATA } from './db.js';
import { renderDoc, docFromSpec } from './render_doc.js';
import { sanitizeDoc, convertCanvas, CANVAS_PRESETS, DOC_VERSION } from './design_geom.js';
import { assetPath, serial, nepaliDate, cleanSpec } from './graphic_routes.js';
import { DEFAULT_SPEC } from './render.js';
import { brandLogoId, brandLogoPath } from './brand_logo.js';
import { graphicTexts, currentHeadline } from './headline.js';

const bad = (m, code = 400, extra = {}) => ({ code, body: { error: m, ...extra } });
const J = s => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
const CAT = { politics: 'राजनीति', election: 'निर्वाचन', crime: 'अपराध', health: 'स्वास्थ्य', disaster: 'विपद्', economy: 'अर्थतन्त्र', sports: 'खेलकुद' };
const STORY_ROLES = new Set(['headline', 'subheadline', 'category', 'date', 'source']);

export function storyDefaults(cid, lang) {
  const cl = db.prepare('SELECT * FROM clusters WHERE id=?').get(cid); if (!cl) return null;
  const drafts = db.prepare("SELECT * FROM drafts WHERE cluster_id=? AND status<>'superseded' ORDER BY (status='approved') DESC, id DESC").all(cid), d = (lang && drafts.find(x => x.lang === lang)) || drafts[0] || null;
  const t = d ? graphicTexts(d) : null, fallback = db.prepare('SELECT title FROM articles WHERE cluster_id=? ORDER BY length(summary) DESC LIMIT 1').get(cid)?.title ?? '';
  return { cluster: cl, draft: d, headline: t?.h || (d ? currentHeadline(d) : '') || fallback, subheadline: t?.s ?? '', date: nepaliDate(), category: CAT[cl.category] ?? '', lead: cl.lead_asset_id ?? null };
}
// Story text goes into the elements by ROLE; a template never carries one story's words.
export function fillDoc(doc, def, photoId) {
  const text = { headline: def.headline, subheadline: def.subheadline, category: def.category, date: def.date, source: '' };
  for (const e of doc.elements) {
    if (e.type === 'text' && STORY_ROLES.has(e.role) && e.role in text) { if (e.role === 'date' && e.text?.trim()) e.text = [def.date].filter(Boolean).join('  ·  '); else e.text = text[e.role] ?? ''; if (e.role === 'subheadline') e.text = e.text.replace(/\[\[|\]\]/g, ''); }
    if (e.type === 'image' && e.role === 'photo') e.asset = photoId ?? null;
  }
  return doc;
}
export const templateDoc = doc => { const d = sanitizeDoc(doc); for (const e of d.elements) { if (e.type === 'text' && STORY_ROLES.has(e.role)) e.text = ''; if (e.type === 'image') e.asset = e.role === 'logo' ? (e.asset === null ? null : 'logo') : 'photo'; } return d; };

// which files a document may use: this story's photos, any logo, nothing else
function resolver(cid, photoId, logoId) {
  const okAsset = id => { const a = db.prepare('SELECT kind,cluster_id FROM assets WHERE id=?').get(id); return a && ((a.kind === 'photo' && a.cluster_id === cid) || a.kind === 'logo') ? assetPath(id) : null; };
  return { byRef: ref => (ref === 'photo' ? (photoId ? okAsset(+photoId) : null) : ref === 'logo' ? ((logoId || brandLogoId()) ? okAsset(+(logoId || brandLogoId())) : null) : Number.isInteger(ref) ? okAsset(ref) : null) };
}
function assetProblem(doc, cid) {
  for (const e of doc.elements) if (e.type === 'image' && Number.isInteger(e.asset)) { const a = db.prepare('SELECT kind,cluster_id FROM assets WHERE id=?').get(e.asset); if (!a) return `"${e.name}" refers to an image that does not exist.`; if (a.kind === 'photo' && a.cluster_id !== cid) return 'That photo belongs to a different story. Upload or adopt an image for this story.'; }
  return null;
}
const TEMPLATE_V1_FORMATS = new Set(['portrait', 'square', 'landscape', 'vertical']);
async function buildDoc(cid, templateId, lang, format) {
  const def = storyDefaults(cid, lang); if (!def) return null;
  const t = templateId ? db.prepare('SELECT * FROM templates WHERE id=?').get(templateId) : db.prepare('SELECT * FROM templates ORDER BY id LIMIT 1').get(); if (!t) return null; const spec = J(t.spec), photoPath = def.lead ? assetPath(def.lead) : null;
  let doc;
  if (spec.version === DOC_VERSION) doc = fillDoc(sanitizeDoc(spec), def, def.lead);
  else { const fmt = TEMPLATE_V1_FORMATS.has(format) ? format : TEMPLATE_V1_FORMATS.has(spec.format) ? spec.format : 'portrait'; doc = await docFromSpec({ ...DEFAULT_SPEC, ...cleanSpec(spec), format: fmt, headline: def.headline, subheadline: def.subheadline, dateText: def.date, sourceText: '', category: def.category }, { photoPath, photoAsset: def.lead ?? null, logoPath: brandLogoPath(), logoAsset: 'logo' }); doc = fillDoc(doc, def, def.lead); }
  const want = CANVAS_PRESETS[format]; if (want && (doc.canvas.w !== want.w || doc.canvas.h !== want.h)) { doc = convertCanvas(doc, want.w, want.h, 'scale'); doc.meta = { ...doc.meta, format }; }
  return { doc: sanitizeDoc(doc), template: { id: t.id, name: t.name, updated_at: t.updated_at ?? t.created_at, version: spec.version ?? 1 }, defaults: { lead_asset_id: def.lead, draft_id: def.draft?.id ?? null, lang: def.draft?.lang ?? null }, presets: CANVAS_PRESETS };
}

export async function saveDocGraphic(b) {
  const cid = +b.cluster_id; if (!db.prepare('SELECT 1 FROM clusters WHERE id=?').get(cid)) return bad('unknown story');
  let doc; try { doc = sanitizeDoc(b.doc); } catch (e) { return bad('Invalid design: ' + e.message); }
  const prob = assetProblem(doc, cid); if (prob) return bad(prob, 409);
  const draft = b.draft_id ? db.prepare('SELECT * FROM drafts WHERE id=? AND cluster_id=?').get(+b.draft_id, cid) : null; if (b.draft_id && !draft) return bad('unknown draft');
  const photoEl = doc.elements.find(e => e.type === 'image' && e.role === 'photo'), logoEl = doc.elements.find(e => e.type === 'image' && e.role === 'logo');
  const photoId = Number.isInteger(photoEl?.asset) ? photoEl.asset : (photoEl?.asset === 'photo' ? (+b.photoAssetId || null) : null), logoId = Number.isInteger(logoEl?.asset) ? logoEl.asset : (logoEl && (logoEl.asset === 'logo' || logoEl.asset == null) ? (+b.logoAssetId || brandLogoId() || null) : null);
  const outFormat = b.outFormat === 'jpeg' ? 'jpeg' : 'png', fmt = doc.meta.format || 'custom';
  const cur = () => db.prepare("SELECT MAX(id) id FROM graphics WHERE cluster_id=? AND COALESCE(draft_id,0)=COALESCE(?,0) AND format=? AND status='current'").get(cid, draft?.id ?? null, fmt).id ?? null;
  if (b.strict && (cur() ?? null) !== (b.base_graphic_id ?? null)) return bad('A newer version of this graphic was saved by someone else. Reload to see it, or save as a copy; nothing was overwritten.', 409, { current_graphic_id: cur() });
  const r = await serial(() => renderDoc(doc, resolver(cid, photoId, logoId), { outFormat })), blocking = r.warnings.find(w => w.severity === 'error'); if (blocking) return bad(`Cannot save: ${blocking.message}`);
  const head = doc.elements.find(e => e.role === 'headline' && e.type === 'text')?.text ?? '', sub = doc.elements.find(e => e.role === 'subheadline' && e.type === 'text')?.text ?? '';
  const dir = path.join(DATA, 'graphics', String(cid)); mkdirSync(dir, { recursive: true });
  db.exec('BEGIN');
  try {
    db.prepare("UPDATE graphics SET status='superseded' WHERE cluster_id=? AND COALESCE(draft_id,0)=COALESCE(?,0) AND format=? AND status='current'").run(cid, draft?.id ?? null, fmt);
    const id = Number(db.prepare('INSERT INTO graphics(cluster_id,draft_id,template_id,photo_asset_id,logo_asset_id,spec,headline_snapshot,path,format,mime,width,height,bytes,warnings,created_at,subheadline_snapshot) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(cid, draft?.id ?? null, +b.template_id || null, photoId, logoId, JSON.stringify(doc), head, '', fmt, r.mime, r.width, r.height, r.image.length, JSON.stringify(r.warnings), now(), sub).lastInsertRowid);
    const file = path.join(dir, `${id}.${outFormat === 'jpeg' ? 'jpg' : 'png'}`); writeFileSync(file, r.image); db.prepare('UPDATE graphics SET path=? WHERE id=?').run(file, id); db.exec('COMMIT');
    log('graphic_saved', `graphic ${id} story ${cid} ${fmt} (document)`); return { id, warnings: r.warnings, bytes: r.image.length, width: r.width, height: r.height, unapproved: !!draft && draft.status !== 'approved' };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

/* ---- templates ---- */
const snapshot = t => { const v = (db.prepare('SELECT MAX(version) v FROM template_versions WHERE template_id=?').get(t.id).v ?? 0) + 1; db.prepare('INSERT INTO template_versions(template_id,version,name,spec,saved_at) VALUES(?,?,?,?,?)').run(t.id, v, t.name, t.spec, now()); return v; };
const prepSpec = spec => (spec?.version === DOC_VERSION ? templateDoc(spec) : { ...cleanSpec(spec), headline: '', subheadline: '', dateText: '', sourceText: '', category: '' });
const txt60 = v => String(v ?? '').replace(/[\u0000-\u001F]/g, '').trim().slice(0, 60);
export function saveTemplate(b) { // create only: an existing name is never silently replaced
  const name = txt60(b.name); if (!name) return bad('template name required'); let spec; try { spec = prepSpec(b.spec); } catch (e) { return bad('Invalid design: ' + e.message); }
  const ex = db.prepare('SELECT * FROM templates WHERE name=?').get(name);
  if (ex) { if (!b.overwrite) return bad(`A template named “${name}” already exists. Choose another name, or confirm that you want to replace it.`, 409, { exists: true, id: ex.id, updated_at: ex.updated_at ?? ex.created_at });
    if (b.expected_updated_at && b.expected_updated_at !== (ex.updated_at ?? ex.created_at)) return bad('That template was changed by someone else after you opened it. Reload it first; nothing was overwritten.', 409, { updated_at: ex.updated_at ?? ex.created_at });
    snapshot(ex); db.prepare('UPDATE templates SET spec=?,updated_at=? WHERE id=?').run(JSON.stringify(spec), now(), ex.id); log('template_updated', `${ex.id} ${name}`); return { ok: true, id: ex.id, updated_at: db.prepare('SELECT updated_at u FROM templates WHERE id=?').get(ex.id).u }; }
  const ts = now(), id = Number(db.prepare('INSERT INTO templates(name,spec,created_at,updated_at) VALUES(?,?,?,?)').run(name, JSON.stringify(spec), ts, ts).lastInsertRowid); log('template_created', `${id} ${name}`); return { ok: true, id, updated_at: ts };
}
const R = [
  ['GET', /^\/api\/design\/(\d+)\/doc$/, async ({ m, url }) => { const q = url.searchParams, r = await buildDoc(+m[1], +q.get('template_id') || null, q.get('lang') || '', q.get('format') || ''); return r ?? bad('story or template not found', 404); }],
  ['POST', /^\/api\/graphics\/preview-doc$/, async ({ body: b }) => {
    const cid = +b.cluster_id; let doc; try { doc = sanitizeDoc(b.doc); } catch (e) { return bad('Invalid design: ' + e.message); } const prob = assetProblem(doc, cid); if (prob) return bad(prob, 409);
    const r = await serial(() => renderDoc(doc, resolver(cid, +b.photoAssetId || null, +b.logoAssetId || null), { scale: +b.scale || 0.5 }));
    return { png: r.image.toString('base64'), width: r.width, height: r.height, designWidth: r.designWidth, designHeight: r.designHeight, warnings: r.warnings, metrics: r.metrics };
  }],
  ['GET', /^\/api\/templates\/(\d+)\/versions$/, ({ m }) => db.prepare('SELECT version,name,saved_at FROM template_versions WHERE template_id=? ORDER BY version DESC').all(+m[1])],
  ['PUT', /^\/api\/templates\/(\d+)$/, ({ m, body: b }) => { // explicit update of a shared template
    const t = db.prepare('SELECT * FROM templates WHERE id=?').get(+m[1]); if (!t) return bad('not found', 404); if ((b.expected_updated_at ?? null) !== (t.updated_at ?? t.created_at)) return bad('That template was changed by someone else after you opened it. Reload it first; nothing was overwritten.', 409, { updated_at: t.updated_at ?? t.created_at });
    let spec; try { spec = prepSpec(b.spec); } catch (e) { return bad('Invalid design: ' + e.message); } const name = b.name ? txt60(b.name) : t.name; if (name !== t.name && db.prepare('SELECT 1 FROM templates WHERE name=? AND id<>?').get(name, t.id)) return bad('Another template already has that name.', 409);
    snapshot(t); const ts = now(); db.prepare('UPDATE templates SET name=?,spec=?,updated_at=? WHERE id=?').run(name, JSON.stringify(spec), ts, t.id); log('template_updated', `${t.id} ${name}`); return { ok: true, updated_at: ts };
  }],
  ['POST', /^\/api\/templates\/(\d+)\/duplicate$/, ({ m, body: b }) => {
    const t = db.prepare('SELECT * FROM templates WHERE id=?').get(+m[1]); if (!t) return bad('not found', 404); let name = txt60(b.name) || `${t.name} copy`, n = 1; while (db.prepare('SELECT 1 FROM templates WHERE name=?').get(name)) name = `${txt60(b.name) || t.name + ' copy'} ${++n}`;
    const ts = now(), id = Number(db.prepare('INSERT INTO templates(name,spec,created_at,updated_at) VALUES(?,?,?,?)').run(name, t.spec, ts, ts).lastInsertRowid); return { ok: true, id, name };
  }],
  ['POST', /^\/api\/templates\/(\d+)\/restore$/, ({ m, body: b }) => {
    const t = db.prepare('SELECT * FROM templates WHERE id=?').get(+m[1]), v = db.prepare('SELECT * FROM template_versions WHERE template_id=? AND version=?').get(+m[1], +b.version); if (!t || !v) return bad('version not found', 404);
    if ((b.expected_updated_at ?? null) !== (t.updated_at ?? t.created_at)) return bad('That template changed after you opened it; reload first.', 409);
    snapshot(t); const ts = now(); db.prepare('UPDATE templates SET spec=?,updated_at=? WHERE id=?').run(v.spec, ts, t.id); log('template_restored', `${t.id} v${v.version}`); return { ok: true, updated_at: ts };
  }],
];
export async function designRoute(req, url, readBody) {
  for (const [method, re, fn] of R) {
    if (method !== req.method) continue; const m = url.pathname.match(re); if (!m) continue;
    const r = await fn({ m, url, req, body: method === 'GET' || method === 'DELETE' ? {} : await readBody(req) }); return r?.code ? r : { code: 200, body: r };
  }
  return null;
}
