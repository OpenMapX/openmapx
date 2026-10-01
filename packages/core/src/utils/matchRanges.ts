import { matchKey } from "./searchSuggestion";

/** Half-open `[start, end)` offsets into the original label. */
export type MatchRange = readonly [start: number, end: number];

const WORD_CHARACTER = /[\p{L}\p{N}]/u;
const APOSTROPHE = /^['’ʼ`]$/u;

/**
 * The parts of `label` that the typed words start, for bolding in a list.
 * Matching ignores case and accents the same way search does ("cafe" bolds
 * "Café"), and only counts word starts, so "rewe" does not light up the middle
 * of "Brewery". Offsets refer to `label` itself, not to a normalized copy.
 */
export function matchRanges(label: string, query: string): MatchRange[] {
  const tokens = matchKey(query).split(" ").filter(Boolean);
  if (tokens.length === 0) return [];

  // Fold the label one code point at a time, remembering where each folded
  // character came from, so a match in the folded text maps back exactly.
  let folded = "";
  const origin: { start: number; end: number }[] = [];
  let offset = 0;
  for (const character of label) {
    const end = offset + character.length;
    // Apostrophes vanish, as in `matchKey`: "kings" marks "King's".
    const fold = APOSTROPHE.test(character)
      ? ""
      : character
          .normalize("NFKD")
          .replace(/\p{M}+/gu, "")
          .toLocaleLowerCase("und");
    for (const piece of fold) {
      folded += piece;
      for (let i = 0; i < piece.length; i += 1) origin.push({ start: offset, end });
    }
    offset = end;
  }

  const ranges: [number, number][] = [];
  for (const token of tokens) {
    for (let at = folded.indexOf(token); at !== -1; at = folded.indexOf(token, at + 1)) {
      if (at > 0 && WORD_CHARACTER.test(folded[at - 1])) continue;
      ranges.push([origin[at].start, origin[at + token.length - 1].end]);
      break;
    }
  }

  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  return merged;
}
