// integrations/hotels/match.ts
//
// Shared hotel name-matching helpers. The LiteAPI rate matcher (liteapi.ts
// pickBestHotel) and the Trip.com typeahead matcher (typeahead.ts
// pickKeywordMatch) must decide "is this candidate the same hotel as the query?"
// IDENTICALLY — otherwise the Tier-2 price badge and the Tier-1 deep link can
// resolve to different properties for the same place. Keep the rule here, once.

/** Lowercase, fold diacritics, collapse to single-spaced alphanumerics. */
export function normalizeName(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Word tokens (length ≥ 2) of a normalized name. */
export function tokenize(s: string): string[] {
  return normalizeName(s)
    .split(" ")
    .filter((t) => t.length >= 2);
}

/** Fraction of the query name's tokens the candidate must share (when neither
 *  name contains the other) to count as a name match. */
const MIN_TOKEN_OVERLAP = 0.6;

/**
 * Does the candidate name plausibly refer to the same hotel as the query?
 * Substring either way (exact/contained names) OR a high token overlap. Pure
 * substring is too strict: real OTA names append marketing words — Trip.com
 * returns "Windsor Palace Luxury Heritage Hotel since 1906 by Paradise Inn
 * Group" for a query of "Windsor Palace Hotel", where neither contains the
 * other but all query tokens are present.
 */
export function nameMatches(queryName: string, candidateName: string): boolean {
  const qn = normalizeName(queryName);
  const cn = normalizeName(candidateName);
  if (!qn || !cn) return false;
  if (cn.includes(qn) || qn.includes(cn)) return true;
  const qt = tokenize(queryName);
  if (qt.length === 0) return false;
  const ct = new Set(tokenize(candidateName));
  const shared = qt.filter((t) => ct.has(t)).length;
  return shared / qt.length >= MIN_TOKEN_OVERLAP;
}
