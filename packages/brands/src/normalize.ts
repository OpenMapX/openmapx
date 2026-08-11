/**
 * Lowercase, strip diacritics, collapse whitespace.
 *
 * Used identically at artifact-generation time (on `matchNames`, see
 * `generate.ts`) and at query time (in `matcher.ts`), so a query normalizes to
 * exactly the string a `matchName` was normalized to. Kept in one place so the
 * two can never drift out of sync with each other.
 */
export function normalize(input: string): string {
  return input.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();
}
