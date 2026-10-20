const $ = s => document.querySelector(s), main = $('#main');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nst = iso => iso ? new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Kathmandu', dateStyle: 'medium', timeStyle: 'short' }) + ' NST' : '—';
const rel = iso => { if (!iso) return '—'; const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : new Date(iso).toLocaleDateString('en-GB', { timeZone: 'Asia/Kathmandu', day: 'numeric', month: 'short' }); };
const toast = (msg, bad) => { const t = $('#toast'); t.textContent = msg; t.className = 'show' + (bad ? ' bad' : ''); clearTimeout(toast.h); toast.h = setTimeout(() => t.className = '', 3500); };
const AUTH = new Error('login required'), fail = x => x === AUTH || toast(x.message, true);
const api = async (p, o = {}) => {
  const r = await fetch('/api/' + p, { ...o, headers: { 'content-type': 'application/json' }, body: o.body && JSON.stringify(o.body) });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && p !== 'login') { login(); throw AUTH; }
  if (!r.ok) throw Object.assign(new Error(j.error || r.status), { data: j });
  return j;
};
// Remote thumbnails can fail (hotlink rules); inline onerror is blocked by CSP, so listen at capture phase.
document.addEventListener('error', e => { if (e.target.tagName === 'IMG' && e.target.dataset.hide) return e.target.parentElement.remove();
  if (e.target.tagName === 'IMG') { const d = document.createElement('div'); d.className = 'ph'; d.textContent = '·'; e.target.replaceWith(d); } }, true);

// two parallel api() calls can both reject with AUTH; the login form is already showing
window.addEventListener('unhandledrejection', e => { if (e.reason === AUTH) e.preventDefault(); });
let timer;
const CATS = ['politics', 'election', 'crime', 'health', 'disaster', 'economy', 'sports', 'other'];
const EDL = { none: '', drafting: 'Drafting…', needs_review: 'Draft ready', awaiting_approval: 'Awaiting approval', approved: 'Approved', draft_failed: 'Draft failed' };

function login(err) {
  clearInterval(timer);
  main.innerHTML = `<form class="login"><h2 class="sec">Sign in</h2><input type="password" id="pw" placeholder="Admin password" autofocus autocomplete="current-password"><button class="pri">Sign in</button><div class="err">${esc(err)}</div></form>`;
  main.querySelector('form').onsubmit = async e => { e.preventDefault(); try { await api('login', { method: 'POST', body: { password: $('#pw').value } }); show(); } catch (x) { login(x.message); } };
}

/* ---------- shared story pieces ---------- */
const https = u => String(u).replace(/^http:\/\//i, 'https://'); // CSP blocks mixed-content images
const chip = c => EDL[c.editorial] ? `<span class="pill ${c.editorial}">${EDL[c.editorial]}</span>` : '';
const dev = c => c.sources >= 2 && c.ageH <= 6 ? '<span class="pill dev">Developing</span>' : '';
const meta = c => `<span title="${esc(nst(c.latest))}">${esc(c.lead.source)} · ${rel(c.latest)}</span>${c.sources > 1 ? ` · <b>${c.sources} sources</b>` : ''} · ${esc(c.lead.language || '?')}`;
// Sized, lazy thumbnails from our own cache (/img). Explicit width/height + aspect-ratio boxes prevent layout shift; the lead image is eager + high priority.
const isrc = (id, w) => `/img/${id}?w=${w}`;
const imgTag = (id, w, h, { eager = false, sizes = '25vw' } = {}) => `<img src="${isrc(id, w)}" srcset="${isrc(id, w)} ${w}w, ${isrc(id, Math.min(1024, w * 2))} ${Math.min(1024, w * 2)}w" sizes="${sizes}" width="${w}" height="${h}" ${eager ? 'loading="eager" fetchpriority="high"' : 'loading="lazy"'} decoding="async" alt="" referrerpolicy="no-referrer">`;
const thumb = (c, cls = 'im', hideEmpty = false, o = {}) => hideEmpty && !c.lead.imageId ? '' : `<a class="${cls}" href="#/story/${c.id}" tabindex="-1" aria-hidden="true">${c.lead.imageId ? imgTag(c.lead.imageId, o.w ?? 320, o.h ?? 213, o) : `<div class="ph">${esc((c.category || '?')[0].toUpperCase())}</div>`}</a>`;
const acts = c => `<div class="acts"><a href="#/story/${c.id}">Open</a><button class="ghost" data-draft="${c.id}">Draft</button><a href="${esc(c.lead.url)}" target="_blank" rel="noopener noreferrer">Original ↗</a></div>`;
const card = c => `<article class="c2">${thumb(c)}<div class="cat">${esc(c.category)} ${dev(c)} ${chip(c)}</div><h3><a href="#/story/${c.id}">${esc(c.lead.title)}</a></h3><div class="meta">${meta(c)}</div>${acts(c)}</article>`;
const mini = c => `<div class="mini"><div><div class="cat">${esc(c.category)} ${dev(c)}</div><h4><a href="#/story/${c.id}">${esc(c.lead.title)}</a></h4><div class="meta">${meta(c)}</div></div>${thumb(c, 'thumbw', false, { w: 160, h: 120, sizes: '64px' })}</div>`;

async function draftClick(e) {
  const id = e.target.dataset?.draft; if (!id) return false;
  e.target.disabled = true;
  try { const r = await api('drafts', { method: 'POST', body: { cluster_id: +id, lang: e.target.dataset.lang || 'both', force: !!e.target.dataset.force } }); toast(r.reused ? r.message : 'Queued — both editions will appear in AI Studio when ready'); e.target.textContent = r.reused ? 'Already exists' : 'Queued'; }
  catch (x) { fail(x); e.target.disabled = false; }
  return true;
}

/* ---------- Newsroom (dashboard) ---------- */
async function newsroom() {
  const d = await api('newsroom');
  if (!d.stats.stories) { main.innerHTML = `<div class="empty"><h3>No stories yet</h3><p>The worker fetches your sources about hourly. Press “Fetch latest” to queue every source now, then reload in a minute.</p><p class="mut">If nothing arrives, check <a href="#/sources"><b>Sources</b></a> for errors.</p></div>`; return; }
  const [hero, ...rest] = d.top;
  const left = d.breaking.length
    ? `<div class="side-h red">Breaking candidates</div><p class="mut">Recent and reported by 2+ monitored sources. A human must verify before calling anything breaking.</p>${d.breaking.slice(0, 2).map(c => `<div class="stk">${thumb(c, 'im', true, { w: 320, h: 213, sizes: '260px' })}<div class="cat red">${esc(c.category)}</div><h4><a href="#/story/${c.id}">${esc(c.lead.title)}</a></h4><div class="meta">${meta(c)}</div></div>`).join('')}`
    : `<div class="side-h">Awaiting verification</div>${d.verify.length ? d.verify.map(mini).join('') : '<p class="mut">Nothing waiting.</p>'}`;
  const q = d.queue, qb = (n, l, na) => `<div class="${na ? 'na' : ''}"><b>${na ? '—' : n}</b><span>${l}</span></div>`;
  main.innerHTML = `
  <div class="nr">
    <aside>${left}</aside>
    <section class="hero">${hero ? `${thumb(hero, 'im', true, { w: 640, h: 427, eager: true, sizes: '(max-width:1000px) 100vw, 50vw' })}<div class="cat" style="margin-top:10px">${esc(hero.category)} ${dev(hero)} ${chip(hero)}</div><h1><a href="#/story/${hero.id}">${esc(hero.lead.title)}</a></h1>
      ${hero.lead.summary ? `<div class="sum">${esc(hero.lead.summary)} <span class="mut">(source excerpt)</span></div>` : ''}<div class="meta">${meta(hero)} · importance ${hero.score}</div><div class="acts" style="justify-content:center">${acts(hero).replace('<div class="acts">', '').replace(/<\/div>$/, '')}</div>` : '<div class="empty">No ranked stories in the last 48 hours.</div>'}</section>
    <aside><div class="side-h">Latest</div>${d.latest.map(mini).join('') || '<p class="mut">No stories.</p>'}</aside>
  </div>
  <h2 class="sec">Hourly pick <span class="mut">the highest-ranked qualifying story that first appeared in each hour (NST); nothing is published automatically</span></h2>
  ${(d.selections || []).length ? `<table>${d.selections.map(x => `<tr><td class="mut" style="white-space:nowrap">${new Date(x.slot_start).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kathmandu', hour: '2-digit', minute: '2-digit' })}–${new Date(x.slot_end).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kathmandu', hour: '2-digit', minute: '2-digit' })}</td><td>${x.status === 'selected' ? `<a href="#/story/${x.cluster_id}"><b>${esc(x.title)}</b></a> <span class="mut">score ${x.score} · ${esc(x.language || '')}</span>` : `<span class="mut">${x.status === 'missed' ? 'worker was not running' : 'no story selected — ' + esc(x.reason || '')}</span>`}</td><td>${x.status === 'selected' ? `<button class="ghost" data-draft="${x.cluster_id}">Draft</button>` : ''}</td></tr>`).join('')}</table>` : '<div class="empty" style="padding:16px">No hourly selection has run yet. The worker decides each hour after it closes.</div>'}
  <h2 class="sec">Editorial queue</h2>
  <div class="queue">${qb(q.drafting, 'Drafting')}${qb(q.needs_review, 'Needs review')}${qb(q.awaiting_approval, 'Awaiting approval')}${qb(q.approved, 'Approved')}${qb(0, 'Scheduled', 1)}${qb(0, 'Published', 1)}</div>
  <p class="mut">Scheduling and publishing are not connected yet (no social accounts authorised).${q.failed_jobs ? ` <b style="color:var(--red)">${q.failed_jobs} draft job(s) failed</b> — see <a href="#/studio">AI Studio</a>.` : ''}</p>
  ${rest.length ? `<h2 class="sec">Top stories <a href="#/news?top">All stories →</a></h2><div class="grid4">${rest.slice(0, 8).map(card).join('')}</div>` : ''}
  ${d.sections.map(s => `<h2 class="sec">${esc(s.category)}</h2><div class="grid4">${s.items.map(card).join('')}</div>`).join('')}
  <h2 class="sec">Publishing activity</h2><div class="empty">No posts published yet. Connect authorised social accounts to publish approved stories; results and failures will be listed here.</div>
  <div class="status"><span><b>Sources</b> ${d.health.working}/${d.health.total} working</span><span>Last successful fetch ${rel(d.health.last_success)}</span><span>${d.stats.stories} stories stored · ${d.stats.last24h} in 24 h · ${d.stats.clusters} distinct events</span>
    ${d.health.problems.map(p => `<a href="#/sources" class="pill ${p.status}" title="${esc(p.error || '')}">${esc(p.name)}: ${esc(p.status.replace('_', ' '))}</a>`).join('')}</div>`;
  main.onclick = draftClick;
  timer = setInterval(() => { if (!document.hidden && location.hash.replace('#', '') in { '': 1, '/': 1 }) newsroom(); }, 90000);
}

/* ---------- News browsing ---------- */
const F = { view: 'latest', category: '', source: '', language: '', period: '', status: '', sort: '', q: '', page: 1 };
async function news() {
  if (location.hash.endsWith('?top')) { F.view = 'top'; history.replaceState(null, '', '#/news'); }
  const qs = new URLSearchParams(Object.entries(F).filter(([, v]) => v));
  const [res, src] = await Promise.all([api('news?' + qs), api('sources')]);
  const sel = (k, opts) => `<select data-f="${k}" aria-label="${k}">${opts.map(([v, l]) => `<option value="${v}" ${String(F[k]) === String(v) ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  main.innerHTML = `<h2 class="sec">News <span class="mut">${res.total} stories</span></h2>
  <form class="filters" id="nf"><input type="search" name="q" placeholder="Search headlines" value="${esc(F.q)}">
    ${sel('view', [['latest', 'Latest'], ['top', 'Top stories'], ['breaking', 'Breaking candidates'], ['trending', 'Trending clusters'], ['verify', 'Awaiting verification']])}
    ${sel('category', [['', 'All categories'], ...CATS.map(c => [c, c])])}${sel('source', [['', 'All sources'], ...src.map(s => [s.id, s.name])])}
    ${sel('language', [['', 'Any language'], ['ne', 'Nepali'], ['en', 'English']])}${sel('period', [['', 'Any time'], ['1h', 'Last hour'], ['6h', 'Last 6 h'], ['24h', 'Last 24 h'], ['7d', 'Last 7 days']])}
    ${sel('status', [['', 'Any editorial status'], ['none', 'Not started'], ['drafting', 'Drafting'], ['needs_review', 'Needs review'], ['awaiting_approval', 'Awaiting approval'], ['approved', 'Approved'], ['draft_failed', 'Draft failed']])}
    ${sel('sort', [['', 'Default sort'], ['time', 'Newest first'], ['score', 'Importance']])}<button class="ghost" type="button" id="reset">Reset</button></form>
  ${res.items.length ? res.items.map(c => `<div class="story">${thumb(c, 'im', false, { w: 160, h: 107, sizes: '120px' })}<div><div class="cat">${esc(c.category)} ${dev(c)} ${chip(c)}${c.pinned ? ' <span class="pill line">pinned</span>' : ''}</div><h3><a href="#/story/${c.id}">${esc(c.lead.title)}</a></h3>
    <div class="meta">${meta(c)}${c.sourceNames.length > 1 ? ' (' + esc(c.sourceNames.join(', ')) + ')' : ''} · importance ${c.score}</div>${acts(c)}</div></div>`).join('') : '<div class="empty">No stories match these filters.</div>'}
  ${res.pages > 1 ? `<div class="row" style="margin-top:16px;justify-content:center"><button class="ghost" data-p="${res.page - 1}" ${res.page <= 1 ? 'disabled' : ''}>← Newer</button><span class="mut">Page ${res.page} of ${res.pages}</span><button class="ghost" data-p="${res.page + 1}" ${res.page >= res.pages ? 'disabled' : ''}>Older →</button></div>` : ''}`;
  main.onchange = e => { const k = e.target.dataset.f; if (k) { F[k] = e.target.value; F.page = 1; news(); } };
  $('#nf').onsubmit = e => { e.preventDefault(); F.q = new FormData(e.target).get('q'); F.page = 1; news(); };
  $('#reset').onclick = () => { Object.assign(F, { view: 'latest', category: '', source: '', language: '', period: '', status: '', sort: '', q: '', page: 1 }); news(); };
  main.onclick = async e => { if (await draftClick(e)) return; const p = e.target.dataset?.p; if (p) { F.page = +p; news(); scrollTo(0, 0); } };
}

/* ---------- Story workspace ---------- */
async function story(id) {
  const [d, rel2] = await Promise.all([api('story/' + id), api('clusters/' + id)]);
  const arts = d.articles, r = d.rank, img = arts.find(a => a.image_url), ed = d.editorial, lead = r?.lead ?? { title: arts[0].title, source: arts[0].source };
  const text = a => a.content_len > a.summary.length ? 'Text in feed' : 'RSS summary only';
  const has = k => d.drafts.some(x => k === 'draft' || (k === 'review' && x.status !== 'superseded') || (k === 'approve' && x.status === 'approved'));
  const step = (l, done, na) => `<span class="${done ? 'done' : ''}" title="${na ? 'Not available yet' : ''}">${l}${na ? ' ·' : ''}</span>`;
  main.innerHTML = `<div class="two"><div>
    <div class="cat ${r?.sensitive ? 'red' : ''}">${d.hourly_pick ? '<span class="pill working">hourly pick</span> ' : ''}${esc(r?.category || 'story')} ${r?.sensitive ? '· sensitive: explicit human review required' : ''}</div>
    <h1 style="font-size:28px;line-height:1.25;margin:6px 0 8px;font-weight:800">${esc(lead.title)}</h1>
    <div class="meta">${arts.length} report(s) from ${new Set(arts.map(a => a.source)).size} source(s) · first collected ${nst(arts.at(-1).fetched_at)}</div>
    ${img ? `<div style="margin:14px 0"><img data-hide="1" src="${isrc(img.id, 1024)}" srcset="${isrc(img.id, 640)} 640w, ${isrc(img.id, 1024)} 1024w" sizes="(max-width:1000px) 100vw, 65vw" width="1024" height="420" fetchpriority="high" decoding="async" alt="" style="width:100%;max-height:420px;object-fit:cover;background:var(--soft)"><div class="mut">Image supplied by ${esc(img.source)}'s feed — reference only. Publication rights are <b>not cleared</b>; upload your own licensed photo for the final graphic.</div></div>` : '<div class="empty" style="margin:14px 0">No image in the feeds for this story. You will upload your own photo for the graphic.</div>'}
    <h2 class="sec">Source evidence</h2>
    ${d.source_text ? `<div class="card" style="margin-bottom:10px"><b>Source material for drafting:</b> <span class="pill ${d.source_text.level === 'full' ? 'approved' : 'drafting'}">${d.source_text.level === 'full' ? 'full material' : 'limited source material'}</span> <span class="mut">${d.source_text.words} words · ${esc({ extracted: 'extracted from the article page', feed_content: 'text carried in the RSS feed', rss_summary: 'RSS summary only' }[d.source_text.origin])}${d.source_text.status && !['rss_only', 'full_text_in_feed', 'extracted'].includes(d.source_text.status) ? ` · retrieval: ${esc(d.source_text.status.replace(/_/g, ' '))}` : ''}</span>
      ${d.source_text.level === 'limited' ? '<div class="mut">The article can only state what this material supports. Drafts are flagged for editor verification and nothing is padded.</div>' : ''}
      <div class="row" style="margin-top:6px"><button class="ghost" data-extract="${id}">Fetch full text from the publisher</button><span class="mut">Only works for publishers you enabled in Sources; robots.txt and AI-use declarations are respected.</span></div></div>` : ''}
    ${arts.map(a => `<div class="card" style="margin-bottom:10px"><div class="row"><b>${esc(a.source)}</b><span class="mut">${esc(a.language || '?')} · published ${nst(a.published_at)} · collected ${nst(a.fetched_at)}</span><span class="pill line">${text(a)}</span></div>
      <h3 style="margin:6px 0"><a href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">${esc(a.title)} ↗</a></h3>
      ${a.summary ? `<div class="mut">RSS SUMMARY (an excerpt, not the full article)</div><p style="margin:2px 0 8px">${esc(a.summary)}</p>` : ''}
      ${a.content_len > a.summary.length + 50 ? `<details><summary class="mut">Text included in feed (${a.content_len} chars)</summary><p style="white-space:pre-wrap">${esc(a.content)}</p></details>` : ''}</div>`).join('')}
    ${rel2.length > 1 ? `<h2 class="sec">How the reports differ</h2><table>${rel2.map(a => `<tr><td>${esc(a.source)}<div class="mut">${nst(a.published_at || a.fetched_at)}</div></td><td>${esc(a.title)}${a.onlyHere.length ? `<div class="mut">only in this report: ${esc(a.onlyHere.join(', '))}</div>` : ''}</td></tr>`).join('')}</table><p class="mut">Several outlets reporting an event is not independent confirmation: they may repeat one original report.</p>` : ''}
  </div><aside>
    <div class="card"><div class="side-h">Editorial workflow</div>
      <div class="steps">${step('Discover', 1)}${step('Select', r?.pinned || d.drafts.length)}${step('Draft', has('draft'))}${step('Review', d.drafts.some(x => x.status === 'approved') || ed === 'awaiting_approval')}${step('Approve', has('approve'))}${step('Design', 0, 1)}${step('Schedule', 0, 1)}${step('Publish', 0, 1)}</div>
      <div class="mut">Design, scheduling and publishing arrive in later phases.</div>
      <div class="row" style="margin:12px 0"><a class="btn pri" style="color:#fff" href="#/editor/${id}">Design graphic</a><a class="btn" href="#/design/${id}" title="The earlier form-based editor">Classic editor</a><button class="pri" data-draft="${id}" ${d.drafts.some(x => x.bundle_id) ? 'data-force="1"' : ''} ${ed === 'drafting' ? 'disabled' : ''}>${d.drafts.some(x => x.bundle_id) ? 'Regenerate both editions' : 'Generate Nepali + English editions'}</button></div>
      ${d.job ? `<div class="mut">AI job: <span class="pill ${d.job.status === 'failed' ? 'failing' : d.job.status === 'done' ? 'working' : 'drafting'}">${d.job.status}</span> (attempt ${d.job.attempts})</div>${d.job.error ? `<div class="err">${esc(d.job.error)}</div>` : ''}` : ''}
      ${d.drafts.length ? `<div class="side-h" style="margin-top:14px">Drafts</div>${d.drafts.map(x => `<div style="padding:5px 0;border-bottom:1px solid var(--rule)"><a href="#/studio/${x.id}"><b>Draft #${x.id}</b></a> <span class="pill line">${esc((x.lang || 'ne').toUpperCase())}</span> ${x.bundle_id ? '' : '<span class="pill line">legacy</span> '}<span class="pill ${x.status === 'approved' ? 'working' : 'line'}">${x.status.replace('_', ' ')}</span><div class="mut">${esc(x.model)} · ${rel(x.created_at)} · ${x.flags.filter(f => f.severity === 'error').length} error / ${x.flags.filter(f => f.severity === 'warn').length} warn flags</div></div>`).join('')}` : ''}</div>
    ${r ? `<div class="card" style="margin-top:14px"><div class="side-h">Ranking <span class="mut" style="text-transform:none;letter-spacing:0">score ${r.score}</span></div>
      <div class="row"><button class="ghost" data-a="pin" data-v="${r.pinned ? 0 : 1}">${r.pinned ? 'Unpin' : 'Pin'}</button><button class="ghost" data-a="reject" data-v="${r.rejected ? 0 : 1}">${r.rejected ? 'Restore' : 'Reject'}</button>
      <select data-a="priority">${[0, 1, 2, 3].map(p => `<option value="${p}" ${p === r.priority ? 'selected' : ''}>priority ${p}</option>`).join('')}</select><select data-a="category">${CATS.map(x => `<option ${x === r.category ? 'selected' : ''}>${x}</option>`).join('')}</select></div>
      <details><summary class="mut">Why this score</summary><table>${r.factors.map(f => `<tr><td>${esc(f.factor)}</td><td>${f.points}</td><td class="mut">${esc(f.note)}</td></tr>`).join('')}</table></details></div>` : '<p class="mut">This story is older than 7 days and is no longer ranked.</p>'}
  </aside></div>`;
  const act = async (body) => { try { await api(`clusters/${id}/action`, { method: 'POST', body }); story(id); } catch (x) { fail(x); } };
  main.onclick = async e => { if (await draftClick(e)) return; const d2 = e.target.dataset; if (d2?.extract) { e.target.disabled = true; try { const r = await api(`story/${d2.extract}/extract`, { method: 'POST', body: {} }); toast(r.status === 'extracted' ? `Extracted ${r.words ?? ''} words` : 'Not retrieved: ' + String(r.status).replace(/_/g, ' '), r.status !== 'extracted'); story(id); } catch (x) { fail(x); e.target.disabled = false; } return; } if (d2?.a === 'pin') act({ pinned: +d2.v }); if (d2?.a === 'reject') act({ rejected: +d2.v }); };
  main.onchange = e => { const d2 = e.target.dataset; if (d2?.a === 'priority') act({ priority: e.target.value }); if (d2?.a === 'category') act({ category: e.target.value }); };
}

/* ---------- Sources ---------- */
const cap = (l, v) => `<span class="${v == null ? '' : v ? 'y' : 'n'}">${l}</span>`;
async function sources() {
  const list = await api('sources'), w = list.filter(s => s.status === 'working').length;
  main.innerHTML = `<h2 class="sec">Source monitoring <span class="mut">${w} of ${list.length} working</span></h2><div class="grid">` + list.map(s => `
  <div class="card"><div class="row"><span class="pill ${s.status}">${s.status.replace('_', ' ')}</span>${s.job ? `<span class="mut">job ${s.job}</span>` : ''}<b>${esc(s.name)}</b></div>
  <div class="row" style="margin-top:8px"><input type="text" style="flex:1;min-width:0" value="${esc(s.feed_url)}" data-u="${s.id}" aria-label="Feed URL"><button data-su="${s.id}">Save URL &amp; retry</button></div>
  ${s.final_url && s.final_url !== s.feed_url ? `<div class="mut">redirects to ${esc(s.final_url)}</div>` : ''}
  ${s.last_error ? `<div class="err" style="margin-top:6px">${esc(s.last_error)}${s.last_http ? ` (HTTP ${s.last_http})` : ''} · ${s.fail_count} consecutive failure(s)</div>` : ''}
  <div class="caps">${cap('headline', s.has_headline)}${cap('summary', s.has_summary)}${cap('full text', s.has_content)}${cap('image', s.has_image)}${cap('URL', s.has_url)}${s.language ? `<span>lang: ${esc(s.language)}</span>` : ''}</div>
  <div class="mut">Last success ${nst(s.last_success_at)} · last check ${nst(s.last_checked_at)}<br>New last fetch: ${s.last_new ?? 0} · in feed: ${s.entries_seen ?? '—'} · stored: ${s.stories}</div>
  <div class="row" style="margin-top:10px"><button class="pri" data-f="${s.id}">Fetch now</button>
  <label class="mut">every <input type="number" min="5" max="1440" value="${s.interval_min}" style="width:64px" data-i="${s.id}"> min</label>
  <label class="mut">credibility <input type="number" min="0" max="1" step="0.1" value="${s.credibility}" style="width:58px" data-cr="${s.id}"></label>
  <label class="mut"><input type="checkbox" ${s.enabled ? 'checked' : ''} data-e="${s.id}"> enabled</label></div>
  <div class="mut" style="margin-top:8px;border-top:1px solid var(--rule);padding-top:8px"><label><input type="checkbox" ${s.auto_images ? 'checked' : ''} data-ai="${s.id}"> Use this publisher's article images automatically (website photo + social graphics)</label>${s.auto_images ? `<div class="mut" style="font-size:12px">Basis recorded: ${esc(s.auto_images_note || '')}</div>` : ''}<br><label><input type="checkbox" ${s.fulltext_enabled ? 'checked' : ''} data-ft="${s.id}"> Allow full-text retrieval from this publisher's article pages</label>
    <div>Tick only after you have read the publisher's terms. robots.txt is always obeyed and paywalled or restricted pages are never fetched.</div>
    <div>AI-use declaration (robots.txt): ${(() => { const p = s.ai_policy ? JSON.parse(s.ai_policy) : null; return !p || !p.checkedAt ? 'not checked yet' : p.aiInput === 'no' ? '<b style="color:var(--red)">AI input forbidden — drafting is blocked</b>' : p.aiInput === 'yes' ? 'AI input allowed' : 'none declared'; })()} <button class="ghost" data-pol="${s.id}" style="padding:1px 8px">check</button></div></div></div>`).join('') + '</div>';
  main.onclick = async e => {
    const d = e.target.dataset;
    try {
      if (d.f) { e.target.textContent = 'Queued…'; await api(`sources/${d.f}/fetch`, { method: 'POST' }); setTimeout(sources, 5000); }
      if (d.pol) { const r = await api(`sources/${d.pol}/check-policy`, { method: 'POST', body: {} }); toast(r.aiInput === 'no' ? 'This publisher forbids AI input' : 'Policy checked'); return sources(); }
      if (d.su) { await api(`sources/${d.su}`, { method: 'PATCH', body: { feed_url: main.querySelector(`[data-u="${d.su}"]`).value } }); toast('URL saved; retrying now'); setTimeout(sources, 6000); }
    } catch (x) { fail(x); }
  };
  main.onchange = async e => {
    const d = e.target.dataset;
    try {
      if (d.i) await api(`sources/${d.i}`, { method: 'PATCH', body: { interval_min: +e.target.value } });
      if (d.e) await api(`sources/${d.e}`, { method: 'PATCH', body: { enabled: e.target.checked } });
      if (d.cr) await api(`sources/${d.cr}/credibility`, { method: 'PATCH', body: { credibility: +e.target.value } });
      if (d.ft) await api(`sources/${d.ft}`, { method: 'PATCH', body: { fulltext_enabled: e.target.checked } });
      if (d.ai) { if (e.target.checked) { const note = prompt('On what basis do you use this publisher’s images? (permission, licence, or your editorial decision; stored with every image)'); if (!note) { sources(); return; } await api(`sources/${d.ai}`, { method: 'PATCH', body: { auto_images: true, auto_images_note: note } }); toast('Automatic images on for this publisher'); } else await api(`sources/${d.ai}`, { method: 'PATCH', body: { auto_images: false } }); sources(); }
    } catch (x) { fail(x); sources(); }
  };
  timer = setInterval(() => { if (!document.activeElement?.dataset?.u && !document.activeElement?.dataset?.i) sources(); }, 30000);
}

/* ---------- Story clusters ---------- */
function clusterCard(c) {
  return `<div class="card" style="margin-bottom:12px"><div class="cat">${c.pinned ? '📌 pinned · ' : ''}${esc(c.category)} · ${c.sources} source(s) · ${c.ageH}h ago${c.sensitive ? ' · <span style="color:var(--red)">sensitive</span>' : ''}</div>
  <h3 style="margin:4px 0"><a href="#/story/${c.id}">${esc(c.lead.title)}</a></h3><div class="mut">${esc(c.lead.source)} — ${esc(c.lead.summary)}</div>
  <div class="row" style="margin-top:8px"><b>Score ${c.score}</b><a class="btn" href="#/story/${c.id}">Open</a><button data-a="detail" data-id="${c.id}">Reports (${c.articles.length})</button></div><div id="d${c.id}"></div></div>`;
}
async function clusters() {
  const [list, cands] = await Promise.all([api('clusters'), api('candidates')]);
  main.innerHTML = `<h2 class="sec">Needs review — uncertain same-event pairs <span class="mut">${cands.length}</span></h2>` + (cands.length ? cands.map(c => `<div class="card" style="margin-bottom:10px"><div class="mut">similarity ${c.score.toFixed(2)} · ${esc(c.reason)}</div>
    <p><b>${esc(c.asrc)}:</b> <a href="${esc(c.au)}" target="_blank" rel="noopener noreferrer">${esc(c.at)}</a><br><b>${esc(c.bsrc)}:</b> <a href="${esc(c.bu)}" target="_blank" rel="noopener noreferrer">${esc(c.bt)}</a></p>
    <div class="row"><button class="pri" data-c="${c.id}" data-d="merge">Same event — merge</button><button data-c="${c.id}" data-d="separate">Different events</button></div></div>`).join('') : '<div class="empty">No uncertain pairs.</div>') +
    `<h2 class="sec">Events with multiple reports <span class="mut">${list.length}</span></h2>` + (list.length ? list.map(clusterCard).join('') : '<div class="empty">No multi-source clusters yet.</div>');
  main.onclick = async e => {
    const d = e.target.dataset; if (!d) return;
    try {
      if (d.c) { await api('candidates/' + d.c, { method: 'POST', body: { decision: d.d } }); return clusters(); }
      if (d.a === 'detail') { const box = $('#d' + d.id); if (box.innerHTML) return box.innerHTML = ''; const arts = await api('clusters/' + d.id);
        box.innerHTML = `<table>${arts.map(a => `<tr><td>${esc(a.source)}<br><span class="mut">${nst(a.published_at || a.fetched_at)}</span></td><td><a href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">${esc(a.title)}</a>${a.onlyHere.length ? `<br><span class="mut">only in this report: ${esc(a.onlyHere.join(', '))}</span>` : ''}</td></tr>`).join('')}</table>`; }
    } catch (x) { fail(x); }
  };
}

/* ---------- AI Studio ---------- */
const sevClass = { error: 'var(--red)', warn: 'var(--warn)', info: 'var(--mut)' };
const flagList = fl => fl.length ? fl.map(f => `<div style="color:${sevClass[f.severity]};font-size:13px;margin:3px 0"><b>${f.severity.toUpperCase()}</b> ${esc(f.message)}</div>`).join('') : '<div class="mut">No automatic flags. This does not mean the text is correct.</div>';
async function studio(openId) {
  const { drafts, jobs } = await api('drafts');
  const jb = j => `<span class="pill ${j.status === 'failed' ? 'failing' : ''}">${j.status}</span>`;
  main.innerHTML = `<h2 class="sec">AI Studio <span class="mut">drafts, translation review, SEO</span></h2>
  ${jobs.length ? `<div class="card" style="margin-bottom:12px"><b>Draft jobs</b>${jobs.map(j => `<div class="mut">${jb(j)} ${esc(j.title || 'cluster ' + j.cluster_id)} · attempt ${j.attempts}${j.error ? ` · <span style="color:var(--red)">${esc(j.error)}</span>` : ''}</div>`).join('')}</div>` : ''}
  ${drafts.length ? `<table>${drafts.map(d => `<tr><td><a href="#/studio/${d.id}"><b>${esc(d.headline)}</b></a><div class="mut">${esc(d.source)} · <b>${esc((d.lang || 'ne').toUpperCase())}</b> · ${({ translate_en: 'EN→NE', ne_original: 'NE original', en_original: 'EN original', ne_to_en: 'NE→EN' })[d.workflow] || d.workflow} · ${nst(d.created_at)} · <a href="#/story/${d.cluster_id}">story</a></div></td><td><span class="pill ${d.status === 'approved' ? 'working' : ''}">${d.status.replace('_', ' ')}</span>${d.source_level === 'limited' ? ' <span class="pill drafting">limited source</span>' : ''}</td><td class="mut">${d.flags.filter(f => f.severity === 'error').length} error · ${d.flags.filter(f => f.severity === 'warn').length} warn</td></tr>`).join('')}</table>` : '<div class="empty">No drafts yet. Open a story and press “Generate Nepali draft”.</div>'}<div id="ed"></div>`;
  main.onclick = null; main.onchange = null;
  if (openId) edit(openId);
  if (jobs.some(j => j.status === 'queued' || j.status === 'running')) timer = setTimeout(() => location.hash.startsWith('#/studio') && !$('#ed').innerHTML && studio(), 6000);
}
async function edit(id) {
  const d = await api('drafts/' + id), sn = d.source_snapshot, ro = d.status !== 'needs_review', e0 = d.effective, bun = !!d.bundle_id, en = d.lang === 'en', L = en ? 'English' : 'Nepali';
  const box = $('#ed'); box.scrollIntoView?.(); const dis = ro ? 'disabled' : '', inp = (k, v, max, tag = 'input', rows = 2) => `<div class="mut" style="display:flex;justify-content:space-between"><span>${k[1]}</span>${max ? `<span data-cnt="${k[0]}"></span>` : ''}</div>${tag === 'textarea' ? `<textarea id="${k[0]}" rows="${rows}" style="width:100%;font:inherit" ${dis}>${esc(v)}</textarea>` : `<input id="${k[0]}" type="text" style="width:100%" value="${esc(v)}" ${dis}>`}`;
  const lim = { gh: 60, gd: 130, sc: 230, md: 155, st: 60 };
  box.innerHTML = `<h2 class="sec">Review ${L} edition — draft #${d.id} <span class="mut">${esc(d.status)}</span></h2>
  <div class="row" style="margin-bottom:10px">${bun ? `<span class="pill ${d.source_level === 'full' ? 'approved' : 'drafting'}">${d.source_level === 'full' ? 'full source material' : 'limited source material'}</span><span class="mut">${d.source_words} source words · one request produced both editions (${esc(d.model)})</span>` : '<span class="pill line">legacy single-language draft</span>'}
    ${bun ? (d.counterpart ? `<a class="btn" href="#/studio/${d.counterpart.id}">Open the ${d.counterpart.lang === 'en' ? 'English' : 'Nepali'} edition (#${d.counterpart.id}, ${esc(d.counterpart.status)})</a>` : '<span class="err">The other edition is missing.</span>') : ''}</div>
  <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(340px,1fr))">
  <div class="card"><div class="cat">Source (${esc(sn.language)}) · ${esc(sn.source)}${sn.source_origin ? ` · ${esc(sn.source_origin.replace('_', ' '))}` : ''}</div><h3>${esc(sn.headline)}</h3><div class="mut">${nst(sn.published_at)}${sn.author ? ' · ' + esc(sn.author) : ''} · <a href="${esc(sn.url)}" target="_blank" rel="noopener noreferrer">open source ↗</a></div><p style="white-space:pre-wrap;font-size:13.5px;max-height:520px;overflow:auto">${esc(sn.source_text || sn.text)}</p>
    ${d.ai_translation ? `<details><summary class="mut">AI translation (internal review aid, not for publication)</summary><p style="white-space:pre-wrap">${esc(d.ai_translation)}</p></details>` : ''}${d.facts?.quotes?.length ? `<details><summary class="mut">Quotations the model says it verified (${d.facts.quotes.length})</summary>${d.facts.quotes.map(q => `<div class="mut">${esc(q.speaker)}: “${esc(q.source_text)}”</div>`).join('')}</details>` : ''}<div class="mut" style="white-space:pre-wrap">Attribution:\n${esc(d.attribution)}</div></div>
  <div class="card"><div class="cat">${L} website article</div>
    <label class="mut">Headline options</label>${d.headline_options.map((h, i) => `<div><label><input type="radio" name="h" value="${esc(h)}" ${h === e0.headline ? 'checked' : ''} ${dis}> ${esc(h)}${i === d.rec_idx ? ' ⭐' : ''}</label></div>`).join('')}
    <input id="hl" type="text" style="width:100%;margin:6px 0" value="${esc(e0.headline)}" ${dis}>
    ${bun ? inp(['sf', 'Standfirst (summary under the headline)'], e0.standfirst, 0, 'textarea', 2) : ''}
    <div class="mut">Article body (${(e0.body.match(/\S+/g) || []).length} words; a line starting with “## ” is a subheading)</div><textarea id="bd" rows="${bun ? 18 : 12}" style="width:100%;font:inherit" ${dis}>${esc(e0.body)}</textarea></div></div>
  ${bun ? `<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(340px,1fr));margin-top:14px">
    <div class="card"><div class="cat">Social graphic text <span class="mut" style="text-transform:none">(only for the image — not the website text)</span></div>${inp(['gh', 'Graphic headline'], e0.graphic_headline, 1)}<div style="height:6px"></div>${inp(['gd', 'Graphic description'], e0.graphic_description, 1, 'textarea', 2)}<div class="mut" style="margin-top:6px">No “Read More”. Changing either field makes an existing graphic outdated.</div></div>
    <div class="card"><div class="cat">Social caption <span class="mut" style="text-transform:none">(independent of the article and the image)</span></div>${inp(['cp', 'Caption for Facebook / Instagram — {{ARTICLE_URL}} becomes the real link'], e0.caption, 0, 'textarea', 7)}<div style="height:6px"></div>${inp(['sc', 'Short caption for X'], e0.short_caption, 1, 'textarea', 2)}</div>
    <div class="card"><div class="cat">SEO &amp; metadata</div>${inp(['st', 'SEO title'], e0.seo_title, 1)}<div style="height:6px"></div>${inp(['md', 'Meta description'], e0.meta_desc, 1, 'textarea', 2)}<div style="height:6px"></div>${inp(['kw', 'Keywords (comma separated)'], (e0.keywords || []).join(', '), 0)}<div style="height:6px"></div>${inp(['ht', 'Hashtags (space separated)'], (e0.hashtags || []).join(' '), 0)}<div style="height:6px"></div>${inp(['at', 'Image alt text'], e0.alt_text, 0)}</div></div>`
  : `<div class="card" style="margin-top:14px"><div class="mut">Social caption</div><textarea id="cp" rows="3" style="width:100%;font:inherit" ${dis}>${esc(e0.caption)}</textarea></div>`}
  <h2 class="sec">Automatic checks <span class="mut">they flag risks for a human; they do not prove the story is true</span></h2><div id="fl">${flagList(d.flags)}</div>
  ${ro ? `<p class="mut">Approved ${nst(d.approved_at)}</p>` : `<div class="row" style="margin-top:14px"><button id="sv">Save edits &amp; re-check</button><label class="mut"><input type="checkbox" id="ack"> I reviewed the error flags and accept them</label><button class="pri" id="ap">Approve this edition</button><button id="rg">${bun ? 'Regenerate both editions (uses 1 AI request)' : 'Regenerate'}</button></div>`}`;
  box.querySelectorAll('input[name=h]').forEach(r => r.onchange = () => $('#hl').value = r.value);
  const count = () => { for (const k of Object.keys(lim)) { const el = $('#' + k), c = box.querySelector(`[data-cnt="${k}"]`); if (el && c) { const n = [...el.value].length; c.textContent = `${n} / ${lim[k]}`; c.style.color = n > lim[k] ? 'var(--red)' : ''; } } }; box.oninput = count; count();
  if (d.status === 'approved') { box.insertAdjacentHTML('beforeend', `<div class="row" style="margin-top:14px"><a class="btn pri" href="#/publish/${d.id}" style="color:#fff">Create social post</a><a class="btn" href="#/editor/${d.cluster_id}?lang=${d.lang}">Design graphic</a></div>`); sitePanel(d, box); }
  if (ro) return;
  const val = k => $('#' + k)?.value ?? '', list = (k, sep) => val(k).split(sep).map(x => x.trim()).filter(Boolean);
  const body = () => ({ headline: val('hl'), body: val('bd'), caption: val('cp'), ...(bun && { extra: { standfirst: val('sf'), graphic_headline: val('gh'), graphic_description: val('gd'), short_caption: val('sc'), seo_title: val('st'), meta_desc: val('md'), alt_text: val('at'), keywords: list('kw', ','), hashtags: list('ht', /\s+/) } }) });
  $('#sv').onclick = async () => { try { const r = await api('drafts/' + id, { method: 'PUT', body: body() }); $('#fl').innerHTML = flagList(r.flags); toast('Saved and re-checked'); } catch (x) { fail(x); } };
  $('#ap').onclick = async () => { try { await api('drafts/' + id, { method: 'PUT', body: body() }); await api(`drafts/${id}/approve`, { method: 'POST', body: { ack_errors: $('#ack').checked } }); toast('Approved'); studio(id); } catch (x) { fail(x); if (x.data?.flags) $('#fl').innerHTML = flagList(x.data.flags); } };
  $('#rg').onclick = async () => { if (bun && !confirm('Regenerate both editions? This uses one AI request and replaces the unapproved drafts (your edits to them are kept in revisions only for the headline/body/caption).')) return; try { await api('drafts', { method: 'POST', body: { cluster_id: d.cluster_id, lang: bun ? 'both' : d.lang, force: true } }); toast('Regeneration queued'); studio(); } catch (x) { fail(x); } };
}


/* ---------- Graphic design editor ---------- */
const CAT_NE = ['', 'राजनीति', 'निर्वाचन', 'अपराध', 'स्वास्थ्य', 'विपद्', 'अर्थतन्त्र', 'खेलकुद', 'समाचार'];
const CAT_MAP = { politics: 'राजनीति', election: 'निर्वाचन', crime: 'अपराध', health: 'स्वास्थ्य', disaster: 'विपद्', economy: 'अर्थतन्त्र', sports: 'खेलकुद' };
async function uploadAsset(file, kind, cluster, rights) {
  const r = await fetch(`/api/assets?kind=${kind}&cluster_id=${cluster || ''}&name=${encodeURIComponent(file.name)}&rights=${encodeURIComponent(rights)}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file });
  const j = await r.json().catch(() => ({})); if (r.status === 401) { login(); throw AUTH; } if (!r.ok) throw new Error(j.error || r.status); return j;
}
async function design(id) {
  const lang = new URLSearchParams(location.hash.split('?')[1] || '').get('lang') || '';
  let d = await api('design/' + id + (lang ? '?lang=' + lang : ''));
  const tpl = d.templates[0];
  const S = { spec: JSON.parse(JSON.stringify(tpl.spec)), templateId: tpl.id, photoId: d.lead_asset_id ?? null, logoId: null, outFormat: 'png', seq: 0, last: null };
  Object.assign(S.spec, { headline: d.draft?.graphic_headline || d.draft?.headline || d.title, subheadline: d.draft?.subheadline || '', dateText: d.date_text, sourceText: '', category: CAT_MAP[d.cluster.category] || '' });
  const photos = () => d.assets.filter(a => a.kind === 'photo'), logos = () => d.assets.filter(a => a.kind === 'logo');
  const get = (o, k) => k.split('.').reduce((a, p) => a?.[p], o), set = (o, k, v) => { const ps = k.split('.'); const l = ps.pop(); ps.reduce((a, p) => a[p], o)[l] = v; };
  const strip = t => t.replace(/\[\[|\]\]/g, '');
  const field = (k, label, tag = 'input', extra = '') => `<label class="mut" style="display:block;margin-top:8px">${label}${tag === 'textarea' ? `<textarea data-k="${k}" rows="3" style="width:100%;font:inherit" ${extra}>${esc(get(S.spec, k))}</textarea>` : `<input type="text" data-k="${k}" value="${esc(get(S.spec, k))}" style="width:100%" ${extra}>`}</label>`;
  const range = (k, label, min, max, step) => `<label class="mut" style="display:block;margin-top:6px">${label} <b data-v="${k}">${(+get(S.spec, k)).toFixed(2)}</b><input type="range" data-k="${k}" data-num="1" min="${min}" max="${max}" step="${step}" value="${get(S.spec, k)}" style="width:100%"></label>`;
  const thumbs = (list, sel, attr) => list.length ? `<div class="row" style="margin-top:6px">${list.map(a => `<button class="ghost" style="padding:2px;${a.id === sel ? 'outline:2px solid var(--blue)' : ''}" ${attr}="${a.id}" title="${esc(a.orig_name)} ${a.width}×${a.height}"><img src="/api/assets/${a.id}/file" alt="" style="width:64px;height:48px;object-fit:${attr === 'data-photo' ? 'cover' : 'contain'};background:#eee;display:block"></button>`).join('')}</div>` : '<div class="mut">None uploaded yet.</div>';
  const dr = d.draft;
  function paint() {
    const hlNow = strip(S.spec.headline).trim(), want = (dr?.graphic_headline || dr?.headline || '').trim(), mismatch = dr && (hlNow !== want || (dr.bundle && strip(S.spec.subheadline).trim() !== (dr.subheadline || '').trim()));
    main.innerHTML = `<div class="mut"><a href="#/story/${id}">← Story</a></div><h2 class="sec">Social graphic <span class="mut">${esc(d.title)}</span> <a class="btn" href="#/editor/${id}${lang ? '?lang=' + lang : ''}">Open the layered editor</a></h2>
    ${d.editions.length > 1 ? `<div class="row" style="margin-bottom:10px">${d.editions.map(e => `<a class="btn ${(dr && dr.lang === e.lang) ? 'pri' : ''}" style="${(dr && dr.lang === e.lang) ? 'color:#fff' : ''}" href="#/design/${id}?lang=${e.lang}">${e.lang === 'ne' ? 'नेपाली' : 'English'} graphic <span class="mut" style="${(dr && dr.lang === e.lang) ? 'color:#fff' : ''}">(${esc(e.status)})</span></a>`).join('')}<span class="mut">Each edition has its own graphic text and caption; both use the story’s lead image.</span></div>` : ''}
    ${dr ? `<div class="card" style="margin-bottom:12px">Headline source: <b>Draft #${dr.id}</b> ${dr.approved ? '<span class="pill approved">approved</span>' : '<span class="pill drafting">not approved</span>'}
      ${!dr.approved ? '<div class="mut">You can design now, but publishing will require the draft to be approved. If the headline changes later, this graphic will be marked outdated.</div>' : ''}
      ${mismatch ? `<div class="err">The text on the graphic differs from the ${dr.approved ? 'approved' : 'current draft'} graphic ${dr.bundle ? 'headline/description' : 'headline'}. <button class="ghost" id="usehl">Use ${dr.approved ? 'approved' : 'draft'} text</button></div>` : ''}</div>` : '<div class="card err" style="margin-bottom:12px">No draft exists for this story yet. The headline below is the original source headline — generate and approve a Nepali draft first (see the story page).</div>'}
    <div class="two" style="grid-template-columns:minmax(0,420px) minmax(0,1fr)"><div>
      <div class="card"><div class="side-h">Template &amp; format</div>
        <div class="row"><select id="tpl">${d.templates.map(t => `<option value="${t.id}" ${t.id === S.templateId ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select><button class="ghost" id="tload">Load</button></div>
        <div class="row" style="margin-top:6px"><input type="text" id="tname" placeholder="Save current style as…" style="flex:1"><button class="ghost" id="tsave">Save template</button></div>
        <div class="row" style="margin-top:10px">${Object.entries(d.formats).map(([k, f]) => `<button data-fmt="${k}" class="${S.spec.format === k ? 'pri' : 'ghost'}">${f.name}</button>`).join('')}</div></div>
      <div class="card" style="margin-top:12px"><div class="side-h">Text</div>
        ${field('headline', 'Headline (wrap words in [[ ]] to highlight them red)', 'textarea')}<div class="row" style="margin-top:4px"><button class="ghost" id="hl">Highlight selection</button></div>
        ${field('subheadline', 'Subheadline', 'textarea')}
        <label class="mut" style="display:block;margin-top:8px">Category tag<select data-k="category" style="width:100%">${CAT_NE.map(c => `<option ${c === S.spec.category ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
        <div class="row" style="margin-top:2px"><div style="flex:1">${field('badgeLeft', 'Badge (left, red)')}</div><div style="flex:1">${field('badgeRight', 'Badge (right, blue)')}</div></div>
        <div class="row"><div style="flex:1">${field('dateText', 'Date')}</div><div style="flex:1">${field('sourceText', 'Source attribution')}</div></div>
        <div class="row"><div style="flex:1">${field('footerText', 'Footer button text')}</div><div style="flex:1">${field('urlText', 'Website text (optional)')}</div></div></div>
      <div class="card" style="margin-top:12px"><div class="side-h">Photo</div>
        <label class="mut"><input type="checkbox" id="rights"> I own this photo or have permission to use it</label>
        <div class="row" style="margin-top:6px"><input type="file" id="pf" accept="image/png,image/jpeg,image/webp"><span class="mut">PNG/JPEG/WebP, ≤12 MB</span></div>
        ${thumbs(photos(), S.photoId, 'data-photo')}
        ${S.photoId ? (() => { const a = d.assets.find(x => x.id === S.photoId); return a ? `<div class="mut" style="margin-top:6px">Story lead image #${a.id}${a.id === d.lead_asset_id ? '' : ' (not the lead)'} · ${a.origin_url ? `from a source report: <a href="${esc(a.origin_url)}" target="_blank" rel="noopener noreferrer">original image ↗</a>` : 'uploaded by you'} · permission: ${esc(a.rights_note || 'none recorded')}</div>` : ''; })() : ''}
        ${d.reference_images.length ? `<div class="mut" style="margin-top:8px">Images found in the reports of this story (reference only). Using one needs your confirmation that you hold the rights:</div><div class="row">${d.reference_images.map(r => `<div style="width:84px"><img src="${isrc(r.id, 160)}" width="84" height="63" loading="lazy" alt="" style="object-fit:cover;opacity:.85"><div class="mut" style="font-size:10px">${esc(r.source)}${r.generic ? ' · <b style="color:var(--red)">looks like a default image</b>' : ''}</div><button class="ghost" data-adopt="${r.id}" data-generic="${r.generic ? 1 : ''}" style="padding:1px 6px;font-size:11px">Use…</button></div>`).join('')}</div>` : ''}
        ${S.photoId ? `<div style="margin-top:8px">${range('photo.zoom', 'Zoom', 1, 4, 0.05)}${range('photo.fx', 'Horizontal position', 0, 1, 0.01)}${range('photo.fy', 'Vertical position', 0, 1, 0.01)}${range('photo.overlay', 'Darken', 0, 0.7, 0.01)}
          <label class="mut"><input type="checkbox" data-k="photo.grayscale" ${S.spec.photo.grayscale ? 'checked' : ''}> Black &amp; white</label><div class="mut">Tip: drag the preview to reposition the photo.</div></div>` : ''}</div>
      <div class="card" style="margin-top:12px"><div class="side-h">Logo &amp; colours</div>
        <div class="row"><input type="file" id="lf" accept="image/png,image/jpeg,image/webp"><button class="ghost" id="nologo">Use placeholder</button></div>${thumbs(logos(), S.logoId, 'data-logo')}
        <div class="row" style="margin-top:8px"><label class="mut">Highlight/badge <input type="color" data-k="colors.accent" value="${S.spec.colors.accent}"></label><label class="mut">Badge 2 <input type="color" data-k="colors.badge2" value="${S.spec.colors.badge2}"></label></div></div>
    </div><div style="position:sticky;top:112px;align-self:start">
      <div id="pw" style="background:var(--soft);min-height:200px;text-align:center"><img id="pv" alt="Graphic preview" style="max-width:100%;max-height:78vh;cursor:grab;touch-action:none;display:none"><div id="pl" class="mut" style="padding:60px 0">Rendering…</div></div>
      <div id="warns" style="margin-top:8px"></div>
      <div class="row" style="margin-top:10px"><button class="pri" id="save">Save graphic</button><select id="of"><option value="png">PNG</option><option value="jpeg" ${S.outFormat === 'jpeg' ? 'selected' : ''}>JPEG (smaller)</option></select><span class="mut" id="sm"></span></div>
      <h2 class="sec">Saved graphics</h2><div id="gl">${d.graphics.length ? d.graphics.map(g => `<div class="row" style="padding:6px 0;border-bottom:1px solid var(--rule)"><img src="/api/graphics/${g.id}/file" alt="" style="width:56px;height:56px;object-fit:cover"><div style="flex:1"><b>${esc(g.format)}</b> <span class="mut">${rel(g.created_at)} · ${(g.bytes / 1024).toFixed(0)} KB</span>${g.stale ? `<div class="err">Outdated: ${esc(g.stale_reason)}</div>` : '<div class="mut" style="color:var(--ok)">Matches current headline</div>'}</div><a class="btn" href="/api/graphics/${g.id}/file?download=1">Download</a></div>`).join('') : '<div class="empty">Nothing saved yet.</div>'}</div>
    </div></div>`;
    bind(); preview();
  }
  const showWarn = w => { $('#warns').innerHTML = w.map(x => `<div style="color:${sevClass[x.severity] ?? 'var(--mut)'};font-size:13px;margin:2px 0"><b>${x.severity.toUpperCase()}</b> ${esc(x.message)}</div>`).join('') || '<div class="mut" style="color:var(--ok)">No layout warnings.</div>'; };
  let timer2;
  function preview() { clearTimeout(timer2); timer2 = setTimeout(async () => {
    const my = ++S.seq; try { const r = await api('graphics/preview', { method: 'POST', body: { spec: S.spec, photoAssetId: S.photoId, logoAssetId: S.logoId, cluster_id: id } }); if (my !== S.seq) return;
      S.last = r; const pv = $('#pv'); if (!pv) return; pv.src = 'data:image/png;base64,' + r.png; pv.style.display = 'inline-block'; $('#pl').style.display = 'none'; showWarn(r.warnings); $('#sm').textContent = `${r.width}×${r.height}px · headline ${r.metrics.headlineFont}px, ${r.metrics.headlineLines} lines`; }
    catch (x) { if (x !== AUTH) { $('#pl').textContent = x.message; $('#pl').style.display = 'block'; } } }, 350); }
  function bind() {
    main.oninput = main.onchange = e => { const t = e.target, k = t.dataset?.k; if (!k) return; const v = t.type === 'checkbox' ? t.checked : t.dataset.num ? +t.value : t.value; set(S.spec, k, v); const lab = main.querySelector(`[data-v="${k}"]`); if (lab) lab.textContent = (+v).toFixed(2); if (k === 'headline') { const m = $('.err #usehl'); } preview(); };
    main.onclick = async e => {
      const t = e.target, ds = t.dataset ?? {};
      try {
        if (t.id === 'usehl') { S.spec.headline = dr.graphic_headline || dr.headline; if (dr.bundle) S.spec.subheadline = dr.subheadline || ''; paint(); }
        else if (ds.fmt) { S.spec.format = ds.fmt; paint(); }
        else if (ds.adopt) { const rights = prompt('Describe the licence or permission you hold for this image (it is stored with the image):'); if (!rights) return; const r = await api(`story/${id}/adopt-image`, { method: 'POST', body: { article_id: +ds.adopt, rights_note: rights, confirm_generic: !!ds.generic && confirm('This looks like the publisher’s default image. Use it anyway?') } }); d = await api('design/' + id + (lang ? '?lang=' + lang : '')); S.photoId = d.lead_asset_id; toast(`Image added to this story (${r.width}×${r.height}) with its source recorded`); paint(); }
        else if (ds.photo) { await api(`story/${id}/lead-image`, { method: 'POST', body: { asset_id: +ds.photo } }); d = await api('design/' + id + (lang ? '?lang=' + lang : '')); S.photoId = +ds.photo; toast('This is now the story’s lead image (website article and every graphic)'); paint(); } else if (ds.logo) { S.logoId = +ds.logo; paint(); }
        else if (t.id === 'nologo') { S.logoId = null; paint(); }
        else if (t.id === 'hl') { const ta = main.querySelector('textarea[data-k="headline"]'), a = ta.selectionStart, b = ta.selectionEnd; if (a === b) return toast('Select some words in the headline first', true); S.spec.headline = ta.value.slice(0, a) + '[[' + ta.value.slice(a, b) + ']]' + ta.value.slice(b); paint(); }
        else if (t.id === 'tload') { const tp = d.templates.find(x => x.id === +$('#tpl').value); const keep = S.spec; S.spec = { ...JSON.parse(JSON.stringify(tp.spec)), headline: keep.headline, subheadline: keep.subheadline, dateText: keep.dateText, sourceText: keep.sourceText, category: keep.category }; S.templateId = tp.id; paint(); }
        else if (t.id === 'tsave') { const name = $('#tname').value.trim(); if (!name) return toast('Name the template first', true); try { await api('templates', { method: 'POST', body: { name, spec: S.spec } }); } catch (x) { if (!/already exists/.test(x.message) || !confirm(x.message + '\n\nReplace it?')) throw x; await api('templates', { method: 'POST', body: { name, spec: S.spec, overwrite: true } }); } d = await api('design/' + id + (lang ? '?lang=' + lang : '')); toast('Template saved'); paint(); }
        else if (t.id === 'save') {
          t.disabled = true; try { const r = await api('graphics', { method: 'POST', body: { cluster_id: id, draft_id: dr?.id ?? null, spec: S.spec, photoAssetId: S.photoId, logoAssetId: S.logoId, template_id: S.templateId, outFormat: $('#of').value } });
            toast(r.unapproved ? 'Saved — note: the draft is not approved yet' : 'Graphic saved'); const keep = { ...S.spec }; d = await api('design/' + id + (lang ? '?lang=' + lang : '')); S.spec = keep; paint(); } finally { t.disabled = false; }
        }
      } catch (x) { fail(x); }
    };
    $('#pf').onchange = async e => { const f = e.target.files[0]; if (!f) return; if (!$('#rights').checked) { e.target.value = ''; return toast('Tick the permission box first', true); }
      try { const r = await uploadAsset(f, 'photo', id, 'uploader confirmed permission'); d = await api('design/' + id + (lang ? '?lang=' + lang : '')); S.photoId = r.id; toast(`Photo uploaded (${r.width}×${r.height})`); paint(); } catch (x) { e.target.value = ''; fail(x); } };
    $('#lf').onchange = async e => { const f = e.target.files[0]; if (!f) return; try { const r = await uploadAsset(f, 'logo', null, ''); d = await api('design/' + id + (lang ? '?lang=' + lang : '')); S.logoId = r.id; toast('Logo uploaded'); paint(); } catch (x) { e.target.value = ''; fail(x); } };
    const pv = $('#pv'); let drag = null;
    pv.onpointerdown = e => { if (!S.photoId) return; drag = { x: e.clientX, y: e.clientY, fx: S.spec.photo.fx, fy: S.spec.photo.fy }; pv.setPointerCapture(e.pointerId); pv.style.cursor = 'grabbing'; e.preventDefault(); };
    pv.onpointermove = e => { if (!drag) return; const a = d.assets.find(x => x.id === S.photoId), cw = S.last.width, ch = S.last.height, sc = Math.max(cw / a.width, ch / a.height) * S.spec.photo.zoom;
      const k = cw / pv.clientWidth; S.spec.photo.fx = Math.min(1, Math.max(0, drag.fx - ((e.clientX - drag.x) * k) / (a.width * sc))); S.spec.photo.fy = Math.min(1, Math.max(0, drag.fy - ((e.clientY - drag.y) * k) / (a.height * sc)));
      for (const kk of ['photo.fx', 'photo.fy']) { const l = main.querySelector(`[data-v="${kk}"]`), inp = main.querySelector(`input[data-k="${kk}"]`); if (l) l.textContent = get(S.spec, kk).toFixed(2); if (inp) inp.value = get(S.spec, kk); } preview(); };
    pv.onpointerup = pv.onpointercancel = () => { drag = null; pv.style.cursor = 'grab'; };
  }
  paint();
}


/* ---------- Social publishing ---------- */
const PST = { draft: 'Needs approval', approved: 'Approved', scheduled: 'Scheduled', publishing: 'Publishing…', published: 'Published', partial: 'Partly published', failed: 'Failed', cancelled: 'Cancelled' };
const tPill = t => `<span class="pill ${t.status === 'published' ? 'approved' : ['failed', 'unknown'].includes(t.status) ? 'failing' : t.status === 'cancelled' ? 'line' : 'drafting'}">${esc(t.status)}</span>`;
const toIsoNst = v => new Date(v + ':00+05:45').toISOString(); // the editor types Nepal time
async function publish(draftId) {
  const [acc, posts, plats] = await Promise.all([api('social/accounts'), api('posts'), api('social/platforms')]);
  const maxCap = Object.fromEntries(plats.map(p => [p.id, p.maxCaption])), connected = acc.accounts.filter(a => a.status === 'connected');
  let form = '', draft, des;
  if (draftId) {
    draft = await api('drafts/' + draftId); des = await api('design/' + draft.cluster_id);
    const fresh = des.graphics.filter(g => g.draft_id === draft.id && !g.stale), stale = des.graphics.filter(g => g.draft_id === draft.id && g.stale);
    form = draft.status !== 'approved' ? `<div class="card err">This draft is not approved yet. Approve it in <a href="#/studio/${draft.id}">AI Studio</a> before posting it.</div>` : `<div class="card" style="margin-bottom:16px">
      <div class="side-h">New social post</div><b>${esc(draft.final_headline)}</b> <span class="pill line">${esc((draft.lang || 'ne').toUpperCase())}</span>
      <div class="row" style="margin-top:8px"><label class="mut">Graphic <select id="pg"><option value="">No image</option>${fresh.map(g => `<option value="${g.id}">graphic #${g.id} (${g.format}, ${g.mime.split('/')[1]})</option>`).join('')}</select></label>
        ${stale.length ? `<span class="err">${stale.length} graphic(s) are outdated and hidden — regenerate in the Design editor.</span>` : ''}${fresh.length ? '' : `<a class="btn" href="#/design/${draft.cluster_id}">Design a graphic</a>`}</div>
      <div class="side-h" style="margin-top:12px">Accounts &amp; captions</div>
      ${connected.length ? connected.map(a => `<div style="padding:8px 0;border-bottom:1px solid var(--rule)"><label><input type="checkbox" data-acc="${a.id}"> <b>${esc(a.display_name)}</b> <span class="mut">${esc(a.label)}</span>${a.isTest ? ' <span class="pill drafting">TEST — nothing is posted</span>' : ''}</label>
        <textarea data-cap="${a.id}" rows="5" style="width:100%;font:inherit;margin-top:4px">${esc((a.platform === 'x' && draft.effective?.short_caption) || draft.final_caption || '')}</textarea><div class="mut" data-cnt="${a.id}"></div><div data-iss="${a.id}"></div></div>`).join('') : '<div class="empty">No connected accounts. Add one below (real platforms need developer credentials).</div>'}
      <label class="mut"><input type="checkbox" id="rp"> post again even if this story was already posted to an account</label>
      <div class="row" style="margin-top:10px"><button class="pri" id="mk">Create post</button><span class="mut">You will approve and schedule it in the queue below.</span></div></div>`;
  }
  const acctHtml = `<h2 class="sec">Accounts <span class="mut">${acc.used} of ${acc.max} used</span></h2><div class="grid">${plats.map(p => `<div class="card"><b>${esc(p.label)}</b> ${p.mockOnly ? '<span class="pill drafting">test</span>' : '<span class="pill line">not connected</span>'}<div class="mut" style="margin:6px 0">${esc(p.note)}</div>
      ${p.mockOnly ? '<div class="row"><input type="text" id="mn" placeholder="Test account name" style="flex:1"><button id="addm">Add test account</button></div>' : `<div class="mut">${p.missingEnv.length ? `Missing: <code>${esc(p.missingEnv.join(', '))}</code>` : 'Credentials present, but the real adapter is not implemented yet.'}</div><button class="ghost" data-conn="${p.id}">Connect…</button>`}</div>`).join('')}</div>
    ${acc.accounts.length ? `<table style="margin-top:12px">${acc.accounts.map(a => `<tr><td><b>${esc(a.display_name)}</b> <span class="mut">${esc(a.label)}</span>${a.isTest ? ' <span class="pill drafting">TEST</span>' : ''}</td><td><span class="pill ${a.status === 'connected' ? 'approved' : 'failing'}">${esc(a.status)}</span>${a.last_error ? `<div class="err">${esc(a.last_error)}</div>` : ''}</td><td>${a.status !== 'disconnected' ? `<button class="ghost" data-dis="${a.id}">Disconnect</button>` : ''}</td></tr>`).join('')}</table>` : ''}`;
  const queue = `<h2 class="sec">Queue &amp; history</h2>` + (posts.length ? posts.map(p => `<div class="card" style="margin-bottom:12px"><div class="row"><b>#${p.id}</b> <a href="#/studio/${p.draft_id}">${esc(p.headline)}</a> <span class="pill ${p.state === 'published' ? 'approved' : ['failed', 'partial'].includes(p.state) ? 'failing' : 'drafting'}">${esc(PST[p.state] || p.state)}</span>${p.scheduled_at ? `<span class="mut">for ${nst(p.scheduled_at)}</span>` : ''}</div>
    ${!p.gate.ok && !['published', 'cancelled'].includes(p.state) ? `<div class="err">${p.gate.problems.map(esc).join(' ')}</div>` : ''}
    <table>${p.targets.map(t => `<tr><td><b>${esc(t.display_name)}</b> <span class="mut">${esc(t.platform)}</span>${t.isTest ? ' <span class="pill drafting">TEST</span>' : ''}<div class="mut">${esc(t.caption.slice(0, 90))}</div></td><td>${tPill(t)}<div class="mut">${t.attempts ? `attempt ${t.attempts}` : ''}${t.status === 'queued' && t.next_run_at ? ` · next ${nst(t.next_run_at)}` : ''}</div></td>
      <td>${t.platform_url ? `<a href="${esc(t.platform_url)}" target="_blank" rel="noopener noreferrer">${esc(t.isTest ? 'test link' : 'view post')} ↗</a><div class="mut">${esc(t.platform_post_id)} · ${nst(t.published_at)}</div>` : ''}${t.error ? `<div class="err">${esc(t.error)}</div>` : ''}</td>
      <td>${t.status === 'failed' && t.error_kind !== 'permanent' ? `<button class="ghost" data-retry="${t.id}">Retry</button>` : ''}${t.status === 'unknown' ? `<button class="ghost" data-retry="${t.id}" data-confirm="1">Retry anyway</button><button class="ghost" data-mark="${t.id}">Mark published…</button>` : ''}</td></tr>`).join('')}</table>
    <div class="row" style="margin-top:8px">${p.state === 'draft' ? `<button class="pri" data-appr="${p.id}">Approve</button>` : ''}${p.state === 'approved' ? `<button class="pri" data-now="${p.id}">Publish now</button><input type="datetime-local" data-when="${p.id}"><button data-sched="${p.id}">Schedule (Nepal time)</button>` : ''}${['draft', 'approved', 'scheduled'].includes(p.state) ? `<button class="ghost" data-cancel="${p.id}">Cancel</button>` : ''}</div></div>`).join('') : '<div class="empty">No posts yet. Open an approved draft in AI Studio and choose “Create social post”.</div>');
  main.innerHTML = `<h2 class="sec">Publishing <span class="mut">approval → schedule → delivery with retries</span></h2>${form}${queue}${acctHtml}`;
  const act = async (fn, msg) => { try { await fn(); if (msg) toast(msg); publish(draftId); } catch (x) { fail(x); } };
  const caps = () => [...main.querySelectorAll('[data-acc]:checked')].map(c => ({ account_id: +c.dataset.acc, caption: main.querySelector(`[data-cap="${c.dataset.acc}"]`).value }));
  let vt; const validate = () => { clearTimeout(vt); vt = setTimeout(async () => { if (!draft || draft.status !== 'approved') return; const gid = $('#pg')?.value || null;
    for (const a of connected) { const el = main.querySelector(`[data-cap="${a.id}"]`), cnt = main.querySelector(`[data-cnt="${a.id}"]`); if (el) cnt.textContent = `${[...el.value].length} / ${maxCap[a.platform]} characters`; }
    try { const r = await api('posts/validate', { method: 'POST', body: { draft_id: draft.id, graphic_id: gid, targets: caps() } }); for (const t of r.targets) { const box = main.querySelector(`[data-iss="${t.account_id}"]`); if (box) box.innerHTML = t.issues.map(i => `<div style="color:${sevClass[i.severity] || 'var(--mut)'};font-size:12.5px">${esc(i.message)}</div>`).join(''); } } catch (x) { fail(x); } }, 350); };
  main.oninput = main.onchange = e => { if (e.target.matches('[data-cap],[data-acc],#pg')) validate(); };
  main.onclick = async e => {
    const d = e.target.dataset ?? {}, id = e.target.id;
    if (id === 'mk') { try { const r = await api('posts', { method: 'POST', body: { draft_id: draft.id, graphic_id: $('#pg').value || null, targets: caps(), repost: $('#rp').checked } }); toast(`Post #${r.id} created — approve it below`); location.hash = '#/publish'; } catch (x) { fail(x); } return; } // navigate away: do not re-render the form
    if (id === 'addm') return act(() => api('social/accounts/mock', { method: 'POST', body: { display_name: $('#mn').value } }), 'Test account added');
    if (d.conn) return act(async () => { try { await api(`social/connect/${d.conn}`, { method: 'POST', body: {} }); } catch (x) { toast(x.message, true); } });
    if (d.dis) return confirm('Disconnect this account? Its queued posts are cancelled.') && act(() => api('social/accounts/' + d.dis, { method: 'DELETE' }), 'Disconnected');
    if (d.appr) return act(() => api(`posts/${d.appr}/approve`, { method: 'POST', body: {} }), 'Approved');
    if (d.now) return act(() => api(`posts/${d.now}/schedule`, { method: 'POST', body: {} }), 'Queued for immediate delivery');
    if (d.sched) { const v = main.querySelector(`[data-when="${d.sched}"]`).value; if (!v) return toast('Pick a date and time (Nepal time)', true); return act(() => api(`posts/${d.sched}/schedule`, { method: 'POST', body: { scheduled_at: toIsoNst(v) } }), 'Scheduled'); }
    if (d.cancel) return act(() => api(`posts/${d.cancel}/cancel`, { method: 'POST', body: {} }), 'Cancelled');
    if (d.retry) return act(() => api(`post-targets/${d.retry}/retry`, { method: 'POST', body: { confirm: !!d.confirm } }), 'Retry queued');
    if (d.mark) { const url = prompt('Paste the URL of the post you verified on the platform:'); if (url) return act(() => api(`post-targets/${d.mark}/mark-published`, { method: 'POST', body: { url } }), 'Recorded'); }
  };
  if (draftId) validate();
  if (posts.some(p => ['scheduled', 'publishing'].includes(p.state))) timer = setTimeout(() => location.hash.startsWith('#/publish') && !document.activeElement?.matches('textarea,input') && publish(draftId), 4000);
}

/* ---------- Website publishing ---------- */
const PUB_CATS = { politics: 'Politics', economy: 'Economy', sports: 'Sports', crime: 'Crime', health: 'Health', disaster: 'Disaster', national: 'National' };
const toPubCat = c => ({ politics: 'politics', election: 'politics', economy: 'economy', sports: 'sports', crime: 'crime', health: 'health', disaster: 'disaster' })[c] || 'national';
async function sitePanel(d, box) {
  const div = document.createElement('div'); box.appendChild(div);
  const [pub, des, st] = await Promise.all([api(`drafts/${d.id}/publication`), api('design/' + d.cluster_id), api('story/' + d.cluster_id)]);
  const photos = des.assets.filter(a => a.kind === 'photo' && a.rights_note && (a.cluster_id === d.cluster_id)), graphics = des.graphics.filter(g => g.draft_id === d.id && !g.stale);
  const live = !pub.none && pub.draft_id === d.id && pub.status === 'published';
  div.innerHTML = `<h2 class="sec">Public website <span class="mut">${esc(d.lang === 'en' ? 'English' : 'Nepali')} edition</span></h2><div class="card">
    ${pub.none ? '<p class="mut">Not on the website yet. Publishing shows this approved text — and nothing else from the draft — to readers.</p>' : `<p>${live ? '<span class="pill approved">live</span>' : pub.status === 'published' ? '<span class="pill drafting">live (older draft)</span>' : '<span class="pill line">unpublished</span>'} <a href="${esc(pub.path)}" target="_blank" rel="noopener">${esc(pub.path)} ↗</a> <span class="mut">updated ${rel(pub.updated_at)}</span></p>`}
    <div class="row"><label class="mut">Category <select id="pcat">${Object.entries(PUB_CATS).map(([k, v]) => `<option value="${k}" ${k === toPubCat(st.rank?.category) ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label class="mut">Photo <select id="pph"><option value="none">No photo (branded placeholder)</option>${photos.map(a => `<option value="${a.id}" ${a.id === des.lead_asset_id ? 'selected' : ''}>#${a.id}${a.id === des.lead_asset_id ? ' (story lead image)' : ''} ${esc(a.orig_name)} (${a.width}×${a.height})</option>`).join('')}</select></label>
      <label class="mut">Photo credit <input type="text" id="pcr" maxlength="120" placeholder="e.g. Photo: Name"></label>
      <label class="mut">Share image <select id="pgr"><option value="">None</option>${graphics.map(g => `<option value="${g.id}">graphic #${g.id} (${g.format})</option>`).join('')}</select></label></div>
    ${photos.length ? '' : '<div class="mut">Only photos uploaded for this story with a recorded usage permission can be published. Upload one in the Design editor.</div>'}
    <div class="row" style="margin-top:10px"><button class="pri" id="pub">${pub.none ? 'Publish to website' : 'Publish this version'}</button>${!pub.none && pub.status === 'published' ? '<button id="unpub">Unpublish</button>' : ''}</div></div>`;
  div.querySelector('#pub').onclick = async () => { try { const r = await api(`drafts/${d.id}/publish`, { method: 'POST', body: { category: $('#pcat').value, photoAssetId: ['', 'none'].includes($('#pph').value) ? null : $('#pph').value, noPhoto: $('#pph').value === 'none', photoCredit: $('#pcr').value, graphicId: $('#pgr').value || null } }); toast(r.created ? 'Published' : 'Website article updated'); div.remove(); sitePanel(d, box); } catch (x) { fail(x); } };
  div.querySelector('#unpub')?.addEventListener('click', async () => { try { await api(`publications/${pub.id}/unpublish`, { method: 'POST' }); toast('Unpublished'); div.remove(); sitePanel(d, box); } catch (x) { fail(x); } });
}
async function site() {
  const l = await api('publications');
  main.innerHTML = `<h2 class="sec">Public website <span class="mut"><a href="/ne/" target="_blank" rel="noopener">Nepali edition ↗</a> · <a href="/en/" target="_blank" rel="noopener">English edition ↗</a></span></h2>` + (l.length ? `<table>${l.map(p => `<tr><td><a href="${esc(p.path)}" target="_blank" rel="noopener"><b>${esc(p.headline)}</b></a><div class="mut">${esc(p.lang.toUpperCase())} · ${esc(p.category)} · published ${nst(p.published_at)} · <a href="#/studio/${p.draft_id}">draft #${p.draft_id}</a></div></td><td><span class="pill ${p.status === 'published' ? 'approved' : 'line'}">${esc(p.status)}</span></td><td>${p.status === 'published' ? `<button class="ghost" data-un="${p.id}">Unpublish</button>` : ''}</td></tr>`).join('')}</table>` : '<div class="empty">Nothing published yet. Approve a draft in AI Studio, then press “Publish to website”.</div>');
  main.onclick = async e => { const id = e.target.dataset?.un; if (!id) return; try { await api(`publications/${id}/unpublish`, { method: 'POST' }); toast('Unpublished'); site(); } catch (x) { fail(x); } };
}

/* ---------- Settings ---------- */
async function settings() {
  const [c, u, g, sg, wt, sel] = await Promise.all([api('ai/config'), api('ai/usage'), api('glossary'), api('style-guide'), api('weights'), api('selection/settings')]);
  const money = v => v == null ? '—' : '$' + (+v).toFixed(4);
  main.innerHTML = `<h2 class="sec">AI provider <span class="mut">OpenAI-compatible, e.g. OpenRouter</span></h2><div class="card"><form id="cf" class="row">
  <label class="mut">Base URL <input type="text" name="base_url" value="${esc(c.base_url)}" style="width:260px"></label><label class="mut">Model <input type="text" name="model" value="${esc(c.model)}" style="width:230px"></label>
  <label class="mut">$/M in <input name="price_in" type="number" step="any" value="${c.price_in}" style="width:76px"></label><label class="mut">$/M out <input name="price_out" type="number" step="any" value="${c.price_out}" style="width:76px"></label>
  <label class="mut">max out tokens (single draft) <input name="max_tokens" type="number" value="${c.max_tokens}" style="width:76px"></label><label class="mut">max out tokens (both editions) <input name="max_tokens_bundle" type="number" value="${c.max_tokens_bundle}" style="width:84px"></label><button class="pri">Save</button></form>
  <p class="mut" id="est">One structured request per story produces both editions. Typical output is about 6,000–9,000 tokens, roughly ${c.price_out ? '$' + (7500 * c.price_out / 1e6).toFixed(3) : 'unknown cost (set the price)'} per story on this model. The model is never changed automatically.</p>
  <p class="mut" id="credit">Checking OpenRouter credit…</p>
  <p class="mut">API key: <b style="color:${c.key_configured ? 'var(--ok)' : 'var(--red)'}">${c.key_configured ? 'present in server .env' : 'NOT set — add OPENROUTER_API_KEY to .env and restart the server and worker'}</b> · price source: ${esc(c.pricing_source)}. The model never changes unless you change it here.</p>
  <div class="row"><button id="pr">Fetch current price for this model</button><button id="ts">Test connection (1 small call)</button><span id="tr" class="mut"></span></div></div>
  <h2 class="sec">AI usage <span class="mut">measured from provider responses</span></h2><div class="card mut">${u.totals.calls || 0} calls · ${u.totals.ok || 0} ok · ${u.totals.failed || 0} failed · ${u.totals.tin || 0} in / ${u.totals.tout || 0} out tokens · cost ${money(u.totals.cost)} · ${u.drafts} drafts${u.drafts && u.totals.cost ? ` · ~${money(u.totals.cost / u.drafts)}/draft` : ''}
  <table>${u.recent.map(r => `<tr><td>${nst(r.at)}</td><td>${esc(r.purpose)}</td><td>${esc(r.model)}</td><td>${r.ok ? 'ok' : '<span style="color:var(--red)">' + esc(r.error) + '</span>'}</td><td>${r.tokens_in ?? ''}/${r.tokens_out ?? ''}</td><td>${money(r.cost)} ${esc(r.cost_source || '')}</td></tr>`).join('')}</table></div>
  <h2 class="sec">Hourly selection</h2><form id="sf" class="row"><label class="mut">window (min) <input name="select_window_min" type="number" min="5" value="${sel.effective.windowMin}" style="width:70px"></label><label class="mut">grace after close (min) <input name="select_grace_min" type="number" min="0" value="${sel.effective.graceMin}" style="width:70px"></label><label class="mut">min score <input name="select_min_score" type="number" min="0" max="100" value="${sel.effective.minScore}" style="width:64px"></label><label class="mut">min sources <input name="select_min_sources" type="number" min="1" value="${sel.effective.minSources}" style="width:60px"></label><label class="mut">ignore stories older than (h) <input name="select_lateness_h" type="number" min="0" value="${sel.effective.latenessH}" style="width:64px"></label>
    <label class="mut"><input type="checkbox" name="select_auto_draft" ${sel.effective.autoDraft ? 'checked' : ''}> automatically request the two editions for each pick (1 AI request per hour at most)</label><button class="pri">Save</button></form>
  <p class="mut">If no story reaches the threshold in a window, nothing is selected for that hour.</p>
  <h2 class="sec">Ranking weights</h2><form id="wf" class="row">${Object.entries(wt.weights).map(([k, x]) => `<label class="mut">${k} <input name="${k}" type="number" min="0" max="100" value="${x}" style="width:64px"></label>`).join('')}<button class="pri">Save weights</button></form>
  <h2 class="sec">Glossary <span class="mut">English → Nepali, enforced in prompts and checked</span></h2><form id="gf" class="row"><input type="text" name="en" placeholder="English term"><input type="text" name="ne" placeholder="नेपाली"><button class="pri">Add / update</button></form>
  <table>${g.map(x => `<tr><td>${esc(x.en)}</td><td>${esc(x.ne)}</td><td><button class="ghost" data-gd="${x.id}">Delete</button></td></tr>`).join('') || '<tr><td class="mut">Empty</td></tr>'}</table>
  <h2 class="sec">Editorial style guide</h2><textarea id="sg" rows="6" style="width:100%;font:inherit">${esc(sg.text)}</textarea><div class="row" style="margin-top:8px"><button id="sgs" class="pri">Save style guide</button></div>`;
  api('ai/credit').then(r => { $('#credit').innerHTML = r.error ? `OpenRouter credit: <span style="color:var(--red)">${esc(r.error)}</span>` : `OpenRouter says: model <b>${esc(r.model)}</b> · credits $${r.credits ?? '?'} · used $${r.usage ?? '?'}${r.remaining != null ? ` · <b style="color:${r.remaining > 0.05 ? 'var(--ok)' : 'var(--red)'}">remaining $${r.remaining}</b>` : ''}${r.free_tier ? ' · <b>free tier</b>' : ''}${r.remaining != null && r.remaining <= 0.01 ? ' — generation will fail until credit is added' : ''}`; }).catch(() => {});
  const form = (sel, fn) => $(sel).onsubmit = async e => { e.preventDefault(); try { await fn(Object.fromEntries(new FormData(e.target))); } catch (x) { fail(x); } };
  form('#cf', async b => { await api('ai/config', { method: 'PUT', body: b }); toast('Saved'); settings(); });
  form('#sf', async b => { await api('selection/settings', { method: 'PUT', body: { ...Object.fromEntries(Object.entries(b).filter(([k]) => k !== 'select_auto_draft')), select_auto_draft: 'select_auto_draft' in b } }); toast('Selection settings saved'); });
  form('#wf', async b => { await api('weights', { method: 'PUT', body: b }); toast('Weights saved'); });
  form('#gf', async b => { await api('glossary', { method: 'POST', body: b }); settings(); });
  $('#pr').onclick = async () => { try { await api('ai/pricing', { method: 'POST' }); settings(); } catch (x) { fail(x); } };
  $('#ts').onclick = async () => { try { $('#tr').textContent = 'Calling…'; const r = await api('ai/test', { method: 'POST' }); $('#tr').innerHTML = r.ok ? `<b style="color:var(--ok)">Works</b> (${esc(r.model)})` : `<b style="color:var(--red)">Failed:</b> ${esc(r.error)}`; } catch (x) { fail(x); } };
  $('#sgs').onclick = async () => { try { await api('style-guide', { method: 'PUT', body: { text: $('#sg').value } }); toast('Saved'); } catch (x) { fail(x); } };
  main.onclick = async e => { if (e.target.dataset.gd) { try { await api('glossary/' + e.target.dataset.gd, { method: 'DELETE' }); settings(); } catch (x) { fail(x); } } };
}

/* ---------- Logs ---------- */
async function logs() { const l = await api('logs'); main.innerHTML = '<h2 class="sec">System logs</h2>' + (l.length ? `<table>${l.map(r => `<tr><td class="mut">${nst(r.at)}</td><td>${esc(r.kind)}</td><td>${esc(r.detail)}</td></tr>`).join('')}</table>` : '<div class="empty">No events yet.</div>'); main.onclick = null; }

/* ---------- router & header ---------- */
/* ---------- Website pipeline (per-edition queue) ---------- */
const STATE = { source_not_enabled: ['source needed', 'Full-text retrieval is off for this publisher'], source_restricted: ['source restricted', ''], source_unavailable: ['source unavailable', ''], insufficient_source: ['insufficient source', ''], brief_not_permitted: ['insufficient source', 'only a short source; briefs are not allowed by policy'], validation_failed: ['validation failed', ''], duplicate_pending: ['awaiting review', 'possible duplicate'], source_updated: ['awaiting review', 'source updated'], publication_refused: ['awaiting review', 'publication refused'], awaiting_review: ['eligible to publish', 'generated, waiting for an editor'], generation_failed: ['generation failed', ''], published: ['published', ''] };
const STAGE = { fetching_source: 'fetching source', generating: 'generating', validating: 'validating', caption: 'composing caption' };
const stateOf = j => (j.status === 'generating' ? [STAGE[j.stage] || 'generating', ''] : j.status === 'queued' ? [j.last_error ? 'waiting to retry' : 'queued', ''] : STATE[j.reason_code] || [j.status, '']);
const ctx_rel = rel;
async function pipeline() {
  const [r, es, mt] = await Promise.all([api('pipeline'), api('editorial/settings'), api('pipeline/metrics')]), dur = v => (v == null ? '—' : v < 90 ? Math.round(v) + ' s' : v < 5400 ? (v / 60).toFixed(1) + ' min' : (v / 3600).toFixed(1) + ' h'), st = x => `${dur(x.median)} <span class="mut">(p95 ${dur(x.p95)}, n=${x.n})</span>`, badge = j => { const [label] = stateOf(j); return `<span class="pill ${j.status === 'published' ? 'working' : j.status === 'failed' || j.reason_code === 'validation_failed' ? 'failing' : j.status === 'needs_review' ? 'drafting' : ''}">${esc(label)}</span>`; };
  main.innerHTML = `<h2 class="sec">Website pipeline <span class="mut">every new story → Nepali + English, written independently</span></h2>
  <div class="card row"><label><input type="checkbox" id="ap" ${r.auto_publish ? 'checked' : ''}> Publish eligible stories automatically (stories that arrive after this is switched on)</label>
  <span class="mut">${Object.entries(r.counts).map(([k, v]) => `${esc(k)}: ${v}`).join(' · ') || 'no jobs yet'}</span></div>
  <div class="card" id="speed"><div class="side-h">Speed — last ${mt.window_hours} h <span class="mut">worker heartbeat ${mt.worker_heartbeat_age_s == null ? 'never' : mt.worker_heartbeat_age_s + ' s ago'}${mt.worker_heartbeat_age_s > 60 ? ' <b style="color:var(--red)">· worker may be stopped</b>' : ''}</span></div>
    <div class="row mut" style="gap:18px;flex-wrap:wrap"><span>Backlog: <b>${mt.backlog.queued_due}</b> waiting to run · <b>${mt.backlog.generating}</b> running · ${mt.backlog.queued_waiting} resting after an error · oldest waiting ${dur(mt.backlog.oldest_due_age_s)}</span><span>Live: <b>${mt.published.count}</b> editions, last ${mt.published.last_at ? esc(ctx_rel(mt.published.last_at)) : '—'}</span><span>Held: ${mt.backlog.needs_review}</span></div>
    <table style="margin-top:8px"><tr><th>Stage</th><th>Median</th></tr><tr><td>Detected → live (end to end)</td><td>${st(mt.published.detection_to_publication_s)}</td></tr><tr><td>Waiting in the queue</td><td>${st(mt.published.queue_wait_s)}</td></tr><tr><td>Source fetch + extraction</td><td>${st(mt.published.extract_s)}</td></tr><tr><td>AI writing</td><td>${st(mt.published.generate_s)}</td></tr><tr><td>Validation</td><td>${st(mt.published.validate_s)}</td></tr><tr><td>Publishing</td><td>${st(mt.published.publish_s)}</td></tr></table>
    <div class="mut" style="margin-top:6px">Outcomes: ${mt.outcomes.published} published · ${mt.outcomes.needs_review} held · ${mt.outcomes.failed} failed · ${mt.outcomes.retries} retries${Object.keys(mt.outcomes.by_reason).length ? ' · ' + Object.entries(mt.outcomes.by_reason).map(([k, v]) => `${esc(k)}: ${v}`).join(', ') : ''}</div>
    ${mt.providers.length ? `<table style="margin-top:8px"><tr><th>Provider / model</th><th>Calls</th><th>Succeeded</th><th>Latency (median, p95)</th></tr>${mt.providers.map(p => `<tr><td>${esc(p.provider)} / ${esc(p.model)}</td><td>${p.calls}</td><td>${Math.round((p.ok_rate ?? 0) * 100)}%</td><td>${dur(p.latency_s.median)} · ${dur(p.latency_s.p95)}</td></tr>`).join('')}</table>` : ''}</div>
  <details class="card"><summary><b>Editorial thresholds</b> <span class="mut">source quality and captions</span></summary><form id="es" class="row">
  <label class="mut">full article ≥ words <input name="min_full_words" type="number" value="${es.min_full_words}" style="width:70px"></label><label class="mut">brief ≥ words <input name="min_brief_words" type="number" value="${es.min_brief_words}" style="width:70px"></label><label class="mut">brief ≥ sentences <input name="min_brief_sentences" type="number" value="${es.min_brief_sentences}" style="width:60px"></label>
  <label class="mut">caption retries <input name="caption_regen_max" type="number" value="${es.caption_regen_max}" style="width:60px"></label><label class="mut"><input name="require_corroboration" type="checkbox" ${es.require_corroboration ? 'checked' : ''}> need 2 sources</label><label class="mut"><input name="edition_allow_limited" type="checkbox" ${es.edition_allow_limited ? 'checked' : ''}> allow automatic short briefs</label><button>Save</button></form></details>
  ${r.jobs.length ? `<table><tr><th>Story</th><th>Edition</th><th>State</th><th>Tries</th><th>Detail</th><th></th></tr>${r.jobs.map(j => `<tr><td><a href="#/story/${j.cluster_id}">${esc((j.title || '').slice(0, 70))}</a></td><td>${j.lang === 'ne' ? 'नेपाली' : 'English'}</td><td>${badge(j)}</td><td>${j.attempts}</td>
  <td class="mut">${esc(j.review_reason || j.last_error || stateOf(j)[1] || (j.published_at ? 'published ' + j.published_at.slice(0, 16) : ''))}</td><td>${['failed', 'needs_review', 'ready'].includes(j.status) ? `<button data-rt="${j.id}">Retry</button>` : ''}${j.draft_id && j.status !== 'published' ? ` <a href="#/studio">Open in Studio</a>` : ''}</td></tr>`).join('')}</table>` : '<p class="mut">Nothing queued.</p>'}`;
  main.onchange = async e => { if (e.target.id === 'ap') { try { await api('pipeline/auto', { method: 'POST', body: { on: e.target.checked } }); toast(e.target.checked ? 'Automatic publishing on' : 'Automatic publishing off'); pipeline(); } catch (x) { fail(x); } } };
  main.onsubmit = async e => { e.preventDefault(); const f = new FormData(e.target), b = {}; for (const k of ['min_full_words', 'min_brief_words', 'min_brief_sentences', 'caption_regen_max']) b[k] = +f.get(k); b.require_corroboration = f.has('require_corroboration'); b.edition_allow_limited = f.has('edition_allow_limited'); try { await api('editorial/settings', { method: 'PUT', body: b }); toast('Saved'); } catch (x) { fail(x); } };
  main.onclick = async e => { const id = e.target.dataset?.rt; if (!id) return; try { await api(`pipeline/${id}/retry`, { method: 'POST' }); pipeline(); } catch (x) { fail(x); } };
}

/* ---------- Social review (hourly pick) ---------- */
async function socialreview() {
  const [list, acc] = await Promise.all([api('social-drafts'), api('social/accounts')]), accounts = acc.accounts.filter(a => a.status === 'connected');
  main.innerHTML = `<h2 class="sec">Social review <span class="mut">nothing is posted until you approve it, per edition</span></h2>
  <p class="mut">${accounts.length ? '' : 'No social account is connected, so approved posts cannot be delivered yet. You can still review and approve.'} ${accounts.some(a => a.isTest) ? 'Test accounts post nothing.' : ''}</p>
  ${list.length ? list.map(d => `<div class="card" data-id="${d.id}"><div class="row"><b>${d.lang === 'ne' ? 'नेपाली' : 'English'}</b> <span class="pill ${d.approval_valid ? 'working' : d.status === 'rejected' ? 'failing' : 'drafting'}">${esc(d.approval_valid ? 'approved' : d.status === 'approved' ? 'approval outdated' : d.status)}</span> <span class="mut">${esc(d.title.slice(0, 80))}</span></div>
  <div class="row" style="align-items:flex-start;gap:14px">${d.graphic_id ? `<img src="/api/graphics/${d.graphic_id}/file" alt="graphic" style="max-width:180px;border-radius:6px">` : '<div class="mut">no graphic</div>'}
  <div style="flex:1"><textarea rows="7" style="width:100%" data-cap ${d.post_id ? 'disabled' : ''}>${esc(d.caption)}</textarea>${d.warnings.map(w => `<div class="${w.severity === 'error' ? 'err' : 'mut'}">${esc(w.message)}</div>`).join('')}
  ${d.targets.map(t => `<div class="mut">${esc(t.display_name)}${t.isTest ? ' (test, nothing posted)' : ''}: ${esc(t.status)} ${esc(t.error || '')}</div>`).join('')}</div></div>
  ${d.post_id ? '' : `<div class="row"><button data-act="save">Save caption</button><button data-act="approve">Approve</button><button data-act="reject">Reject</button><button data-act="regen">Regenerate</button>
  ${d.approval_valid && accounts.length ? `<select data-acct>${accounts.map(a => `<option value="${a.id}">${esc(a.display_name)}${a.isTest ? ' (test)' : ''}</option>`).join('')}</select><button data-act="deliver">Send to delivery queue</button>` : ''}</div>`}</div>`).join('') : '<p class="mut">No picks have social drafts yet. They appear after an hourly pick when both editions exist.</p>'}`;
  main.onclick = async e => {
    const act = e.target.dataset?.act; if (!act) return; const card = e.target.closest('[data-id]'), id = card.dataset.id;
    try {
      if (act === 'save') await api(`social-drafts/${id}`, { method: 'PUT', body: { caption: card.querySelector('[data-cap]').value } });
      else if (act === 'approve') { await api(`social-drafts/${id}/approve`, { method: 'POST' }); toast('Approved this exact content'); }
      else if (act === 'reject') await api(`social-drafts/${id}/reject`, { method: 'POST', body: { reason: prompt('Reason (optional)') || '' } });
      else if (act === 'regen') await api(`social-drafts/${id}/regenerate`, { method: 'POST' });
      else if (act === 'deliver') { await api(`social-drafts/${id}/deliver`, { method: 'POST', body: { account_ids: [+card.querySelector('[data-acct]').value] } }); toast('Queued for delivery'); }
      socialreview();
    } catch (x) { fail(x); }
  };
}

/* ---------- AI providers ---------- */
async function providers() {
  const r = await api('ai/providers'), open = new Set((main.dataset.open || '').split(',')), st = x => x.cooldown_until ? `cooling until ${esc(x.cooldown_until.slice(11, 19))}Z` : (x.last_error ? 'last error' : 'ready');
  main.innerHTML = `<h2 class="sec">AI providers <span class="mut">keys stay on the server; only the last 4 characters are ever shown</span></h2>
  <div class="card row"><label><input type="checkbox" id="fo" ${r.router.free_only ? 'checked' : ''}> Free-only mode (block every model not marked free)</label>
  <label class="mut">Daily spending cap $ <input id="cap" type="number" step="0.01" min="0" value="${r.router.daily_spend_cap_usd}" style="width:80px"></label><button id="sv">Save</button><span class="mut">spent today (known + assumed): $${r.spent_today}</span></div>
  ${r.providers.map(p => `<details class="card" data-p="${p.id}" ${open.has(p.id) ? 'open' : ''}><summary><b>${esc(p.label)}</b> <span class="pill ${p.enabled ? 'working' : ''}">${p.enabled ? 'enabled' : 'off'}</span> <span class="mut">${p.keys.length} key(s) · ${p.models.filter(m => m.enabled).length} model(s) on · today ${p.usage_today.requests} req / ${p.usage_today.tokens} tok</span></summary>
  <div class="row"><label><input type="checkbox" data-act="pen" ${p.enabled ? 'checked' : ''}> enabled</label><label class="mut">requests/day <input data-f="daily_requests" type="number" value="${p.daily_requests ?? ''}" placeholder="unlimited" style="width:90px"></label><label class="mut">tokens/day <input data-f="daily_tokens" type="number" value="${p.daily_tokens ?? ''}" placeholder="unlimited" style="width:110px"></label><button data-act="pbud">Save budgets</button><span class="mut">env var: ${esc(p.env_var)}</span></div>
  <table><tr><th>Key</th><th>Status</th><th>Last OK</th><th>Quota (provider-reported)</th><th></th></tr>${p.keys.map(k => `<tr data-k="${k.id}"><td>${esc(k.label || '')} <code>${esc(k.masked)}</code> <span class="mut">${k.source}</span></td><td>${st(k)}${k.last_error ? `<div class="mut">${esc(k.last_error.slice(0, 120))}</div>` : ''}</td><td class="mut">${esc((k.last_ok_at || '—').slice(0, 16))}</td>
  <td class="mut">${k.remaining_requests ?? 'unknown'} req · ${k.remaining_tokens ?? 'unknown'} tok</td><td><label><input type="checkbox" data-act="ken" ${k.enabled ? 'checked' : ''}> on</label> ${k.source === 'db' ? '<button data-act="kdel">Delete</button>' : ''}</td></tr>`).join('') || '<tr><td colspan="5" class="mut">No key. Add one below or set the env var.</td></tr>'}</table>
  <div class="row"><input type="password" data-f="newkey" placeholder="paste API key (saved encrypted, never shown again)" autocomplete="off" style="width:300px"><input data-f="newlabel" placeholder="label" style="width:110px"><button data-act="kadd">Add key</button></div>
  <table><tr><th>Model</th><th>Free?</th><th>Status</th><th>Lang</th><th></th></tr>${p.models.map(m => `<tr data-m="${m.id}"><td><code>${esc(m.model)}</code></td><td><label><input type="checkbox" data-act="mfree" ${m.is_free ? 'checked' : ''}> free</label></td><td>${st(m)}</td><td class="mut">${esc(m.langs)}</td><td><label><input type="checkbox" data-act="men" ${m.enabled ? 'checked' : ''}> on</label> <button data-act="mdel">Remove</button></td></tr>`).join('') || '<tr><td colspan="5" class="mut">No model yet. Add one you have checked on your own account.</td></tr>'}</table>
  <div class="row"><input data-f="newmodel" placeholder="model id exactly as the provider lists it" style="width:300px"><label class="mut"><input type="checkbox" data-f="newfree"> I verified it is free for my account</label><button data-act="madd">Add model</button>
  ${p.keys.length ? `<select data-f="tkey">${p.keys.map(k => `<option value="${k.id}">${esc(k.label || k.masked)}</option>`).join('')}</select><input data-f="tmodel" placeholder="model to test (optional)" style="width:200px"><button data-act="test">Test connection</button>` : ''}</div><div class="mut" data-out></div></details>`).join('')}`;
  const keep = () => { main.dataset.open = [...main.querySelectorAll('details[open]')].map(d => d.dataset.p).join(','); };
  main.onclick = async e => {
    const act = e.target.dataset?.act, card = e.target.closest('details'); if (e.target.id === 'sv') { try { await api('ai/router', { method: 'PUT', body: { free_only: $('#fo').checked, daily_spend_cap_usd: +$('#cap').value } }); toast('Saved'); keep(); providers(); } catch (x) { fail(x); } return; }
    if (!act || act === 'pen' || act === 'ken' || act === 'men' || act === 'mfree') return; const p = card.dataset.p, f = n => card.querySelector(`[data-f=${n}]`), row = e.target.closest('tr');
    try {
      if (act === 'pbud') await api(`ai/providers/${p}`, { method: 'PUT', body: { daily_requests: f('daily_requests').value || null, daily_tokens: f('daily_tokens').value || null } });
      else if (act === 'kadd') { await api(`ai/providers/${p}/keys`, { method: 'POST', body: { key: f('newkey').value, label: f('newlabel').value } }); f('newkey').value = ''; }
      else if (act === 'kdel') { if (!confirm('Delete this key?')) return; await api(`ai/keys/${row.dataset.k}`, { method: 'DELETE' }); }
      else if (act === 'madd') await api(`ai/providers/${p}/models`, { method: 'POST', body: { model: f('newmodel').value, is_free: f('newfree').checked } });
      else if (act === 'mdel') await api(`ai/models/${row.dataset.m}`, { method: 'DELETE' });
      else if (act === 'test') { const o = await api(`ai/providers/${p}/test`, { method: 'POST', body: { key_id: +f('tkey').value, model: f('tmodel').value || null } }); card.querySelector('[data-out]').textContent = (o.listed ? `${o.listed.length} models visible. ` : 'Model list not available. ') + (o.modelListed === false ? 'That model is NOT in the list. ' : '') + (o.ping ? (o.ping.ok ? 'Test request OK.' : `Test request failed (${o.ping.kind}): ${o.ping.error}`) : ''); return; }
      keep(); providers();
    } catch (x) { fail(x); }
  };
  main.onchange = async e => {
    const act = e.target.dataset?.act, card = e.target.closest('details'); if (!act || !card) return; const p = card.dataset.p, row = e.target.closest('tr'), on = e.target.checked;
    try {
      if (act === 'pen') await api(`ai/providers/${p}`, { method: 'PUT', body: { enabled: on } }); else if (act === 'ken') await api(`ai/keys/${row.dataset.k}`, { method: 'PUT', body: { enabled: on } });
      else if (act === 'men') await api(`ai/models/${row.dataset.m}`, { method: 'PUT', body: { enabled: on } }); else if (act === 'mfree') await api(`ai/models/${row.dataset.m}`, { method: 'PUT', body: { is_free: on } }); else return;
      keep(); providers();
    } catch (x) { fail(x); }
  };
}

async function editorPage(id) { const m = await import('/admin/editor.js'); return m.editor({ api, esc, toast, fail, main, AUTH, rel, isrc, uploadAsset }, +id); }
const PAGES = { editor: editorPage, newsroom, news, story, design, site, publish, clusters, studio, sources, settings, logs, pipeline, socialreview, providers };
let lastHash = location.hash, reverting = false;
async function show() {
  if (reverting) { reverting = false; return; }
  if (window.__guard && !window.__guard()) { reverting = true; location.hash = lastHash; return; } // unsaved editor changes: stay unless confirmed
  lastHash = location.hash; if (window.__cleanup) { window.__cleanup(); window.__cleanup = null; }
  clearInterval(timer); clearTimeout(timer);
  const [, t0 = 'newsroom', arg] = location.hash.split('?')[0].split('/'), t = PAGES[t0] ? t0 : 'newsroom';
  document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('on', a.dataset.t === t || ((t === 'story' || t === 'design' || t === 'editor') && a.dataset.t === 'news')));
  main.onclick = main.onchange = main.onsubmit = null;
  try { await PAGES[t](arg); } catch (e) { if (e !== AUTH) main.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}
window.addEventListener('hashchange', show);
$('#gs').onsubmit = e => { e.preventDefault(); F.q = $('#gq').value.trim(); F.page = 1; F.view = 'latest'; if (location.hash === '#/news') show(); else location.hash = '#/news'; };
$('#fetchall').onclick = async () => { try { const r = await api('sources/fetch-all', { method: 'POST' }); toast(`Queued ${r.queued} sources — new stories appear within a minute`); } catch (x) { fail(x); } };
$('#out').onclick = () => api('logout', { method: 'POST' }).then(() => login()).catch(fail);
show();
