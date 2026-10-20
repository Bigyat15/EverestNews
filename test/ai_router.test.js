// Multi-provider routing against MOCK provider endpoints. Nothing here calls a real provider or spends any free-tier quota.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
Object.assign(process.env, { DB_PATH: ':memory:', TOKEN_KEY: 'd'.repeat(64), SOCIAL_MOCK: '1', PUBLIC_BASE_URL: 'https://news.example.test', EXTRACT_DELAY_MS: '0' });
for (const k of ['OPENROUTER_API_KEY', 'GROQ_API_KEY', 'GEMINI_API_KEY']) delete process.env[k];
const { db } = await import('../src/db.js');
for (const k of ['OPENROUTER_API_KEY', 'GROQ_API_KEY', 'GEMINI_API_KEY']) delete process.env[k]; // db.js loads the project .env; a test must never see real keys
const R = await import('../src/ai_router.js');
const { complete } = await import('../src/ai.js');
const { aiRoute } = await import('../src/ai_routes.js');
const E = await import('../src/editions.js');
const { _setRobotsFetcher } = await import('../src/robots.js');
const F = await import('./fixtures/content.js');
_setRobotsFetcher(async () => ({ status: 200, buf: Buffer.from('User-agent: *\nDisallow:\n') }));

const hits = []; const plan = {}; let live = 0, peak = 0; // plan[provider] = array of behaviours consumed in order; default = success
const ok = (text = '{"ok":true}', extra = {}) => ({ status: 200, body: { choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 }, model: extra.model }, headers: extra.headers });
const srv = http.createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', async () => {
  const provider = req.url.split('/')[1], body = JSON.parse(b || '{}'); hits.push({ provider, path: req.url, auth: req.headers.authorization, body }); live++; peak = Math.max(peak, live);
  const beh = (plan[provider] ?? []).shift() ?? ok('{"ok":true}', { model: body.model }); if (beh.hang) await new Promise(r => setTimeout(r, beh.hang));
  live--; if (beh.drop) return req.socket.destroy(); res.writeHead(beh.status, { 'content-type': 'application/json', ...(beh.headers || {}) }); res.end(JSON.stringify(beh.body ?? {})); }); });
await new Promise(r => srv.listen(0, '127.0.0.1', r)); const port = srv.address().port; test.after(() => srv.close());
const SECRET = { gemini: 'AIzaSyFAKEFAKEFAKEFAKEFAKE1234567', groq: 'gsk_FAKEFAKEFAKEFAKEFAKE9999', openrouter: 'sk-or-v1-FAKEFAKEFAKEFAKE7777', cerebras: 'csk-FAKEFAKEFAKEFAKEFAKE5555', mistral: 'mistralFAKEKEY0000FAKE3333', requesty: 'rqty-FAKEFAKEFAKEFAKE2222' };
function setup(providers = Object.keys(SECRET), { free = true } = {}) {
  db.exec('DELETE FROM ai_cache; DELETE FROM ai_usage; DELETE FROM ai_keys; DELETE FROM ai_models; DELETE FROM ai_providers; DELETE FROM settings WHERE key=\'ai_router\''); hits.length = 0; for (const k of Object.keys(plan)) delete plan[k];
  for (const p of providers) { db.prepare('INSERT INTO ai_providers(provider,enabled,base_url) VALUES(?,1,?)').run(p, `http://127.0.0.1:${port}/${p}`); R.addKey(p, 'k', SECRET[p]); db.prepare('INSERT INTO ai_models(provider,model,enabled,is_free,priority) VALUES(?,?,1,?,?)').run(p, `${p}-model`, free ? 1 : 0, 100 + providers.indexOf(p)); }
}
const call = (o = {}) => complete({ system: 's', user: 'u', purpose: 'edition_en', lang: 'en', ...o });
beforeEach(() => setup());

test('every provider adapter sends the documented request and returns one normalised result', async () => {
  for (const p of Object.keys(SECRET)) {
    setup([p]); const r = await call(); assert.equal(r.provider, p); assert.equal(r.text, '{"ok":true}'); assert.equal(r.usage.completion_tokens, 5); assert.equal(r.model, `${p}-model`);
    const h = hits[0]; assert.equal(h.path, `/${p}/chat/completions`); assert.equal(h.auth, `Bearer ${SECRET[p]}`);
    assert.equal(!!h.body.response_format, R.PROVIDERS[p].json, `${p}: json mode only where the provider documents it`); assert.equal(h.body.max_tokens, 6000);
  }
  assert.deepEqual(Object.keys(R.PROVIDERS).sort(), ['cerebras', 'gemini', 'groq', 'mistral', 'openrouter', 'requesty']);
});
test('invalid credentials: the key rests, another provider answers, and the bad key is not hammered', async () => {
  setup(['groq', 'mistral']); plan.groq = [{ status: 401, body: { error: { message: `bad key ${SECRET.groq}` } } }];
  const r = await call(); assert.equal(r.provider, 'mistral'); const k = db.prepare("SELECT * FROM ai_keys WHERE provider='groq'").get(); assert.ok(k.cooldown_until > new Date().toISOString(), 'rests for hours');
  assert.ok(!k.last_error.includes(SECRET.groq), 'the secret is not stored in the diagnostic'); await call(); await call(); assert.equal(hits.filter(h => h.provider === 'groq').length, 1, 'no further calls to the rejected key');
});
test('an unavailable model is set aside; the request fails over', async () => {
  setup(['groq', 'cerebras']); plan.groq = [{ status: 404, body: { error: { message: 'model not found' } } }]; const r = await call(); assert.equal(r.provider, 'cerebras');
  assert.ok(db.prepare("SELECT cooldown_until c FROM ai_models WHERE provider='groq'").get().c > new Date().toISOString()); assert.equal(hits.filter(h => h.provider === 'groq').length, 1);
});
test('429: Retry-After is respected as a floor and a cooled-down key is not called again', async () => {
  setup(['groq', 'gemini']); plan.groq = [{ status: 429, headers: { 'retry-after': '120', 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '2m0s' }, body: { error: { message: 'slow down' } } }];
  const r = await call(); assert.equal(r.provider, 'gemini'); const k = db.prepare("SELECT * FROM ai_keys WHERE provider='groq'").get(); assert.ok(Date.parse(k.cooldown_until) - Date.now() >= 115000, 'at least Retry-After (120 s)'); assert.equal(k.remaining_requests, 0);
  for (let i = 0; i < 3; i++) await call(); assert.equal(hits.filter(h => h.provider === 'groq').length, 1, 'immediate repeats go elsewhere');
  setup(['groq']); plan.groq = [{ status: 429, headers: { 'retry-after': '300' }, body: {} }];
  await assert.rejects(call(), e => e.code === 'no_capacity' && Date.parse(e.retryAt) - Date.now() >= 290000, 'with nowhere to go the error says when to try again');
});
test('5xx, timeout and network failures cool the model down with bounded backoff and fail over', async () => {
  for (const [name, beh] of [['5xx', { status: 503, body: { error: { message: 'busy' } } }], ['timeout', { hang: 600, status: 200, body: {} }], ['network', { drop: true }]]) {
    setup(['groq', 'mistral']); R.setRouterCfg({ timeout_ms: 150 }); plan.groq = [beh]; const r = await call(); assert.equal(r.provider, 'mistral', name); const m = db.prepare("SELECT * FROM ai_models WHERE provider='groq'").get(); assert.ok(m.cooldown_until > new Date().toISOString(), name); assert.ok(m.consecutive_failures >= 1); await call(); await call(); assert.equal(hits.filter(h => h.provider === 'groq').length, 1, name + ': the cooling model is not called again');
  }
  R.setRouterCfg({ timeout_ms: 120000 }); for (let n = 1; n < 40; n++) { const v = R.backoffMs(n, 30000, 900000); assert.ok(v <= 900000 * 1.25 && v >= 30000 * 0.75, 'bounded'); } assert.ok(R.backoffMs(1, 1000, 1e6, () => 0) < R.backoffMs(1, 1000, 1e6, () => 1), 'jittered'); assert.ok(R.backoffMs(4, 1000, 1e6, () => .5) > R.backoffMs(1, 1000, 1e6, () => .5), 'exponential');
});
test('unknown quota stays unknown: nothing is invented, and parsing covers real header shapes', async () => {
  const r = await call(); assert.ok(r); const k = db.prepare('SELECT * FROM ai_keys LIMIT 1').get(); assert.equal(k.remaining_requests, null); assert.equal(k.remaining_tokens, null); assert.equal(k.quota_reset_at, null);
  assert.equal(R.parseDurationMs('2m59.56s'), 179560); assert.equal(R.parseDurationMs('7.66s'), 7660); assert.equal(R.parseDurationMs('1h2m'), 3720000); assert.equal(R.parseDurationMs('250ms'), 250); assert.equal(R.parseDurationMs('nonsense'), null); assert.equal(R.parseRetryAfter('2'), 2000);
  assert.equal(R.parseRetryAfter(new Date(Date.now() + 30000).toUTCString()) > 20000, true); assert.deepEqual(R.quotaFromHeaders(new Headers()), { remainingRequests: null, remainingTokens: null, resetMs: null, retryAfterMs: null });
  setup(['groq']); plan.groq = [ok('{"ok":1}', { model: 'groq-model', headers: { 'x-ratelimit-remaining-requests': '14370', 'x-ratelimit-remaining-tokens': '17997', 'x-ratelimit-reset-tokens': '7.66s' } })]; await call(); const g = db.prepare('SELECT * FROM ai_keys').get(); assert.equal(g.remaining_requests, 14370); assert.equal(g.remaining_tokens, 17997); assert.ok(g.quota_reset_at);
});
test('free-only mode blocks every paid model; the spending cap stops paid calls and never touches free ones', async () => {
  setup(['groq', 'mistral'], { free: false }); db.prepare("UPDATE ai_models SET is_free=1 WHERE provider='mistral'").run(); db.prepare("UPDATE ai_models SET price_in=1, price_out=1 WHERE provider='groq'").run();
  R.setRouterCfg({ free_only: true }); const r = await call(); assert.equal(r.provider, 'mistral'); assert.equal(hits.filter(h => h.provider === 'groq').length, 0, 'the paid model was never called');
  db.prepare("UPDATE ai_models SET enabled=0 WHERE provider='mistral'").run(); await assert.rejects(call(), e => e.code === 'no_capacity' && /free-only/.test(e.message), 'with only paid models free-only stops cleanly');
  R.setRouterCfg({ free_only: false, daily_spend_cap_usd: 0.001 }); db.prepare("INSERT INTO ai_usage(at,purpose,model,ok,cost,provider) VALUES(?,?,?,1,0.5,'groq')").run(new Date().toISOString(), 'x', 'groq-model'); const n = hits.length;
  await assert.rejects(call(), e => e.code === 'no_capacity' && /spending cap/.test(e.message)); assert.equal(hits.length, n, 'cap reached: no request left the building');
  db.prepare("UPDATE ai_models SET enabled=1 WHERE provider='mistral'").run(); assert.equal((await call()).provider, 'mistral', 'free models are unaffected by the cap');
});
test('paid calls with an unknown price are counted conservatively against the cap', async () => {
  setup(['groq'], { free: false }); R.setRouterCfg({ daily_spend_cap_usd: 0.025, unknown_call_cost_usd: 0.01 }); await call(); await call(); await call(); await assert.rejects(call(), e => e.code === 'no_capacity', 'three unknown-price calls assumed $0.03 >= cap'); assert.equal(hits.length, 3);
});
test('per-provider daily request and token budgets are enforced', async () => {
  setup(['groq', 'mistral']); db.prepare("UPDATE ai_providers SET daily_requests=2 WHERE provider='groq'").run(); for (let i = 0; i < 5; i++) await call(); assert.equal(hits.filter(h => h.provider === 'groq').length, 2); assert.equal(hits.filter(h => h.provider === 'mistral').length, 3);
  setup(['groq']); db.prepare("UPDATE ai_providers SET daily_tokens=100 WHERE provider='groq'").run(); await assert.rejects(call({ maxTokens: 6000 }), e => e.code === 'no_capacity', 'a request that cannot fit the token budget is not sent'); assert.equal(hits.length, 0);
});
test('task suitability: language and output-size limits pick the right model', async () => {
  setup(['groq', 'mistral']); db.prepare("UPDATE ai_models SET langs='en' WHERE provider='groq'").run(); assert.equal((await call({ lang: 'ne', purpose: 'edition_ne' })).provider, 'mistral'); assert.equal((await call({ lang: 'en' })).provider, 'groq');
  db.prepare("UPDATE ai_models SET max_output_tokens=1000 WHERE provider='groq'").run(); assert.equal((await call({ lang: 'en', maxTokens: 6000 })).provider, 'mistral');
});
test('keys can be disabled without a restart, and revoked keys are skipped', async () => {
  setup(['groq', 'mistral']); const id = db.prepare("SELECT id FROM ai_keys WHERE provider='groq'").get().id; assert.equal((await call()).provider, 'groq'); R.setKeyEnabled(id, false); assert.equal((await call()).provider, 'mistral'); R.deleteKey(id); assert.equal((await call()).provider, 'mistral');
});
test('secrets: encrypted at rest, never in API responses, logs, errors or diagnostics; env keys are never stored', async () => {
  setup(['groq']); const row = db.prepare('SELECT * FROM ai_keys').get(); assert.match(row.key_enc, /^v1:/); assert.ok(!row.key_enc.includes(SECRET.groq)); assert.equal(row.last4, '9999');
  const all = JSON.stringify(await aiRoute({ method: 'GET' }, new URL('http://x/api/ai/providers'), async () => ({}))); assert.ok(!all.includes(SECRET.groq) && !all.includes('FAKEFAKE')); assert.match(all, /••••9999/);
  plan.groq = [{ status: 500, body: { error: { message: `upstream echoed ${SECRET.groq} and Bearer ${SECRET.groq}` } } }]; await assert.rejects(call(), e => { assert.ok(!e.message.includes(SECRET.groq)); return true; });
  const dump = JSON.stringify([db.prepare('SELECT * FROM ai_usage').all(), db.prepare('SELECT * FROM ai_keys').all(), db.prepare('SELECT * FROM audit').all()]); assert.ok(!dump.includes(SECRET.groq), 'not in usage rows, key rows or the audit log');
  setup(['mistral']); plan.mistral = [{ status: 500, body: { error: { message: `echo ${SECRET.mistral}` } } }]; await assert.rejects(call(), e => { assert.ok(!e.message.includes(SECRET.mistral), 'a key with no recognisable prefix is still removed (known-key redaction)'); return true; }); assert.ok(!JSON.stringify(db.prepare('SELECT * FROM ai_usage').all()).includes(SECRET.mistral)); setup(['groq']);
  assert.equal(R.redact(`x ${SECRET.groq} y AIzaSyABCDEFGHIJKLMNOPQRSTUV z`), 'x [redacted] y [redacted] z');
  setup([]); process.env.GROQ_API_KEY = 'envkey-AAAA1111BBBB2222,envkey-CCCC3333DDDD4444'; R.syncEnvKeys(); const ek = db.prepare("SELECT * FROM ai_keys WHERE source='env' AND provider='groq'").all(); assert.equal(ek.length, 2); assert.ok(ek.every(k => k.key_enc === null)); assert.ok(!JSON.stringify(ek).includes('AAAA1111')); delete process.env.GROQ_API_KEY; R.syncEnvKeys(); assert.equal(db.prepare("SELECT COUNT(*) n FROM ai_keys WHERE source='env' AND provider='groq'").get().n, 0);
});
test('admin API: keys are accepted once and never returned; budgets, models and free-only validate input', async () => {
  const r = (method, path, body = {}) => aiRoute({ method }, new URL('http://x' + path), async () => body).then(x => x.body);
  setup([]); const k = await r('POST', '/api/ai/providers/groq/keys', { key: SECRET.groq, label: 'main' }); assert.ok(k.id && !JSON.stringify(k).includes('FAKE')); assert.match((await r('POST', '/api/ai/providers/groq/keys', { key: 'x y' })).error, /key/);
  assert.ok((await r('POST', '/api/ai/providers/groq/models', { model: 'my-free-model', is_free: true })).id); assert.match((await r('POST', '/api/ai/providers/groq/models', { model: 'my-free-model' })).error, /already/); assert.match((await r('POST', '/api/ai/providers/groq/models', { model: '??' })).error, /invalid/);
  assert.match((await r('PUT', '/api/ai/providers/groq', { base_url: 'http://evil.example/x' })).error, /https/); assert.equal((await r('PUT', '/api/ai/providers/groq', { enabled: true, daily_requests: 10 })).ok, true); assert.equal((await r('PUT', '/api/ai/router', { free_only: true })).free_only, true);
  const t = await r('POST', '/api/ai/providers/groq/test', { key_id: k.id, model: null }); assert.ok('listed' in t, 'test action runs against the (unreachable) real endpoint without throwing'); 
});
test('a finished answer is cached under its idempotency key; an invalid answer is never cached', async () => {
  setup(['groq']); await call({ cacheKey: 'k1' }); R.cacheStore('k1', { text: '{"ok":true}', model: 'm' }); const n = hits.length; const again = await call({ cacheKey: 'k1' }); assert.equal(again.cached, true); assert.equal(hits.length, n, 'a cache hit costs no request');
  const before = hits.length; await call({ cacheKey: 'never-stored' }); await call({ cacheKey: 'never-stored' }); assert.equal(hits.length - before, 2, 'unvalidated output is not replayed');
});

// ---- the editorial pipeline on top of the router ----
const wants = b => (b.messages.at(-1).content.match(/Target edition language: (\w+)/) || [])[1];
const edBody = b => JSON.stringify({ source_assessment: { sufficient: true, gaps: [] }, facts: F.FACTS, quotes: [{ speaker: 'Ram Bahadur Thapa', source_text: F.EN_QUOTE }], edition: wants(b) === 'Nepali' ? F.NE_ED : F.EN_ED });
const ts = () => new Date().toISOString(); let n = 0;
function story() { n++; const cid = Number(db.prepare('INSERT INTO clusters(created_at) VALUES(?)').run(ts()).lastInsertRowid); db.prepare('INSERT INTO articles(source_id,url,canon_url,title,title_key,language,summary,full_text,published_at,fetched_at,updated_at,cluster_id) VALUES(1,?,?,?,?,?,?,?,?,?,?,?)').run('https://r.test/' + n, 'https://r.test/' + n, F.EN_TITLE, 't' + n, 'en', F.EN_SUMMARY, F.EN_TEXT, ts(), ts(), ts(), cid); return cid; }
const edServer = http.createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => { const body = JSON.parse(b); edHits.push(body); const beh = edPlan.shift() ?? { status: 200 }; res.writeHead(beh.status, { 'content-type': 'application/json', ...(beh.headers || {}) }); res.end(JSON.stringify(beh.status === 200 ? { choices: [{ message: { content: beh.text ?? edBody(body) }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 5 } } : { error: { message: 'x' } })); }); });
const edHits = [], edPlan = []; await new Promise(r => edServer.listen(0, '127.0.0.1', r)); test.after(() => edServer.close());
function edSetup() { setup([]); db.exec("DELETE FROM edition_jobs; DELETE FROM publications; DELETE FROM drafts"); db.prepare("INSERT INTO ai_providers(provider,enabled,base_url) VALUES('groq',1,?)").run(`http://127.0.0.1:${edServer.address().port}/v1`); R.addKey('groq', 'k', SECRET.groq); db.prepare("INSERT INTO ai_models(provider,model,enabled,is_free,priority) VALUES('groq','free-m',1,1,1)").run(); edHits.length = 0; edPlan.length = 0; }
test('queue recovery: when every provider fails the job stays durable (no attempt burned), then completes once capacity returns', async () => {
  edSetup(); const cid = story(); E.queueStory(cid, 'auto', 1); edPlan.push({ status: 429, headers: { 'retry-after': '600' } });
  await E.runEditionJob(); let j = db.prepare("SELECT * FROM edition_jobs WHERE cluster_id=? ORDER BY id").all(cid); const hit = j.find(x => x.last_error); assert.ok(hit, 'the failing job records why'); assert.equal(hit.status, 'queued'); assert.equal(hit.attempts, 0, 'waiting for capacity burns no attempt'); assert.ok(hit.run_at > ts(), 'scheduled for when the provider said it may be used');
  while (await E.runEditionJob()); assert.equal(edHits.length, 1, 'while the provider rests no further request is sent'); assert.ok(db.prepare('SELECT * FROM edition_jobs').all().every(x => x.status === 'queued' && x.attempts === 0 && x.run_at > ts()), 'both jobs wait for capacity, none failed');
  db.exec("UPDATE ai_keys SET cooldown_until=NULL, quota_reset_at=NULL, remaining_requests=NULL; UPDATE edition_jobs SET run_at='2000-01-01T00:00:00.000Z'"); while (await E.runEditionJob());
  assert.deepEqual(db.prepare("SELECT lang FROM publications WHERE cluster_id=? AND status='published' ORDER BY lang").all(cid).map(r => r.lang), ['en', 'ne'], 'both editions published after recovery'); assert.equal(db.prepare("SELECT COUNT(*) n FROM publications WHERE cluster_id=?").get(cid).n, 2, 'no duplicates');
});
test('retries never pay twice: a validated answer is reused; invalid output is retried, not cached; social stays untouched', async () => {
  edSetup(); const cid = story(); E.queueStory(cid, 'auto', 0); // ready, not auto-published
  edPlan.push({ status: 200, text: 'not json at all' }); await E.runEditionJob(); assert.equal(db.prepare("SELECT COUNT(*) n FROM ai_cache").get().n, 0, 'invalid output is not cached');
  db.exec("UPDATE edition_jobs SET run_at='2000-01-01T00:00:00.000Z'"); while (await E.runEditionJob()); const used = edHits.length; assert.ok(db.prepare("SELECT COUNT(*) n FROM ai_cache").get().n >= 2, 'validated answers are cached');
  const g = await import('../src/editions.js'); await g.generateEdition(cid, 'en'); await g.generateEdition(cid, 'ne'); assert.equal(edHits.length, used, 'regenerating the same edition from the same source costs no request');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM posts').get().n + db.prepare('SELECT COUNT(*) n FROM social_drafts').get().n, 0, 'website generation creates nothing for social and approves nothing there');
});
test('Nepali and English output is validated whatever the provider; a model not enabled for Nepali is never asked for it', async () => {
  edSetup(); db.prepare("UPDATE ai_models SET langs='en'").run(); const cid = story(); E.queueStory(cid, 'auto', 1); while (await E.runEditionJob());
  const j = Object.fromEntries(db.prepare('SELECT * FROM edition_jobs WHERE cluster_id=?').all(cid).map(x => [x.lang, x])); assert.equal(j.en.status, 'published'); assert.notEqual(j.ne.status, 'published', 'no capable model for Nepali'); assert.ok(edHits.every(b => wants(b) === 'English'), 'Nepali was never sent to an English-only model');
  edHits.length = 0; db.prepare("UPDATE ai_models SET langs='en,ne'").run(); db.exec("UPDATE edition_jobs SET status='queued', run_at='2000-01-01T00:00:00.000Z', attempts=0 WHERE lang='ne'"); const wrongLang = { status: 200, text: JSON.stringify({ source_assessment: { sufficient: true, gaps: [] }, facts: [], quotes: [{ speaker: 'Ram Bahadur Thapa', source_text: F.EN_QUOTE }], edition: F.EN_ED }) }; edPlan.push(wrongLang, wrongLang); while (await E.runEditionJob());
  assert.equal(db.prepare("SELECT status FROM edition_jobs WHERE cluster_id=? AND lang='ne'").get(cid).status, 'needs_review', 'English text returned twice for the Nepali edition is blocked'); assert.equal(db.prepare("SELECT COUNT(*) n FROM publications WHERE cluster_id=? AND lang='ne'").get(cid).n, 0);
});

test('routed calls respect the per-provider concurrency limit (a setting) and every queued call still completes', async () => {
  for (const [limit, expectPeak] of [[1, 1], [3, 3]]) { setup(['groq']); R.setRouterCfg({ provider_concurrency: limit }); peak = 0; live = 0; plan.groq = Array.from({ length: 6 }, () => ({ hang: 60, status: 200, body: { choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 }, model: 'groq-model' } }));
    const rs = await Promise.all(Array.from({ length: 6 }, () => call())); assert.equal(rs.length, 6); assert.equal(peak, expectPeak, `limit ${limit}: at most ${expectPeak} calls in flight`); }
  R.setRouterCfg({ provider_concurrency: 2 }); const ms = db.prepare('SELECT ms FROM ai_usage WHERE ok=1 AND ms IS NOT NULL').all(); assert.ok(ms.length >= 6 && ms.every(r => r.ms >= 0), 'every call records its latency');
});
