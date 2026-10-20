// robots.txt handling shared by image enrichment and full-text retrieval: path rules AND Content-Signal AI-use declarations.
import { safeFetchBuffer } from './feeds.js';

const UA_NAME = 'everestnepalbot', TTL = 6 * 36e5, cache = new Map();
let fetcher = u => safeFetchBuffer(u, { maxBytes: 200 * 1024, truncate: true, timeoutMs: 10000 });
export const _setRobotsFetcher = f => { fetcher = f; cache.clear(); }; // tests only

export function robotsAllows(txt, path) {
  const groups = []; let cur = null, lastWasAgent = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim(); const m = line.match(/^([\w-]+)\s*:\s*(.*)$/); if (!m) continue;
    const k = m[1].toLowerCase(), v = m[2].trim();
    if (k === 'user-agent') { if (!lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); } cur.agents.push(v.toLowerCase()); lastWasAgent = true; }
    else { lastWasAgent = false; if (cur && (k === 'allow' || k === 'disallow') && v) cur.rules.push([k, v]); }
  }
  const g = groups.find(x => x.agents.includes(UA_NAME)) || groups.find(x => x.agents.includes('*')); if (!g) return true;
  let best = null;
  for (const [k, v] of g.rules) {
    const re = new RegExp('^' + v.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
    if (re.test(path) && (!best || v.length >= best[1].length)) best = [k, v];
  }
  return !best || best[0] === 'allow';
}
// Cloudflare-style "Content-Signal: search=yes, ai-input=no, ai-train=no". Absent = the site neither grants nor restricts.
export function contentSignals(txt) {
  const out = {};
  for (const raw of txt.split(/\r?\n/)) { const m = raw.replace(/#.*/, '').match(/^\s*content-signal\s*:\s*(.*)$/i); if (!m) continue; for (const pair of m[1].split(',')) { const [k, v] = pair.split('=').map(x => x?.trim().toLowerCase()); if (k && (v === 'yes' || v === 'no')) out[k] = out[k] === 'no' ? 'no' : v; } }
  return { search: out.search ?? null, aiInput: out['ai-input'] ?? null, aiTrain: out['ai-train'] ?? null };
}
// Returns { txt } or null when robots.txt could not be read (callers must treat that as "unknown", not "allowed").
export async function getRobots(url) {
  const x = new URL(url); let c = cache.get(x.host);
  if (!c || Date.now() - c.at > TTL) {
    try { const r = await fetcher(x.origin + '/robots.txt'); if (r.status >= 500) throw new Error('robots 5xx'); c = { at: Date.now(), txt: r.status < 400 ? r.buf.toString('utf8') : '' }; cache.set(x.host, c); }
    catch { return null; }
  }
  return { txt: c.txt };
}
export async function robotsDecision(url) {
  const r = await getRobots(url); if (!r) return { known: false, allowed: false, signals: null };
  const x = new URL(url); return { known: true, allowed: robotsAllows(r.txt, x.pathname + x.search), signals: contentSignals(r.txt) };
}
