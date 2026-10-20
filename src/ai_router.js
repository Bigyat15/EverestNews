// Multi-provider routing for generation requests. One OpenAI-compatible adapter, described per provider; every outcome is normalised to the same result / AiError.
// Nothing here creates accounts, rotates identities or tries to beat a limit: a limited key/model simply rests until the provider says it may be used again.
import { db, now, log } from './db.js';
import { encrypt, decrypt } from './secrets.js';

export const PROVIDERS = { // base URLs checked against each provider's public docs; models are NOT preloaded: add and verify them on your own account
  gemini: { label: 'Google Gemini (AI Studio, OpenAI-compatible endpoint)', base: 'https://generativelanguage.googleapis.com/v1beta/openai', env: 'GEMINI_API_KEY', json: false },
  groq: { label: 'Groq', base: 'https://api.groq.com/openai/v1', env: 'GROQ_API_KEY', json: true },
  openrouter: { label: 'OpenRouter', base: 'https://openrouter.ai/api/v1', env: 'OPENROUTER_API_KEY', json: true },
  cerebras: { label: 'Cerebras', base: 'https://api.cerebras.ai/v1', env: 'CEREBRAS_API_KEY', json: false },
  mistral: { label: 'Mistral AI', base: 'https://api.mistral.ai/v1', env: 'MISTRAL_API_KEY', json: true },
  requesty: { label: 'Requesty', base: 'https://router.requesty.ai/v1', env: 'REQUESTY_API_KEY', json: false },
};
export class AiError extends Error { constructor(kind, message, o = {}) { super(message); this.kind = kind; Object.assign(this, o); } }

// ---- settings ----
const DEFAULT_ROUTER = { free_only: false, daily_spend_cap_usd: 1, unknown_call_cost_usd: 0.01, max_attempts: 4, timeout_ms: 75000, provider_concurrency: 2 };
export const routerCfg = () => { const r = db.prepare("SELECT value FROM settings WHERE key='ai_router'").get(); return { ...DEFAULT_ROUTER, ...(r ? JSON.parse(r.value) : {}) }; };
export const setRouterCfg = c => { const n = { ...routerCfg() }; for (const k of Object.keys(DEFAULT_ROUTER)) if (k in c) { const v = k === 'free_only' ? !!c[k] : +c[k]; if (k !== 'free_only' && !(v >= 0)) throw new Error(`${k} must be a number >= 0`); n[k] = v; } db.prepare("INSERT INTO settings(key,value) VALUES('ai_router',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(n)); return n; };

// ---- bounded concurrency per provider: several editions can be generated at once without hammering one provider's rate limit ----
const slots = new Map(); // provider -> { active, queue: [] }
export async function acquire(provider, limit) {
  const st = slots.get(provider) ?? slots.set(provider, { active: 0, queue: [] }).get(provider);
  if (st.active >= limit) await new Promise(r => st.queue.push(r)); else st.active++;
  let released = false; return () => { if (released) return; released = true; const next = st.queue.shift(); if (next) next(); else st.active--; }; // hands the slot straight to the next waiter
}
export const slotState = () => Object.fromEntries([...slots].map(([k, v]) => [k, { active: v.active, waiting: v.queue.length }]));

// ---- keys ----
const last4 = k => k.slice(-4);
export const maskKey = k => ({ id: k.id, provider: k.provider, label: k.label, source: k.source, masked: k.last4 ? '••••' + k.last4 : (k.source === 'env' ? 'from environment' : '••••'), enabled: !!k.enabled });
export function addKey(provider, label, plain) {
  if (!PROVIDERS[provider]) throw new Error('unknown provider'); plain = String(plain ?? '').trim(); if (plain.length < 8 || /\s/.test(plain)) throw new Error('that does not look like an API key');
  const id = Number(db.prepare("INSERT INTO ai_keys(provider,label,source,key_enc,last4,created_at) VALUES(?,?,'db',?,?,?)").run(provider, String(label || '').slice(0, 40) || null, encrypt(plain), last4(plain), now()).lastInsertRowid);
  ensureProvider(provider); log('ai_key_added', `${provider} key ${id}`); return id;
}
export const setKeyEnabled = (id, on) => db.prepare('UPDATE ai_keys SET enabled=? WHERE id=?').run(on ? 1 : 0, id).changes; // takes effect on the next request: no restart
export const deleteKey = id => db.prepare('DELETE FROM ai_keys WHERE id=?').run(id).changes;
export function ensureProvider(p) { db.prepare('INSERT OR IGNORE INTO ai_providers(provider,updated_at) VALUES(?,?)').run(p, now()); }
// Keys from the environment (GROQ_API_KEY=a,b): listed so they can be disabled, never stored.
export function syncEnvKeys() {
  for (const [p, d] of Object.entries(PROVIDERS)) {
    const vals = String(process.env[d.env] ?? '').split(',').map(x => x.trim()).filter(Boolean);
    vals.forEach((v, i) => db.prepare("INSERT OR IGNORE INTO ai_keys(provider,label,source,env_index,last4,created_at) VALUES(?,?,'env',?,?,?)").run(p, d.env + (vals.length > 1 ? '#' + (i + 1) : ''), i, last4(v), now()));
    db.prepare("DELETE FROM ai_keys WHERE provider=? AND source='env' AND env_index>=?").run(p, vals.length);
    if (vals.length) ensureProvider(p);
  }
}
const secretOf = k => k.source === 'env' ? String(process.env[PROVIDERS[k.provider].env] ?? '').split(',').map(x => x.trim()).filter(Boolean)[k.env_index] : decrypt(k.key_enc);
// Remove every key we know (and common key shapes) from any text that may be logged or shown.
export function redact(text) {
  let t = String(text ?? '');
  for (const k of db.prepare('SELECT * FROM ai_keys').all()) { try { const s = secretOf(k); if (s && s.length >= 8) t = t.split(s).join('[redacted]'); } catch {} }
  return t.replace(/\b(sk-[A-Za-z0-9_-]{12,}|AIza[0-9A-Za-z_-]{20,}|gsk_[A-Za-z0-9]{16,}|csk-[A-Za-z0-9]{16,})/g, '[redacted]').replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1[redacted]');
}

// ---- header parsing ----
export function parseDurationMs(v) { // "2m59.56s", "7.66s", "120ms", "1h2m", or plain seconds
  if (v == null || v === '') return null; if (/^\d+(\.\d+)?$/.test(String(v).trim())) return Math.round(+v * 1000);
  let ms = 0, any = false; for (const m of String(v).matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) { any = true; ms += +m[1] * ({ ms: 1, s: 1000, m: 60000, h: 3600000 }[m[2]]); } return any ? Math.round(ms) : null;
}
export function parseRetryAfter(v, nowMs = Date.now()) { if (!v) return null; if (/^\d+(\.\d+)?$/.test(v.trim())) return Math.round(+v * 1000); const t = Date.parse(v); return Number.isNaN(t) ? null : Math.max(0, t - nowMs); }
const numHeader = (h, n) => { const v = h.get(n); return v != null && /^\d+$/.test(v.trim()) ? +v : null; };
export function quotaFromHeaders(h) { // unknown stays null: we never invent a quota
  const rr = numHeader(h, 'x-ratelimit-remaining-requests'), rt = numHeader(h, 'x-ratelimit-remaining-tokens');
  const reset = Math.max(parseDurationMs(h.get('x-ratelimit-reset-requests')) ?? 0, parseDurationMs(h.get('x-ratelimit-reset-tokens')) ?? 0) || null;
  return { remainingRequests: rr, remainingTokens: rt, resetMs: reset, retryAfterMs: parseRetryAfter(h.get('retry-after')) };
}
// bounded exponential backoff with jitter
export const backoffMs = (n, base = 30000, cap = 900000, rnd = Math.random) => Math.round(Math.min(cap, base * 2 ** Math.max(0, n - 1)) * (0.75 + rnd() * 0.5));

// ---- candidates ----
const dayStart = () => new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z').toISOString();
export function usageToday(provider = null) {
  const r = db.prepare(`SELECT COUNT(*) req, COALESCE(SUM(COALESCE(tokens_in,0)+COALESCE(tokens_out,0)),0) tok, COALESCE(SUM(cost),0) cost, SUM(cost IS NULL AND ok=1) unknown FROM ai_usage WHERE at>=? ${provider ? 'AND provider=?' : ''}`).get(...(provider ? [dayStart(), provider] : [dayStart()]));
  return { requests: r.req, tokens: r.tok, cost: r.cost, unknownCostCalls: r.unknown ?? 0 };
}
export function spentToday(cfg = routerCfg()) { const u = usageToday(); return u.cost + u.unknownCostCalls * cfg.unknown_call_cost_usd; }
const isFree = m => !!m.is_free; // only what the operator declared free after checking their own account
const future = t => t && Date.parse(t) > Date.now();

export function candidates({ lang = null, maxTokens = 0, purpose = '' } = {}, cfg = routerCfg()) {
  const out = [], why = []; const over = spentToday(cfg) >= cfg.daily_spend_cap_usd;
  for (const m of db.prepare('SELECT m.*, p.enabled penabled, p.base_url, p.daily_requests, p.daily_tokens FROM ai_models m JOIN ai_providers p ON p.provider=m.provider WHERE m.enabled=1 AND p.enabled=1 ORDER BY m.priority, m.id').all()) {
    const tag = `${m.provider}/${m.model}`;
    if (lang && !m.langs.split(',').includes(lang)) { why.push(`${tag}: not enabled for ${lang}`); continue; }
    if (m.max_output_tokens && maxTokens > m.max_output_tokens) { why.push(`${tag}: output limit ${m.max_output_tokens} < ${maxTokens}`); continue; }
    if (!isFree(m) && cfg.free_only) { why.push(`${tag}: paid model blocked by free-only mode`); continue; }
    if (!isFree(m) && over) { why.push(`${tag}: daily spending cap reached`); continue; }
    if (future(m.cooldown_until)) { why.push(`${tag}: cooling down until ${m.cooldown_until}`); continue; }
    const u = usageToday(m.provider); if (m.daily_requests != null && u.requests >= m.daily_requests) { why.push(`${tag}: daily request budget used`); continue; } if (m.daily_tokens != null && u.tokens + maxTokens > m.daily_tokens) { why.push(`${tag}: daily token budget used`); continue; }
    const keys = db.prepare('SELECT * FROM ai_keys WHERE provider=? AND enabled=1 ORDER BY COALESCE(last_ok_at,\'\') , id').all(m.provider).filter(k => !future(k.cooldown_until) && !(k.remaining_requests === 0 && future(k.quota_reset_at)));
    if (!keys.length) { why.push(`${tag}: no usable key`); continue; }
    out.push({ model: m, key: keys[0] });
  }
  return { list: out, why };
}
function earliestRetry() { const t = [...db.prepare("SELECT cooldown_until t FROM ai_models WHERE enabled=1 AND cooldown_until>?").all(now()), ...db.prepare("SELECT cooldown_until t FROM ai_keys WHERE enabled=1 AND cooldown_until>?").all(now())].map(r => r.t).sort(); return t[0] ?? new Date(Date.now() + 15 * 60000).toISOString(); }

// ---- one HTTP call ----
export async function callProvider({ provider, base, model, key, system, user, json, maxTokens, timeoutMs }) {
  const d = PROVIDERS[provider]; let res, data;
  try {
    res = await fetch((base || d.base).replace(/\/$/, '') + '/chat/completions', { method: 'POST', signal: AbortSignal.timeout(timeoutMs),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secretOf(key)}`, 'x-title': 'Everest News' },
      body: JSON.stringify({ model, temperature: 0.3, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], ...(json && d.json && { response_format: { type: 'json_object' } }) }) });
  } catch (e) { throw new AiError(e.name === 'TimeoutError' || e.name === 'AbortError' ? 'timeout' : 'network', redact(`${provider}: ${e.message}`)); }
  data = await res.json().catch(() => ({})); const q = quotaFromHeaders(res.headers), msg = redact(data?.error?.message || (typeof data?.error === 'string' ? data.error : '') || JSON.stringify(data).slice(0, 200));
  if (res.status === 401 || res.status === 403) throw new AiError('auth', `${provider} rejected the credentials (${res.status}): ${msg}`, { status: res.status, quota: q });
  if (res.status === 404 || (res.status === 400 && /model/i.test(msg) && /(not found|does not exist|unavailable|unsupported|invalid)/i.test(msg))) throw new AiError('model', `${provider} model "${model}" is unavailable (${res.status}): ${msg}`, { status: res.status, quota: q });
  if (res.status === 429) throw new AiError('rate_limit', `${provider} rate limited (429): ${msg}`, { status: 429, quota: q, retryAfterMs: q.retryAfterMs ?? q.resetMs });
  if (res.status === 402) throw new AiError('billing', `${provider} says the account has no credit (402): ${msg}`, { status: 402, quota: q });
  if (res.status >= 500) throw new AiError('server', `${provider} server error ${res.status}: ${msg}`, { status: res.status, quota: q, retryAfterMs: q.retryAfterMs });
  if (!res.ok || data.error) throw new AiError('bad_request', `${provider} error ${res.status}: ${msg}`, { status: res.status, quota: q });
  const c = data.choices?.[0], text = c?.message?.content; if (!text) throw new AiError('empty', `${provider} returned no content`, { quota: q });
  if (c.finish_reason === 'length') throw new AiError('truncated', `output truncated at max_tokens=${maxTokens}; raise max tokens in Settings or the draft is too long`, { usage: data.usage, quota: q });
  return { text, usage: data.usage || {}, model: data.model || model, quota: q };
}

const setCooldown = (table, id, ms, err) => db.prepare(`UPDATE ${table} SET cooldown_until=?, last_error=?, consecutive_failures=consecutive_failures+1 WHERE id=?`).run(new Date(Date.now() + ms).toISOString(), redact(err).slice(0, 300), id);
function learn(cand, err) {
  const { model: m, key: k } = cand, n = Math.max(m.consecutive_failures, k.consecutive_failures) + 1;
  if (err.kind === 'auth') setCooldown('ai_keys', k.id, 6 * 3600e3, err.message); // an invalid key is not hammered; fix or disable it
  else if (err.kind === 'billing') setCooldown('ai_keys', k.id, 3600e3, err.message);
  else if (err.kind === 'model') setCooldown('ai_models', m.id, 6 * 3600e3, err.message);
  else if (err.kind === 'rate_limit') setCooldown('ai_keys', k.id, Math.max(err.retryAfterMs ?? 0, backoffMs(n, 30000, 900000)), err.message); // Retry-After is a floor, never undercut
  else if (err.kind === 'server' || err.kind === 'timeout' || err.kind === 'network') setCooldown('ai_models', m.id, Math.max(err.retryAfterMs ?? 0, backoffMs(n, 15000, 600000)), err.message);
  if (err.quota) storeQuota(k.id, err.quota);
}
function storeQuota(id, q) { db.prepare('UPDATE ai_keys SET remaining_requests=?, remaining_tokens=?, quota_reset_at=? WHERE id=?').run(q.remainingRequests, q.remainingTokens, q.resetMs ? new Date(Date.now() + q.resetMs).toISOString() : null, id); }
function record(purpose, c, ok, r, err, ms = null) {
  const u = r?.usage ?? err?.usage ?? {}, m = c.model, rep = typeof u.cost === 'number' ? u.cost : null, free = isFree(m);
  const est = m.price_in != null || m.price_out != null ? ((u.prompt_tokens || 0) * (m.price_in || 0) + (u.completion_tokens || 0) * (m.price_out || 0)) / 1e6 : null;
  const cost = !ok && !u.completion_tokens ? null : free ? 0 : rep ?? est;
  db.prepare('INSERT INTO ai_usage(at,purpose,model,ok,tokens_in,tokens_out,cost,cost_source,error,provider,key_id,ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(now(), purpose, m.model, ok ? 1 : 0, u.prompt_tokens ?? null, u.completion_tokens ?? null, cost, cost == null ? null : free ? 'free' : rep != null ? 'provider' : 'estimated', err ? redact(err.message).slice(0, 500) : null, m.provider, c.key.id, ms);
}

// Called by the caller ONLY after it has validated the answer, so a bad answer is never replayed on retry.
export const cacheStore = (key, r) => key && db.prepare('INSERT OR REPLACE INTO ai_cache(cache_key,text,model,provider,usage,created_at) VALUES(?,?,?,?,?,?)').run(key, r.text, r.model ?? null, r.provider ?? null, JSON.stringify(r.usage ?? {}), now());
// Route one request. Results are cached under cacheKey so a retried job re-uses the answer instead of paying again.
export async function route({ system, user, purpose = 'draft', json = true, maxTokens = 6000, lang = null, cacheKey = null }, hooks = {}) {
  if (cacheKey) { const c = db.prepare('SELECT * FROM ai_cache WHERE cache_key=?').get(cacheKey); if (c) return { text: c.text, usage: JSON.parse(c.usage || '{}'), model: c.model, provider: c.provider, cached: true }; }
  const cfg = routerCfg(), tried = new Set(); let last = null;
  for (let i = 0; i < cfg.max_attempts; i++) {
    const { list } = candidates({ lang, maxTokens, purpose }, cfg), cand = list.find(c => !tried.has(`${c.model.id}:${c.key.id}`)); if (!cand) break;
    tried.add(`${cand.model.id}:${cand.key.id}`);
    const release = await acquire(cand.model.provider, Math.max(1, Math.round(cfg.provider_concurrency || 2))), t0 = Date.now();
    try {
      const r = await (hooks.call ?? callProvider)({ provider: cand.model.provider, base: db.prepare('SELECT base_url FROM ai_providers WHERE provider=?').get(cand.model.provider)?.base_url, model: cand.model.model, key: cand.key, system, user, json, maxTokens, timeoutMs: cfg.timeout_ms });
      db.prepare('UPDATE ai_models SET last_ok_at=?,last_error=NULL,consecutive_failures=0 WHERE id=?').run(now(), cand.model.id); db.prepare('UPDATE ai_keys SET last_ok_at=?,last_error=NULL,consecutive_failures=0,cooldown_until=NULL WHERE id=?').run(now(), cand.key.id);
      if (r.quota) storeQuota(cand.key.id, r.quota); record(purpose, cand, true, r, null, Date.now() - t0);
      return { text: r.text, usage: r.usage, model: r.model, provider: cand.model.provider, cached: false };
    } catch (e) {
      const err = e instanceof AiError ? e : new AiError('network', redact(e.message)); record(purpose, cand, false, null, err, Date.now() - t0); last = err;
      if (err.kind === 'truncated' || err.kind === 'bad_request') throw Object.assign(new Error(err.message), { permanent: true, logged: true, kind: err.kind }); // another provider will not fix a bad request
      learn(cand, err); log('ai_failover', `${cand.model.provider}/${cand.model.model}: ${err.kind}`);
    } finally { release(); }
  }
  const { why } = candidates({ lang, maxTokens, purpose }, cfg);
  throw Object.assign(new Error(last ? `all eligible providers failed; last error: ${last.message}` : `no provider is available right now (${why.slice(0, 6).join('; ') || 'none configured'})`), { code: 'no_capacity', retryAt: earliestRetry() });
}

// Admin "test connection": lists models the key can see (if the provider supports it) and runs a tiny completion on the chosen model.
export async function testConnection(provider, keyId, model) {
  const d = PROVIDERS[provider], k = db.prepare('SELECT * FROM ai_keys WHERE id=? AND provider=?').get(keyId, provider); if (!d || !k) throw new Error('unknown provider or key');
  const base = (db.prepare('SELECT base_url FROM ai_providers WHERE provider=?').get(provider)?.base_url || d.base).replace(/\/$/, ''); let listed = null;
  try { const r = await fetch(base + '/models', { headers: { authorization: `Bearer ${secretOf(k)}` }, signal: AbortSignal.timeout(20000) }); if (r.ok) listed = ((await r.json()).data ?? []).map(x => String(x.id).replace(/^models\//, '')).slice(0, 400); } catch {}
  let ping = null; if (model) { try { const r = await callProvider({ provider, base, model, key: k, system: 'Reply with the single word ok.', user: 'ok', json: false, maxTokens: 16, timeoutMs: 30000 }); ping = { ok: true, model: r.model }; if (r.quota) storeQuota(k.id, r.quota); } catch (e) { ping = { ok: false, kind: e.kind, error: redact(e.message) }; } }
  return { listed, modelListed: listed && model ? listed.includes(model) : null, ping };
}
