import dns from 'node:dns/promises';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { tokens } from './cluster.js';
import { XMLParser } from 'fast-xml-parser';
import { db, now, log } from './db.js';

const MAX_BYTES = 5 * 1024 * 1024, TIMEOUT_MS = 20000, MAX_REDIRECTS = 5;
const UA = 'EverestNepalBot/0.1 (+RSS reader; contact admin)';

export function isPrivateIp(ip) {
  if (net.isIPv6(ip)) { const v = ip.toLowerCase(); return v === '::1' || v === '::' || /^f[cd]/.test(v) || v.startsWith('fe80') || v.startsWith('::ffff:') && isPrivateIp(v.slice(7)); }
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}
async function assertSafe(u) {
  const url = new URL(u);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('blocked: non-http(s) URL');
  const addrs = net.isIP(url.hostname) ? [{ address: url.hostname }] : await dns.lookup(url.hostname, { all: true });
  if (addrs.some(a => isPrivateIp(a.address))) throw new Error('blocked: private/internal address (SSRF guard)');
}

// Manual redirect following so every hop is SSRF-checked; body is size-capped. Returns raw bytes.
export async function safeFetchBuffer(startUrl, { maxBytes = MAX_BYTES, truncate = false, timeoutMs = TIMEOUT_MS, accept = 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' } = {}) {
  let url = startUrl;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    await assertSafe(url);
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': UA, accept } });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { url = new URL(res.headers.get('location'), url).href; continue; }
    const reader = res.body.getReader(); const chunks = []; let n = 0;
    for (;;) { const { done, value } = await reader.read(); if (done) break; n += value.length; chunks.push(value); if (n > maxBytes) { reader.cancel(); if (!truncate) throw new Error('response too large'); break; } }
    return { status: res.status, type: res.headers.get('content-type') || '', finalUrl: url, buf: Buffer.concat(chunks) };
  }
  throw new Error('too many redirects');
}
export async function safeFetch(startUrl, opts) { const r = await safeFetchBuffer(startUrl, opts); const { buf, ...rest } = r; return { ...rest, body: buf.toString('utf8') }; }

const TRACKING = /^(utm_|fbclid|gclid|mc_|ref$|source$)/i;
export function canonUrl(u) {
  const x = new URL(u); x.hash = ''; x.hostname = x.hostname.replace(/^www\./, '');
  for (const k of [...x.searchParams.keys()]) if (TRACKING.test(k)) x.searchParams.delete(k);
  x.searchParams.sort(); x.pathname = x.pathname.replace(/\/+$/, '') || '/';
  return x.href.replace(/\/$/, '');
}
export const titleKey = t => t.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
export function detectLang(text) {
  const letters = (text.match(/\p{L}/gu) || []).length; if (!letters) return null;
  const dev = (text.match(/[ऀ-ॿ]/g) || []).length / letters;
  return dev > 0.5 ? 'ne' : (text.match(/[A-Za-z]/g) || []).length / letters > 0.8 ? 'en' : 'other';
}
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”' };
export const decodeEntities = h => h.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (m, d, x, n) => { try { return d ? String.fromCodePoint(+d) : x ? String.fromCodePoint(parseInt(x, 16)) : (ENT[n.toLowerCase()] ?? m); } catch { return m; } });
// tags first, then entities, so an escaped "&lt;b&gt;" stays text instead of being treated as markup
const strip = h => decodeEntities((h || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
const txt = v => (v == null ? '' : typeof v === 'object' ? (v['#text'] ?? '') : String(v));
const arr = v => (v == null ? [] : Array.isArray(v) ? v : [v]);

export function parseFeed(xml) {
  const p = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', processEntities: true, trimValues: true });
  let doc; try { doc = p.parse(xml); } catch (e) { throw new Error('malformed XML: ' + e.message); }
  const items = doc?.rss?.channel ? arr(doc.rss.channel.item) : doc?.feed ? arr(doc.feed.entry) : doc?.['rdf:RDF'] ? arr(doc['rdf:RDF'].item) : null;
  if (!items) throw new Error('not an RSS/Atom feed (no channel/feed element)');
  return items.map(it => {
    const link = typeof it.link === 'object' ? (arr(it.link).find(l => l['@_rel'] !== 'self')?.['@_href'] ?? '') : txt(it.link) || txt(it.guid);
    const enc = arr(it.enclosure)[0], mc = arr(it['media:content'])[0] || arr(it['media:thumbnail'])[0];
    const html = txt(it['content:encoded']) || txt(it.content);
    let image = enc?.['@_type']?.startsWith('image') ? enc['@_url'] : mc?.['@_url'];
    image ||= html.match(/<img[^>]+src=["']([^"']+)/i)?.[1] || txt(it.description).match(/<img[^>]+src=["']([^"']+)/i)?.[1];
    const d = new Date(txt(it.pubDate) || txt(it.published) || txt(it.updated) || txt(it['dc:date']));
    return { guid: txt(it.guid) || txt(it.id), url: String(link).trim(), title: strip(txt(it.title)), summary: strip(txt(it.description) || txt(it.summary)), content: strip(html),
      published: isNaN(d) ? null : d.toISOString(), image: image || null, category: arr(it.category).map(txt)[0] || null };
  });
}

// Fetch one source, store results, update health. Never fabricates entries.
export async function fetchSource(sourceId) {
  const s = db.prepare('SELECT * FROM sources WHERE id=?').get(sourceId);
  const t = now(); let res;
  try {
    res = await safeFetch(s.feed_url);
    if (res.status >= 400) throw Object.assign(new Error(`HTTP ${res.status}`), { http: res.status, blocked: [401, 403, 429].includes(res.status) });
    if (/html/i.test(res.type) && !/<rss|<feed|<rdf/i.test(res.body.slice(0, 2000))) throw Object.assign(new Error(`HTML returned instead of a feed (${res.type})`), { http: res.status });
    const entries = parseFeed(res.body).filter(e => e.url && e.title);
    const ins = db.prepare(`INSERT OR IGNORE INTO articles(source_id,guid,url,canon_url,title,title_key,language,summary,content,published_at,fetched_at,updated_at,image_url,category,extraction_status,ignore_reason,content_hash)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const find = db.prepare('SELECT id,cluster_id,title,summary,content,content_hash FROM articles WHERE source_id=? AND (guid=? OR canon_url=?)');
    let added = 0, bad = 0; db.exec('BEGIN');
    try {
      for (const e of entries) {
        let cu; try { cu = canonUrl(new URL(e.url, res.finalUrl).href); } catch { bad++; continue; }
        const lang = detectLang(e.title + ' ' + e.summary);
        const status = e.content.length > 400 ? 'full_text_in_feed' : 'rss_only';
        const hash = createHash('sha1').update([e.title, e.summary, e.content].join('\n')).digest('hex');
        const prev = find.get(sourceId, e.guid || cu, cu);
        if (prev) { // already known: track changed source reporting without touching anything published
          if (prev.content_hash && prev.content_hash !== hash) {
            db.prepare('INSERT INTO article_revisions(article_id,at,title,summary,content,content_hash) VALUES(?,?,?,?,?,?)').run(prev.id, t, prev.title, prev.summary, prev.content, prev.content_hash);
            db.prepare('UPDATE articles SET title=?,summary=?,content=?,content_hash=?,revision_count=revision_count+1,updated_at=? WHERE id=?').run(e.title, e.summary, e.content || null, hash, t, prev.id);
            if (prev.cluster_id) db.prepare("UPDATE edition_jobs SET update_pending=1 WHERE cluster_id=?").run(prev.cluster_id);
          } else if (!prev.content_hash) db.prepare('UPDATE articles SET content_hash=? WHERE id=?').run(hash, prev.id);
          continue;
        }
        // unusable items (no real headline) are kept for the record but never enter the pipeline
        const ignore = tokens(e.title).size < 2 ? 'title_too_short' : null;
        added += ins.run(sourceId, e.guid, cu, cu, e.title, titleKey(e.title), lang, e.summary, e.content || null, e.published, t, t, e.image, e.category, status, ignore, hash).changes;
      }
      db.exec('COMMIT');
    } catch (err) { db.exec('ROLLBACK'); throw err; }
    const any = f => entries.some(f) ? 1 : 0;
    const langs = {}; entries.forEach(e => { const l = detectLang(e.title) || '?'; langs[l] = (langs[l] || 0) + 1; });
    db.prepare(`UPDATE sources SET status='working',final_url=?,last_http=?,last_error=NULL,last_success_at=?,last_checked_at=?,last_new=?,fail_count=0,
      has_headline=?,has_summary=?,has_content=?,has_image=?,has_url=?,language=?,entries_seen=? WHERE id=?`)
      .run(res.finalUrl, res.status, t, t, added, any(e => e.title), any(e => e.summary), any(e => e.content.length > 400), any(e => e.image), any(e => e.url),
        Object.entries(langs).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null, entries.length, sourceId);
    if (bad) log('fetch', `${s.name}: ${bad} entries skipped (bad URL)`);
    return { added, seen: entries.length };
  } catch (err) {
    const status = err.blocked ? 'blocked' : /malformed|not an RSS|HTML returned|HTTP 404|HTTP 410/.test(err.message) ? 'needs_investigation' : 'failing';
    db.prepare(`UPDATE sources SET status=?,final_url=COALESCE(?,final_url),last_http=?,last_error=?,last_checked_at=?,last_new=0,fail_count=fail_count+1 WHERE id=?`)
      .run(status, res?.finalUrl ?? null, err.http ?? res?.status ?? null, err.message, t, sourceId);
    log('fetch_error', `${s.name}: ${err.message}`);
    throw err;
  }
}
