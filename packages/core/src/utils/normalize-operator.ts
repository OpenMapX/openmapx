const LEGAL_SUFFIX =
  /\b(gmbh|ag|kg|se|b\.?v\.?|n\.?v\.?|s\.?a\.?|s\.?r\.?l\.?|s\.?p\.?a\.?|ltd|inc|plc|co|oy|as|a\.?s\.?)\b/g;

/** Canonical match key for a charging network/operator name (or "" if empty). */
export function normalizeOperator(name: string | undefined): string {
  if (!name) return "";
  return name
    .toLowerCase()
    .replace(LEGAL_SUFFIX, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Do two operator keys refer to the same network?
 *
 * Equality is too strict for user-entered network names: a driver types "EnBW"
 * while the register carries "EnBW mobility+ AG und Co.KG" (key
 * `enbw mobility und`), so an exact comparison silently ignores the preference.
 * Compare leading whole words instead, in whichever direction is shorter, so
 * "enbw" matches "enbw mobility und" and "tesla" matches "tesla supercharger".
 *
 * Anchoring at the first word is deliberate — operator names lead with the
 * brand, and a floating substring would let "go" match "ewe go".
 */
export function operatorKeyMatches(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const aWords = a.split(" ");
  const bWords = b.split(" ");
  const [shorter, longer] = aWords.length <= bWords.length ? [aWords, bWords] : [bWords, aWords];
  return shorter.every((word, i) => longer[i] === word);
}

/** Does an operator key match any of the user's network keys? */
export function matchesAnyOperator(key: string, keys: Iterable<string> | undefined): boolean {
  if (!key || !keys) return false;
  for (const candidate of keys) {
    if (operatorKeyMatches(key, candidate)) return true;
  }
  return false;
}
