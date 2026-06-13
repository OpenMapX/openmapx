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

export const DOMAIN_TO_PRIVACY_SECTION: Record<
  string,
  { key: string; labelEn: string; labelDe: string }
> = {
  geocoding: { key: "geocoding", labelEn: "Geocoding", labelDe: "Geokodierung" },
  routing: { key: "routing", labelEn: "Routing", labelDe: "Routing" },
  transit: { key: "transit", labelEn: "Public Transit", labelDe: "Öffentlicher Nahverkehr" },
  "map-overlay": {
    key: "mapOverlays",
    labelEn: "Map Overlays",
    labelDe: "Kartenüberlagerungen",
  },
  "data-source": {
    key: "dataSources",
    labelEn: "Data Sources",
    labelDe: "Datenquellen",
  },
  "street-view": {
    key: "streetView",
    labelEn: "Street-Level Imagery",
    labelDe: "Straßenansicht",
  },
  photos: { key: "photos", labelEn: "Place Photos", labelDe: "Ortsfotos" },
  knowledge: {
    key: "knowledge",
    labelEn: "Place Knowledge",
    labelDe: "Ortswissen",
  },
  "poi-search": {
    key: "poiSearch",
    labelEn: "Point of Interest Search",
    labelDe: "Interessenpunkt-Suche",
  },
  weather: {
    key: "weather",
    labelEn: "Weather",
    labelDe: "Wetter",
  },
  reviews: {
    key: "reviews",
    labelEn: "Reviews",
    labelDe: "Bewertungen",
  },
  "live-transit": {
    key: "liveTransit",
    labelEn: "Live Transit",
    labelDe: "Live-Nahverkehr",
  },
  "gtfs-catalog": {
    key: "transitDataCatalogs",
    labelEn: "Transit Data Catalogs",
    labelDe: "Nahverkehrsdaten-Kataloge",
  },
  "flight-search": { key: "flights", labelEn: "Flights", labelDe: "Flüge" },
  "hotel-search": { key: "hotels", labelEn: "Hotels", labelDe: "Hotels" },
  "food-delivery": {
    key: "foodDelivery",
    labelEn: "Food Delivery",
    labelDe: "Essenslieferung",
  },
  "restaurant-menu": {
    key: "restaurantMenus",
    labelEn: "Restaurant Menus",
    labelDe: "Restaurant-Speisekarten",
  },
};

export const DOMAIN_TO_ATTRIBUTION_SECTION: Record<string, { heading: string; headingDe: string }> =
  {
    geocoding: {
      heading: "Map Data and Geocoding",
      headingDe: "Kartendaten und Geokodierung",
    },
    routing: { heading: "Routing", headingDe: "Routing" },
    transit: {
      heading: "Public Transit",
      headingDe: "Öffentlicher Nahverkehr",
    },
    "map-overlay": {
      heading: "Map Overlays and Data",
      headingDe: "Kartenüberlagerungen und Daten",
    },
    "data-source": {
      heading: "Data Sources",
      headingDe: "Datenquellen",
    },
    "street-view": {
      heading: "Street-Level Imagery",
      headingDe: "Straßenansicht",
    },
    photos: { heading: "Place Photos", headingDe: "Ortsfotos" },
    knowledge: {
      heading: "Place Knowledge",
      headingDe: "Ortswissen",
    },
    "poi-search": {
      heading: "Point of Interest Search",
      headingDe: "Interessenpunkt-Suche",
    },
    weather: {
      heading: "Weather",
      headingDe: "Wetter",
    },
    reviews: {
      heading: "Reviews",
      headingDe: "Bewertungen",
    },
    "live-transit": {
      heading: "Live Transit",
      headingDe: "Live-Nahverkehr",
    },
    "gtfs-catalog": {
      heading: "Transit Data Catalogs",
      headingDe: "Nahverkehrsdaten-Kataloge",
    },
    "flight-search": { heading: "Flights", headingDe: "Flüge" },
    "hotel-search": { heading: "Hotels", headingDe: "Hotels" },
    "food-delivery": {
      heading: "Food Delivery",
      headingDe: "Essenslieferung",
    },
    "restaurant-menu": {
      heading: "Restaurant Menus",
      headingDe: "Restaurant-Speisekarten",
    },
  };

const EXPOSURE_LABELS: Record<string, { en: string; de: string }> = {
  direct: { en: "Direct (browser)", de: "Direkt (Browser)" },
  mixed: { en: "Mixed", de: "Gemischt" },
  proxied: { en: "Proxied (server)", de: "Über Server (Proxy)" },
  "server-only": { en: "Server-only", de: "Nur Server" },
  "build-time": { en: "Build-time only", de: "Nur zur Build-Zeit" },
};

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
 * Domain that decides an integration's legal-table section heading. Exported so
 * the completeness checker (scripts/check-legal-tables.ts) can assert every
 * contributing domain has a real heading in {@link DOMAIN_TO_PRIVACY_SECTION}
 * and {@link DOMAIN_TO_ATTRIBUTION_SECTION} instead of silently falling back to
 * the raw, untranslated domain string.
 */
export function legalSectionDomain(integration: Pick<LoadedIntegrationMeta, "domains">): string {
  return integration.domains[0] ?? "map-overlay";
}

export function generatePrivacySectionsFromManifests(
  integrations: LoadedIntegrationMeta[],
  locale: string,
): { key: string; labelEn: string; labelDe: string; rows: PrivacyServiceRow[] }[] {
  const grouped = new Map<
    string,
    { key: string; labelEn: string; labelDe: string; rows: PrivacyServiceRow[] }
  >();

  for (const integration of integrations) {
    if (!integration.enabled) continue;

    const sources = integration.dataSources;
    if (!sources?.length) continue;

    const domain = legalSectionDomain(integration);
    const sectionMeta = DOMAIN_TO_PRIVACY_SECTION[domain] ?? {
      key: domain,
      labelEn: domain,
      labelDe: domain,
    };

    if (!grouped.has(sectionMeta.key)) {
      grouped.set(sectionMeta.key, { ...sectionMeta, rows: [] });
    }

    for (const ds of sources) {
      const service = ds.name || localized(integration, locale, "name") || integration.name;
      const exposure = ds.endUserExposure
        ? (EXPOSURE_LABELS[ds.endUserExposure]?.[locale === "de" ? "de" : "en"] ??
          ds.endUserExposure)
        : "";

      grouped.get(sectionMeta.key)?.rows.push({
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
  const grouped = new Map<string, { heading: string; headingDe: string; rows: AttributionRow[] }>();

  for (const integration of integrations) {
    if (!integration.enabled) continue;

    const sources = integration.dataSources;
    if (!sources?.length) continue;

    const domain = legalSectionDomain(integration);
    const sectionMeta = DOMAIN_TO_ATTRIBUTION_SECTION[domain] ?? {
      heading: domain,
      headingDe: domain,
    };

    const groupKey = sectionMeta.heading;
    if (!grouped.has(groupKey)) {
      grouped.set(groupKey, { ...sectionMeta, rows: [] });
    }

    const desc = localized(integration, locale, "description") || integration.description || "";

    for (const ds of sources) {
      grouped.get(groupKey)?.rows.push({
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
