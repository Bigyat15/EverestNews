import { db } from './db.js';

export const DEFAULT_WEIGHTS = { recency: 30, corroboration: 25, nepal: 15, credibility: 10, impact: 10, facts: 10 };
export const getWeights = () => { const r = db.prepare("SELECT value FROM settings WHERE key='rank_weights'").get(); return { ...DEFAULT_WEIGHTS, ...(r ? JSON.parse(r.value) : {}) }; };

const CATS = {
  politics: /सरकार|मन्त्री|प्रधानमन्त्री|संसद|दल|पार्टी|सभा|government|minister|parliament|party|cabinet|prime minister/i,
  election: /निर्वाचन|चुनाव|मतदान|उम्मेदवार|election|vote|poll|candidate/i,
  crime: /हत्या|पक्राउ|अपराध|चोरी|बलात्कार|आरोप|अनुसन्धान|arrest|murder|crime|police|allegation|corruption|भ्रष्टाचार/i,
  health: /स्वास्थ्य|अस्पताल|रोग|डेंगु|कोरोना|खोप|health|hospital|disease|dengue|covid/i,
  disaster: /भूकम्प|बाढी|पहिरो|आगलागी|दुर्घटना|मृत्यु|मृत|घाइते|earthquake|flood|landslide|fire|accident|killed|dead|injured|death/i,
  economy: /अर्थ|बजार|शेयर|नेप्से|बैंक|मूल्य|रुपैयाँ|economy|market|nepse|bank|price|budget|rupee/i,
  sports: /खेल|क्रिकेट|फुटबल|खेलाडी|cricket|football|match|tournament|sport/i,
};
const SENSITIVE = new Set(['politics', 'election', 'crime', 'health', 'disaster']);
const NEPAL = /नेपाल|काठमाडौं|काठमाण्डौं|प्रदेश|नेपाली|nepal|kathmandu|nepali|pokhara|biratnagar|lalitpur|bhaktapur/i;
const HIGH_IMPACT = new Set(['disaster', 'election', 'politics', 'health', 'economy', 'crime']);

export function categorize(text) { for (const [c, re] of Object.entries(CATS)) if (re.test(text)) return c; return 'other'; }

// Ranks every non-rejected cluster that has activity in the last 7 days. Returns explainable results.
// asOf: rank the world as it was known at that instant (only articles fetched by then), so a past selection is reproducible.
export function rankClusters(nowMs = Date.now(), { asOf = null } = {}) {
  const W = getWeights(), since = new Date(nowMs - 7 * 864e5).toISOString();
  const rows = db.prepare(`SELECT a.id,a.cluster_id,a.source_id,a.title,a.summary,a.url,a.language,a.image_url,a.extraction_status,a.workflow_status,a.duplicate_of,
    COALESCE(a.published_at,a.fetched_at) t, a.fetched_at fa, length(COALESCE(a.content,'')) cl, length(COALESCE(a.summary,'')) sl, s.name source, s.credibility
    FROM articles a JOIN sources s ON s.id=a.source_id WHERE COALESCE(a.published_at,a.fetched_at)>=? ${asOf ? 'AND a.fetched_at<=?' : ''}`).all(...(asOf ? [since, asOf] : [since]));
  const live = new Set(db.prepare("SELECT DISTINCT cluster_id FROM publications WHERE status='published'").all().map(r => r.cluster_id)); // a story that is live on the site is never a candidate again
  const man = new Map(db.prepare('SELECT * FROM clusters').all().map(c => [c.id, c]));
  const groups = new Map(); for (const r of rows) (groups.get(r.cluster_id) ?? groups.set(r.cluster_id, []).get(r.cluster_id)).push(r);
  const out = [];
  for (const [id, arts] of groups) {
    const m = man.get(id) ?? {}; arts.sort((a, b) => (a.t < b.t ? 1 : -1));
    const lead = arts.reduce((b, a) => (a.cl + a.sl > b.cl + b.sl ? a : b));
    const text = arts.map(a => a.title + ' ' + a.summary).join(' ');
    const category = m.category || categorize(text), srcIds = new Set(arts.map(a => a.source_id));
    const ageH = (nowMs - Date.parse(arts[0].t)) / 36e5;
    const f = {
      recency: [0.5 ** (Math.max(ageH, 0) / 6), `latest report ${ageH.toFixed(1)}h ago (half-life 6h)`],
      corroboration: [Math.min(1, Math.log(srcIds.size) / Math.log(4)), `${srcIds.size} distinct source(s); independence of reporting is not verified`],
      nepal: [NEPAL.test(text) ? 1 : arts.some(a => a.language === 'ne') ? 0.7 : 0.3, NEPAL.test(text) ? 'mentions Nepal/Nepali place' : 'no explicit Nepal keyword'],
      credibility: [arts.reduce((s, a) => s + a.credibility, 0) / arts.length, 'mean of editor-set source credibility'],
      impact: [HIGH_IMPACT.has(category) ? 1 : 0.3, `category: ${category}`],
      facts: [Math.min(1, Math.max(...arts.map(a => a.cl + a.sl)) / 600), `${Math.max(...arts.map(a => a.cl + a.sl))} chars of source text available`],
    };
    const factors = Object.entries(f).map(([k, [v, note]]) => ({ factor: k, value: +v.toFixed(2), weight: W[k], points: +(v * W[k]).toFixed(1), note }));
    const base = factors.reduce((s, x) => s + x.points, 0), manual = (m.priority || 0) * 5;
    if (manual) factors.push({ factor: 'editor priority', value: m.priority, weight: 5, points: manual, note: 'manual boost' });
    const sensitive = SENSITIVE.has(category), published = live.has(id) || arts.some(a => a.workflow_status === 'published');
    out.push({ id, score: +(base + manual).toFixed(1), factors, category, sensitive, sources: srcIds.size, firstSeen: arts.reduce((m, a) => (a.fa < m ? a.fa : m), arts[0].fa), ageH: +ageH.toFixed(2), pinned: !!m.pinned, rejected: !!m.rejected, priority: m.priority || 0,
      published, hasDup: arts.some(a => a.duplicate_of), lead: { id: lead.id, title: lead.title, url: lead.url, source: lead.source, image: lead.image_url || arts.find(a => a.image_url)?.image_url || null, imageId: (lead.image_url ? lead : arts.find(a => a.image_url))?.id ?? null, language: lead.language, summary: lead.summary.slice(0, 220) },
      articles: arts.map(a => ({ source_id: a.source_id, image: a.image_url, language: a.language, id: a.id, title: a.title, url: a.url, source: a.source, t: a.t, textChars: a.cl + a.sl, extraction: a.extraction_status })), latest: arts[0].t });
  }
  return out;
}

export function view(name, nowMs = Date.now()) {
  const all = rankClusters(nowMs), live = all.filter(c => !c.rejected);
  const byScore = (a, b) => b.pinned - a.pinned || b.score - a.score;
  const nstMidnight = (() => { const d = new Date(nowMs + 5.75 * 36e5); d.setUTCHours(0, 0, 0, 0); return d.getTime() - 5.75 * 36e5; })();
  const f = {
    now: () => live.filter(c => c.ageH <= 48).sort(byScore),
    hour: () => live.filter(c => c.ageH <= 1).sort(byScore),
    today: () => live.filter(c => Date.parse(c.latest) >= nstMidnight).sort(byScore),
    // Breaking needs recency AND >1 source; it is a candidate for human check, never an automatic label.
    breaking: () => live.filter(c => c.ageH <= 3 && c.sources >= 2).sort(byScore),
    trending: () => live.filter(c => c.ageH <= 6 && c.sources >= 3).sort((a, b) => b.sources - a.sources || b.score - a.score),
    verify: () => live.filter(c => c.sources === 1 && (c.sensitive || c.ageH <= 6)).sort(byScore),
    dups: () => all.filter(c => c.rejected || c.published || c.hasDup).sort(byScore),
  }[name];
  return f ? f().slice(0, 50) : null;
}
