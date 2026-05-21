import type { DataSourceAttribution, DataSourceDetail, DataSourceResult } from "@openmapx/core";
import type { EvChargingStation, EvChargingStatus } from "@openmapx/mobility-core/ev-charging";
import type { OcmDataProvider, OcmPoi } from "./ocm-types.js";
import { mapStationToDetail, mapStationToResult } from "./station-mapper.js";
import { connector } from "./utils.js";

const OCM_ABOUT_URL = "https://openchargemap.org/about";

function isSafeHttpUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function isOcmContributorProvider(provider: OcmDataProvider): boolean {
  return (
    provider.ID === 1 ||
    provider.Title.toLowerCase().includes("open charge map contributor") ||
    provider.Title.toLowerCase() === "open charge map"
  );
}

function normalizeProviderLicense(provider: OcmDataProvider): string {
  const license = provider.License?.trim();
  if (license) return license;
  if (provider.IsOpenDataLicensed === true) return "Open data license (provider-specific)";
  return "Provider-specific license";
}

function getOcmProviderAttribution(poi: OcmPoi): DataSourceAttribution | undefined {
  const provider = poi.DataProvider;
  if (!provider || isOcmContributorProvider(provider)) return undefined;

  return {
    text: provider.Title,
    url: isSafeHttpUrl(provider.WebsiteURL) ? provider.WebsiteURL : OCM_ABOUT_URL,
    license: normalizeProviderLicense(provider),
    licenseUrl: isSafeHttpUrl(provider.License) ? provider.License : OCM_ABOUT_URL,
  };
}

function getMaxPower(poi: OcmPoi): number {
  if (!poi.Connections?.length) return 0;
  let max = 0;
  for (const conn of poi.Connections) {
    if (conn.PowerKW && conn.PowerKW > max) {
      max = conn.PowerKW;
    }
  }
  return max;
}

export function getVariant(poi: OcmPoi): string {
  const maxPower = getMaxPower(poi);
  if (maxPower === 0) return "unknown";
  if (maxPower <= 22) return "slow";
  if (maxPower <= 100) return "fast";
  return "ultra-rapid";
}

export function getStatus(poi: OcmPoi): EvChargingStatus {
  if (poi.StatusType?.IsOperational === false) {
    const title = poi.StatusType.Title?.toLowerCase() ?? "";
    if (title.includes("planned") || title.includes("construction")) {
      return "planned";
    }
    return "not-operational";
  }
  if (poi.StatusType?.IsOperational === true) {
    return "operational";
  }
  return "unknown";
}

export function buildSummary(poi: OcmPoi): string {
  const parts: string[] = [];

  // Total connector count
  const totalQty = poi.Connections?.reduce((sum, c) => sum + (c.Quantity ?? 1), 0) ?? 0;

  // Unique connector type names
  const connectorNames = new Set<string>();
  for (const conn of poi.Connections ?? []) {
    if (conn.ConnectionType?.Title) {
      connectorNames.add(conn.ConnectionType.Title);
    }
  }

  if (totalQty > 0 && connectorNames.size > 0) {
    parts.push(`${totalQty}x ${Array.from(connectorNames).join(", ")}`);
  } else if (totalQty > 0) {
    parts.push(`${totalQty} connectors`);
  }

  // Max power
  const maxPower = getMaxPower(poi);
  if (maxPower > 0) {
    parts.push(`${maxPower}kW`);
  }

  // Operator
  if (poi.OperatorInfo?.Title && !poi.OperatorInfo.IsPrivateIndividual) {
    parts.push(poi.OperatorInfo.Title);
  }

  return parts.join(" \u00B7 ");
}

export function mapOcmToStation(poi: OcmPoi): EvChargingStation {
  const providerAttribution = getOcmProviderAttribution(poi);

  return {
    id: `ocm:${poi.ID}`,
    name: poi.AddressInfo.Title || "EV Charging Station",
    coordinates: [poi.AddressInfo.Longitude, poi.AddressInfo.Latitude],
    sources: ["ocm"],
    sourceItemIds: [`ocm:${poi.ID}`, poi.UUID ? `ocm:${poi.UUID}` : undefined].filter(
      (id): id is string => Boolean(id),
    ),
    attributions: providerAttribution ? [providerAttribution] : undefined,
    status: getStatus(poi),
    address: {
      line1: poi.AddressInfo.AddressLine1,
      town: poi.AddressInfo.Town,
      state: poi.AddressInfo.StateOrProvince,
      postcode: poi.AddressInfo.Postcode,
      country: poi.AddressInfo.Country?.Title,
    },
    operator:
      poi.OperatorInfo?.Title && !poi.OperatorInfo.IsPrivateIndividual
        ? {
            name: poi.OperatorInfo.Title,
            url: poi.OperatorInfo.WebsiteURL,
          }
        : undefined,
    usageType: poi.UsageType?.Title,
    usageCost: poi.UsageCost,
    membershipRequired: poi.UsageType?.IsMembershipRequired,
    access: poi.AddressInfo.AccessComments,
    connectors: (poi.Connections ?? []).map((conn) =>
      connector({
        type: conn.ConnectionType?.Title,
        powerKw: conn.PowerKW,
        currentType: conn.CurrentType?.Title,
        quantity: conn.Quantity,
        status: conn.StatusType?.Title ?? poi.StatusType?.Title,
        reference: conn.Reference,
      }),
    ),
    updatedAt: poi.DateLastStatusUpdate ?? poi.DateLastVerified ?? poi.DateLastConfirmed,
    sourceUrl: poi.AddressInfo.RelatedURL,
  };
}

export function mapOcmToDetail(poi: OcmPoi): DataSourceDetail {
  return mapStationToDetail(mapOcmToStation(poi));
}

export function mapOcmToResult(poi: OcmPoi): DataSourceResult {
  return {
    ...mapStationToResult(mapOcmToStation(poi)),
    summary: buildSummary(poi),
    variant: getVariant(poi),
  };
}
