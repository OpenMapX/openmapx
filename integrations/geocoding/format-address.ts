/**
 * Country-aware address formatting using @fragaria/address-formatter.
 *
 * House number position (before/after street name), postcode placement, and
 * other conventions vary by country. This module wraps the formatter with
 * proper TypeScript types so call sites stay clean.
 */

import formatter from "@fragaria/address-formatter";

export interface AddressComponents {
  house_number?: string;
  road?: string;
  neighbourhood?: string;
  suburb?: string;
  city?: string;
  town?: string;
  village?: string;
  county?: string;
  state?: string;
  postcode?: string;
  country?: string;
  country_code?: string;
  // POI / landmark fields. The underlying OpenCage templates accept these
  // as aliases and position them correctly per country (e.g. before the
  // street in most templates), so landmark queries like "Brandenburg Gate"
  // don't lose the feature name when there's no road component.
  attraction?: string;
  tourism?: string;
  historic?: string;
  amenity?: string;
  leisure?: string;
  building?: string;
  shop?: string;
}

interface AddressFormatter {
  format(components: AddressComponents, options: Record<string, unknown>): string[];
}

function runFormatter(
  components: AddressComponents,
  options: { appendCountry: boolean },
): string[] {
  // The underlying formatter stringifies `undefined` values into the output
  // instead of skipping them — strip empty keys first so callers can pass
  // optional fields inline without guarding each one.
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(components)) {
    if (typeof v === "string" && v.length > 0) clean[k] = v;
  }
  return (formatter as unknown as AddressFormatter)
    .format(clean, { output: "array", ...options })
    .filter(Boolean);
}

/**
 * Format address components into a single-line, country-appropriate string.
 * House number position is determined by `country_code` (e.g. DE → after street,
 * US/AU → before street). Falls back to street-first when country is unknown.
 */
export function formatAddress(
  components: AddressComponents,
  options: { appendCountry?: boolean } = {},
): string {
  return runFormatter(components, { appendCountry: options.appendCountry ?? true }).join(", ");
}
