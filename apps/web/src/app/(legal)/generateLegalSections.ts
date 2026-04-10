import type { LoadedIntegrationMeta } from "@openmapx/core";

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
}

const DOMAIN_TO_PRIVACY_SECTION: Record<string, { key: string; labelEn: string; labelDe: string }> =
  {
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
  };

const DOMAIN_TO_ATTRIBUTION_SECTION: Record<string, { heading: string; headingDe: string }> = {
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
};

const EXPOSURE_LABELS: Record<string, { en: string; de: string }> = {
  direct: { en: "Direct (browser)", de: "Direkt (Browser)" },
  proxied: { en: "Proxied (server)", de: "Über Server (Proxy)" },
  "server-only": { en: "Server-only", de: "Nur Server" },
  "build-time": { en: "Build-time only", de: "Nur zur Build-Zeit" },
};

/**
 * Resolve a localized string from integration.strings dataSources array by index.
 */
function localizedDataSourceField(
  integration: LoadedIntegrationMeta,
  locale: string,
  index: number,
  field: string,
): string {
  const localeStrings = integration.strings?.[locale];
  if (!localeStrings) return "";

  const dsLocale = localeStrings.dataSources;
  if (!dsLocale) return "";

  if (Array.isArray(dsLocale)) {
    const entry = dsLocale[index] as Record<string, unknown> | undefined;
    const val = entry?.[field];
    return typeof val === "string" ? val : "";
  }

  const val = (dsLocale as Record<string, unknown>)[field];
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

export function generatePrivacySectionsFromManifests(
  integrations: LoadedIntegrationMeta[],
  locale: string,
): { key: string; labelEn: string; labelDe: string; rows: PrivacyServiceRow[] }[] {
  const grouped = new Map<
    string,
    { key: string; labelEn: string; labelDe: string; rows: PrivacyServiceRow[] }
  >();

  for (const integration of integrations) {
    if (!integration.enabled || !integration.configured) continue;

    const sources = integration.dataSources;
    if (!sources?.length) continue;

    const domain = integration.domains[0] ?? "map-overlay";
    const sectionMeta = DOMAIN_TO_PRIVACY_SECTION[domain] ?? {
      key: domain,
      labelEn: domain,
      labelDe: domain,
    };

    if (!grouped.has(sectionMeta.key)) {
      grouped.set(sectionMeta.key, { ...sectionMeta, rows: [] });
    }

    for (let i = 0; i < sources.length; i++) {
      const ds = sources[i];
      const service = ds.name || localized(integration, locale, "name") || integration.name;
      const exposure = ds.endUserExposure
        ? (EXPOSURE_LABELS[ds.endUserExposure]?.[locale === "de" ? "de" : "en"] ??
          ds.endUserExposure)
        : "";

      grouped.get(sectionMeta.key)?.rows.push({
        service,
        purpose:
          localizedDataSourceField(integration, locale, i, "purpose") ||
          localizedDataSourceField(integration, locale, i, "service") ||
          "",
        dataSent: localizedDataSourceField(integration, locale, i, "dataSent") || "",
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
    if (!integration.enabled || !integration.configured) continue;

    const sources = integration.dataSources;
    if (!sources?.length) continue;

    const domain = integration.domains[0] ?? "map-overlay";
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
      if (ds.dynamic) continue;
      grouped.get(groupKey)?.rows.push({
        source: ds.name,
        desc,
        license: ds.license,
        licenseUrl: ds.licenseUrl,
        url: ds.url,
        attributionHtml: ds.attribution,
        commercialUse: ds.commercialUse,
      });
    }
  }

  return Array.from(grouped.values()).filter((s) => s.rows.length > 0);
}
