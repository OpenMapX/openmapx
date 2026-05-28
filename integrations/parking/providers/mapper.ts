import type {
  DataSourceDetail,
  DataSourceDetailSection,
  DataSourceResult,
  OsmIdentity,
} from "@openmapx/core";
import {
  type I18nToken,
  sharedT,
  type Translatable,
  token,
} from "@openmapx/integration-framework/strings";
import { resolveLicenseLink } from "@openmapx/mobility-core/license";
import type { ParkingFacility, ParkingType } from "@openmapx/mobility-core/parking";

function facilityIdentity(facility: ParkingFacility): OsmIdentity | undefined {
  if (!facility.operator) return undefined;
  return { operator: facility.operator };
}

const PARKING_TYPE_TOKEN: Record<ParkingType, I18nToken> = {
  garage: token("value.parkingGarage"),
  underground: token("value.undergroundGarage"),
  surface: token("value.surfaceLot"),
  "on-street": token("value.onStreet"),
  unknown: sharedT.value.unknown,
};

const TREND_TOKEN: Record<"increasing" | "decreasing" | "constant", I18nToken> = {
  increasing: token("value.trendIncreasing"),
  decreasing: token("value.trendDecreasing"),
  constant: token("value.trendConstant"),
};

const ACCESS_TOKEN: Record<NonNullable<ParkingFacility["access"]>, I18nToken> = {
  public: sharedT.value.public,
  customers: sharedT.value.customers,
  private: sharedT.value.private,
  permit: sharedT.value.permit,
};

const STATE_TOKEN: Record<NonNullable<ParkingFacility["state"]>, I18nToken> = {
  open: sharedT.value.open,
  closed: sharedT.value.closed,
  unknown: sharedT.value.unknown,
};

function computeVariant(facility: ParkingFacility): string {
  if (facility.state === "closed") return "closed";
  if (facility.isStale) return "unknown";
  if (!facility.hasRealtimeData) return "unknown";
  if (facility.freeSpaces === undefined) return "unknown";
  if (facility.freeSpaces === 0) return "full";
  if (facility.capacity && facility.freeSpaces <= facility.capacity * 0.2) {
    return "limited";
  }
  return "available";
}

function buildSummary(facility: ParkingFacility): I18nToken {
  if (facility.state === "closed") return token("summary.closed");
  if (facility.isStale) return token("summary.stale");
  if (facility.hasRealtimeData && facility.freeSpaces !== undefined) {
    if (facility.freeSpaces === 0) return token("summary.full");
    if (facility.capacity) {
      return token("summary.spacesOf", {
        free: facility.freeSpaces,
        capacity: facility.capacity,
      });
    }
    return token("summary.spaces", { count: facility.freeSpaces });
  }
  if (facility.capacity) return token("summary.totalSpaces", { count: facility.capacity });
  return PARKING_TYPE_TOKEN[facility.parkingType];
}

function buildSortValues(facility: ParkingFacility): Record<string, number> | undefined {
  if (facility.hasRealtimeData && facility.freeSpaces !== undefined) {
    return { freeSpaces: facility.freeSpaces };
  }
  return undefined;
}

export function mapParkingToResult(facility: ParkingFacility): DataSourceResult {
  return {
    id: facility.id,
    name: facility.name,
    coordinates: facility.coordinates,
    source: facility.sources[0],
    variant: computeVariant(facility),
    status: facility.state === "closed" ? "non-operational" : undefined,
    summary: buildSummary(facility),
    operator: facility.operator,
    sortValues: buildSortValues(facility),
  };
}

function formatTimestamp(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return value;
  return new Date(time)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, " UTC");
}

export function mapParkingToDetail(facility: ParkingFacility): DataSourceDetail {
  const sections: DataSourceDetailSection[] = [];

  if (facility.hasRealtimeData && facility.freeSpaces !== undefined) {
    const rows: [I18nToken, Translatable][] = [];
    if (facility.capacity) {
      rows.push([token("row.freeSpaces"), `${facility.freeSpaces} / ${facility.capacity}`]);
      const occupancy = Math.round(
        ((facility.capacity - facility.freeSpaces) / facility.capacity) * 100,
      );
      rows.push([token("row.occupancy"), `${occupancy}%`]);
    } else {
      rows.push([token("row.freeSpaces"), facility.freeSpaces]);
    }
    if (facility.state && facility.state !== "unknown") {
      rows.push([sharedT.row.status, STATE_TOKEN[facility.state]]);
    }
    if (facility.trend && facility.trend !== "constant") {
      rows.push([token("row.trend"), TREND_TOKEN[facility.trend]]);
    }
    if (facility.isStale) {
      rows.push([token("row.dataFreshness"), sharedT.value.stale]);
    }
    const updatedAt = formatTimestamp(facility.realtimeDataUpdatedAt ?? facility.dataUpdatedAt);
    if (updatedAt) {
      rows.push([sharedT.row.lastUpdated, updatedAt]);
    }
    sections.push({
      title: token("section.availability"),
      type: "table",
      rows,
      sectionIcon: "info",
    });
  }

  const infoRows: [I18nToken, Translatable][] = [];
  infoRows.push([sharedT.row.type, PARKING_TYPE_TOKEN[facility.parkingType]]);
  if (facility.capacity) {
    infoRows.push([sharedT.row.capacity, `${facility.capacity}`]);
  }
  if (facility.maxHeight) {
    infoRows.push([token("row.maxHeight"), `${(facility.maxHeight / 100).toFixed(2)} m`]);
  }
  if (facility.disabledSpaces) {
    infoRows.push([token("row.disabledSpaces"), facility.disabledSpaces]);
  }
  if (facility.womenSpaces) {
    infoRows.push([token("row.womenSpaces"), facility.womenSpaces]);
  }
  if (facility.chargingSpaces) {
    const label = facility.chargingDetails ?? `${facility.chargingSpaces}`;
    infoRows.push([token("row.evCharging"), label]);
  }
  if (facility.parkAndRide) {
    infoRows.push([token("row.parkAndRide"), sharedT.value.yes]);
  }
  if (facility.nearestStation) {
    infoRows.push([token("row.nearestStation"), facility.nearestStation]);
  }
  if (facility.access && facility.access !== "public") {
    infoRows.push([sharedT.row.access, ACCESS_TOKEN[facility.access]]);
  }
  if (infoRows.length > 0) {
    sections.push({
      title: token("section.facility"),
      type: "table",
      rows: infoRows,
      sectionIcon: "info",
    });
  }

  if (facility.tariffRows && facility.tariffRows.length > 0) {
    sections.push({
      title: sharedT.section.pricing,
      type: "table",
      rows: facility.tariffRows,
      sectionIcon: "payments",
    });
  } else if (facility.feeDescription) {
    sections.push({
      title: sharedT.section.pricing,
      type: "text",
      content: facility.feeDescription,
      sectionIcon: "payments",
    });
  } else if (facility.fee === "free") {
    sections.push({
      title: sharedT.section.pricing,
      type: "text",
      content: token("value.freeParking"),
      sectionIcon: "payments",
    });
  } else if (facility.fee === "paid") {
    sections.push({
      title: sharedT.section.pricing,
      type: "text",
      content: token("value.paidParking"),
      sectionIcon: "payments",
    });
  }

  if (facility.paymentMethods) {
    sections.push({
      title: sharedT.section.payment,
      type: "text",
      content: facility.paymentMethods,
      sectionIcon: "payments",
      collapsed: true,
    });
  }

  if (facility.qualityWarnings && facility.qualityWarnings.length > 0) {
    sections.push({
      title: sharedT.section.dataQuality,
      type: "list",
      items: facility.qualityWarnings.map((w) => mapQualityWarning(w)),
      sectionIcon: "warning",
      collapsed: true,
    });
  }

  const sourceRows: [I18nToken, Translatable][] = [];
  const sourceName =
    facility.sourceAttribution?.contributor ??
    facility.sourceAttribution?.name ??
    facility.sourceName;
  if (sourceName) sourceRows.push([sharedT.row.source, sourceName]);
  if (facility.sourceUid) sourceRows.push([sharedT.row.sourceId, facility.sourceUid]);
  const sourceUpdatedAt = formatTimestamp(facility.dataUpdatedAt);
  if (sourceUpdatedAt) sourceRows.push([sharedT.row.lastUpdated, sourceUpdatedAt]);
  if (sourceRows.length > 0) {
    sections.push({
      title: sharedT.section.source,
      type: "table",
      rows: sourceRows,
      sectionIcon: "info",
      collapsed: true,
    });
  }

  // Per-feed license is surfaced as a clickable attribution rather than a
  // dead text row: resolveLicenseLink normalises the (often verbose) license
  // label to its SPDX id and derives the canonical license-text URL when the
  // feed didn't supply an explicit `licenseUrl`. The detail panel's
  // `DetailAttribution` renders `license` as a link when `licenseUrl` is set.
  const attributions = buildDetailAttributions(facility);

  return {
    id: facility.id,
    sources: facility.sources,
    name: facility.name,
    coordinates: facility.coordinates,
    identity: facilityIdentity(facility),
    address: facility.address ? { line1: facility.address } : undefined,
    operator: facility.operator ? { name: facility.operator, url: facility.url } : undefined,
    openingHours: facility.openingHours,
    sections,
    attributions,
    parkAndRide: facility.parkAndRide ? true : undefined,
  };
}

/**
 * Build the per-feed attribution row for the detail footer. Only emitted when
 * the facility carries a `sourceAttribution` (aggregators like parkapi-v3,
 * opentransportdata-ch, cita-lu); single-source feeds rely on the manifest
 * attribution. The license link is resolved via the shared SPDX helper so
 * even feeds that only give a license string get a clickable license URL.
 */
function buildDetailAttributions(facility: ParkingFacility) {
  const attr = facility.sourceAttribution;
  if (!attr) return undefined;
  const text = attr.contributor ?? attr.name;
  if (!text) return undefined;
  const licenseLink = resolveLicenseLink({ license: attr.license, licenseUrl: attr.licenseUrl });
  return [
    {
      text,
      url: attr.url ?? "",
      license: licenseLink?.label,
      licenseUrl: licenseLink?.url,
    },
  ];
}

/**
 * Map a known quality-warning string to its token. The mapper inputs are
 * strings emitted by other parts of the parking pipeline (validators,
 * clampers); when unknown, pass through as-is. The known set is small and
 * documented in `quality.*` of the parking strings catalog.
 */
function mapQualityWarning(warning: string): I18nToken | string {
  switch (warning) {
    case "Realtime availability is older than 30 minutes.":
      return token("quality.realtimeStale");
    case "Realtime free-space count exceeded capacity and was clamped.":
      return token("quality.freeSpacesClamped");
    case "Realtime free-space count was negative and was clamped to 0.":
      return token("quality.negativeFreeSpacesClamped");
    case "EV charging available":
      return token("quality.evChargingAvailable");
    default:
      return warning;
  }
}
