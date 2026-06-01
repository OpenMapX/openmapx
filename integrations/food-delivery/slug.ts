import type { DeliveryQuery } from "./types.js";

/** Shorthand for encodeURIComponent. */
export const enc = encodeURIComponent;

/** `name` (+ city), URL-encoded — for platforms with only a generic text search. */
export function term(q: DeliveryQuery): string {
  return enc([q.name, q.city].filter(Boolean).join(" ").trim());
}

/** Lowercase and strip combining diacritics (Münster → munster). */
export function foldDiacritics(input: string): string {
  return input.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/**
 * Slugify a place/city name the way Wolt and Lieferando do in their URL paths:
 * strip diacritics (Münster → munster, Düsseldorf → dusseldorf), lowercase,
 * collapse anything non-alphanumeric to single hyphens.
 */
export function slugify(input: string): string {
  return foldDiacritics(input)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Slug for restaurant/brand-page paths (Zomato, Talabat). Apostrophes are
 * dropped entirely rather than hyphenated, matching the platforms' own slugs:
 * "Karim's" → "karims" (not "karim-s"), "McDonald's" → "mcdonalds".
 */
export function brandSlug(input: string): string {
  return slugify(input.replace(/['’`]/g, ""));
}
