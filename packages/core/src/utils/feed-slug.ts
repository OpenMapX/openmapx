/**
 * Canonical validator for feed slugs (GTFS, MOTIS, etc.) that flow into
 * SQL identifiers and filesystem paths.
 *
 * Why strict: slugs are interpolated into raw SQL identifiers (`"gtfs_<slug>"`)
 * and temp-directory names. Accepting arbitrary strings would permit
 * SQL-identifier injection via embedded quotes and path traversal via `/`, `\`,
 * or `..` segments. This regex pins the shape to a single, safe form.
 */
const FEED_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export class InvalidFeedSlugError extends Error {
  constructor(slug: string) {
    super(
      `Invalid feed slug "${slug}": must be 1-63 chars, lowercase alphanumeric with underscores or hyphens, starting with a letter or digit`,
    );
    this.name = "InvalidFeedSlugError";
  }
}

/** Returns true if `slug` matches the canonical feed-slug form. */
export function isValidFeedSlug(slug: unknown): slug is string {
  return typeof slug === "string" && FEED_SLUG_RE.test(slug);
}

/** Throws `InvalidFeedSlugError` unless `slug` matches the canonical form. */
export function assertValidFeedSlug(slug: unknown): asserts slug is string {
  if (!isValidFeedSlug(slug)) {
    throw new InvalidFeedSlugError(String(slug));
  }
}

/**
 * Best-effort normalization of a human-supplied name into a valid slug.
 * Returns `null` if the result cannot be coerced into the canonical shape
 * (e.g. empty after stripping, or entirely non-alphanumeric).
 */
export function normalizeFeedSlug(input: string): string | null {
  const cleaned = input
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 63);
  if (!cleaned) return null;
  // Leading character must be alphanumeric per the canonical regex.
  const head = cleaned[0];
  if (!head || !/[a-z0-9]/.test(head)) return null;
  return isValidFeedSlug(cleaned) ? cleaned : null;
}
