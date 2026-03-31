import type { LoadedIntegrationMeta } from "@openmapx/core";

export interface PrivacyServiceRow {
  service: string;
  purpose: string;
  dataSent: string;
  country: string;
  privacy: string;
}

export interface AttributionRow {
  source: string;
  desc: string;
  license: string;
  licenseUrl?: string;
  url: string;
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
    enrichment: {
      key: "enrichment",
      labelEn: "Place Enrichment",
      labelDe: "Ortsinformationen",
    },
    "poi-search": {
      key: "poiSearch",
      labelEn: "Point of Interest Search",
      labelDe: "Interessenpunkt-Suche",
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
  enrichment: {
    heading: "Place Enrichment",
    headingDe: "Ortsinformationen",
  },
  "poi-search": {
    heading: "Point of Interest Search",
    headingDe: "Interessenpunkt-Suche",
  },
};

export function generatePrivacySectionsFromManifests(
  integrations: LoadedIntegrationMeta[],
): { key: string; labelEn: string; labelDe: string; rows: PrivacyServiceRow[] }[] {
  const grouped = new Map<
    string,
    { key: string; labelEn: string; labelDe: string; rows: PrivacyServiceRow[] }
  >();

  for (const integration of integrations) {
    if (!integration.enabled || !integration.configured || !integration.privacy) continue;

    const domain = integration.domains[0] ?? "map-overlay";
    const sectionMeta = DOMAIN_TO_PRIVACY_SECTION[domain] ?? {
      key: domain,
      labelEn: domain,
      labelDe: domain,
    };

    if (!grouped.has(sectionMeta.key)) {
      grouped.set(sectionMeta.key, { ...sectionMeta, rows: [] });
    }

    const privacyEntries = Array.isArray(integration.privacy)
      ? integration.privacy
      : [integration.privacy];

    for (const p of privacyEntries) {
      grouped.get(sectionMeta.key)?.rows.push({
        service: p.service ?? integration.name,
        purpose: p.purpose,
        dataSent: p.dataSent,
        country: p.providerCountry,
        privacy: p.providerPrivacyUrl,
      });
    }
  }

  return Array.from(grouped.values()).filter((s) => s.rows.length > 0);
}

export function generateAttributionSectionsFromManifests(
  integrations: LoadedIntegrationMeta[],
): { heading: string; headingDe: string; rows: AttributionRow[] }[] {
  const grouped = new Map<string, { heading: string; headingDe: string; rows: AttributionRow[] }>();

  for (const integration of integrations) {
    if (!integration.enabled || !integration.configured || !integration.attribution?.length)
      continue;

    const domain = integration.domains[0] ?? "map-overlay";
    const sectionMeta = DOMAIN_TO_ATTRIBUTION_SECTION[domain] ?? {
      heading: domain,
      headingDe: domain,
    };

    const groupKey = sectionMeta.heading;
    if (!grouped.has(groupKey)) {
      grouped.set(groupKey, { ...sectionMeta, rows: [] });
    }

    for (const attr of integration.attribution) {
      if (attr.dynamic) continue; // Dynamic attributions fetched at render time
      grouped.get(groupKey)?.rows.push({
        source: attr.name,
        desc: integration.description ?? "",
        license: attr.license,
        licenseUrl: attr.licenseUrl,
        url: attr.url,
      });
    }
  }

  return Array.from(grouped.values()).filter((s) => s.rows.length > 0);
}
