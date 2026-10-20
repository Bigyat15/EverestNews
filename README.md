# Everest News

Newsroom + public website for a Nepali news publication. It watches RSS feeds, groups and ranks stories, drafts original attributed
Nepali/English summaries with an AI model, lets an editor review and approve them, renders branded social graphics, publishes to a public website,
and (when platform credentials exist) delivers posts to social accounts.

Two processes share one SQLite database:

| Process | Command | Does |
|---|---|---|
| web | `node src/server.js` | public site (`/ne/`, `/en/`), admin app (`/admin`), JSON API (`/api`, login required) |
| worker | `node src/worker.js` | feed fetching, AI drafting, image enrichment/thumbnails, social delivery, retention |

Requires Node ≥ 22.13 (developed on 24). No Redis, no native build step. ~30 MB RAM per process at idle.

## Quick start (local)

```bash
npm install
node src/server.js        # first run creates .env with a random admin password, session secret and token key
node src/worker.js        # in a second terminal
```

Open `http://127.0.0.1:3470/admin` (password: `ADMIN_PASSWORD` in `.env`). The public site is at `/` (redirects to `/ne/`).

## Configuration (`.env`, never committed)

| Variable | Purpose |
|---|---|
| `ADMIN_PASSWORD`, `SESSION_SECRET`, `TOKEN_KEY` | generated on first run. `TOKEN_KEY` encrypts stored social tokens (AES‑256‑GCM) – back it up, losing it invalidates stored tokens |
| `PORT` | default 3470, listens on 127.0.0.1 only (put a reverse proxy in front) |
| `PUBLIC_BASE_URL` | e.g. `https://news.example.com` – used for canonical URLs, sitemap, share image URLs, and to mark cookies `Secure` |
| `BRAND_NAME` | default `Everest News` (site, graphics, metadata) |
| `OPENROUTER_API_KEY` | AI drafting. Model, price and max tokens (single draft / both editions) are set in Admin → Settings. The configured model is the only one ever called – there is no fallback to another model |
| `FACEBOOK_APP_ID/SECRET`, `X_CLIENT_ID/SECRET` | placeholders for future real social adapters (not implemented yet – see below) |
| `SOCIAL_MOCK=1` | enables TEST social accounts that post nothing. **Leave unset in production** |
| `DATA_DIR` | default `data/` (database, uploads, graphics, thumbnail cache) |
| `IMG_CACHE_MB` | thumbnail cache cap, default 300 |
| optional logo | drop `assets/brand/logo.svg` or `logo.png` to replace the text masthead |

## Layered graphic editor

Admin → a story → **Design graphic** opens the layered editor (the earlier form-based editor stays available as *Classic editor*). Every graphic is an editable **design document** (version 2): canvas size + an ordered list of layers (image, text, shape, gradient, badge), each with an exact frame, rotation, opacity, lock/visibility, and, for images, fit mode, zoom, offset, clipping and corner radius. The original image file is never modified; transforms are stored as numbers and applied at render time.

- **One coordinate system:** design pixels of the canvas, origin top-left, rotation clockwise about the element's centre. The view zoom (toolbar) only scales the screen; it never changes a stored number. Image zoom is relative to the fit scale of the chosen mode (1.00× = the fitted size).
- **One geometry, one renderer:** `src/design_geom.js` (resize, rotate, snap, fit, layers, validation) is imported by the server renderer (`src/render_doc.js`), the browser editor and the tests. The editor's canvas shows the **server-rendered** image, so preview and export are the same code path: byte-identical at 1×; the half-scale editing preview differs only by anti-aliasing (tested).
- **Moving and resizing:** drag to move; handles resize (the aspect lock is on by default, Shift inverts it, Alt resizes from the centre); the round handle rotates (Shift snaps to 15°); arrow keys nudge (1 px, Shift 10 px, configurable); snapping to canvas edges/centre/other layers/guides (hold Alt to bypass); Ctrl/⌘+click picks the topmost layer.
- **Keyboard:** Ctrl/⌘ Z undo, Shift+Z / Y redo, D duplicate, S save, Delete, Esc. Never active while typing in a field.
- **Templates:** saving an article graphic never touches a shared template. *Save as new template* refuses an existing name unless you confirm; *Update this template* is conflict-checked and keeps a version history (restore any version); *Duplicate* copies. Story words are never stored in a template. Old (classic) templates keep working and open as documents (a conversion tested against the classic renderer); changing the canvas size offers *scale / keep positions / fit image / reset to template*.
- **Safety:** documents are validated (sizes, ids, ranges, asset references); a story can only use its own photos; saves are checked against concurrent edits (a stale save is refused and writes nothing).
- Verify in a real browser: `npm run editor:check` (needs Google Chrome; isolated fixture, no auth, in-memory database).

## Source evidence, quotations and captions

- **Retrieval:** when a feed gives only a summary, the article page is fetched (opt-in per publisher in Sources → *Allow full-text retrieval*; robots.txt and `Content-Signal: ai-input=no` obeyed; 403/paywall/robots refusals remembered for a week and never worked around; timeouts/5xx retried at most 3 times with growing waits). Stored: HTTP status, final and canonical URL, method, fetch time, attempts, error, extracted text (`articles.*`). Extraction is cached and shared by both editions.
- **Source quality** (`src/source_quality.js`, thresholds in Pipeline → Editorial thresholds): `full` (a real article, not truncated, not navigation, ≥ full-words), `brief` (short but usable; only generated when *allow automatic short briefs* is on, with a word ceiling given to the model) or `insufficient` (the model is **not called**; the job waits in review with a reason such as *source needed*, *source restricted*, *insufficient source*). An RSS summary is never `full`.
- **Evidence:** the model must return `verified_facts` with exact evidence snippets, `attributed_quotes`, `unsupported_claims`. Software checks that each snippet exists in the captured text and that a fact carries no figure its evidence lacks; every quotation in the article (any quote style, including Nepali ‘ ’) must be in the source body and its speaker named there; a quote that exists only in the headline is rejected; a model that flags its own unsupported claims is not auto-published. Paraphrase is not required to match verbatim. Any problem triggers **one** stricter regeneration, then review.
- **Captions** are composed after the facts pass: if the model's caption copies the article/source, adds figures or quotes, it is regenerated separately (≤ `caption_regen_max`, from verified facts only); if that still fails a safe extractive caption (headline + standfirst) is used.
- Honest limits: evidence checks are textual, so a fact paraphrased from a *true* snippet can still be misread; cross-language quotes are checked only by their source-language original; JavaScript-only pages yield `too_short`; every automatic edition remains a candidate for human spot-checking.

## AI providers

Admin → AI providers manages Gemini, Groq, OpenRouter, Cerebras, Mistral and Requesty: encrypted keys (or env vars), per-model free flag, daily budgets, a daily spending cap and free-only mode, failover with cooldowns, and a test button. See [docs/AI_PROVIDERS.md](docs/AI_PROVIDERS.md) for what is verified and what you must verify on your own account.

## Pipeline states and recovery

`edition_jobs` (one row per story per edition): `queued → generating → published | needs_review | ready | failed`. Failures retry with doubling backoff (max 1 h, 5 attempts) and are shown with their error; Retry in Admin → Pipeline. A job left `generating` by a killed worker is re-queued on restart. `published` is written only after the `publications` row is read back with its timestamp. Every clustering decision (joined / new cluster / review candidate) is in `duplicate_decisions`; changed feed items are kept in `article_revisions`. Rollback: the migrations are additive (new tables, nullable columns); to switch the feature off set automatic publishing off - nothing already published is touched. Back up `data/everest.db` before upgrading.

## Hourly pick

Every hour (aligned to :00 Nepal time) the worker looks at the window that just closed and records one decision in the `selections` table:

- **Which stories compete:** stories whose first report was *fetched* inside that window (so a late arrival belongs to the window it arrived in, not the one it was published in), that are not older than the lateness tolerance (6 h by default, so a feed backlog is not "news of the hour"), not rejected, not already picked or already posted to social (a story that is live on the website is still eligible), not a near-duplicate of a recent pick or of a story with an unresolved duplicate link, and not from a publisher that forbids AI use.
- **How they are ranked:** the existing `rankClusters` score (importance, recency, corroboration, source credibility), evaluated *as of the window's close*, so a decision is reproducible. Ties are broken deterministically.
- **Qualifying:** score at least `select_min_score` (65) and at least `select_min_sources` (1). If nothing qualifies, **nothing is selected for that hour** and the reason is recorded.
- **Restarts:** a window is decided at most once (unique constraint). Windows that passed while the worker was down are recorded as `missed` and never back-filled with a stale story.
- **What it does *not* do:** it never publishes, posts or approves anything. Prepared for the pick: a separate **Nepali and English social draft** (caption + card with the story's own lead image) appear in Admin → Social review. Each edition is approved, edited, rejected or regenerated on its own; an approval is bound to the exact content and any change voids it; only an approved, unchanged draft can be sent to the delivery queue, and the worker re-checks this at send time. If an edition does not exist yet, `select_auto_draft` (off: costs AI requests) queues it.

Tune it under Admin → Settings → Hourly selection.

## One story, one image

Each story has one **lead image** (`clusters.lead_asset_id`). The website article, its cards and every graphic (Nepali and English) use it. A photo can only be used for the story it belongs to. To use an image found in a source report, an editor adopts it (Design → "Use…"): robots.txt must allow it, the editor records the licence/permission, and the original URL and report are stored with the asset. Publisher default images (the same file on several unrelated stories) are flagged. Changing the lead image, the graphic text or the edition makes older graphics and queued posts outdated, and they are refused until regenerated. Third-party thumbnails in the admin are cached for 7 days and are never shown publicly.

## How a story becomes public

1. **Discover** – the worker fetches the configured RSS feeds (Admin → Sources; URLs are editable, failures are shown, never hidden).
2. **Select** – stories are clustered and ranked (Newsroom / News). Pin, reject, re‑categorise.
3. **Generate both editions, independently** – every eligible new story gets one durable job per edition (`edition_jobs`, Admin → Pipeline). Each edition is its own AI request written straight from the original source reporting (headline, standfirst, body, **graphic text**, **social caption**, SEO fields, hashtags, alt text). Neither finished edition is ever the input of the other, and the output language is validated. Thin or ambiguous sources, wrong-language output, error flags, a possible duplicate or an already-live similar headline stop the edition in **needs review** instead of publishing.
4. **Review & approve** – every field is editable. Automatic gates (see below) flag risks; error flags must be explicitly acknowledged. Approving one edition re‑checks it against its counterpart.
5. **Publish to website** – with *automatic publishing* on (Admin → Pipeline, off by default; applies only to stories that arrive after it is switched on) clean editions are approved (`approved_by='auto'`) and published by the worker with no cap and no dependence on the hourly pick; changed source reporting never overwrites a live article, it flags it for review. Manually: only an *approved* draft can be published; one live article per story per language; a near‑duplicate headline in the same edition needs confirmation. Photos must be your own uploads with a recorded usage permission.
6. **Design & post** – the Design editor prefills the image from the **graphic** fields (never the website headline) and renders portrait/square/landscape. Posts use the **social caption**, with the real article URL substituted for `{{ARTICLE_URL}}` once the article is published.

Public pages never read drafts, sources or logs – only the `publications` table and rights‑cleared uploaded photos.

## Source material and what the AI is allowed to see

| Source text | Where it comes from | Notes |
|---|---|---|
| `articles.summary` | RSS description | never overwritten |
| `articles.content` | text carried in the feed (a few publishers include the full article) | never overwritten |
| `articles.full_text` | extracted from the public article page | **opt‑in per publisher** (Sources → “Allow full‑text retrieval”). Obeys robots.txt, rate‑limited, never bypasses paywalls or access restrictions, stores status (`extracted`, `robots_disallowed`, `ai_input_disallowed`, `access_restricted`, `paywall_suspected`, `too_short`, `extraction_failed`) |
| `drafts.*` | generated | separate from all of the above |

If a publisher’s robots.txt declares `Content-Signal: ai-input=no`, AI drafting from that publisher is blocked. “Full material” means at least 150 real words from extraction or the feed (`min_full_words` setting). Anything less is **limited source material**: the draft is flagged, must be acknowledged by an editor, and the system flags an article that is longer than its source supports (no padding).

## Editorial quality gates (flags for a human, not proof of truth)

completeness of every field in both editions · article depth vs. the real source size · padding on thin sources · figures, dates and names against the source · figure consistency between the two editions · structure/length mismatch between editions · language leakage · quotations must be verbatim in the source · **near‑copy detection** (share of 7‑word phrases copied from the source: warn ≥ 12%, error ≥ 25%; if the first result is ≥ 25% the system makes **one** extra rewrite request and keeps the less‑copied result) · caption must say more than the graphic text, not copy the article, carry hashtags and stay ≤ 900 characters · graphic text must fit the template in all three formats · source URL present · SEO length · publisher AI‑use declaration.

Cost: measured with `claude-haiku-5.5` on a 529‑word source, one request ≈ 9,300 output tokens ≈ **$0.005**; with the rewrite request ≈ **$0.010**. The configured model is the only one ever called. Admin → Settings shows what OpenRouter reports for your credit.

## Production deployment

Behind HTTPS (Caddy example – automatic certificates):

```
news.example.com {
    reverse_proxy 127.0.0.1:3470
}
```

systemd units (adjust paths/user):

```ini
# /etc/systemd/system/everest-web.service
[Service]
WorkingDirectory=/srv/everest
ExecStart=/usr/bin/node src/server.js
Restart=always
User=everest
MemoryMax=600M
[Install]
WantedBy=multi-user.target
```
```ini
# /etc/systemd/system/everest-worker.service
[Service]
WorkingDirectory=/srv/everest
ExecStart=/usr/bin/node src/worker.js
Restart=always
User=everest
MemoryMax=700M
[Install]
WantedBy=multi-user.target
```

Set `PUBLIC_BASE_URL=https://news.example.com` in `.env`. Run **one** worker. `GET /healthz` returns 200 only while the database is up and the worker heartbeat is fresh (503 otherwise) – point your uptime monitor at it. Logs go to journald (rotated by the system); application events are in the `audit` table (Admin → System Logs).

**Backups** (database + uploads + `.env`):

```bash
sqlite3 data/everest.db ".backup 'backup/everest-$(date +%F).db'"
rsync -a data/uploads/ backup/uploads/ && cp .env backup/.env
```

**Retention** runs daily in the worker: superseded graphics (30 d, unless used by an article or post), finished jobs (14 d), audit rows (90 d),
superseded drafts (60 d). Change via the `settings` table keys `retain_graphics_days`, `retain_jobs_days`, `retain_audit_days`, `retain_drafts_days`.
The thumbnail cache prunes itself to `IMG_CACHE_MB`.

## Tests

```bash
npm test      # 213 tests, ~22 s. Includes end-to-end tests that start real server and worker processes in a temp directory.
```

The AI tests use a local mock provider (they prove our code paths, not model quality). The social tests use the mock adapter.
Nothing in the test suite touches your data directory, a real model, or a real social account.

## What is and is not implemented

Working: feed ingestion and health, clustering/ranking, AI drafting (NE and EN) with checks, approval gate, public website (home, latest, category,
article, search, sitemap, robots, hreflang, structured data), graphic editor (Devanagari‑correct, 3 formats), stale‑graphic detection,
social queue (approve/schedule/retry/idempotency/crash recovery) against the **mock** adapter.

**Not implemented – needs credentials and development:** real Facebook Page, Instagram and X adapters (OAuth + publishing). They show as
“not configured” and can never report a connection or a post. Also not implemented: an editorial calendar view, analytics from real platform metrics, eKantipur (no public RSS feed found – set a URL in Sources when you have one).

## Rights and sources

Third‑party story images are shown only inside the private admin as small cached thumbnails for reference. The public website serves only photos you
uploaded with a recorded usage permission. Public article pages list links to the original reporting for that story; the site carries no blanket disclosure sentence or outlet labels on its home, category or card pages, and no source name is stamped on graphics unless an editor types one.
