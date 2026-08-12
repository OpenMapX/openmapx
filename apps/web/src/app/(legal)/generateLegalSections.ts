import deCatalog from "@openmapx/i18n/locales/de.json";
import enCatalog from "@openmapx/i18n/locales/en.json";
import type { LoadedIntegrationMeta } from "@openmapx/integration-framework";

export interface PrivacyServiceRow {
  service: string;
  purpose: string;
  dataSent: string;
  country: string;
  privacy: string;
  endUserExposure?: string;
}

export interface AttributionRow {
  source: string;
  desc: string;
  license: string;
  licenseUrl?: string;
  url: string;
  attributionHtml?: string;
  commercialUse?: string;
  notes?: string;
}

/**
 * Maps an integration domain to its legal-table section key. The key indexes the
 * localized headings in the shared i18n catalog (`legal.privacySections.<key>`,
 * `legal.attributionSections.<key>`) — so the heading STRINGS live with every
 * other translation and are covered by `check-translations`' en/de parity check,
 * while only the structural domain→key mapping stays in code. Domains absent here
 * have no section heading; `scripts/check-legal-tables.ts` blocks that.
 */
export const DOMAIN_TO_SECTION_KEY: Record<string, string> = {
  geocoding: "geocoding",
  routing: "routing",
  transit: "transit",
  "map-overlay": "mapOverlays",
  "data-source": "dataSources",
  "street-level-imagery": "streetLevel",
  photos: "photos",
  knowledge: "knowledge",
  "poi-search": "poiSearch",
  "search-suggestions": "searchSuggestions",
  weather: "weather",
  reviews: "reviews",
  "live-transit": "liveTransit",
  "gtfs-catalog": "transitDataCatalogs",
  "flight-search": "flights",
  "ride-hailing": "rideHailing",
  "hotel-search": "hotels",
  "food-delivery": "foodDelivery",
  "restaurant-menu": "restaurantMenus",
};

/** The `legal` catalog sub-objects this module resolves headings + labels from. */
export interface LegalSectionStrings {
  privacySections: Record<string, string>;
  attributionSections: Record<string, string>;
  exposure: Record<string, string>;
}

// The generators run both in the Next.js pages (where next-intl is available)
// and in scripts/check-legal-tables.ts (a plain tsx script with no React
// runtime), so they can't use the next-intl `t()` API. Instead they read the
// same locale catalogs next-intl loads — keeping a single source of truth — and
// resolve by locale. `as unknown` bridges the JSON's literal-keyed type to the
// open Record shape these helpers index dynamically.
const LEGAL_STRINGS: Record<string, LegalSectionStrings> = {
  en: (enCatalog as unknown as { legal: LegalSectionStrings }).legal,
  de: (deCatalog as unknown as { legal: LegalSectionStrings }).legal,
};

/** Resolve the legal section strings for a locale, falling back to English. */
export function legalSectionStrings(locale: string): LegalSectionStrings {
  return LEGAL_STRINGS[locale] ?? LEGAL_STRINGS.en;
}

/**
 * Resolve a localized per-source string from `integration.strings[locale].dataSources`,
 * which is an object keyed by the manifest source's `sourceId` (NOT a positional
 * array — keying by sourceId is what makes the strings impossible to silently
 * misalign with the manifest when sources are added or reordered). Returns "" when
 * the locale, the dataSources map, the keyed entry, or the field is absent; the
 * completeness checker (scripts/check-legal-tables.ts) turns those empties — and any
 * accidental array shape — into commit-blocking errors.
 */
function localizedDataSourceField(
  integration: LoadedIntegrationMeta,
  locale: string,
  sourceId: string,
  field: string,
): string {
  const dsLocale = integration.strings?.[locale]?.dataSources;
  if (!dsLocale || typeof dsLocale !== "object" || Array.isArray(dsLocale)) return "";

  const entry = (dsLocale as Record<string, unknown>)[sourceId] as
    | Record<string, unknown>
    | undefined;
  const val = entry?.[field];
  return typeof val === "string" ? val : "";
}

function localized(integration: LoadedIntegrationMeta, locale: string, path: string): string {
  const localeStrings = integration.strings?.[locale];
  if (!localeStrings) return "";

  const parts = path.split(".");
  let current: unknown = localeStrings;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return "";
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === "string" ? current : "";
}

/**
 * Domain that decides an integration's legal-table section. Exported so the
 * completeness checker (scripts/check-legal-tables.ts) resolves the same
 * domain → {@link DOMAIN_TO_SECTION_KEY} → catalog heading chain the generators
 * use, instead of silently falling back to the raw, untranslated domain string.
 */
export function legalSectionDomain(integration: Pick<LoadedIntegrationMeta, "domains">): string {
  return integration.domains[0] ?? "map-overlay";
}

export function generatePrivacySectionsFromManifests(
  integrations: LoadedIntegrationMeta[],
  locale: string,
): { key: string; labelEn: string; labelDe: string; rows: PrivacyServiceRow[] }[] {
  // Headings are returned for both locales (the per-locale content.{en,de}.tsx
  // documents each pick their field); only row content + exposure follow `locale`.
  const en = legalSectionStrings("en");
  const de = legalSectionStrings("de");
  const strings = legalSectionStrings(locale);
  const grouped = new Map<
    string,
    { key: string; labelEn: string; labelDe: string; rows: PrivacyServiceRow[] }
  >();

  for (const integration of integrations) {
    if (!integration.enabled) continue;

    const sources = integration.dataSources;
    if (!sources?.length) continue;

    const domain = legalSectionDomain(integration);
    const key = DOMAIN_TO_SECTION_KEY[domain] ?? domain;

    if (!grouped.has(key)) {
      grouped.set(key, {
        key,
        labelEn: en.privacySections[key] ?? key,
        labelDe: de.privacySections[key] ?? key,
        rows: [],
      });
    }

    for (const ds of sources) {
      const service = ds.name || localized(integration, locale, "name") || integration.name;
      const exposure = ds.endUserExposure
        ? (strings.exposure[ds.endUserExposure] ?? ds.endUserExposure)
        : "";

      grouped.get(key)?.rows.push({
        service,
        purpose:
          localizedDataSourceField(integration, locale, ds.sourceId, "purpose") ||
          localizedDataSourceField(integration, locale, ds.sourceId, "service") ||
          "",
        dataSent: localizedDataSourceField(integration, locale, ds.sourceId, "dataSent") || "",
        country: ds.providerCountry,
        privacy: ds.providerPrivacyUrl,
        endUserExposure: exposure,
      });
    }
  }

  return Array.from(grouped.values()).filter((s) => s.rows.length > 0);
}

export function generateAttributionSectionsFromManifests(
  integrations: LoadedIntegrationMeta[],
  locale: string,
): { heading: string; headingDe: string; rows: AttributionRow[] }[] {
  // Headings are returned for both locales (content.{en,de}.tsx pick their field).
  const en = legalSectionStrings("en");
  const de = legalSectionStrings("de");
  const grouped = new Map<string, { heading: string; headingDe: string; rows: AttributionRow[] }>();

  for (const integration of integrations) {
    if (!integration.enabled) continue;

    const sources = integration.dataSources;
    if (!sources?.length) continue;

    const domain = legalSectionDomain(integration);
    const key = DOMAIN_TO_SECTION_KEY[domain] ?? domain;

    if (!grouped.has(key)) {
      grouped.set(key, {
        heading: en.attributionSections[key] ?? key,
        headingDe: de.attributionSections[key] ?? key,
        rows: [],
      });
    }

    const desc = localized(integration, locale, "description") || integration.description || "";

    for (const ds of sources) {
      grouped.get(key)?.rows.push({
        source: ds.name,
        desc,
        license: ds.license,
        licenseUrl: ds.licenseUrl,
        url: ds.url,
        attributionHtml: ds.attribution,
        commercialUse: ds.commercialUse,
        notes: ds.notes,
      });
    }
  }

  return Array.from(grouped.values()).filter((s) => s.rows.length > 0);
}
