import { db, now, log } from './db.js';
import { getCfg, setCfg, keyConfigured, complete, refreshPricing } from './ai.js';
import { enqueueDraft, getStyle, DEFAULT_STYLE } from './editorial.js';
import { runChecks } from './checks.js';
import { PROVIDERS, routerCfg, setRouterCfg, addKey, setKeyEnabled, deleteKey, syncEnvKeys, maskKey, usageToday, spentToday, testConnection, ensureProvider } from './ai_router.js';
import { updateDraft, approveDraft, DraftError, effective } from './drafts.js';

const J = s => (s ? JSON.parse(s) : null);
const draftRow = d => ({ ...d, source_snapshot: J(d.source_snapshot), headline_options: J(d.headline_options), secondary_phrases: J(d.secondary_phrases), hashtags: J(d.hashtags), flags: J(d.flags) });
const bad = m => ({ code: 400, body: { error: m } });
const text = (v, max) => typeof v === 'string' && v.length <= max;

// Each route: [method, pattern, handler({m, body})] -> value | {code, body}
const R = [
  ['GET', /^\/api\/ai\/config$/, () => ({ ...getCfg(), key_configured: keyConfigured() })],
  ['PUT', /^\/api\/ai\/config$/, ({ body: b }) => {
    if (!/^https?:\/\/[^\s]+$/.test(b.base_url || '')) return bad('base_url must be an http(s) URL');
    if (!/^[\w./:@-]{2,100}$/.test(b.model || '')) return bad('invalid model id');
    const pi = +b.price_in, po = +b.price_out; if (!(pi >= 0 && po >= 0)) return bad('prices must be >= 0');
    const mt = b.max_tokens === undefined ? getCfg().max_tokens : Math.round(+b.max_tokens); if (!(mt >= 500 && mt <= 32000)) return bad('max_tokens must be 500-32000');
    const mtb = b.max_tokens_bundle === undefined ? getCfg().max_tokens_bundle : Math.round(+b.max_tokens_bundle); if (!(mtb >= 2000 && mtb <= 40000)) return bad('max_tokens_bundle must be 2000-40000');
    const old = getCfg(); setCfg({ max_tokens: mt, max_tokens_bundle: mtb, base_url: b.base_url, model: b.model, price_in: pi, price_out: po, pricing_source: old.model === b.model && old.price_in === pi && old.price_out === po ? old.pricing_source : 'manual' });
    log('ai_config', `${b.base_url} ${b.model}`); return { ok: true };
  }],
  ['POST', /^\/api\/ai\/pricing$/, async () => { try { return await refreshPricing(); } catch (e) { return bad(e.message); } }],
  ['POST', /^\/api\/ai\/test$/, async () => {
    try { const r = await complete({ system: 'Reply with JSON only.', user: 'Return {"ok":true,"nepali":"नमस्ते"}', purpose: 'test', maxTokens: 200 }); return { ok: true, model: r.model, reply: r.text.slice(0, 200), usage: r.usage }; }
    catch (e) { return { ok: false, error: e.message }; }
  }],
  ['GET', /^\/api\/ai\/credit$/, async () => { // what OpenRouter itself reports for this key (nothing secret is returned)
    if (!keyConfigured()) return { error: 'OPENROUTER_API_KEY is not set' };
    try { const h = { authorization: `Bearer ${process.env.OPENROUTER_API_KEY.trim()}` }, base = getCfg().base_url.replace(/\/$/, '');
      const [k, c] = await Promise.all([fetch(base + '/key', { headers: h, signal: AbortSignal.timeout(15000) }).then(r => r.json()), fetch(base + '/credits', { headers: h, signal: AbortSignal.timeout(15000) }).then(r => r.json()).catch(() => ({}))]);
      const credits = c.data?.total_credits ?? null, used = c.data?.total_usage ?? k.data?.usage ?? null; return { model: getCfg().model, usage: used, credits, remaining: credits != null && used != null ? +(credits - used).toFixed(4) : (k.data?.limit_remaining ?? null), free_tier: !!k.data?.is_free_tier };
    } catch (e) { return { error: e.message }; } }],
  ['GET', /^\/api\/ai\/usage$/, () => ({
    totals: db.prepare("SELECT COUNT(*) calls, SUM(ok) ok, SUM(1-ok) failed, SUM(tokens_in) tin, SUM(tokens_out) tout, SUM(cost) cost FROM ai_usage").get(),
    byModel: db.prepare('SELECT model, COUNT(*) calls, SUM(tokens_in) tin, SUM(tokens_out) tout, SUM(cost) cost FROM ai_usage GROUP BY model').all(),
    drafts: db.prepare("SELECT COUNT(*) n FROM drafts").get().n, recent: db.prepare('SELECT at,purpose,model,ok,tokens_in,tokens_out,cost,cost_source,error FROM ai_usage ORDER BY id DESC LIMIT 15').all() })],
  ['GET', /^\/api\/ai\/providers$/, () => {
    syncEnvKeys(); const cfg = routerCfg();
    return { router: cfg, spent_today: +spentToday(cfg).toFixed(4), providers: Object.entries(PROVIDERS).map(([id, d]) => { ensureProvider(id); const p = db.prepare('SELECT * FROM ai_providers WHERE provider=?').get(id);
      return { id, label: d.label, default_base: d.base, env_var: d.env, enabled: !!p.enabled, base_url: p.base_url, daily_requests: p.daily_requests, daily_tokens: p.daily_tokens, usage_today: usageToday(id),
        keys: db.prepare('SELECT * FROM ai_keys WHERE provider=? ORDER BY id').all(id).map(k => ({ ...maskKey(k), cooldown_until: k.cooldown_until > now() ? k.cooldown_until : null, last_error: k.last_error, last_ok_at: k.last_ok_at, remaining_requests: k.remaining_requests, remaining_tokens: k.remaining_tokens, quota_reset_at: k.quota_reset_at })), // quota fields are null when the provider does not report them
        models: db.prepare('SELECT * FROM ai_models WHERE provider=? ORDER BY priority,id').all(id).map(m => ({ ...m, enabled: !!m.enabled, is_free: !!m.is_free, cooldown_until: m.cooldown_until > now() ? m.cooldown_until : null })) }; }) };
  }],
  ['PUT', /^\/api\/ai\/router$/, ({ body: b }) => { try { return setRouterCfg(b); } catch (e) { return bad(e.message); } }],
  ['PUT', /^\/api\/ai\/providers\/(\w+)$/, ({ m, body: b }) => {
    if (!PROVIDERS[m[1]]) return bad('unknown provider'); ensureProvider(m[1]); const cur = db.prepare('SELECT * FROM ai_providers WHERE provider=?').get(m[1]), n = v => (v === null || v === '' || v === undefined ? null : Math.round(+v));
    const dr = 'daily_requests' in b ? n(b.daily_requests) : cur.daily_requests, dt = 'daily_tokens' in b ? n(b.daily_tokens) : cur.daily_tokens; if ((dr != null && !(dr >= 0)) || (dt != null && !(dt >= 0))) return bad('budgets must be numbers >= 0');
    let base = 'base_url' in b ? (b.base_url || null) : cur.base_url; if (base && !/^https:\/\/[^\s]+$|^http:\/\/(127\.0\.0\.1|localhost)[:/][^\s]*$/.test(base)) return bad('base_url must be https (http only for localhost)');
    db.prepare('UPDATE ai_providers SET enabled=?,base_url=?,daily_requests=?,daily_tokens=?,updated_at=? WHERE provider=?').run('enabled' in b ? (b.enabled ? 1 : 0) : cur.enabled, base, dr, dt, now(), m[1]); log('ai_provider', `${m[1]} enabled=${'enabled' in b ? !!b.enabled : !!cur.enabled}`); return { ok: true };
  }],
  ['POST', /^\/api\/ai\/providers\/(\w+)\/keys$/, ({ m, body: b }) => { try { return { id: addKey(m[1], b.label, b.key) }; } catch (e) { return bad(e.message); } }], // the key is accepted once and is never returned
  ['PUT', /^\/api\/ai\/keys\/(\d+)$/, ({ m, body: b }) => setKeyEnabled(+m[1], !!b.enabled) ? { ok: true } : { code: 404, body: { error: 'not found' } }],
  ['DELETE', /^\/api\/ai\/keys\/(\d+)$/, ({ m }) => deleteKey(+m[1]) ? { ok: true } : { code: 404, body: { error: 'not found' } }],
  ['POST', /^\/api\/ai\/providers\/(\w+)\/models$/, ({ m, body: b }) => {
    if (!PROVIDERS[m[1]]) return bad('unknown provider'); if (!/^[\w./:@+-]{2,120}$/.test(b.model || '')) return bad('invalid model id'); ensureProvider(m[1]);
    const langs = String(b.langs || 'en,ne').split(',').map(x => x.trim()).filter(x => ['en', 'ne'].includes(x)); if (!langs.length) return bad('langs must include en and/or ne');
    const num = v => (v === undefined || v === null || v === '' ? null : +v); if ([b.price_in, b.price_out, b.max_output_tokens].some(v => num(v) != null && !(num(v) >= 0))) return bad('prices and limits must be numbers >= 0');
    try { return { id: Number(db.prepare('INSERT INTO ai_models(provider,model,enabled,is_free,price_in,price_out,langs,max_output_tokens,priority) VALUES(?,?,?,?,?,?,?,?,?)').run(m[1], b.model, b.enabled ? 1 : 0, b.is_free ? 1 : 0, num(b.price_in), num(b.price_out), langs.join(','), num(b.max_output_tokens), Math.round(+b.priority || 100)).lastInsertRowid) }; } catch { return bad('that model is already added'); }
  }],
  ['PUT', /^\/api\/ai\/models\/(\d+)$/, ({ m, body: b }) => {
    const cur = db.prepare('SELECT * FROM ai_models WHERE id=?').get(+m[1]); if (!cur) return { code: 404, body: { error: 'not found' } };
    db.prepare('UPDATE ai_models SET enabled=?,is_free=?,priority=? WHERE id=?').run('enabled' in b ? (b.enabled ? 1 : 0) : cur.enabled, 'is_free' in b ? (b.is_free ? 1 : 0) : cur.is_free, 'priority' in b ? Math.round(+b.priority || 100) : cur.priority, cur.id); return { ok: true };
  }],
  ['DELETE', /^\/api\/ai\/models\/(\d+)$/, ({ m }) => db.prepare('DELETE FROM ai_models WHERE id=?').run(+m[1]).changes ? { ok: true } : { code: 404, body: { error: 'not found' } }],
  ['POST', /^\/api\/ai\/providers\/(\w+)\/test$/, async ({ m, body: b }) => { try { return await testConnection(m[1], +b.key_id, b.model || null); } catch (e) { return bad(e.message); } }],
  ['GET', /^\/api\/glossary$/, () => db.prepare('SELECT * FROM glossary ORDER BY en').all()],
  ['POST', /^\/api\/glossary$/, ({ body: b }) => {
    const en = (b.en || '').trim(), ne = (b.ne || '').trim(); if (!en || !ne || en.length > 100 || ne.length > 100) return bad('en and ne required (<=100 chars)');
    db.prepare('INSERT INTO glossary(en,ne) VALUES(?,?) ON CONFLICT(en) DO UPDATE SET ne=excluded.ne').run(en, ne); return { ok: true };
  }],
  ['DELETE', /^\/api\/glossary\/(\d+)$/, ({ m }) => { db.prepare('DELETE FROM glossary WHERE id=?').run(+m[1]); return { ok: true }; }],
  ['GET', /^\/api\/style-guide$/, () => ({ text: getStyle(), default: DEFAULT_STYLE })],
  ['PUT', /^\/api\/style-guide$/, ({ body: b }) => { if (!text(b.text, 4000) || !b.text.trim()) return bad('style guide required (<=4000 chars)'); db.prepare("INSERT INTO settings(key,value) VALUES('style_guide',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(b.text); return { ok: true }; }],
  ['POST', /^\/api\/drafts$/, ({ body: b }) => {
    const id = +b.cluster_id; if (!db.prepare('SELECT 1 FROM clusters WHERE id=?').get(id)) return bad('unknown cluster');
    const lang = ['ne', 'en'].includes(b.lang) ? b.lang : 'both'; // default: one request that produces both editions
    if (lang === 'both' && !b.force && db.prepare("SELECT 1 FROM drafts WHERE cluster_id=? AND bundle_id IS NOT NULL AND status IN ('needs_review','approved')").get(id)) return { queued: false, reused: true, message: 'Editions already exist for this story. Use Regenerate to spend a new request.' };
    enqueueDraft(id, lang); log('draft_requested', `cluster ${id} ${lang}${b.force ? ' (forced)' : ''}`); return { queued: true };
  }],
  ['GET', /^\/api\/drafts$/, () => ({
    drafts: db.prepare(`SELECT d.id,d.cluster_id,d.lang,d.bundle_id,d.source_level,d.source_words,d.status,d.workflow,d.created_at,d.approved_at,d.flags,json_extract(d.source_snapshot,'$.headline') headline,json_extract(d.source_snapshot,'$.source') source FROM drafts d ORDER BY d.id DESC LIMIT 100`).all().map(d => ({ ...d, flags: J(d.flags) })),
    jobs: db.prepare(`SELECT j.*, (SELECT title FROM articles WHERE cluster_id=j.cluster_id ORDER BY length(COALESCE(content,''))+length(summary) DESC LIMIT 1) title FROM ai_jobs j WHERE status IN ('queued','running','failed') OR finished_at>? ORDER BY id DESC LIMIT 30`).all(new Date(Date.now() - 36e5).toISOString()) })],
  ['GET', /^\/api\/drafts\/(\d+)$/, ({ m }) => { const d = db.prepare('SELECT * FROM drafts WHERE id=?').get(+m[1]); const cp = d?.bundle_id ? db.prepare("SELECT id,lang,status FROM drafts WHERE bundle_id=? AND lang<>? AND status<>'superseded' ORDER BY id DESC LIMIT 1").get(d.bundle_id, d.lang) : null; return d ? { ...draftRow(d), effective: effective(d), counterpart: cp ?? null, gen_meta: J(d.gen_meta), facts: J(d.facts_json), revisions: db.prepare('SELECT id,at,headline FROM draft_revisions WHERE draft_id=? ORDER BY id DESC').all(d.id) } : { code: 404, body: { error: 'not found' } }; }],
  ['PUT', /^\/api\/drafts\/(\d+)$/, async ({ m, body: b }) => { try { return { ok: true, flags: await updateDraft(+m[1], b) }; } catch (e) { if (e instanceof DraftError) return { code: e.status, body: { error: e.message } }; throw e; } }],
  ['POST', /^\/api\/drafts\/(\d+)\/approve$/, async ({ m, body: b }) => { try { await approveDraft(+m[1], { ack_errors: !!b.ack_errors }); return { ok: true }; } catch (e) { if (e instanceof DraftError) return { code: e.status, body: { error: e.message, flags: e.flags } }; throw e; } }],
];

export async function aiRoute(req, url, readBody) {
  for (const [method, re, fn] of R) {
    if (method !== req.method) continue; const m = url.pathname.match(re); if (!m) continue;
    const body = method === 'GET' || method === 'DELETE' ? {} : await readBody(req);
    const r = await fn({ m, body }); return r?.code ? r : { code: 200, body: r };
  }
  return null;
}
