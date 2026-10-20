// Source-text ladder: RSS summary -> text carried in the feed -> text extracted from the public article page.
// Extraction is OPT-IN per source (sources.fulltext_enabled), obeys robots.txt (including Content-Signal ai-input=no), is rate limited,
// never tries to get around paywalls or access controls, and writes to articles.full_text only: summary/content are never overwritten.
import * as cheerio from 'cheerio';
import { db, now, log } from './db.js';
import { safeFetch } from './feeds.js';
import { robotsDecision } from './robots.js';

export const MIN_WORDS = 60;
const REUSE_AFTER_MS = 6 * 36e5, REUSE_PERMANENT_MS = 7 * 864e5, MAX_FETCH_ATTEMPTS = 3, TRANSIENT_RE = /timeout|timed out|abort|econn|enotfound|eai_again|socket|network|fetch failed/i;
const PERMANENT = new Set(['access_restricted', 'paywall_suspected', 'robots_disallowed', 'ai_input_disallowed', 'too_short']); // not asked again for a week
let fetcher = u => safeFetch(u, { maxBytes: 1.5 * 1024 * 1024, truncate: true, timeoutMs: 15000, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5' });
export const _setPageFetcher = f => { fetcher = f; }; // tests only
let last = 0; const politeDelay = async () => { const d = process.env.EXTRACT_DELAY_MS, wait = last + (d !== undefined && Number.isFinite(+d) ? +d : 1000) - Date.now(); if (wait > 0) await new Promise(r => setTimeout(r, wait)); last = Date.now(); };

const words = t => (String(t).match(/\S+/g) || []).length;
const BOILER = /^(also read|read also|related( news| stories)?|advertisement|sponsored|follow us|subscribe|share this|click here|file photo|photo:|tags?:|यो पनि पढ्नुहोस्|थप पढ्नुहोस्|सम्बन्धित समाचार|विज्ञापन|फेसबुकमा फलो|हाम्रा सामाजिक)/i;
const clean = t => t.replace(/\s+/g, ' ').replace(/ /g, ' ').trim();
const flatten = j => (Array.isArray(j) ? j.flatMap(flatten) : j && typeof j === 'object' ? [j, ...flatten(j['@graph'] ?? [])] : []);
const authorName = a => (Array.isArray(a) ? authorName(a[0]) : typeof a === 'string' ? a : a?.name) || null;

function paragraphsOf($, root) {
  const seen = new Set();
  return $(root).find('p').map((_, p) => {
    const el = $(p), text = clean(el.text()), linkText = clean(el.find('a').text());
    if (text.length < 35 || BOILER.test(text) || linkText.length > text.length * 0.5 || seen.has(text)) return null; seen.add(text); return text;
  }).get();
}

// Pure function: HTML in, { paragraphs, author, published, method } out (or null). Exported for tests.
export function extractFromHtml(html) {
  const $ = cheerio.load(html); let ld = null;
  $('script[type="application/ld+json"]').each((_, el) => { try { for (const x of flatten(JSON.parse($(el).contents().text()))) if (/Article/.test(String(x['@type'])) && !ld) ld = x; } catch { /* malformed JSON-LD is common; ignore */ } });
  const canonical = $('link[rel=canonical]').attr('href') || $('meta[property="og:url"]').attr('content') || null;
  const author = authorName(ld?.author) || clean($('meta[name=author]').attr('content') || '') || null, published = ld?.datePublished || $('meta[property="article:published_time"]').attr('content') || null;
  if (ld?.articleBody && words(ld.articleBody) >= MIN_WORDS) return { paragraphs: String(ld.articleBody).split(/\n{1,}/).map(clean).filter(x => x.length > 20), author, published, canonical, method: 'jsonld' };
  const paywallHint = /paywall|subscribe to (continue|read)|premium (content|article)|members[- ]only|सदस्यता लिनुहोस्/i.test(html);
  $('script,style,noscript,nav,header,footer,aside,form,iframe,figure,figcaption,button,[class*=share],[class*=social],[class*=related],[class*=comment],[class*=advert],[class*=promo],[id*=comment]').remove();
  let best = null;
  for (const sel of ['[itemprop=articleBody]', 'article', '.entry-content', '.post-content', '.article-content', '.article-body', '.story-content', '.news-content', '.single-content', 'main', '#content'])
    $(sel).each((_, el) => { const ps = paragraphsOf($, el), total = ps.join('').length; if (!best || total > best.total) best = { ps, total, sel }; });
  if (!best || best.total < 200) { const ps = paragraphsOf($, 'body'); best = { ps, total: ps.join('').length, sel: 'body' }; }
  return { paragraphs: best.ps, author, published, canonical, method: best.sel === 'body' ? 'paragraphs' : 'container:' + best.sel, paywallHint };
}

// Text the editor/AI can actually rely on, and how much of it there is. "full" is a threshold on real words, not a claim about the article.
export const minFullWords = () => { const r = db.prepare("SELECT value FROM settings WHERE key='min_full_words'").get(); return r ? +JSON.parse(r.value) : 150; };
export function sourceTextFor(a) {
  const text = a.full_text?.trim() ? { text: a.full_text.trim(), origin: 'extracted' } : (a.content?.length ?? 0) > (a.summary?.length ?? 0) + 50 ? { text: a.content.trim(), origin: 'feed_content' } : { text: (a.summary ?? '').trim(), origin: 'rss_summary' };
  const w = words(text.text); return { ...text, words: w, level: text.origin !== 'rss_summary' && w >= minFullWords() ? 'full' : 'limited' };
}

async function mark(id, status, extra = {}) {
  db.prepare('UPDATE articles SET extraction_status=?,extracted_at=?,full_text=COALESCE(?,full_text),author=COALESCE(?,author),extraction_method=COALESCE(?,extraction_method),fetch_status=COALESCE(?,fetch_status),canonical_final=COALESCE(?,canonical_final),extraction_error=?,fetch_attempts=? WHERE id=?')
    .run(status, now(), extra.text ?? null, extra.author ?? null, extra.method ?? null, extra.http ?? null, extra.canonical ?? null, extra.error ?? null, extra.attempts ?? 0, id);
  return { status, ...extra };
}
// Returns { status, retryAt?, exhausted? }. Transient failures (timeout, 5xx, 429, network) are retried at most MAX_FETCH_ATTEMPTS times with growing waits;
// refusals (403, robots, paywall, AI-input=no) are remembered for a week and never worked around.
// Both editions of a story ask for the same page at the same moment: the second caller shares the first one's request instead of fetching it again.
const inflight = new Map();
export function extractFullText(articleId, opts = {}) { const k = `${articleId}:${opts.force ? 1 : 0}`; if (!inflight.has(k)) inflight.set(k, extractOnce(articleId, opts).finally(() => inflight.delete(k))); return inflight.get(k); }
async function extractOnce(articleId, { force = false } = {}) {
  const a = db.prepare('SELECT a.*, s.fulltext_enabled, s.name source FROM articles a JOIN sources s ON s.id=a.source_id WHERE a.id=?').get(articleId); if (!a) return { status: 'not_found' };
  if (a.full_text) return { status: 'extracted', reused: true };
  if (!a.fulltext_enabled) return { status: 'not_enabled', source: a.source }; // the editor has not confirmed this publisher's terms
  if (!force && a.extracted_at) {
    const age = Date.now() - Date.parse(a.extracted_at);
    if (a.extraction_status === 'extraction_failed') {
      if (a.fetch_attempts >= MAX_FETCH_ATTEMPTS) return { status: 'extraction_failed', exhausted: true, error: a.extraction_error };
      const wait = Math.min(2 ** a.fetch_attempts * 10, 120) * 60000; if (age < wait) return { status: 'extraction_failed', retryAt: new Date(Date.parse(a.extracted_at) + wait).toISOString(), reused: true, error: a.extraction_error };
    } else if (age < (PERMANENT.has(a.extraction_status) ? REUSE_PERMANENT_MS : REUSE_AFTER_MS)) return { status: a.extraction_status, reused: true };
  }
  const rb = await robotsDecision(a.url);
  if (!rb.known) return { status: 'robots_unreadable' }; // do not record an attempt: try again later
  if (!rb.allowed) return mark(a.id, 'robots_disallowed');
  if (rb.signals?.aiInput === 'no') return mark(a.id, 'ai_input_disallowed'); // publisher forbids using its content as AI input
  await politeDelay();
  const attempts = (a.fetch_attempts ?? 0) + 1, fail = (error, http = null, permanent = false) => mark(a.id, 'extraction_failed', { error: String(error).slice(0, 300), http, attempts: permanent ? MAX_FETCH_ATTEMPTS : attempts, ...(permanent ? {} : { retryAt: null }) });
  let res; try { res = await fetcher(a.url); } catch (e) { return fail(e.message, null, !TRANSIENT_RE.test(e.message)); }
  if (res.status === 401 || res.status === 402 || res.status === 403) return mark(a.id, 'access_restricted', { http: res.status }); // we do not try to get around this
  if (res.status === 404 || res.status === 410) return fail('HTTP ' + res.status, res.status, true);
  if (res.status >= 400) return fail('HTTP ' + res.status, res.status);
  const ex = extractFromHtml(res.body), text = ex.paragraphs.join('\n\n'), w = words(text); let canonical = null; try { canonical = ex.canonical ? new URL(ex.canonical, res.finalUrl || a.url).href : (res.finalUrl || null); } catch { canonical = res.finalUrl || null; }
  const base = { http: res.status, canonical, attempts };
  if (ex.paywallHint && w < 150) return mark(a.id, 'paywall_suspected', base);
  if (w < MIN_WORDS) return mark(a.id, 'too_short', base);
  log('extract', `${a.source} article ${a.id}: ${w} words via ${ex.method}`);
  return mark(a.id, 'extracted', { ...base, text, author: ex.author, method: ex.method, words: w });
}
