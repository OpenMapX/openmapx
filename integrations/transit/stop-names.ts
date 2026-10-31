import { diceSimilarity } from "@openmapx/core";
import { expandSearchQuery } from "@openmapx/integration-geocoding/query-expansion";

/** A platform or track designation and everything after it, e.g. "Gl.27-36", "Gleis 9". */
const PLATFORM_DESIGNATION =
  /(^|[^\p{L}])(gl|gleis|gleise|bstg|bussteig|steig|platform|track|quai|voie)(?![\p{L}]).*$/u;

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
  const words = expandSearchQuery(name)
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s*(\([^)]*\)|\[[^\]]*\])\s*/g, " ")
    .replace(PLATFORM_DESIGNATION, " ")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 1 && !GENERIC_STATION_WORDS.has(word));
  return [...new Set(words)].sort().join(" ");
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
