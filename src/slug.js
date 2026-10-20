// Stable, SEO-friendly article URLs: /<lang>/story/<id>[-latin-slug]. The id is authoritative; the slug is cosmetic.
export const slugify = h => String(h).normalize('NFKD').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 60).replace(/-+$/, '');
export const articlePath = p => { const s = slugify(p.headline); return `/${p.lang}/story/${p.id}${s.length >= 3 ? '-' + s : ''}`; };
