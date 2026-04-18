/**
 * Country-aware address formatting using @fragaria/address-formatter.
 *
 * House number position (before/after street name), postcode placement, and
 * whether the state/region is shown vary by country. The underlying formatter
 * picks a template from `country_code`, so the whitelist below intentionally
 * keeps `state` + `country_code` to support US-style "San Francisco, CA 94102"
 * output globally — `state_code` is derived from `state` + `country_code`
 * automatically by the formatter.
 */

import formatter from "@fragaria/address-formatter";

export interface AddressComponents {
  house_number?: string;
  road?: string;
  city?: string;
  town?: string;
  village?: string;
  municipality?: string;
  county?: string;
  state?: string;
  postcode?: string;
  country?: string;
  country_code?: string;
}

interface AddressFormatter {
  format(components: Record<string, string>, options: Record<string, unknown>): string[];
}

// Only these keys are forwarded to the underlying formatter. Nominatim returns
// many extra fields (ISO3166-2-lvl4 → "DE-BE", amenity/bar/shop POI names,
// suburb, borough, neighbourhood, …) that the OpenCage formatter doesn't
// recognize; unrecognized keys get dumped into the `attention` placeholder
// which prefixes the output. Whitelisting keeps the rendered line close to
// what Google Maps shows: "{road} {house_number}, {postcode} {city}, {country}".
const FORMATTER_KEYS = [
  "road",
  "house_number",
  "postcode",
  "city",
  "state",
  "country",
  "country_code",
] as const;

function runFormatter(
  components: AddressComponents,
  options: { appendCountry: boolean },
): string[] {
  // Collapse Nominatim's city fallbacks (town/village/municipality) into `city`
  // so the template's {{{city}}} slot renders for rural addresses too.
  const city = components.city ?? components.town ?? components.village ?? components.municipality;

  const source: Record<string, string | undefined> = { ...components, city };

  const clean: Record<string, string> = {};
  for (const key of FORMATTER_KEYS) {
    const v = source[key];
    if (typeof v === "string" && v.length > 0) clean[key] = v;
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
