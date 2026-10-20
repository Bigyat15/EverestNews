// Provider abstraction: any OpenAI-compatible chat-completions endpoint (OpenRouter by default).
// Key comes from the environment only; it is never stored in the DB or sent to the browser.
import { db, now } from './db.js';
import { cacheStore, route, routerCfg, spentToday, redact, syncEnvKeys } from './ai_router.js';

export const DEFAULT_CFG = { base_url: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-sonnet-5.5', price_in: 0, price_out: 0, pricing_source: 'unset', max_tokens: 6000, max_tokens_bundle: 14000 };
export const getCfg = () => { const r = db.prepare("SELECT value FROM settings WHERE key='ai'").get(); return { ...DEFAULT_CFG, ...(r ? JSON.parse(r.value) : {}) }; };
export const setCfg = c => db.prepare("INSERT INTO settings(key,value) VALUES('ai',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(c));
const cfg0 = () => getCfg();
export { cacheStore };
export const keyConfigured = () => !!process.env.OPENROUTER_API_KEY?.trim();

const record = (purpose, model, ok, u = {}, cost = null, costSource = null, error = null, ms = null) =>
  db.prepare('INSERT INTO ai_usage(at,purpose,model,ok,tokens_in,tokens_out,cost,cost_source,error,provider,ms) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(now(), purpose, model, ok ? 1 : 0, u.prompt_tokens ?? null, u.completion_tokens ?? null, cost, costSource, error?.slice(0, 500) ?? null, 'openrouter', ms);

// Providers added in Admin -> AI providers take over; with none enabled the original single-provider path below keeps working unchanged.
export async function complete({ system, user, purpose = 'draft', json = true, maxTokens = cfg0().max_tokens, lang = null, cacheKey = null }) {
  syncEnvKeys();
  if (db.prepare('SELECT 1 FROM ai_models m JOIN ai_providers p ON p.provider=m.provider WHERE m.enabled=1 AND p.enabled=1').get()) return route({ system, user, purpose, json, maxTokens, lang, cacheKey });
  if (cacheKey) { const c = db.prepare('SELECT * FROM ai_cache WHERE cache_key=?').get(cacheKey); if (c) return { text: c.text, usage: JSON.parse(c.usage || '{}'), model: c.model, provider: c.provider, cached: true }; }
  const rc = routerCfg(); // the legacy model is treated as paid: free-only mode and the daily cap apply to it too
  if (rc.free_only) throw Object.assign(new Error('free-only mode is on and no free model is configured'), { code: 'no_capacity', retryAt: new Date(Date.now() + 3600e3).toISOString() });
  if (spentToday(rc) >= rc.daily_spend_cap_usd) throw Object.assign(new Error('daily spending cap reached'), { code: 'no_capacity', retryAt: new Date(Date.parse(new Date().toISOString().slice(0, 10)) + 864e5).toISOString() });
  const cfg = getCfg(), t0 = Date.now(); if (!keyConfigured()) throw new Error('OPENROUTER_API_KEY is not set in .env');
  let res, data;
  try {
    res = await fetch(cfg.base_url.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST', signal: AbortSignal.timeout(120000),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPENROUTER_API_KEY.trim()}`, 'x-title': 'Everest News' },
      body: JSON.stringify({ model: cfg.model, temperature: 0.3, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], ...(json && { response_format: { type: 'json_object' } }) }),
    });
    data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(`provider error ${res.status}: ${data.error?.message || JSON.stringify(data).slice(0, 200)}`);
    const text = data.choices?.[0]?.message?.content; if (!text) throw new Error('provider returned no content');
    if (data.choices[0].finish_reason === 'length') { record(purpose, cfg.model, false, data.usage, data.usage?.cost ?? null, data.usage?.cost != null ? 'provider' : 'unknown', 'truncated', Date.now() - t0); throw Object.assign(new Error(`output truncated at max_tokens=${maxTokens}; raise max tokens in Settings (needs credit headroom) or the draft is too long`), { permanent: true, logged: true }); }
    const u = data.usage || {};
    // prefer provider-reported cost; otherwise estimate from measured tokens x configured price
    const reported = typeof u.cost === 'number' ? u.cost : null;
    const est = ((u.prompt_tokens || 0) * cfg.price_in + (u.completion_tokens || 0) * cfg.price_out) / 1e6;
    record(purpose, cfg.model, true, u, reported ?? est, reported != null ? 'provider' : cfg.price_in || cfg.price_out ? 'estimated' : 'unknown', null, Date.now() - t0);
    return { text, usage: u, model: data.model || cfg.model, provider: 'openrouter' };
  } catch (e) { e.message = redact(e.message); if (!e.logged) record(purpose, cfg.model, false, data?.usage, null, null, e.message, Date.now() - t0); throw e; }
}

// Pull current per-token prices from OpenRouter's public model list for the configured model.
export async function refreshPricing() {
  const cfg = getCfg(); const r = await fetch(cfg.base_url.replace(/\/$/, '') + '/models', { signal: AbortSignal.timeout(30000) });
  const m = (await r.json()).data?.find(x => x.id === cfg.model); if (!m) throw new Error(`model "${cfg.model}" not found in the provider's model list`);
  setCfg({ ...cfg, price_in: +m.pricing.prompt * 1e6, price_out: +m.pricing.completion * 1e6, pricing_source: 'provider model list ' + now().slice(0, 10) });
  return getCfg();
}
