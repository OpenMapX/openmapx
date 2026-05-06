import type { DataSourceDetail, DataSourceDetailSection, DataSourceResult } from "@openmapx/core";
import type { ParkingFacility, ParkingType } from "./types.js";

/**
 * All string values emitted here must either:
 * - Be numeric/data (e.g. "126 / 220", "2.10 m") — not translated
 * - Have a matching entry in ROW_LABEL_KEYS on the frontend — translated via i18n
 */

const PARKING_TYPE_LABELS: Record<ParkingType, string> = {
  garage: "Parking Garage",
  underground: "Underground Garage",
  surface: "Surface Lot",
  "on-street": "On-Street",
  unknown: "Parking",
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

function buildSummary(facility: ParkingFacility): string | undefined {
  if (facility.state === "closed") return "Closed";
  if (facility.isStale) return "Availability stale";
  if (facility.hasRealtimeData && facility.freeSpaces !== undefined) {
    if (facility.freeSpaces === 0) return "Full";
    if (facility.capacity) return `${facility.freeSpaces}/${facility.capacity} free`;
    return `${facility.freeSpaces} free`;
  }
  if (facility.capacity) return `${facility.capacity} spaces`;
  return PARKING_TYPE_LABELS[facility.parkingType];
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

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
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

  // Availability section (real-time data only)
  if (facility.hasRealtimeData && facility.freeSpaces !== undefined) {
    const rows: (string | number)[][] = [];
    if (facility.capacity) {
      rows.push(["Free Spaces", `${facility.freeSpaces} / ${facility.capacity}`]);
      const occupancy = Math.round(
        ((facility.capacity - facility.freeSpaces) / facility.capacity) * 100,
      );
      rows.push(["Occupancy", `${occupancy}%`]);
    } else {
      rows.push(["Free Spaces", facility.freeSpaces]);
    }
    if (facility.state && facility.state !== "unknown") {
      rows.push(["Status", capitalize(facility.state)]);
    }
    if (facility.isStale) {
      rows.push(["Data Freshness", "Stale"]);
    }
    const updatedAt = formatTimestamp(facility.realtimeDataUpdatedAt ?? facility.dataUpdatedAt);
    if (updatedAt) {
      rows.push(["Last Updated", updatedAt]);
    }
    sections.push({ title: "Availability", type: "table", rows, sectionIcon: "info" });
  }

  // Facility info
  const infoRows: (string | number)[][] = [];
  infoRows.push(["Type", PARKING_TYPE_LABELS[facility.parkingType]]);
  if (facility.capacity) {
    infoRows.push(["Capacity", `${facility.capacity}`]);
  }
  if (facility.maxHeight) {
    infoRows.push(["Max Height", `${(facility.maxHeight / 100).toFixed(2)} m`]);
  }
  if (facility.disabledSpaces) {
    infoRows.push(["Disabled Spaces", facility.disabledSpaces]);
  }
  if (facility.chargingSpaces) {
    const label = facility.chargingDetails ?? `${facility.chargingSpaces}`;
    infoRows.push(["EV Charging", label]);
  }
  if (facility.parkAndRide) {
    infoRows.push(["Park & Ride", "Yes"]);
  }
  if (facility.nearestStation) {
    infoRows.push(["Nearest Station", facility.nearestStation]);
  }
  if (facility.access && facility.access !== "public") {
    infoRows.push(["Access", capitalize(facility.access)]);
  }
  if (infoRows.length > 0) {
    sections.push({ title: "Facility", type: "table", rows: infoRows, sectionIcon: "info" });
  }

  // Fee info — structured tariff rows (DB BahnPark) or free-text description (v3)
  if (facility.tariffRows && facility.tariffRows.length > 0) {
    sections.push({
      title: "Pricing",
      type: "table",
      rows: facility.tariffRows,
      sectionIcon: "payments",
    });
  } else if (facility.feeDescription) {
    sections.push({
      title: "Pricing",
      type: "text",
      content: facility.feeDescription,
      sectionIcon: "payments",
    });
  } else if (facility.fee === "free") {
    sections.push({
      title: "Pricing",
      type: "text",
      content: "Free Parking",
      sectionIcon: "payments",
    });
  } else if (facility.fee === "paid") {
    sections.push({
      title: "Pricing",
      type: "text",
      content: "Paid Parking",
      sectionIcon: "payments",
    });
  }

  // Payment methods
  if (facility.paymentMethods) {
    sections.push({
      title: "Payment",
      type: "text",
      content: facility.paymentMethods,
      sectionIcon: "payments",
      collapsed: true,
    });
  }

  if (facility.qualityWarnings && facility.qualityWarnings.length > 0) {
    sections.push({
      title: "Data Quality",
      type: "list",
      items: facility.qualityWarnings,
      sectionIcon: "warning",
      collapsed: true,
    });
  }

  const sourceRows: (string | number)[][] = [];
  const sourceName =
    facility.sourceAttribution?.contributor ??
    facility.sourceAttribution?.name ??
    facility.sourceName;
  if (sourceName) sourceRows.push(["Source", sourceName]);
  if (facility.sourceUid) sourceRows.push(["Source ID", facility.sourceUid]);
  const license = facility.sourceAttribution?.license;
  if (license) sourceRows.push(["License", license]);
  const sourceUpdatedAt = formatTimestamp(facility.dataUpdatedAt);
  if (sourceUpdatedAt) sourceRows.push(["Last Updated", sourceUpdatedAt]);
  if (sourceRows.length > 0) {
    sections.push({
      title: "Source",
      type: "table",
      rows: sourceRows,
      sectionIcon: "info",
      collapsed: true,
    });
  }

  return {
    id: facility.id,
    sources: facility.sources,
    name: facility.name,
    coordinates: facility.coordinates,
    address: facility.address ? { line1: facility.address } : undefined,
    operator: facility.operator ? { name: facility.operator, url: facility.url } : undefined,
    openingHours: facility.openingHours,
    sections,
    parkAndRide: facility.parkAndRide ? true : undefined,
  };
}
