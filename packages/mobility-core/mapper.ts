/**
 * Maps shared mobility stations and vehicles to DataSource types.
 */

import type {
  DataSourceBranding,
  DataSourceDetail,
  DataSourceDetailSection,
  DataSourceResult,
  PricingPlanEntry,
} from "@openmapx/core";
import type { SharedMobilityStation, SharedMobilityVehicle } from "./types.js";

/** Detects raw slugs like "berlin-scooter-system-pricing-plan" (no spaces, all lowercase). */
const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;

function cleanPlanName(name: string, description?: string): string {
  if (SLUG_RE.test(name.trim())) return description?.trim() ?? "";
  return name.trim();
}

function stationVariant(station: SharedMobilityStation): string {
  if (!station.isActive) return "inactive";
  if (station.availableVehicles === 0) return "empty";
  if (station.emptySlots === 0) return "full";
  return "available";
}

function stationSummary(station: SharedMobilityStation): string {
  const parts: string[] = [];
  parts.push(`${station.availableVehicles} available`);
  if (station.emptySlots !== undefined) {
    parts.push(`${station.emptySlots} slots`);
  }
  if (station.accessMethod) {
    parts.push(station.accessMethod);
  }
  if (station.pricingSummary) {
    parts.push(station.pricingSummary);
  }
  return parts.join(" \u00B7 ");
}

const ACCESSORY_LABELS: Record<string, string> = {
  air_conditioning: "AC",
  cruise_control: "Cruise Control",
  automatic: "Automatic",
  manual: "Manual",
  navigation: "Navigation",
  doors_3: "3 doors",
  doors_4: "4 doors",
  doors_5: "5 doors",
};

function formatAccessory(acc: string): string {
  return ACCESSORY_LABELS[acc] ?? acc.replace(/_/g, " ");
}

function brandingFromStation(station: SharedMobilityStation): DataSourceBranding | undefined {
  if (!station.branding) return undefined;
  return {
    name: station.branding.name ?? station.operator,
    legalName: station.branding.legalName,
    logoUrl: station.branding.logoUrl,
    logoUrlDark: station.branding.logoUrlDark,
    color: station.branding.color,
  };
}

function brandingFromVehicle(vehicle: SharedMobilityVehicle): DataSourceBranding | undefined {
  const base = vehicle.branding;
  if (!base && !vehicle.vehicleImageUrl && !vehicle.vehicleIconUrl) return undefined;
  return {
    name: base?.name ?? vehicle.operator,
    legalName: base?.legalName,
    logoUrl: base?.logoUrl,
    logoUrlDark: base?.logoUrlDark,
    color: base?.color,
    imageUrl: vehicle.vehicleIconUrl ?? vehicle.vehicleImageUrl,
    imageUrlDark: vehicle.vehicleIconUrlDark ?? vehicle.vehicleIconUrl ?? vehicle.vehicleImageUrl,
  };
}

function mapContextSelection(
  systemId?: string,
  vehicleTypeIds?: string[],
): DataSourceResult["mapContext"] | undefined {
  if (!systemId && (!vehicleTypeIds || vehicleTypeIds.length === 0)) return undefined;
  return {
    ...(systemId ? { systemIds: [systemId] } : {}),
    ...(vehicleTypeIds && vehicleTypeIds.length > 0 ? { vehicleTypeIds } : {}),
  };
}

export function mapStationToResult(station: SharedMobilityStation): DataSourceResult {
  const variant = stationVariant(station);
  return {
    id: station.id,
    name: station.name,
    coordinates: station.coordinates,
    source: station.sources[0],
    variant,
    status: variant,
    summary: stationSummary(station),
    operator: station.operator,
    branding: brandingFromStation(station),
    mapContext: mapContextSelection(station.systemId, station.vehicleTypeIds),
    sortValues: {
      available: station.availableVehicles,
      slots: station.emptySlots ?? 0,
    },
  };
}

export function mapStationToDetail(station: SharedMobilityStation): DataSourceDetail {
  const sections: DataSourceDetailSection[] = [];

  // Availability table
  const rows: (string | number)[][] = [["Available Vehicles", station.availableVehicles]];
  if (station.emptySlots !== undefined) {
    rows.push(["Empty Slots", station.emptySlots]);
  }
  if (station.capacity !== undefined) {
    rows.push(["Total Capacity", station.capacity]);
  }
  if (station.stationType) {
    rows.push(["Type", station.stationType === "fixed" ? "Fixed Station" : "Free-floating Zone"]);
  }
  if (station.pricingSummary) {
    rows.push(["Pricing", station.pricingSummary]);
  }

  sections.push({
    title: "Availability",
    type: "table",
    columns: ["", ""],
    rows,
    sectionIcon: "info",
  });

  // Transit info
  if (station.transitInfo?.lines || station.transitInfo?.stops) {
    const transitRows: (string | number)[][] = [];
    if (station.transitInfo.lines) {
      transitRows.push(["Bus Lines", station.transitInfo.lines]);
    }
    if (station.transitInfo.stops) {
      transitRows.push(["Nearest Stops", station.transitInfo.stops]);
    }
    sections.push({
      title: "Public Transit",
      type: "table",
      columns: ["", ""],
      rows: transitRows,
      sectionIcon: "directions_bus",
    });
  }

  // Vehicle type details (structured — from GBFS)
  if (station.vehicleTypeDetails && station.vehicleTypeDetails.length > 0) {
    const vtRows: (string | number)[][] = [];
    for (const vt of station.vehicleTypeDetails) {
      const label =
        (vt.make && vt.model ? `${vt.make} ${vt.model}` : vt.name) ||
        (vt.formFactor ? FORM_FACTOR_LABELS[vt.formFactor] : null) ||
        "Vehicle";
      const propLabel = vt.propulsion
        ? (PROPULSION_LABELS[vt.propulsion] ?? vt.propulsion)
        : undefined;
      vtRows.push(["Vehicle", label]);
      if (propLabel) vtRows.push(["Propulsion", propLabel]);
      if (vt.riderCapacity) vtRows.push(["Seats", vt.riderCapacity]);
      if (vt.accessories && vt.accessories.length > 0) {
        vtRows.push(["Features", vt.accessories.map(formatAccessory).join(", ")]);
      }
      if (vt.co2PerKm !== undefined) {
        vtRows.push(["CO₂", vt.co2PerKm === 0 ? "Zero emissions" : `${vt.co2PerKm} g/km`]);
      }
    }
    sections.push({
      title: "Vehicle Details",
      type: "table",
      columns: ["", ""],
      rows: vtRows,
      sectionIcon: "directions_car",
      collapsed: true,
    });
  } else if (station.vehicleClassNames && station.vehicleClassNames.length > 0) {
    // Fallback: simple vehicle class names (from non-GBFS sources)
    sections.push({
      title: "Vehicle Classes",
      type: "list",
      items: station.vehicleClassNames,
      sectionIcon: "info",
    });
  }

  // Pricing
  if (station.pricingDetails && station.pricingDetails.length > 0) {
    const pricingPlans: PricingPlanEntry[] = station.pricingDetails.map((p) => ({
      name: cleanPlanName(p.name, p.description),
      description: p.description,
      currency: p.currency,
      unlockFee: p.flatRate,
      perKm: p.perKmRate,
      perHour: p.perHourRate,
      free: !p.flatRate && p.perKmRate === undefined && p.perHourRate === undefined,
    }));
    sections.push({
      title: "Pricing",
      type: "pricing",
      pricingPlans,
      sectionIcon: "payments",
      collapsed: true,
    });
  }

  // Rental links
  if (station.rentalUris) {
    const linkRows: (string | number)[][] = [];
    if (station.rentalUris.web) linkRows.push(["Web", station.rentalUris.web]);
    if (station.rentalUris.android) linkRows.push(["Android", station.rentalUris.android]);
    if (station.rentalUris.ios) linkRows.push(["iOS", station.rentalUris.ios]);
    if (linkRows.length > 0) {
      sections.push({
        title: "Book",
        type: "table",
        columns: ["", ""],
        rows: linkRows,
        sectionIcon: "open_in_new",
        collapsed: true,
      });
    }
  }

  if (station.rentalApps) {
    const appRows: (string | number)[][] = [];
    if (station.rentalApps.ios?.storeUri)
      appRows.push(["iOS App", station.rentalApps.ios.storeUri]);
    if (station.rentalApps.android?.storeUri) {
      appRows.push(["Android App", station.rentalApps.android.storeUri]);
    }
    if (appRows.length > 0) {
      sections.push({
        title: "Apps",
        type: "table",
        columns: ["", ""],
        rows: appRows,
        sectionIcon: "open_in_new",
        collapsed: true,
      });
    }
  }

  // Location hint
  if (station.locationHint) {
    sections.push({
      title: "Directions",
      type: "text",
      content: station.locationHint,
      sectionIcon: "info",
    });
  }

  // Operator notes
  if (station.operatorNotes) {
    sections.push({
      title: "Notes",
      type: "text",
      content: station.operatorNotes,
      sectionIcon: "info",
    });
  }

  // Address
  const address = station.address
    ? {
        line1: station.address.street,
        town: station.address.city,
        postcode: station.address.postcode,
        country: station.address.country,
      }
    : undefined;

  // Access method → usageInfo
  const usageInfo = station.accessMethod ? { type: `Access: ${station.accessMethod}` } : undefined;
  const branding = brandingFromStation(station);

  return {
    id: station.id,
    sources: station.sources,
    name: station.name,
    coordinates: station.coordinates,
    address,
    branding,
    operator:
      station.operator || station.branding?.legalName
        ? {
            name: station.operator ?? station.branding?.name ?? station.name,
            url: station.website,
            legalName: station.branding?.legalName,
          }
        : undefined,
    usageInfo,
    sections,
  };
}

function vehicleVariant(vehicle: SharedMobilityVehicle): string {
  if (vehicle.isDisabled) return "disabled";
  if (vehicle.isReserved) return "reserved";
  if (vehicle.batteryLevel !== undefined) {
    if (vehicle.batteryLevel < 20) return "low_battery";
    if (vehicle.batteryLevel >= 80) return "high_battery";
    return "medium_battery";
  }
  return "available";
}

function vehicleSummary(vehicle: SharedMobilityVehicle): string {
  const parts: string[] = [];
  if (vehicle.batteryLevel !== undefined) {
    parts.push(`${vehicle.batteryLevel}%`);
  }
  if (vehicle.rangeMeters !== undefined) {
    const km = (vehicle.rangeMeters / 1000).toFixed(1);
    parts.push(`${km} km`);
  }
  return parts.join(" \u00B7 ");
}

export function mapVehicleToResult(vehicle: SharedMobilityVehicle): DataSourceResult {
  const variant = vehicleVariant(vehicle);
  const formLabel = FORM_FACTOR_LABELS[vehicle.formFactor] ?? "Vehicle";
  return {
    id: vehicle.id,
    name: vehicle.operator ? `${vehicle.operator} ${formLabel}` : formLabel,
    coordinates: vehicle.coordinates,
    source: vehicle.sources[0],
    variant,
    status: variant,
    summary: vehicleSummary(vehicle),
    operator: vehicle.operator,
    branding: brandingFromVehicle(vehicle),
    mapContext: mapContextSelection(
      vehicle.systemId,
      vehicle.vehicleTypeId ? [vehicle.vehicleTypeId] : undefined,
    ),
    sortValues: {
      ...(vehicle.batteryLevel !== undefined ? { battery: vehicle.batteryLevel } : {}),
      ...(vehicle.rangeMeters !== undefined ? { range: vehicle.rangeMeters } : {}),
    },
  };
}

export function mapVehicleToDetail(vehicle: SharedMobilityVehicle): DataSourceDetail {
  const sections: DataSourceDetailSection[] = [];

  const rows: (string | number)[][] = [];
  rows.push(["Type", FORM_FACTOR_LABELS[vehicle.formFactor] ?? "Vehicle"]);
  if (vehicle.propulsion) {
    rows.push(["Propulsion", PROPULSION_LABELS[vehicle.propulsion] ?? vehicle.propulsion]);
  }
  if (vehicle.batteryLevel !== undefined) {
    rows.push(["Battery", `${vehicle.batteryLevel}%`]);
  }
  if (vehicle.rangeMeters !== undefined) {
    rows.push(["Range", `${(vehicle.rangeMeters / 1000).toFixed(1)} km`]);
  }
  rows.push([
    "Status",
    vehicle.isReserved ? "Reserved" : vehicle.isDisabled ? "Disabled" : "Available",
  ]);

  sections.push({
    title: "Vehicle Info",
    type: "table",
    columns: ["", ""],
    rows,
    sectionIcon: "info",
  });

  if (vehicle.rentalUris || vehicle.rentalApps) {
    const linkRows: (string | number)[][] = [];
    if (vehicle.rentalUris?.web) linkRows.push(["Web", vehicle.rentalUris.web]);
    if (vehicle.rentalUris?.ios) linkRows.push(["iOS", vehicle.rentalUris.ios]);
    if (vehicle.rentalUris?.android) linkRows.push(["Android", vehicle.rentalUris.android]);
    if (vehicle.rentalApps?.ios?.storeUri)
      linkRows.push(["iOS App", vehicle.rentalApps.ios.storeUri]);
    if (vehicle.rentalApps?.android?.storeUri) {
      linkRows.push(["Android App", vehicle.rentalApps.android.storeUri]);
    }
    if (linkRows.length > 0) {
      sections.push({
        title: "Book",
        type: "table",
        columns: ["", ""],
        rows: linkRows,
        sectionIcon: "open_in_new",
        collapsed: true,
      });
    }
  }

  const branding = brandingFromVehicle(vehicle);
  return {
    id: vehicle.id,
    sources: vehicle.sources,
    name: vehicle.operator
      ? `${vehicle.operator} ${FORM_FACTOR_LABELS[vehicle.formFactor] ?? "Vehicle"}`
      : (FORM_FACTOR_LABELS[vehicle.formFactor] ?? "Vehicle"),
    coordinates: vehicle.coordinates,
    branding,
    operator:
      vehicle.operator || vehicle.branding?.legalName
        ? {
            name: vehicle.operator ?? vehicle.branding?.name ?? "Operator",
            url: vehicle.rentalUris?.web,
            legalName: vehicle.branding?.legalName,
          }
        : undefined,
    sections,
  };
}

const FORM_FACTOR_LABELS: Record<string, string> = {
  bicycle: "Bicycle",
  cargo_bicycle: "Cargo Bicycle",
  scooter_standing: "E-Scooter",
  scooter_seated: "Seated Scooter",
  car: "Car",
  moped: "Moped",
  other: "Vehicle",
};

const PROPULSION_LABELS: Record<string, string> = {
  human: "Human-powered",
  electric_assist: "Electric Assist",
  electric: "Electric",
  combustion: "Combustion",
  combustion_diesel: "Diesel",
  hybrid: "Hybrid",
  plug_in_hybrid: "Plug-in Hybrid",
  hydrogen_fuel_cell: "Hydrogen",
};
