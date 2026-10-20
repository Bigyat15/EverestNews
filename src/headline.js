// Text identity used to decide whether a graphic still matches what an editor approved. Dependency-free so the worker can use it.
const J = s => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
// Website headline: the approved one, else the editor's edit, else the recommended option.
export const currentHeadline = d => (d.status === 'approved' ? d.final_headline : (d.edited_headline ?? J(d.headline_options)?.[d.rec_idx] ?? ''));
// compare the words only: highlight markers and spacing must not make a graphic look outdated
export const norm = t => String(t ?? '').replace(/\[\[|\]\]/g, '').replace(/\s+/g, ' ').trim();
// Bilingual-bundle drafts have their OWN graphic headline/description (never the website headline). Legacy drafts fall back to the website headline.
const part = (d, k) => (d.status === 'approved' ? J(d.final_json)?.[k] : J(d.edited_json)?.[k]) ?? d[k] ?? '';
export const graphicHeadline = d => part(d, 'graphic_headline');
export const graphicDescription = d => part(d, 'graphic_description');
export const graphicTexts = d => (d.bundle_id ? { h: graphicHeadline(d), s: graphicDescription(d) } : { h: currentHeadline(d), s: null });
export const isStale = (g, d) => {
  if (!d) return false; const t = graphicTexts(d);
  if (norm(g.headline_snapshot) !== norm(t.h)) return true;
  return t.s !== null && norm(g.subheadline_snapshot) !== norm(t.s);
};
// The story has ONE lead image (clusters.lead_asset_id). A graphic made with a different photo is outdated when that image changes.
export const imageChanged = (g, leadId) => leadId != null && (g.photo_asset_id ?? null) !== leadId;

// Identity of everything a reviewer approved for one social post. Any change (caption, graphic text, graphic, lead image, edition draft) yields a different hash, which voids the approval.
import { createHash } from 'node:crypto';
export const socialHash = (sd, draft, leadId) => createHash('sha256').update(JSON.stringify([sd.caption, sd.edition_draft_id, sd.graphic_id, leadId ?? null, graphicHeadline(draft), graphicDescription(draft), draft.status])).digest('hex');
