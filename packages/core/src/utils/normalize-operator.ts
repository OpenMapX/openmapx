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
