import z from "zod/v4";

/** Structured parts a feed/source id is derived from. The id is never hand-typed. */
export interface FeedIdParts {
  /** ISO 3166-1 alpha-2, lowercase. Omitted for global providers (e.g. ocm, osm). */
  country?: string;
  /** ISO 3166-2 subdivision code or city slug, lowercase (e.g. "by", "nw"). */
  subdivision?: string;
  /** Distinct feed/operator slug, lowercase alphanumeric (e.g. "sfoe", "dotnl", "bamberg"). */
  operator: string;
  /** Variant discriminator, lowercase alphanumeric (e.g. "flow", "pr", "truck"). */
  stream?: string;
}

const token = z.string().regex(/^[a-z0-9]+$/, "lowercase alphanumeric slug");

export const feedIdPartsSchema = z.object({
  country: z
    .string()
    .regex(/^[a-z]{2}$/, "ISO 3166-1 alpha-2 lowercase")
    .optional(),
  subdivision: token.optional(),
  operator: token,
  stream: token.optional(),
});

/** Postgres-table (after `-`→`_`) and Redis-key safe. */
export const feedIdSchema = z
  .string()
  .regex(
    /^[a-z0-9]+(-[a-z0-9]+)*$/,
    "lowercase slug, hyphen-separated, no leading/trailing/double hyphen",
  );

/** The single canonical derivation. Mirrors OpenConditions' feed-id scheme. */
export function deriveFeedId(parts: FeedIdParts): string {
  return [parts.country, parts.subdivision, parts.operator, parts.stream].filter(Boolean).join("-");
}

/** Throws on the first duplicate — feed ids must be globally unique across all domains
 * because they name a shared `poi_ingest` table and the global attribution map. */
export function assertUniqueFeedIds(ids: readonly string[]): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new Error(`duplicate feed id: "${id}"`);
    seen.add(id);
  }
}
