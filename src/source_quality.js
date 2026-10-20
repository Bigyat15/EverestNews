// Deterministic source-quality assessment. Word count alone never makes a source "full": an RSS summary can never be full text,
// a truncated or navigation-like text is not a complete article, and every threshold is an editorial setting.
import { db } from './db.js';
import { minFullWords } from './extract.js';

const setting = (k, d) => { const r = db.prepare('SELECT value FROM settings WHERE key=?').get(k); try { return r ? JSON.parse(r.value) : d; } catch { return d; } };
export const qualityCfg = () => ({ minFull: minFullWords(), minBrief: +setting('min_brief_words', 40), minSentences: +setting('min_brief_sentences', 2), requireCorroboration: setting('require_corroboration', false) === true, allowBrief: setting('edition_allow_limited', false) === true });
const TRUNC = /(\.\.\.|…|\[…\]|\[\.\.\.\]|read more|continue reading|थप पढ्नुहोस्|अझै पढ्नुहोस्|पूरा पढ्नुहोस्)\s*$/i;
const words = t => (String(t ?? '').match(/\S+/g) || []).length;

// src: { text, origin: 'extracted'|'feed_content'|'rss_summary', words }.  Returns { level: 'full'|'brief'|'insufficient', reasons, metrics }
export function assessSource(src, { sources = 1 } = {}, cfg = qualityCfg()) {
  const text = String(src.text ?? '').trim(), w = src.words ?? words(text), reasons = [], lines = text.split(/\n+/).filter(Boolean);
  const sentences = (text.match(/[^.!?।]+[.!?।]+(\s|$)/g) || []).length || (text ? 1 : 0), shortLines = lines.filter(l => words(l) < 6).length;
  const truncated = TRUNC.test(text), navLike = lines.length >= 4 && shortLines / lines.length >= 0.6, uniq = new Set(text.toLowerCase().split(/\s+/)).size;
  const metrics = { words: w, chars: text.length, origin: src.origin, sentences, lines: lines.length, truncated, navLike, uniqueWordRatio: w ? +(uniq / w).toFixed(2) : 0, sources };
  const done = (level) => ({ level, reasons, metrics });
  if (navLike) reasons.push('looks_like_navigation');
  if (truncated) reasons.push('truncated');
  if (cfg.requireCorroboration && sources < 2) reasons.push('needs_corroboration');
  if (w < cfg.minBrief) reasons.push('too_few_words');
  else if (sentences < cfg.minSentences) reasons.push('too_few_sentences');
  if (reasons.some(r => ['looks_like_navigation', 'needs_corroboration', 'too_few_words', 'too_few_sentences'].includes(r))) return done('insufficient');
  if (src.origin === 'rss_summary') { reasons.push('rss_summary_only'); return done('brief'); } // a summary is metadata, never the article
  if (truncated || w < cfg.minFull) { if (w < cfg.minFull) reasons.push('below_full_threshold'); return done('brief'); }
  return done('full');
}
