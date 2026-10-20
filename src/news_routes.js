import { db, now, log } from './db.js';
import { rankClusters, view } from './rank.js';
import { clusterNew } from './cluster.js';
import { enqueue } from './worker.js';
import { listSelections, DEFAULTS as SEL_DEFAULTS, cfg as selCfg } from './selection.js';
import { sourceTextFor, extractFullText } from './extract.js';
import { sourcePolicy } from './bundle.js';
import { pipelineMetrics } from './metrics.js';
import { queueStory, retryEditionJob, enableAutoPublish, autoPublishOn } from './editions.js';

const ED_DEFAULTS = { min_full_words: 150, min_brief_words: 40, min_brief_sentences: 2, caption_regen_max: 2, require_corroboration: false, edition_allow_limited: false };
const readSetting = (k, d) => { const r = db.prepare('SELECT value FROM settings WHERE key=?').get(k); try { return r ? JSON.parse(r.value) : d; } catch { return d; } };
const bad = m => ({ code: 400, body: { error: m } });
const ts = c => Date.parse(c.latest);

// Editorial stage of a story, from real draft/job records.
function editorialMap() {
  const m = new Map();
  for (const d of db.prepare("SELECT cluster_id,status,edited_body FROM drafts WHERE status IN ('needs_review','approved') ORDER BY id").all())
    m.set(d.cluster_id, d.status === 'approved' ? 'approved' : d.edited_body != null ? 'awaiting_approval' : 'needs_review');
  for (const j of db.prepare("SELECT cluster_id,status FROM ai_jobs WHERE status IN ('queued','running','failed') ORDER BY id").all())
    if (j.status !== 'failed' || !m.has(j.cluster_id)) m.set(j.cluster_id, j.status === 'failed' ? 'draft_failed' : 'drafting');
  return m;
}
const decorate = (list, ed) => list.map(c => ({ ...c, editorial: ed.get(c.id) || 'none', articles: undefined, sourceNames: [...new Set(c.articles.map(a => a.source))], article_count: c.articles.length }));
const periodH = { '1h': 1, '6h': 6, '24h': 24, '7d': 168 };

const R = [
  ['GET', /^\/api\/newsroom$/, () => {
    clusterNew(); const ed = editorialMap(), all = rankClusters(), live = all.filter(c => !c.rejected);
    const top = decorate(view('now').slice(0, 14), ed), byCat = {};
    for (const c of top) (byCat[c.category] ??= []).push(c);
    const src = db.prepare('SELECT id,name,status,last_error,last_success_at FROM sources WHERE enabled=1').all();
    const q = (sql) => db.prepare(sql).get().n;
    return {
      top, breaking: decorate(view('breaking').slice(0, 4), ed), verify: decorate(view('verify').slice(0, 5), ed),
      latest: decorate([...live].sort((a, b) => ts(b) - ts(a)).slice(0, 10), ed),
      sections: Object.entries(byCat).filter(([, v]) => v.length >= 2).slice(0, 2).map(([category, items]) => ({ category, items: items.slice(0, 4) })),
      queue: { drafting: q("SELECT COUNT(*) n FROM ai_jobs WHERE status IN ('queued','running')"), needs_review: q("SELECT COUNT(*) n FROM drafts WHERE status='needs_review' AND edited_body IS NULL"),
        awaiting_approval: q("SELECT COUNT(*) n FROM drafts WHERE status='needs_review' AND edited_body IS NOT NULL"), approved: q("SELECT COUNT(*) n FROM drafts WHERE status='approved'"), scheduled: 0, published: 0, failed_jobs: q("SELECT COUNT(*) n FROM ai_jobs WHERE status='failed'") },
      publishing: { connected: false, recent: [] }, selections: listSelections(6).map(x => ({ ...x, factors: undefined })),
      health: { total: src.length, working: src.filter(s => s.status === 'working').length, problems: src.filter(s => s.status !== 'working').map(s => ({ id: s.id, name: s.name, status: s.status, error: s.last_error })), last_success: src.map(s => s.last_success_at).filter(Boolean).sort().at(-1) ?? null },
      stats: { stories: q('SELECT COUNT(*) n FROM articles'), last24h: q(`SELECT COUNT(*) n FROM articles WHERE fetched_at>='${new Date(Date.now() - 864e5).toISOString()}'`), clusters: live.length },
    };
  }],
  ['GET', /^\/api\/news$/, ({ url }) => {
    clusterNew(); const g = k => url.searchParams.get(k) || '', ed = editorialMap(), vw = g('view') || 'latest';
    let list = vw === 'latest' || vw === 'top' ? rankClusters().filter(c => !c.rejected) : view(vw);
    if (!list) return bad('unknown view');
    const q = g('q').toLowerCase().trim(), cat = g('category'), src = +g('source') || 0, lang = g('language'), per = periodH[g('period')], st = g('status');
    list = list.filter(c => (!q || c.articles.some(a => a.title.toLowerCase().includes(q))) && (!cat || c.category === cat) && (!src || c.articles.some(a => a.source_id === src))
      && (!lang || c.lead.language === lang) && (!per || c.ageH <= per) && (!st || (ed.get(c.id) || 'none') === st));
    const sort = g('sort') || (vw === 'latest' ? 'time' : 'score');
    list.sort((a, b) => b.pinned - a.pinned || (sort === 'time' ? ts(b) - ts(a) : b.score - a.score));
    const page = Math.max(1, +g('page') || 1), size = 20;
    return { total: list.length, page, pages: Math.ceil(list.length / size), items: decorate(list.slice((page - 1) * size, page * size), ed) };
  }],
  ['GET', /^\/api\/story\/(\d+)$/, ({ m }) => {
    const id = +m[1], cl = db.prepare('SELECT * FROM clusters WHERE id=?').get(id); if (!cl) return { code: 404, body: { error: 'story not found' } };
    const arts = db.prepare(`SELECT a.id,a.title,a.url,a.summary,substr(a.content,1,2500) content,length(a.content) content_len,length(a.full_text) full_len,a.author,a.extraction_method,a.extracted_at,s.fulltext_enabled,s.ai_policy,a.published_at,a.fetched_at,a.image_url,a.language,a.extraction_status,a.source_id,s.name source
      FROM articles a JOIN sources s ON s.id=a.source_id WHERE a.cluster_id=? ORDER BY COALESCE(a.published_at,a.fetched_at) DESC`).all(id);
    const lead = db.prepare('SELECT a.*, s.name source FROM articles a JOIN sources s ON s.id=a.source_id WHERE a.cluster_id=? ORDER BY length(COALESCE(a.full_text,\'\'))+length(COALESCE(a.content,\'\'))+length(a.summary) DESC LIMIT 1').get(id), st = lead ? sourceTextFor(lead) : null;
    const sel = db.prepare("SELECT slot_start,slot_end,score FROM selections WHERE cluster_id=? AND status='selected'").get(id) ?? null;
    return { cluster: cl, hourly_pick: sel, source_text: st && { origin: st.origin, words: st.words, level: st.level, article_id: lead.id, status: lead.extraction_status }, rank: rankClusters().find(c => c.id === id) ?? null, articles: arts, editorial: editorialMap().get(id) || 'none',
      drafts: db.prepare('SELECT id,lang,status,workflow,model,created_at,approved_at,flags FROM drafts WHERE cluster_id=? ORDER BY id DESC').all(id).map(d => ({ ...d, flags: JSON.parse(d.flags) })),
      job: db.prepare("SELECT status,attempts,error FROM ai_jobs WHERE cluster_id=? ORDER BY id DESC LIMIT 1").get(id) ?? null };
  }],
  ['GET', /^\/api\/selections$/, () => listSelections(48).map(x => ({ ...x, factors: x.factors ? JSON.parse(x.factors) : null }))],
  ['GET', /^\/api\/selection\/settings$/, () => ({ defaults: SEL_DEFAULTS, effective: selCfg(), stored: Object.fromEntries(Object.keys(SEL_DEFAULTS).map(k => [k, (() => { const r = db.prepare('SELECT value FROM settings WHERE key=?').get(k); return r ? JSON.parse(r.value) : null; })()])) })],
  ['PUT', /^\/api\/selection\/settings$/, ({ body: b }) => {
    const rules = { select_window_min: [5, 1440], select_grace_min: [0, 120], select_min_score: [0, 100], select_min_sources: [1, 20], select_lateness_h: [0, 72], select_dup_similarity: [0.3, 1], select_tz_offset_min: [-720, 840] };
    for (const [k, [lo, hi]] of Object.entries(rules)) if (k in b) { const v = +b[k]; if (!(v >= lo && v <= hi)) return bad(`${k} must be ${lo}-${hi}`); db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(k, JSON.stringify(v)); }
    if ('select_auto_draft' in b) db.prepare("INSERT INTO settings(key,value) VALUES('select_auto_draft',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(!!b.select_auto_draft));
    log('selection_settings', JSON.stringify(b)); return { ok: true };
  }],
  ['POST', /^\/api\/story\/(\d+)\/extract$/, async ({ m }) => {
    const lead = db.prepare('SELECT a.id FROM articles a WHERE a.cluster_id=? ORDER BY length(COALESCE(a.full_text,\'\'))+length(COALESCE(a.content,\'\'))+length(a.summary) DESC LIMIT 1').get(+m[1]); if (!lead) return { code: 404, body: { error: 'story not found' } };
    return await extractFullText(lead.id, { force: true });
  }],
  ['POST', /^\/api\/sources\/(\d+)\/check-policy$/, async ({ m }) => { db.prepare('UPDATE sources SET ai_policy=NULL WHERE id=?').run(+m[1]); return await sourcePolicy(+m[1]); }],
  ['POST', /^\/api\/sources\/fetch-all$/, () => {
    let n = 0; for (const s of db.prepare('SELECT id FROM sources WHERE enabled=1').all()) { enqueue(s.id); db.prepare("UPDATE jobs SET run_at=? WHERE source_id=? AND status='queued'").run(now(), s.id); n++; }
    log('manual_fetch', `all enabled sources (${n})`); return { queued: n };
  }],
  ['GET', /^\/api\/pipeline\/metrics$/, ({ url }) => pipelineMetrics(Math.min(168, Math.max(1, +url?.searchParams?.get('hours') || 24)))],
  ['GET', /^\/api\/pipeline$/, () => ({ auto_publish: autoPublishOn(), jobs: db.prepare(`SELECT j.*, (SELECT title FROM articles WHERE cluster_id=j.cluster_id ORDER BY length(summary) DESC LIMIT 1) title,
      NULL x FROM edition_jobs j ORDER BY j.id DESC LIMIT 200`).all().map(({ x, ...j }) => j),
    counts: Object.fromEntries(db.prepare('SELECT status, COUNT(*) n FROM edition_jobs GROUP BY status').all().map(r => [r.status, r.n])) })],
  ['GET', /^\/api\/editorial\/settings$/, () => ({ ...ED_DEFAULTS, ...Object.fromEntries(Object.keys(ED_DEFAULTS).map(k => [k, readSetting(k, ED_DEFAULTS[k])])) })],
  ['PUT', /^\/api\/editorial\/settings$/, ({ body: b }) => {
    for (const [k, d] of Object.entries(ED_DEFAULTS)) if (k in b) { const v = typeof d === 'boolean' ? !!b[k] : Math.round(+b[k]); if (typeof d === 'number' && !(v >= 0 && v <= 5000)) return bad(`${k} must be a number between 0 and 5000`); db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, JSON.stringify(v)); }
    log('editorial_settings', Object.keys(b).join(',')); return { ok: true };
  }],
  ['POST', /^\/api\/pipeline\/auto$/, ({ body }) => { enableAutoPublish(!!body.on); log('auto_publish', String(!!body.on)); return { auto_publish: autoPublishOn() }; }],
  ['POST', /^\/api\/pipeline\/story\/(\d+)$/, ({ m }) => { if (!db.prepare('SELECT 1 FROM clusters WHERE id=?').get(+m[1])) return { code: 404, body: { error: 'story not found' } }; return { queued: queueStory(+m[1], 'manual', 1) }; }],
  ['POST', /^\/api\/pipeline\/(\d+)\/retry$/, ({ m }) => retryEditionJob(+m[1]) ? { ok: true } : { code: 409, body: { error: 'only failed, ready or review jobs can be retried' } }],
];

export async function newsRoute(req, url, readBody) {
  for (const [method, re, fn] of R) {
    if (method !== req.method) continue; const m = url.pathname.match(re); if (!m) continue;
    const r = await fn({ m, url, body: method === 'GET' ? {} : await readBody(req) }); return r?.code ? r : { code: 200, body: r };
  }
  return null;
}
