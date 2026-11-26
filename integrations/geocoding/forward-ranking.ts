import {
  beforeFirst,
  isRailwayStationCategory,
  normalizeSearchTerm,
  type SearchResult,
} from "@openmapx/core";
import { expandSearchQuery } from "@openmapx/provider-kit/geocoding";

const STATION_WORDS = new Set(["hauptbahnhof", "bahnhof", "station", "centraal"]);
// An amenity or numbered address at a station is a different destination.
const OTHER_DESTINATIONS = new Set([
  "taxi",
  "parking",
  "parkplatz",
  "parkhaus",
  "garage",
  "carpark",
  "bus",
  "busstation",
  "police",
  "polizei",
  "fire",
  "feuerwehr",
  "gas",
  "petrol",
  "tankstelle",
]);

function tokens(text: string): string[] {
  return normalizeSearchTerm(expandSearchQuery(text)).split(" ").filter(Boolean);
}

export function isStationQuery(query: string): boolean {
  const words = tokens(query);
  return (
    words.some((word) => STATION_WORDS.has(word)) &&
    !words.some((word) => OTHER_DESTINATIONS.has(word) || /\d/.test(word))
  );
}

/** Retain names discovered by synonyms without replacing provider confidence/attribution. */
export function mergeForwardEvidence(first: SearchResult, duplicate: SearchResult): SearchResult {
  const aliases = [
    ...new Set([
      ...(first.aliases ?? []),
      ...(duplicate.aliases ?? []),
      ...(duplicate.name && duplicate.name !== first.name ? [duplicate.name] : []),
    ]),
  ];
  const localities = [...new Set([...(first.localities ?? []), ...(duplicate.localities ?? [])])];
  return {
    ...first,
    ...(aliases.length ? { aliases } : {}),
    ...(localities.length ? { localities } : {}),
  };
}

/**
 * Rank the combined synonym candidates, using names and actual settlements.
 * Display addresses are not match evidence: "Neusser Tor, Am Hauptbahnhof"
 * cannot establish that a taxi stand is the requested station in Neuss.
 * Confidence remains the provider's value; stable ties retain provider order.
 */
export function rankForwardResults(query: string, results: SearchResult[]): SearchResult[] {
  if (!isStationQuery(query)) return results;
  const words = tokens(query);
  const placeWords = words.filter((word) => !STATION_WORDS.has(word));
  const covers = (name: string[], required: string[]) =>
    required.every((word) => name.includes(word));
  const scored = results.map((result, index) => {
    // Older/other adapters can still supply a plain name as the first label segment.
    const names = [result.name ?? beforeFirst(result.label, ","), ...(result.aliases ?? [])].map(
      tokens,
    );
    const localities = (result.localities ?? []).map(tokens);
    const nameMatch = names.some((name) => covers(name, words));
    const complete =
      nameMatch ||
      names.some((name) => localities.some((locality) => covers([...name, ...locality], words)));
    const localityMatch =
      placeWords.length > 0 && localities.some((locality) => covers(locality, placeWords));
    const score: [number, number, number, number] = complete
      ? [
          1,
          Number(localityMatch),
          Number(isRailwayStationCategory(result.rawCategory)),
          Number(nameMatch),
        ]
      : [0, 0, 0, 0];
    return { result, score, index };
  });
  scored.sort(
    (a, b) =>
      b.score[0] - a.score[0] ||
      b.score[1] - a.score[1] ||
      b.score[2] - a.score[2] ||
      b.score[3] - a.score[3] ||
      a.index - b.index,
  );
  return scored.map(({ result }) => result);
}
