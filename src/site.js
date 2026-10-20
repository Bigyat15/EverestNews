// Public Everest News website: server-rendered HTML, no JavaScript required, separate from the admin app.
// It only ever reads rows from `publications` (approved, published snapshots) and rights-cleared uploaded photos.
import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';
import { BRAND } from './brand.js';
import { view } from './rank.js';
import { articlePath } from './slug.js';
import { assetImage } from './imgcache.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATIC = {
  'site.css': ['site/site.css', 'text/css', 3600], 'site.js': ['site/site.js', 'text/javascript', 3600], 'favicon.svg': ['site/favicon.svg', 'image/svg+xml', 86400],
  ...Object.fromEntries(['NotoSansDevanagari-Medium', 'NotoSansDevanagari-Bold', 'NotoSansDevanagari-ExtraBold', 'RedHatDisplay-Bold', 'RedHatDisplay-Black'].map(n => [n + '.ttf', [`assets/fonts/${n}.ttf`, 'font/ttf', 2592000]])),
};
const LOGO = ['logo.svg', 'logo.png'].map(f => path.join(ROOT, 'assets/brand', f)).find(existsSync); // optional replaceable logo
if (LOGO) STATIC['logo' + path.extname(LOGO)] = [path.relative(ROOT, LOGO), LOGO.endsWith('svg') ? 'image/svg+xml' : 'image/png', 3600];

export const CAT_NAMES = {
  politics: { ne: 'राजनीति', en: 'Politics' }, economy: { ne: 'अर्थतन्त्र', en: 'Economy' }, sports: { ne: 'खेलकुद', en: 'Sports' }, crime: { ne: 'अपराध', en: 'Crime' },
  health: { ne: 'स्वास्थ्य', en: 'Health' }, disaster: { ne: 'विपद्', en: 'Disaster' }, national: { ne: 'राष्ट्रिय', en: 'National' },
};
const CAT_ORDER = Object.keys(CAT_NAMES);
const T = {
  ne: { native: 'नेपाली', home: 'गृहपृष्ठ', latest: 'ताजा', latestH: 'ताजा समाचार', top: 'मुख्य समाचार', more: 'थप समाचार', searchPh: 'समाचार खोज्नुहोस्', searchH: 'खोज', viewAll: 'सबै हेर्नुहोस् »', breaking: 'ब्रेकिङ', related: 'सम्बन्धित समाचार', sources: 'मूल प्रतिवेदन', share: 'सेयर', copy: 'लिङ्क कपी', copied: 'कपी भयो', updated: 'अद्यावधिक', prev: '← अघिल्लो', next: 'पछिल्लो →',
    emptyT: 'हाल कुनै प्रकाशित समाचार छैन', emptyB: 'सम्पादकले समीक्षा गरी स्वीकृत गरेपछि समाचार यहाँ देखिनेछन्।', noRes: 'कुनै नतिजा भेटिएन', noResB: 'अर्को शब्दले खोज्नुहोस्।', tooShort: 'कम्तीमा दुई अक्षर लेख्नुहोस्।', resFor: 'नतिजा', nf: 'पृष्ठ भेटिएन', nfB: 'तपाईंले खोजेको पृष्ठ उपलब्ध छैन।', back: 'गृहपृष्ठमा जानुहोस्', err: 'केही गडबड भयो। कृपया फेरि प्रयास गर्नुहोस्।', tag: 'नेपाल र विश्वका समाचार', desc: 'नेपाल र विश्वका मुख्य समाचार — एभरेस्ट न्युज।', min: 'मिनेट अघि', hr: 'घण्टा अघि', rate: 'धेरै अनुरोध भए। केही बेरपछि प्रयास गर्नुहोस्।' },
  en: { native: 'English', home: 'Home', latest: 'Latest', latestH: 'Latest news', top: 'Top stories', more: 'More stories', searchPh: 'Search stories', searchH: 'Search', viewAll: 'View all »', breaking: 'Breaking', related: 'Related stories', sources: 'Original reporting', share: 'Share', copy: 'Copy link', copied: 'Copied', updated: 'Updated', prev: '← Newer', next: 'Older →',
    emptyT: 'No stories published yet', emptyB: 'Stories appear here once an editor has reviewed and approved them.', noRes: 'No results found', noResB: 'Try a different word.', tooShort: 'Type at least two characters.', resFor: 'results', nf: 'Page not found', nfB: 'The page you are looking for is not available.', back: 'Back to the home page', err: 'Something went wrong. Please try again.', tag: 'News from Nepal and beyond', desc: 'The day’s main news from Nepal and the world — Everest News.', min: 'min ago', hr: 'h ago', rate: 'Too many requests. Please try again shortly.' },
};

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const J = s => { try { return JSON.parse(s); } catch { return []; } };
const nfNe = new Intl.NumberFormat('ne-NP');
const fmtDate = (iso, lang, time = false) => {
  const d = new Date(iso);
  if (lang === 'ne') { const p = Object.fromEntries(new Intl.DateTimeFormat('ne-NP', { timeZone: 'Asia/Kathmandu', day: 'numeric', month: 'long', year: 'numeric', ...(time && { hour: 'numeric', minute: '2-digit', hour12: true }) }).formatToParts(d).map(x => [x.type, x.value])); return `${p.day} ${p.month} ${p.year}` + (time ? `, ${p.hour}:${p.minute} ${p.dayPeriod ?? ''}`.trimEnd() : ''); }
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kathmandu', day: 'numeric', month: 'short', year: 'numeric', ...(time && { hour: '2-digit', minute: '2-digit' }) }).format(d) + (time ? ' NST' : '');
};
const rel = (iso, lang) => { const m = Math.round((Date.now() - Date.parse(iso)) / 60000), t = T[lang]; const n = x => (lang === 'ne' ? nfNe.format(x) : x); return m < 60 ? `${n(Math.max(1, m))} ${t.min}` : m < 1440 ? `${n(Math.round(m / 60))} ${t.hr}` : fmtDate(iso, lang); };
const baseUrl = h => { if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, ''); const host = /^[\w.\-:\[\]]+$/.test(h.host ?? '') ? h.host : 'localhost'; return `${h['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${host}`; };

const published = (lang, extra = '', ...a) => db.prepare(`SELECT p.*, c.pinned FROM publications p JOIN clusters c ON c.id=p.cluster_id WHERE p.lang=? AND p.status='published' ${extra}`).all(lang, ...a);
let brk = { at: 0, ids: new Set() };
const breakingClusters = () => { if (Date.now() - brk.at > 45000) { try { brk = { at: Date.now(), ids: new Set(view('breaking').map(c => c.id)) }; } catch { brk = { at: Date.now(), ids: new Set() }; } } return brk.ids; };
const norm = t => String(t ?? '').replace(/\[\[|\]\]/g, '').replace(/\s+/g, ' ').trim();
const ogGraphic = p => { if (!p.graphic_id) return null; const g = db.prepare('SELECT * FROM graphics WHERE id=?').get(p.graphic_id); return g && g.status === 'current' && norm(g.headline_snapshot) === norm(p.headline) ? g : null; };

/* ---------- html pieces ---------- */
const photoUrl = (p, w) => `/media/p/${p.id}?w=${w}&v=${Date.parse(p.updated_at) || 0}`;
const img = (p, w, h, o = {}) => p.photo_asset_id
  ? `<img src="${photoUrl(p, w)}" srcset="${photoUrl(p, w)} ${w}w, ${photoUrl(p, Math.min(1024, w * 2))} ${Math.min(1024, w * 2)}w" sizes="${o.sizes || '25vw'}" width="${w}" height="${h}" ${o.eager ? 'loading="eager" fetchpriority="high"' : 'loading="lazy"'} decoding="async" alt="${esc(p.alt_text || p.headline)}">`
  : `<div class="ph" aria-hidden="true"><span>${esc(BRAND)}</span></div>`;
const href = p => esc(articlePath(p));
const catLink = (p, lang) => `<div class="cat"><a href="/${lang}/category/${p.category}">${esc(CAT_NAMES[p.category]?.[lang] ?? p.category)}</a></div>`;
const card = (p, lang, o = {}) => `<article class="card"><a class="media" href="${href(p)}" tabindex="-1" aria-hidden="true">${img(p, o.w ?? 320, o.h ?? 213, o)}</a>${catLink(p, lang)}<h3><a href="${href(p)}">${esc(p.headline)}</a></h3><div class="meta"><time datetime="${p.published_at}">${rel(p.published_at, lang)}</time></div>${o.ex && p.summary ? `<p class="ex">${esc(p.summary)}</p>` : ''}</article>`;
const row = (p, lang) => `<div class="row"><div>${catLink(p, lang).replace('class="cat"', 'class="cat" style="margin-top:0"')}<h4><a href="${href(p)}">${esc(p.headline)}</a></h4><div class="meta"><time datetime="${p.published_at}">${rel(p.published_at, lang)}</time></div></div><a class="thumb" href="${href(p)}" tabindex="-1" aria-hidden="true">${img(p, 160, 120, { sizes: '72px' })}</a></div>`;
const pager = (lang, basePath, page, pages, t) => pages > 1 ? `<nav class="pager" aria-label="pagination">${page > 1 ? `<a href="${basePath}?page=${page - 1}" rel="prev">${t.prev}</a>` : ''}<span>${lang === 'ne' ? nfNe.format(page) : page} / ${lang === 'ne' ? nfNe.format(pages) : pages}</span>${page < pages ? `<a href="${basePath}?page=${page + 1}" rel="next">${t.next}</a>` : ''}</nav>` : '';
const sec = (title, link, linkText) => `<div class="sec"><h2>${esc(title)}</h2>${link ? `<a href="${link}">${esc(linkText)}</a>` : ''}</div>`;

const logoHtml = lang => LOGO ? `<a class="mast" href="/${lang}/" aria-label="${esc(BRAND)}"><img src="/static/logo${path.extname(LOGO)}" alt="${esc(BRAND)}"></a>` : `<a class="mast" href="/${lang}/">${esc(BRAND.split(' ')[0].toUpperCase())} <b>${esc(BRAND.split(' ').slice(1).join(' ').toUpperCase())}</b></a>`;
const ICON = { menu: '<svg viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h16"/></svg>', search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>' };

function layout(lang, base, o) {
  const t = T[lang], other = lang === 'ne' ? 'en' : 'ne', cats = db.prepare("SELECT DISTINCT category FROM publications WHERE lang=? AND status='published'").all(lang).map(r => r.category).sort((a, b) => CAT_ORDER.indexOf(a) - CAT_ORDER.indexOf(b));
  const canon = base + (o.path ?? `/${lang}/`), title = o.title ? `${o.title} | ${BRAND}` : `${BRAND} — ${t.tag}`, desc = o.desc || t.desc;
  const alts = o.alts ? Object.entries(o.alts).map(([l, u]) => `<link rel="alternate" hreflang="${l}" href="${base}${esc(u)}">`).join('') + `<link rel="alternate" hreflang="x-default" href="${base}${esc(o.alts.ne ?? o.alts.en)}">` : '';
  const ld = o.jsonld ? `<script type="application/ld+json">${JSON.stringify(o.jsonld).replace(/</g, '\\u003c')}</script>` : '';
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(desc)}"><link rel="canonical" href="${esc(canon)}">${o.noindex ? '<meta name="robots" content="noindex,follow">' : ''}${alts}
<meta property="og:site_name" content="${esc(BRAND)}"><meta property="og:type" content="${o.ogType || 'website'}"><meta property="og:title" content="${esc(o.title || BRAND)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:url" content="${esc(canon)}"><meta property="og:locale" content="${lang === 'ne' ? 'ne_NP' : 'en_US'}">
${o.ogImage ? `<meta property="og:image" content="${esc(base + o.ogImage)}"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="${esc(base + o.ogImage)}">` : '<meta name="twitter:card" content="summary">'}
<meta name="twitter:title" content="${esc(o.title || BRAND)}"><meta name="twitter:description" content="${esc(desc)}">
<link rel="icon" href="/static/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/static/site.css?v=${statSync(path.join(ROOT, 'site/site.css')).mtimeMs | 0}">${ld}</head>
<body><a class="skip" href="#main">Skip to content</a>
<header class="hd"><div class="hbar"><div class="hl"><a class="ib" href="/${lang}/search" aria-label="${t.searchH}">${ICON.search}</a><form class="hs" role="search" action="/${lang}/search" method="get"><input type="search" name="q" placeholder="${esc(t.searchPh)}" aria-label="${esc(t.searchPh)}" maxlength="100"></form></div>
${logoHtml(lang)}<div class="hr"><div class="lang" role="navigation" aria-label="Language"><a class="${lang === 'ne' ? 'on' : ''}" href="${lang === 'ne' ? '' : esc(o.otherUrl ?? `/ne/`)}" hreflang="ne" lang="ne">नेपाली</a><a class="${lang === 'en' ? 'on' : ''}" href="${lang === 'en' ? '' : esc(o.otherUrl ?? `/en/`)}" hreflang="en" lang="en">English</a></div></div></div>${o.noCounterpart ? `<p class="wrap" role="status" data-no-counterpart>${lang === 'ne' ? 'यो समाचार अहिलेसम्म अङ्ग्रेजीमा उपलब्ध छैन। भाषा बटनले अङ्ग्रेजी गृहपृष्ठमा लैजान्छ।' : 'This article is not yet available in Nepali. The language button opens the Nepali homepage.'}</p>` : ''}
<nav class="cats" aria-label="Sections"><a class="${o.active === 'home' ? 'on' : ''}" href="/${lang}/">${t.home}</a><a class="${o.active === 'latest' ? 'on' : ''}" href="/${lang}/latest">${t.latest}</a>${cats.map(c => `<a class="${o.active === c ? 'on' : ''}" href="/${lang}/category/${c}">${esc(CAT_NAMES[c][lang])}</a>`).join('')}</nav></header>
<main id="main">${o.body}</main>
<footer class="ft"><div class="wrap"><p>© ${new Date().getFullYear()} ${esc(BRAND)}</p><p><a href="/${lang}/">${t.home}</a> · <a href="/${other}/" hreflang="${other}">${T[other].native}</a></p></div></footer><script src="/static/site.js" defer></script></body></html>`;
}

/* ---------- pages ---------- */
function home(lang, base) {
  const t = T[lang], all = published(lang, 'ORDER BY p.published_at DESC LIMIT 80');
  if (!all.length) return layout(lang, base, { active: 'home', body: `<div class="empty"><h1>${esc(t.emptyT)}</h1><p>${esc(t.emptyB)}</p></div>` });
  const lead = all.find(p => p.pinned) ?? all.find(p => p.photo_asset_id) ?? all[0], rest = all.filter(p => p !== lead);
  const left = rest.slice(0, 2), rail = rest.slice(0, 7), brkSet = breakingClusters();
  const breaking = all.filter(p => brkSet.has(p.cluster_id) && Date.now() - Date.parse(p.published_at) < 3 * 36e5).slice(0, 1);
  const grid = rest.slice(2, 10), used = new Set([lead, ...left, ...grid]);
  const byCat = {}; for (const p of all) (byCat[p.category] ??= []).push(p);
  const sections = CAT_ORDER.filter(c => (byCat[c]?.length ?? 0) >= 2).slice(0, 3);
  const body = `<div class="wrap">
  ${breaking.map(p => `<div class="brk"><b>${esc(t.breaking)}</b><a href="${href(p)}">${esc(p.headline)}</a></div>`).join('')}
  <div class="top"><aside class="stack"><div class="side-h">${esc(t.top)}</div>${left.map(p => card(p, lang, { sizes: '250px' })).join('')}</aside>
    <section class="lead"><a class="media" href="${href(lead)}" tabindex="-1" aria-hidden="true">${img(lead, 640, 427, { eager: true, sizes: '(max-width:1000px) 100vw, 50vw' })}</a>${catLink(lead, lang)}<h1><a href="${href(lead)}">${esc(lead.headline)}</a></h1>${lead.summary ? `<p class="ex">${esc(lead.summary)}</p>` : ''}<div class="meta"><time datetime="${lead.published_at}">${rel(lead.published_at, lang)}</time></div></section>
    <aside class="rail"><div class="side-h">${esc(t.latestH)}</div>${rail.map(p => row(p, lang)).join('')}</aside></div>
  ${grid.length ? sec(t.more, `/${lang}/latest`, t.viewAll) + `<div class="grid4">${grid.map(p => card(p, lang, { ex: true })).join('')}</div>` : ''}
  ${sections.map(c => { const items = byCat[c].filter(p => !used.has(p) || true).slice(0, 4); return sec(CAT_NAMES[c][lang], `/${lang}/category/${c}`, t.viewAll) + `<div class="grid4">${items.map(p => card(p, lang)).join('')}</div>`; }).join('')}</div>`;
  return layout(lang, base, { active: 'home', body, ogImage: all.find(p => ogGraphic(p)) ? `/media/g/${all.find(p => ogGraphic(p)).id}` : null, alts: { ne: '/ne/', en: '/en/' }, otherUrl: `/${lang === 'ne' ? 'en' : 'ne'}/` });
}
function listing(lang, base, { title, active, basePath, rows, page, pagePath, otherUrl, desc }) {
  const t = T[lang], per = 12, pages = Math.max(1, Math.ceil(rows.length / per)), pg = Math.min(Math.max(1, page), pages), items = rows.slice((pg - 1) * per, pg * per);
  const body = `<div class="wrap"><h1 class="page-h">${esc(title)}</h1>${items.length ? `<div class="list">${items.map(p => `<div class="item"><a class="media" href="${href(p)}" tabindex="-1" aria-hidden="true">${img(p, 320, 213, { sizes: '200px' })}</a><div>${catLink(p, lang)}<h3><a href="${href(p)}">${esc(p.headline)}</a></h3>${p.summary ? `<p class="ex" style="margin:0 0 6px;color:#444">${esc(p.summary)}</p>` : ''}<div class="meta"><time datetime="${p.published_at}">${rel(p.published_at, lang)}</time></div></div></div>`).join('')}</div>` : `<div class="empty"><p>${esc(t.noRes)}</p></div>`}${pager(lang, pagePath, pg, pages, t)}</div>`;
  return layout(lang, base, { title, desc, active, path: pagePath + (pg > 1 ? `?page=${pg}` : ''), body, otherUrl, noindex: false });
}
function article(lang, base, p) {
  const t = T[lang], other = lang === 'ne' ? 'en' : 'ne', alt = db.prepare("SELECT * FROM publications WHERE cluster_id=? AND lang=? AND status='published'").get(p.cluster_id, other);
  const srcs = J(p.attribution), path0 = articlePath(p), g = ogGraphic(p), ogImage = p.photo_asset_id ? photoUrl(p, 1024) : g ? `/media/g/${p.id}` : null;
  const related = published(lang, 'AND p.id<>? ORDER BY (p.category=?) DESC, p.published_at DESC LIMIT 4', p.id, p.category);
  const url = base + path0, paras = String(p.body).split(/\n{2,}/).map(x => x.trim()).filter(Boolean);
  const bodyHtml = paras.map(x => (/^##\s+\S/.test(x) ? `<h2>${esc(x.replace(/^##\s+/, ''))}</h2>` : `<p>${esc(x).replace(/\n/g, '<br>')}</p>`)).join('');
  const share = `<div class="share"><span>${t.share}</span><a href="https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}" target="_blank" rel="noopener noreferrer">Facebook</a><a href="https://twitter.com/intent/tweet?url=${encodeURIComponent(url)}&text=${encodeURIComponent(p.headline)}" target="_blank" rel="noopener noreferrer">X</a><a href="https://wa.me/?text=${encodeURIComponent(p.headline + ' ' + url)}" target="_blank" rel="noopener noreferrer">WhatsApp</a><button type="button" data-copy="${esc(url)}" data-done="${esc(t.copied)}">${t.copy}</button></div>`;
  const body = `<div class="wrap"><article class="art" lang="${lang}"><div class="cat red"><a href="/${lang}/category/${p.category}">${esc(CAT_NAMES[p.category]?.[lang] ?? p.category)}</a></div><h1>${esc(p.headline)}</h1>${p.summary ? `<p class="dek">${esc(p.summary)}</p>` : ''}
  <div class="byline"><span>${esc(BRAND)}</span><time datetime="${p.published_at}">${fmtDate(p.published_at, lang, true)}</time>${Date.parse(p.updated_at) - Date.parse(p.published_at) > 60000 ? `<span>${t.updated}: ${fmtDate(p.updated_at, lang, true)}</span>` : ''}</div>
  ${p.photo_asset_id ? `<figure class="hero">${img(p, 640, 427, { eager: true, sizes: '(max-width:800px) 100vw, 760px' })}${p.photo_credit ? `<figcaption>${esc(p.photo_credit)}</figcaption>` : ''}</figure>` : ''}
  <div class="body">${bodyHtml}</div>
  ${srcs.length ? `<aside class="src"><h2>${t.sources}</h2><ul>${srcs.map(s => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer nofollow">${esc(s.source)} ↗</a></li>`).join('')}</ul></aside>` : ''}
  ${share}</article>
  ${related.length ? `<section class="rel">${sec(t.related)}<div class="grid4">${related.map(r => card(r, lang)).join('')}</div></section>` : ''}</div>`;
  const ld = { '@context': 'https://schema.org', '@type': 'NewsArticle', headline: p.headline.slice(0, 110), description: p.meta_desc || p.summary || undefined, inLanguage: lang, datePublished: p.published_at, dateModified: p.updated_at, mainEntityOfPage: url,
    author: { '@type': 'Organization', name: BRAND }, publisher: { '@type': 'Organization', name: BRAND }, ...(ogImage && { image: [base + ogImage] }), ...(J(p.keywords)?.length && { keywords: J(p.keywords).join(', ') }), articleSection: CAT_NAMES[p.category]?.en };
  return layout(lang, base, { title: p.seo_title || p.headline, desc: p.meta_desc || p.summary, path: path0, body, ogType: 'article', ogImage, jsonld: ld, active: p.category, alts: alt ? { [lang]: path0, [other]: articlePath(alt) } : null, otherUrl: alt ? articlePath(alt) : `/${other}/`, noCounterpart: !alt });
}
const snippet = (text, q) => { const i = text.toLowerCase().indexOf(q.toLowerCase()); const a = Math.max(0, (i < 0 ? 0 : i) - 60), s = text.slice(a, a + 180); if (i < 0) return esc(s) + (text.length > 180 ? '…' : ''); const k = i - a; return (a ? '…' : '') + esc(s.slice(0, k)) + '<mark>' + esc(s.slice(k, k + q.length)) + '</mark>' + esc(s.slice(k + q.length)) + '…'; };
function search(lang, base, q) {
  const t = T[lang]; q = (q ?? '').trim().slice(0, 100); let results = [], msg = '';
  if (q && Array.from(q).length < 2) msg = t.tooShort;
  else if (q) { const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`; results = db.prepare(`SELECT p.* FROM publications p WHERE p.lang=? AND p.status='published' AND (p.headline LIKE ? ESCAPE '\\' OR p.summary LIKE ? ESCAPE '\\' OR p.body LIKE ? ESCAPE '\\') ORDER BY p.published_at DESC LIMIT 50`).all(lang, like, like, like); }
  const body = `<div class="wrap"><h1 class="page-h">${esc(t.searchH)}</h1><form class="sform" action="/${lang}/search" method="get" role="search"><input type="search" name="q" value="${esc(q)}" placeholder="${esc(t.searchPh)}" maxlength="100" autofocus aria-label="${esc(t.searchPh)}"><button>${esc(t.searchH)}</button></form>
  ${msg ? `<p class="page-sub">${esc(msg)}</p>` : q ? (results.length ? `<p class="page-sub">${lang === 'ne' ? nfNe.format(results.length) : results.length} ${esc(t.resFor)} — “${esc(q)}”</p><div class="list">${results.map(p => `<div class="item"><a class="media" href="${href(p)}" tabindex="-1" aria-hidden="true">${img(p, 320, 213, { sizes: '200px' })}</a><div>${catLink(p, lang)}<h3><a href="${href(p)}">${esc(p.headline)}</a></h3><p class="ex" style="margin:0 0 6px;color:#444">${snippet(p.body, q)}</p><div class="meta">${fmtDate(p.published_at, lang)}</div></div></div>`).join('')}</div>` : `<div class="empty" style="margin:40px 0"><h1>${esc(t.noRes)}</h1><p>${esc(t.noResB)}</p></div>`) : ''}</div>`;
  return layout(lang, base, { title: q ? `${t.searchH}: ${q}` : t.searchH, path: `/${lang}/search`, body, noindex: true, otherUrl: `/${lang === 'ne' ? 'en' : 'ne'}/search${q ? '?q=' + encodeURIComponent(q) : ''}` });
}
function notFound(lang, base) { const t = T[lang]; return layout(lang, base, { title: t.nf, noindex: true, body: `<div class="empty"><h1>${esc(t.nf)}</h1><p>${esc(t.nfB)}</p><p><a href="/${lang}/"><b>${esc(t.back)}</b></a></p></div>` }); }

/* ---------- dispatcher ---------- */
const buckets = new Map();
const limited = (ip, max = 40) => { const n = Date.now(), b = buckets.get(ip); if (!b || n > b.reset) { buckets.set(ip, { c: 1, reset: n + 60000 }); if (buckets.size > 5000) buckets.clear(); return false; } return ++b.c > max; };
const H = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin', 'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" };
// a published story must show up quickly: pages may be cached for seconds, not minutes (tunable)
const PAGE_MAX_AGE = Math.max(0, +process.env.PAGE_MAX_AGE_S || 15), PAGE_SWR = Math.max(0, +process.env.PAGE_SWR_S || 30);
const html = (status, body, extra = {}) => ({ status, body, headers: { ...H, 'content-type': 'text/html; charset=utf-8', 'cache-control': status === 200 ? `public, max-age=${PAGE_MAX_AGE}, stale-while-revalidate=${PAGE_SWR}` : 'no-store', ...extra } });

export async function handleSite(method, url, headers = {}, ip = '') {
  const p = url.pathname, base = baseUrl(headers);
  if (method !== 'GET' && method !== 'HEAD') return { status: 405, headers: { ...H, allow: 'GET, HEAD' }, body: 'Method not allowed' };
  try {
    if (p === '/favicon.ico') return { status: 301, headers: { ...H, location: '/static/favicon.svg' }, body: '' };
    if (p === '/robots.txt') return { status: 200, headers: { ...H, 'content-type': 'text/plain', 'cache-control': 'public, max-age=3600' }, body: `User-agent: *\nDisallow: /admin\nDisallow: /api/\nDisallow: /img/\nDisallow: /*/search\nSitemap: ${base}/sitemap.xml\n` };
    if (p === '/sitemap.xml') {
      const urls = []; for (const l of ['ne', 'en']) { urls.push([`/${l}/`, null], [`/${l}/latest`, null]); for (const c of db.prepare("SELECT DISTINCT category FROM publications WHERE lang=? AND status='published'").all(l)) urls.push([`/${l}/category/${c.category}`, null]); }
      for (const a of db.prepare("SELECT * FROM publications WHERE status='published' ORDER BY published_at DESC LIMIT 5000").all()) urls.push([articlePath(a), a.updated_at]);
      return { status: 200, headers: { ...H, 'content-type': 'application/xml', 'cache-control': 'public, max-age=120' }, body: `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map(([u, m]) => `<url><loc>${esc(base + u)}</loc>${m ? `<lastmod>${m}</lastmod>` : ''}</url>`).join('')}</urlset>` };
    }
    let m;
    if ((m = p.match(/^\/static\/([\w.\-]+)$/)) && STATIC[m[1]]) { const [f, type, age] = STATIC[m[1]]; return { status: 200, headers: { ...H, 'content-type': type, 'cache-control': `public, max-age=${age}` }, body: readFileSync(path.join(ROOT, f)) }; }
    if ((m = p.match(/^\/media\/p\/(\d+)$/))) {
      const r = db.prepare("SELECT a.id,a.path FROM publications p JOIN assets a ON a.id=p.photo_asset_id WHERE p.id=? AND p.status='published'").get(+m[1]); // only photos attached to LIVE articles are ever served
      if (!r || !existsSync(r.path)) return { status: 404, headers: H, body: '' };
      const o = await assetImage(r.id, r.path, url.searchParams.get('w')); return { status: 200, headers: { ...H, 'content-type': 'image/webp', 'cache-control': 'public, max-age=2592000, immutable' }, body: o.buf };
    }
    if ((m = p.match(/^\/media\/g\/(\d+)$/))) {
      const pub = db.prepare("SELECT * FROM publications WHERE id=? AND status='published'").get(+m[1]), g = pub && ogGraphic(pub); if (!g || !existsSync(g.path)) return { status: 404, headers: H, body: '' };
      return { status: 200, headers: { ...H, 'content-type': g.mime, 'cache-control': 'public, max-age=3600' }, body: readFileSync(g.path) };
    }
    if (p === '/') { const al = String(headers['accept-language'] ?? ''); return { status: 302, headers: { ...H, location: /^\s*en/i.test(al) && !/^\s*ne/i.test(al) ? '/en/' : '/ne/', vary: 'Accept-Language' }, body: '' }; }
    const lm = p.match(/^\/(ne|en)(?:\/(.*))?$/); if (!lm) return html(404, notFound('ne', base));
    const lang = lm[1], rest = (lm[2] ?? '').replace(/\/$/, ''), page = Math.max(1, parseInt(url.searchParams.get('page')) || 1), other = lang === 'ne' ? 'en' : 'ne';
    if (rest === '') return html(200, home(lang, base));
    if (rest === 'latest') return html(200, listing(lang, base, { title: T[lang].latestH, active: 'latest', pagePath: `/${lang}/latest`, rows: published(lang, 'ORDER BY p.published_at DESC LIMIT 500'), page, otherUrl: `/${other}/latest` }));
    if ((m = rest.match(/^category\/([a-z]+)$/))) {
      if (!CAT_NAMES[m[1]]) return html(404, notFound(lang, base));
      return html(200, listing(lang, base, { title: CAT_NAMES[m[1]][lang], active: m[1], pagePath: `/${lang}/category/${m[1]}`, rows: published(lang, 'AND p.category=? ORDER BY p.published_at DESC LIMIT 500', m[1]), page, otherUrl: `/${other}/category/${m[1]}` }));
    }
    if ((m = rest.match(/^story\/(\d+)(?:-[\w\-]*)?$/))) {
      const pub = db.prepare("SELECT * FROM publications WHERE id=? AND lang=? AND status='published'").get(+m[1], lang); if (!pub) return html(404, notFound(lang, base));
      const canon = articlePath(pub); if (p.replace(/\/$/, '') !== canon) return { status: 301, headers: { ...H, location: canon }, body: '' }; // one canonical URL per article
      return html(200, article(lang, base, pub));
    }
    if (rest === 'search') { if (limited(ip)) return html(429, layout(lang, base, { title: T[lang].rate, noindex: true, body: `<div class="empty"><h1>${esc(T[lang].rate)}</h1></div>` }), { 'retry-after': '60' }); return html(200, search(lang, base, url.searchParams.get('q')), { 'cache-control': 'no-store' }); }
    return html(404, notFound(lang, base));
  } catch (e) {
    console.error('site error', e); const lang = p.startsWith('/en') ? 'en' : 'ne';
    return html(500, `<!doctype html><meta charset="utf-8"><title>${esc(BRAND)}</title><p style="font:16px system-ui;padding:40px;text-align:center">${esc(T[lang].err)}</p>`);
  }
}
