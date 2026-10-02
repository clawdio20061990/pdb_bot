import type { VenueOption } from '../types.js';
import type { InteractionResult, PlaceCitation } from './gemini.js';

/**
 * Which Google Maps places a grounded answer is about.
 * Normally these are the place_citation annotations; but Gemini regularly returns the answer without
 * annotations (seen in ~1/3 of suggestion calls), so we fall back to the places the Maps tool returned
 * that the answer text actually mentions.
 */

const REVIEW = /^review of /i;

/** "X - Google Maps" -> "X" (also drops a "Review of " prefix and a trailing "(…)" gloss). */
export function placeLabel(name: string): string {
  const base = name.replace(REVIEW, '').replace(/\s*[-–|]\s*Google Maps\s*$/i, '').trim();
  const noGloss = base.replace(/\s*\([^)]*\)\s*$/, '').trim();
  return noGloss.length >= 3 ? noGloss : base;
}

/** Lowercase, strip diacritics (incl. Polish ł) and punctuation, so "Gdańsk" matches "Gdansk". */
export function normalize(text: string): string {
  return ` ${text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[łŁ]/g, 'l')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()} `;
}

/**
 * Position of a place's name in the (normalized) answer. Long listing names ("Brovarnia Gdańsk I Restauracja i …")
 * are often shortened in the text, so word prefixes are tried too — but only distinctive ones (2+ words, 10+ chars),
 * otherwise "Rejsy w Sopocie…" would match "Rejsy w Gdańsku…".
 */
function mentionIndex(normalizedText: string, name: string): number {
  const words = normalize(placeLabel(name)).trim().split(' ').filter(Boolean);
  for (let n = words.length; n >= 1; n--) {
    const phrase = words.slice(0, n).join(' ');
    if (n < words.length && (n < 2 || phrase.length < 10)) break;
    const idx = normalizedText.indexOf(` ${phrase} `);
    if (idx >= 0) return idx;
  }
  return -1;
}

/** Source links to display right after a grounded answer (Google Maps attribution requirement). */
export function groundedSources(res: InteractionResult): PlaceCitation[] {
  if (res.citations.length) return res.citations;
  const text = normalize(res.text);
  const seen = new Set<string>();
  return res.mapsPlaces
    .filter((p) => !REVIEW.test(p.name))
    .map((p) => ({ p, idx: mentionIndex(text, p.name) }))
    .filter(({ p, idx }) => {
      const key = p.place_id ?? p.url;
      if (idx < 0 || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.idx - b.idx)
    .map(({ p }) => p);
}

/** One option per place (reviews share the place id), in order of first mention. */
export function placeOptions(res: InteractionResult, max = 5): VenueOption[] {
  const byPlace = new Map<string, { option: VenueOption; fromReview: boolean }>();
  for (const c of groundedSources(res)) {
    const key = c.place_id ?? c.url;
    const fromReview = REVIEW.test(c.name);
    const existing = byPlace.get(key);
    if (!existing || (existing.fromReview && !fromReview)) {
      byPlace.set(key, { option: { name: placeLabel(c.name), place_id: c.place_id }, fromReview });
    }
  }
  return [...byPlace.values()].slice(0, max).map((v) => v.option);
}

/**
 * The part of a multi-place answer that is about one place ("1. Name … 2. Name …").
 * Used to store facts about the place the organizer picked, without a second Maps call.
 */
export function blockAbout(text: string, option: VenueOption): string {
  const starts = [...text.matchAll(/^\s*\d+[.)]\s+/gm)].map((m) => m.index ?? 0);
  if (starts.length < 2) return text; // single place (or unnumbered): the whole answer is about it
  const blocks = starts.map((start, i) => text.slice(start, starts[i + 1] ?? text.length).trim());
  const wanted = normalize(option.name).trim();
  const match = blocks.find((b) => {
    const head = normalize(b.split('\n')[0] ?? '');
    return head.includes(wanted) || (wanted.length > 12 && head.includes(wanted.slice(0, 12)));
  });
  return match ?? text;
}

/** For a named-venue lookup: the place whose name best matches what the organizer typed. */
/**
 * Every cited place that really matches what the organizer typed. More than one means the name is
 * ambiguous (a chain with several addresses) and the organizer has to pick.
 */
export function matchingOptions(res: InteractionResult, typedName: string): VenueOption[] {
  const typed = normalize(typedName);
  const words = typed.split(' ').filter((w) => w.length >= 4);
  return placeOptions(res, 10).filter((o) => {
    const name = normalize(o.name);
    // A shared word is enough, so "Pizzeria Napoli" never resolves to some "Pizza Roma".
    return name.includes(typed.trim()) || typed.includes(name.trim()) || words.some((w) => name.includes(` ${w} `));
  });
}

export function bestMatch(res: InteractionResult, typedName: string): VenueOption | null {
  return matchingOptions(res, typedName)[0] ?? null;
}
