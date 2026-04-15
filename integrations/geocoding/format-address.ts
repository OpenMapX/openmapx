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
  city?: string;
  town?: string;
  village?: string;
  county?: string;
  state?: string;
  postcode?: string;
  country?: string;
  country_code?: string;
}

interface AddressFormatter {
  format(components: AddressComponents, options: Record<string, unknown>): string[];
}

function runFormatter(
  components: AddressComponents,
  options: { appendCountry: boolean },
): string[] {
  return (formatter as unknown as AddressFormatter)
    .format(components, { output: "array", ...options })
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
