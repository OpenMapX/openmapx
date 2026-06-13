import type { SearchResult } from "@integrations/geocoding/types";

// Connectors/articles that must not count toward query coverage (EN + DE).
const STOPWORDS = new Set([
  "in",
  "im",
  "at",
  "of",
  "on",
  "the",
  "a",
  "an",
  "der",
  "die",
  "das",
  "den",
  "dem",
  "des",
  "mit",
  "with",
  "near",
  "nearby",
  "around",
  "ohne",
  "without",
  "and",
  "or",
  "und",
  "oder",
  "meiner",
  "meine",
  "mein",
  "my",
  "me",
  "zur",
  "zum",
  "la",
  "le",
]);

const CONFIDENT_COVERAGE = 0.6;

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "") // strip diacritics (ä → a, ö → o, …)
    .replace(/[^\p{L}\p{N}\s]/gu, " "); // punctuation → space
}

function significantTokens(s: string): string[] {
  return normalize(s)
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

/**
 * Whether a geocode result confidently answers the query — i.e. its label
 * accounts for most of what the user typed, so navigating straight to it is
 * safe. Provider-agnostic and language-agnostic: `SearchResult.confidence` is
 * unreliable (Photon hardcodes 1, Nominatim reports popularity), so we measure
 * query→label token coverage with substring matching (covers German compounds
 * like "Hauptbahnhof" ⊇ "bahnhof"). Used to gate auto-navigation on submit;
 * a low-coverage match (e.g. "Glen Park, Indiana" for "Park mit See in Aachen")
 * is rejected so the search falls back to NL instead of teleporting.
 */
export function isConfidentPlaceMatch(query: string, result: SearchResult): boolean {
  const qTokens = significantTokens(query);
  if (qTokens.length === 0) return false;
  const haystack = normalize(`${result.label} ${result.rawCategory ?? ""}`);
  const covered = qTokens.filter((t) => haystack.includes(t)).length;
  return covered / qTokens.length >= CONFIDENT_COVERAGE;
}
