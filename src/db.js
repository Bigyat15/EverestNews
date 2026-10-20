import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

export const DATA = process.env.DATA_DIR || 'data'; // overridable so tests run against an isolated directory
mkdirSync(DATA, { recursive: true });
// .env is created on first run so secrets never live in code or git.
if (!existsSync('.env')) {
  writeFileSync('.env', `ADMIN_PASSWORD=${randomBytes(9).toString('base64url')}\nSESSION_SECRET=${randomBytes(32).toString('hex')}\nPORT=3470\n`, { mode: 0o600 });
}
// credentials for encrypting stored social tokens; generated once, kept out of git
if (!/^TOKEN_KEY=/m.test(readFileSync('.env', 'utf8'))) appendFileSync('.env', `TOKEN_KEY=${randomBytes(32).toString('hex')}\n`);
for (const l of readFileSync('.env', 'utf8').split('\n')) {
  const m = l.match(/^(\w+)=(.*)$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
}

export const db = new DatabaseSync(process.env.DB_PATH || `${DATA}/everest.db`);
db.exec('PRAGMA busy_timeout=5000'); // first, so concurrent web+worker startup waits instead of failing
db.exec(`
PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS sources(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, feed_url TEXT NOT NULL, final_url TEXT,
  enabled INTEGER NOT NULL DEFAULT 1, interval_min INTEGER NOT NULL DEFAULT 10,
  status TEXT NOT NULL DEFAULT 'unchecked', last_http INTEGER, last_error TEXT,
  last_success_at TEXT, last_checked_at TEXT, last_new INTEGER DEFAULT 0, fail_count INTEGER NOT NULL DEFAULT 0,
  has_headline INTEGER, has_summary INTEGER, has_content INTEGER, has_image INTEGER, has_url INTEGER,
  language TEXT, entries_seen INTEGER);
CREATE TABLE IF NOT EXISTS jobs(
  id INTEGER PRIMARY KEY, source_id INTEGER NOT NULL REFERENCES sources(id), status TEXT NOT NULL DEFAULT 'queued',
  run_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, started_at TEXT, finished_at TEXT, result TEXT, error TEXT);
-- one pending job per source = no overlapping fetches
CREATE UNIQUE INDEX IF NOT EXISTS jobs_one_pending ON jobs(source_id) WHERE status IN ('queued','running');
CREATE TABLE IF NOT EXISTS articles(
  id INTEGER PRIMARY KEY, source_id INTEGER NOT NULL REFERENCES sources(id), guid TEXT,
  url TEXT NOT NULL, canon_url TEXT NOT NULL UNIQUE, title TEXT NOT NULL, title_key TEXT NOT NULL,
  language TEXT, summary TEXT, content TEXT, published_at TEXT, fetched_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  image_url TEXT, category TEXT, extraction_status TEXT NOT NULL DEFAULT 'rss_only',
  workflow_status TEXT NOT NULL DEFAULT 'collected', cluster_id INTEGER, duplicate_of INTEGER REFERENCES articles(id));
CREATE INDEX IF NOT EXISTS articles_pub ON articles(published_at DESC);
CREATE INDEX IF NOT EXISTS articles_titlekey ON articles(title_key);
CREATE TABLE IF NOT EXISTS clusters(
  id INTEGER PRIMARY KEY, created_at TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0, rejected INTEGER NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 0, category TEXT);
CREATE TABLE IF NOT EXISTS cluster_candidates(
  id INTEGER PRIMARY KEY, a_id INTEGER NOT NULL REFERENCES articles(id), b_id INTEGER NOT NULL REFERENCES articles(id),
  score REAL NOT NULL, reason TEXT, status TEXT NOT NULL DEFAULT 'pending', UNIQUE(a_id,b_id));
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS glossary(id INTEGER PRIMARY KEY, en TEXT NOT NULL UNIQUE COLLATE NOCASE, ne TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ai_jobs(
  id INTEGER PRIMARY KEY, cluster_id INTEGER NOT NULL REFERENCES clusters(id), status TEXT NOT NULL DEFAULT 'queued',
  run_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, error TEXT, created_at TEXT NOT NULL, finished_at TEXT);
CREATE TABLE IF NOT EXISTS ai_usage(
  id INTEGER PRIMARY KEY, at TEXT NOT NULL, purpose TEXT NOT NULL, model TEXT NOT NULL, ok INTEGER NOT NULL,
  tokens_in INTEGER, tokens_out INTEGER, cost REAL, cost_source TEXT, error TEXT);
-- Source material stays in articles; every generated/edited/approved field lives here, never overwriting sources.
CREATE TABLE IF NOT EXISTS drafts(
  id INTEGER PRIMARY KEY, cluster_id INTEGER NOT NULL REFERENCES clusters(id), article_id INTEGER NOT NULL REFERENCES articles(id),
  workflow TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'needs_review', model TEXT, created_at TEXT NOT NULL,
  source_snapshot TEXT NOT NULL, attribution TEXT NOT NULL,
  ai_translation TEXT, ai_draft TEXT, headline_options TEXT, rec_idx INTEGER, rec_reason TEXT, caption TEXT, long_summary TEXT,
  primary_phrase TEXT, secondary_phrases TEXT, hashtags TEXT, alt_text TEXT, meta_title TEXT, meta_desc TEXT, flags TEXT NOT NULL DEFAULT '[]',
  edited_headline TEXT, edited_body TEXT, edited_caption TEXT, final_headline TEXT, final_body TEXT, final_caption TEXT, approved_at TEXT);
CREATE TABLE IF NOT EXISTS draft_revisions(id INTEGER PRIMARY KEY, draft_id INTEGER NOT NULL REFERENCES drafts(id), at TEXT NOT NULL, headline TEXT, body TEXT, caption TEXT);
CREATE TABLE IF NOT EXISTS assets(
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL, cluster_id INTEGER REFERENCES clusters(id), path TEXT NOT NULL, orig_name TEXT, mime TEXT NOT NULL,
  bytes INTEGER NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, sha256 TEXT NOT NULL, created_at TEXT NOT NULL, rights_note TEXT);
CREATE TABLE IF NOT EXISTS templates(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, spec TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS graphics(
  id INTEGER PRIMARY KEY, cluster_id INTEGER NOT NULL REFERENCES clusters(id), draft_id INTEGER REFERENCES drafts(id), template_id INTEGER REFERENCES templates(id),
  photo_asset_id INTEGER REFERENCES assets(id), logo_asset_id INTEGER REFERENCES assets(id), spec TEXT NOT NULL, headline_snapshot TEXT NOT NULL,
  path TEXT NOT NULL, format TEXT NOT NULL, mime TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, bytes INTEGER NOT NULL, warnings TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'current', created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS graphics_cluster ON graphics(cluster_id, status);
-- Public website content: an immutable-ish snapshot of an APPROVED draft, one live article per story per language.
CREATE TABLE IF NOT EXISTS publications(
  id INTEGER PRIMARY KEY, cluster_id INTEGER NOT NULL REFERENCES clusters(id), lang TEXT NOT NULL, draft_id INTEGER NOT NULL REFERENCES drafts(id),
  headline TEXT NOT NULL, summary TEXT, body TEXT NOT NULL, caption TEXT, seo_title TEXT, meta_desc TEXT, alt_text TEXT,
  category TEXT NOT NULL DEFAULT 'other', photo_asset_id INTEGER REFERENCES assets(id), photo_credit TEXT, graphic_id INTEGER REFERENCES graphics(id),
  attribution TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'published', published_at TEXT NOT NULL, updated_at TEXT NOT NULL, unpublished_at TEXT,
  UNIQUE(cluster_id, lang));
CREATE INDEX IF NOT EXISTS publications_list ON publications(lang, status, published_at DESC);
-- Social publishing. Tokens are stored encrypted (AES-256-GCM); a target is the unit of delivery: one post -> one account.
CREATE TABLE IF NOT EXISTS social_accounts(
  id INTEGER PRIMARY KEY, platform TEXT NOT NULL, adapter TEXT NOT NULL, display_name TEXT NOT NULL, external_id TEXT, status TEXT NOT NULL DEFAULT 'connected',
  token_enc TEXT, token_expires_at TEXT, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(platform, external_id));
CREATE TABLE IF NOT EXISTS posts(
  id INTEGER PRIMARY KEY, cluster_id INTEGER NOT NULL REFERENCES clusters(id), draft_id INTEGER NOT NULL REFERENCES drafts(id), graphic_id INTEGER REFERENCES graphics(id),
  state TEXT NOT NULL DEFAULT 'draft', scheduled_at TEXT, approved_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS post_targets(
  id INTEGER PRIMARY KEY, post_id INTEGER NOT NULL REFERENCES posts(id), account_id INTEGER NOT NULL REFERENCES social_accounts(id), caption TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, next_run_at TEXT, platform_post_id TEXT, platform_url TEXT, error TEXT, error_kind TEXT,
  idempotency_key TEXT NOT NULL UNIQUE, published_at TEXT, updated_at TEXT NOT NULL, UNIQUE(post_id, account_id));
CREATE INDEX IF NOT EXISTS targets_due ON post_targets(status, next_run_at);
CREATE TABLE IF NOT EXISTS mock_remote(key TEXT PRIMARY KEY, account_id INTEGER, caption TEXT, url TEXT, at TEXT); -- test-only: the "platform side" of the mock adapter
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, at TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT);
`);

export const now = () => new Date().toISOString();
export const log = (kind, detail) => db.prepare('INSERT INTO audit(at,kind,detail) VALUES(?,?,?)').run(now(), kind, String(detail).slice(0, 2000));

if (!db.prepare("PRAGMA table_info(sources)").all().some(c => c.name === 'credibility')) db.exec('ALTER TABLE sources ADD COLUMN credibility REAL NOT NULL DEFAULT 0.5');

const acols = db.prepare('PRAGMA table_info(articles)').all().map(c => c.name);
if (!acols.includes('image_checked_at')) db.exec('ALTER TABLE articles ADD COLUMN image_checked_at TEXT; ALTER TABLE articles ADD COLUMN image_source TEXT');

// additive, data-preserving migrations (SQLite cannot IF NOT EXISTS a column)
const addCol = (t, c, ddl) => { if (!db.prepare(`PRAGMA table_info(${t})`).all().some(x => x.name === c)) { try { db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${ddl}`); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; /* another process (web/worker starting together) added it first */ } } };
addCol('drafts', 'lang', "TEXT NOT NULL DEFAULT 'ne'"); addCol('ai_jobs', 'lang', "TEXT NOT NULL DEFAULT 'ne'");
// content pipeline (additive): source text ladder, per-source terms, bilingual editorial bundle, separate graphic/social fields
addCol('articles', 'full_text', 'TEXT'); addCol('articles', 'author', 'TEXT'); addCol('articles', 'extraction_method', 'TEXT'); addCol('articles', 'extracted_at', 'TEXT');
addCol('sources', 'fulltext_enabled', 'INTEGER NOT NULL DEFAULT 0'); addCol('sources', 'ai_policy', 'TEXT');
for (const [c, t] of [['bundle_id', 'TEXT'], ['source_level', 'TEXT'], ['source_words', 'INTEGER'], ['graphic_headline', 'TEXT'], ['graphic_description', 'TEXT'], ['short_caption', 'TEXT'], ['keywords', 'TEXT'], ['facts_json', 'TEXT'], ['edited_json', 'TEXT'], ['final_json', 'TEXT'], ['gen_meta', 'TEXT']]) addCol('drafts', c, t);
addCol('graphics', 'subheadline_snapshot', 'TEXT');
// story image association + provenance, and the persisted hourly selection
addCol('articles', 'ignore_reason', 'TEXT'); addCol('articles', 'content_hash', 'TEXT'); addCol('articles', 'revision_count', 'INTEGER NOT NULL DEFAULT 0'); addCol('drafts', 'approved_by', 'TEXT');
db.exec(`
-- Durable per-edition website queue: one row per story per locale. lifecycle: queued -> generating -> (needs_review | ready | published | failed)
CREATE TABLE IF NOT EXISTS edition_jobs(
  id INTEGER PRIMARY KEY, cluster_id INTEGER NOT NULL REFERENCES clusters(id), lang TEXT NOT NULL CHECK(lang IN ('ne','en')), status TEXT NOT NULL DEFAULT 'queued',
  auto_publish INTEGER NOT NULL DEFAULT 1, attempts INTEGER NOT NULL DEFAULT 0, run_at TEXT NOT NULL, last_error TEXT, review_reason TEXT,
  draft_id INTEGER REFERENCES drafts(id), publication_id INTEGER REFERENCES publications(id), source_hash TEXT, update_pending INTEGER NOT NULL DEFAULT 0, origin TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, published_at TEXT, UNIQUE(cluster_id, lang));
CREATE INDEX IF NOT EXISTS edition_jobs_due ON edition_jobs(status, run_at);
-- Every automatic or manual duplicate decision, with its reason
CREATE TABLE IF NOT EXISTS duplicate_decisions(
  id INTEGER PRIMARY KEY, at TEXT NOT NULL, article_id INTEGER, cluster_id INTEGER, other_article_id INTEGER, other_cluster_id INTEGER, action TEXT NOT NULL, score REAL, reason TEXT, details TEXT);
CREATE TABLE IF NOT EXISTS article_revisions(id INTEGER PRIMARY KEY, article_id INTEGER NOT NULL REFERENCES articles(id), at TEXT NOT NULL, title TEXT, summary TEXT, content TEXT, content_hash TEXT);
-- Social content for the hourly pick: one draft per locale, each with its own approval
CREATE TABLE IF NOT EXISTS social_drafts(
  id INTEGER PRIMARY KEY, selection_id INTEGER NOT NULL REFERENCES selections(id), cluster_id INTEGER NOT NULL REFERENCES clusters(id), lang TEXT NOT NULL CHECK(lang IN ('ne','en')),
  edition_draft_id INTEGER NOT NULL REFERENCES drafts(id), status TEXT NOT NULL DEFAULT 'draft', caption TEXT NOT NULL, graphic_headline TEXT, graphic_description TEXT,
  graphic_id INTEGER REFERENCES graphics(id), warnings TEXT NOT NULL DEFAULT '[]', content_hash TEXT, approved_hash TEXT, approved_by TEXT, approved_at TEXT, rejected_reason TEXT,
  post_id INTEGER REFERENCES posts(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(selection_id, lang));
`);
addCol('articles', 'fetch_status', 'INTEGER'); addCol('articles', 'canonical_final', 'TEXT'); addCol('articles', 'fetch_attempts', 'INTEGER NOT NULL DEFAULT 0'); addCol('articles', 'extraction_error', 'TEXT'); addCol('articles', 'source_quality', 'TEXT'); addCol('edition_jobs', 'reason_code', 'TEXT'); addCol('edition_jobs', 'stage', 'TEXT');
addCol('templates', 'updated_at', 'TEXT'); for (const c of ['detected_at TEXT', 'first_started_at TEXT', 'extract_ms INTEGER', 'generate_ms INTEGER', 'validate_ms INTEGER', 'publish_ms INTEGER', 'total_ms INTEGER']) addCol('edition_jobs', c.split(' ')[0], c.split(' ')[1]); addCol('ai_usage', 'ms', 'INTEGER'); db.exec('CREATE INDEX IF NOT EXISTS edition_jobs_pub ON edition_jobs(published_at); CREATE INDEX IF NOT EXISTS ai_usage_at ON ai_usage(at)'); addCol('sources', 'auto_images', 'INTEGER NOT NULL DEFAULT 0'); addCol('sources', 'auto_images_note', 'TEXT'); addCol('clusters', 'image_tried_at', 'TEXT');
db.exec('CREATE TABLE IF NOT EXISTS template_versions(id INTEGER PRIMARY KEY, template_id INTEGER NOT NULL REFERENCES templates(id) ON DELETE CASCADE, version INTEGER NOT NULL, name TEXT, spec TEXT NOT NULL, saved_at TEXT NOT NULL, UNIQUE(template_id, version));');
addCol('ai_usage', 'provider', 'TEXT'); addCol('ai_usage', 'key_id', 'INTEGER');
db.exec(`
-- Multi-provider AI routing. Secrets live only in key_enc (AES-256-GCM, TOKEN_KEY) or in the environment (key_enc NULL, source='env').
CREATE TABLE IF NOT EXISTS ai_providers(provider TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, base_url TEXT, daily_requests INTEGER, daily_tokens INTEGER, updated_at TEXT);
CREATE TABLE IF NOT EXISTS ai_keys(
  id INTEGER PRIMARY KEY, provider TEXT NOT NULL, label TEXT, source TEXT NOT NULL DEFAULT 'db', env_index INTEGER, key_enc TEXT, last4 TEXT, enabled INTEGER NOT NULL DEFAULT 1,
  cooldown_until TEXT, last_error TEXT, last_ok_at TEXT, remaining_requests INTEGER, remaining_tokens INTEGER, quota_reset_at TEXT, consecutive_failures INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
  UNIQUE(provider, source, env_index));
CREATE TABLE IF NOT EXISTS ai_models(
  id INTEGER PRIMARY KEY, provider TEXT NOT NULL, model TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, is_free INTEGER NOT NULL DEFAULT 0, price_in REAL, price_out REAL, langs TEXT NOT NULL DEFAULT 'en,ne',
  max_output_tokens INTEGER, priority INTEGER NOT NULL DEFAULT 100, cooldown_until TEXT, last_error TEXT, last_ok_at TEXT, consecutive_failures INTEGER NOT NULL DEFAULT 0, UNIQUE(provider, model));
-- A finished model answer is kept under its idempotency key so a retry never pays for the same edition twice.
CREATE TABLE IF NOT EXISTS ai_cache(cache_key TEXT PRIMARY KEY, text TEXT NOT NULL, model TEXT, provider TEXT, usage TEXT, created_at TEXT NOT NULL);
`);
addCol('clusters', 'lead_asset_id', 'INTEGER'); addCol('assets', 'origin_article_id', 'INTEGER'); addCol('assets', 'origin_url', 'TEXT');
db.exec(`CREATE TABLE IF NOT EXISTS selections(
  id INTEGER PRIMARY KEY, slot_start TEXT NOT NULL UNIQUE, slot_end TEXT NOT NULL, status TEXT NOT NULL, reason TEXT,
  cluster_id INTEGER REFERENCES clusters(id), score REAL, factors TEXT, candidates INTEGER NOT NULL DEFAULT 0, image_article_id INTEGER REFERENCES articles(id),
  created_at TEXT NOT NULL, draft_requested_at TEXT);
  CREATE UNIQUE INDEX IF NOT EXISTS selections_one_cluster ON selections(cluster_id) WHERE cluster_id IS NOT NULL AND status='selected';`); addCol('publications', 'keywords', 'TEXT');
db.exec("CREATE INDEX IF NOT EXISTS drafts_bundle ON drafts(bundle_id)");
db.exec("DROP INDEX IF EXISTS ai_jobs_one_pending; CREATE UNIQUE INDEX IF NOT EXISTS ai_jobs_one_pending_lang ON ai_jobs(cluster_id, lang) WHERE status IN ('queued','running');");

const SEED = [
  ['RONB', 'https://www.ronbpost.com/feed'], ['Onlinekhabar', 'https://www.onlinekhabar.com/feed'],
  ['Setopati', 'https://www.setopati.com/feed'], ['Ratopati', 'https://ratopati.com/feed'],
  ['Nepalkhabar', 'https://www.nepalkhabar.com/rss'], ['Annapurna Post', 'https://annapurnapost.com/rss'],
  ['Bizmandu', 'https://bizmandu.com/rss'], ['eKantipur', 'https://ekantipur.com/rss'],
  ['Onlinekhabar English', 'https://english.onlinekhabar.com/feed'], ['myRepublica', 'https://myrepublica.nagariknetwork.com/rss'],
];
const ins = db.prepare('INSERT OR IGNORE INTO sources(name,feed_url) VALUES(?,?)');
for (const [n, u] of SEED) ins.run(n, u);
