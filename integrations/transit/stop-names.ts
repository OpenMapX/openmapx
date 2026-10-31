import { diceSimilarity } from "@openmapx/core";
import { expandSearchQuery } from "@openmapx/integration-geocoding/query-expansion";

/** A platform or track designation and everything after it, e.g. "Gl.27-36", "Gleis 9". */
const PLATFORM_DESIGNATION =
  /(^|[^\p{L}])(gl|gleis|gleise|bstg|bussteig|steig|platform|track|quai|voie)(?![\p{L}]).*$/u;

/**
 * The text with each closed bracketed part, "(...)" or "[...]", replaced by a
 * space. Unclosed brackets stay. One pass: once a bracket kind has no closing
 * partner left, later ones of that kind can't close either, so nothing is
 * scanned twice, unlike a pattern that retries from every opening bracket.
 */
export function withoutBracketedParts(
  text: string,
  pairs: readonly string[] = ["()", "[]"],
): string {
  const open = new Map(pairs.map((pair) => [pair[0], pair[1]]));
  const exhausted = new Set<string>();
  let out = "";
  let i = 0;
  while (i < text.length) {
    const close = open.get(text[i]);
    if (close && !exhausted.has(close)) {
      const end = text.indexOf(close, i + 1);
      if (end !== -1) {
        out += " ";
        i = end + 1;
        continue;
      }
      exhausted.add(close);
    }
    out += text[i];
    i++;
  }
  return out;
}

/** Words saying only that a stop is a station, as in "Köln Messe/Deutz Bf". */
const GENERIC_STATION_WORDS = new Set(["bahnhof", "station", "gare"]);

/**
 * Comparison key for a stop name, equal for the spellings sources use for one
 * stop: "Köln Hbf", "Köln, Hauptbahnhof" and "Hauptbahnhof Köln" share a key,
 * as do "Frankfurt(Main)Hbf" and "Frankfurt Hauptbahnhof". Abbreviations are
 * expanded, case, accents, punctuation and word order ignored, and
 * parenthesised qualifiers dropped, as place-to-stop linking already does.
 * Single letters are dropped too: they are mode prefixes, as in VBB's
 * "S+U Berlin Hauptbahnhof", not part of the stop's name. So are bracketed
 * and trailing platform designations ("München Hbf Gl.27-36",
 * "Berlin Hauptbahnhof [Gleis 1-8]"), which name a part of the stop, and
 * words saying only that it is a station ("Köln Messe/Deutz Bf"); "Hauptbahnhof"
 * is kept, since it tells a main station from other stops of a city.
 */
export function stopNameKey(name: string): string {
  const words = stopNameWords(name).filter((word) => !GENERIC_STATION_WORDS.has(word));
  return [...new Set(words)].sort().join(" ");
}

/**
 * A stop name's words in order, normalised as {@link stopNameKey} compares
 * them, but keeping the words that say the stop is a station.
 */
export function stopNameWords(name: string): string[] {
  return withoutBracketedParts(expandSearchQuery(name))
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(PLATFORM_DESIGNATION, " ")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 1);
}

/** How specific a stop name is: "Köln Breslauer Platz/Hbf" names more than "Köln Hbf". */
export function stopNameSpecificity(key: string): number {
  return key ? key.split(" ").length : 0;
}

/**
 * The key, among the stop-name keys on a place's board, of the place's main
 * stop: the stop the place was opened for when it is on the board, else the
 * one named like the place, else the most similarly named one, with ties going
 * to the stop with more departures.
 */
export function mainStopKey(
  placeName: string,
  rowsByKey: Map<string, number>,
  openedFor?: string,
): string | undefined {
  const openedKey = openedFor ? stopNameKey(openedFor) : undefined;
  if (openedKey && rowsByKey.has(openedKey)) return openedKey;
  const placeKey = stopNameKey(placeName);
  if (rowsByKey.has(placeKey)) return placeKey;
  let best: string | undefined;
  let bestScore = -1;
  let bestRows = -1;
  for (const [key, rows] of rowsByKey) {
    const score = diceSimilarity(key, placeKey);
    if (score > bestScore || (score === bestScore && rows > bestRows)) {
      best = key;
      bestScore = score;
      bestRows = rows;
    }
  }
  return best;
}
