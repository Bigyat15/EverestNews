// Fills in missing thumbnails from each article page's og:image / twitter:image meta tag.
// Reference thumbnails only: rights are NOT cleared; the editor uploads a licensed photo for the final graphic.
import { db, now } from './db.js';
import { safeFetch } from './feeds.js';

import { robotsAllows, robotsDecision } from './robots.js';
export { robotsAllows }; // kept for existing imports/tests

const HEAD_BYTES = 250 * 1024;
async function allowed(u) { const d = await robotsDecision(u); return d.known ? d.allowed : null; } // null = robots.txt unreadable: skip for now, retry later

export function extractImage(html, base) {
  const metas = html.match(/<meta\b[^>]*>/gi) || [];
  const get = tag => { for (const m of metas) { if (new RegExp(`(?:property|name)=["']${tag}["']`, 'i').test(m)) { const c = m.match(/content=["']([^"']+)["']/i); if (c) return c[1]; } } };
  const raw = get('og:image:secure_url') || get('og:image') || get('twitter:image') || get('twitter:image:src');
  if (!raw) return null;
  try { const u = new URL(raw.replace(/&amp;/g, '&'), base); return /^https?:$/.test(u.protocol) ? u.href : null; } catch { return null; }
}

// One small batch per call (called by the idle worker loop): newest first, one page at a time.
export async function enrichBatch(n = 4) {
  const rows = db.prepare(`SELECT id,url FROM articles WHERE image_url IS NULL AND image_checked_at IS NULL AND COALESCE(published_at,fetched_at)>=? ORDER BY COALESCE(published_at,fetched_at) DESC LIMIT ?`)
    .all(new Date(Date.now() - 3 * 864e5).toISOString(), n);
  const done = (id, img, st) => db.prepare('UPDATE articles SET image_url=COALESCE(?,image_url),image_source=?,image_checked_at=? WHERE id=?').run(img, st, now(), id);
  for (const r of rows) {
    try {
      const ok = await allowed(r.url);
      if (ok === null) continue; if (ok === false) { done(r.id, null, 'robots_disallowed'); continue; }
      const res = await safeFetch(r.url, { maxBytes: HEAD_BYTES, truncate: true });
      if (res.status >= 400) { done(r.id, null, 'http_' + res.status); continue; }
      const img = extractImage(res.body, res.finalUrl); done(r.id, img, img ? 'og' : 'none');
    } catch (e) { done(r.id, null, 'error'); }
    await new Promise(r2 => setTimeout(r2, 800)); // politeness delay
  }
  return rows.length > 0;
}

// A publisher's default/stock image reused across unrelated stories is not "the image of this event".
// Heuristic: the same image URL on 3+ other stories from the same source within 30 days.
export function genericImage(a) {
  if (!a?.image_url) return false;
  return db.prepare(`SELECT COUNT(DISTINCT cluster_id) n FROM articles WHERE source_id=? AND image_url=? AND id<>? AND COALESCE(published_at,fetched_at)>=?`).get(a.source_id, a.image_url, a.id, new Date(Date.now() - 30 * 864e5).toISOString()).n >= 3;
}
