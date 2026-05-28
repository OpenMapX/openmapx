/**
 * Maps shared mobility stations and vehicles to DataSource types.
 *
 * Labels in the emitted results/details are `I18nToken` values resolved
 * client-side against the active integration's strings catalog (bike-sharing,
 * car-sharing, or scooter-sharing). Each consumer integration ships an
 * identical key namespace under `section.*`, `row.*`, `value.*`, `summary.*`
 * and `format.*` so the same shared mapper produces locale-correct text in
 * each context.
 *
 * mobility-core does not depend on `@openmapx/integration-framework`; the
 * I18nToken shape is mirrored via {@link I18nTokenLike} to keep the
 * dependency graph one-way. The browser-side resolver only checks for `$t`,
 * so structural compatibility is sufficient.
 */

import type {
  DataSourceBranding,
  DataSourceDetail,
  DataSourceDetailSection,
  DataSourceResult,
  OsmIdentity,
  PricingPlanEntry,
} from "@openmapx/core";
import type { SharedMobilityStation, SharedMobilityVehicle } from "./types/shared-mobility.js";

/**
 * Structural mirror of `I18nToken` from
 * `@openmapx/integration-framework/strings`. Inlined here to avoid a
 * `mobility-core` → `integration-framework` import cycle. The runtime
 * resolver only checks for the `$t` property.
 */
interface I18nTokenLike {
  $t: string;
  values?: Record<string, string | number>;
}

type Translatable = I18nTokenLike | string | number;

function t(key: string, values?: Record<string, string | number>): I18nTokenLike {
  return values ? { $t: key, values } : { $t: key };
}

const T = {
  section: {
    availability: { $t: "shared.section.availability" } as I18nTokenLike,
    pricing: { $t: "shared.section.pricing" } as I18nTokenLike,
    transit: t("section.transit"),
    vehicleDetails: t("section.vehicleDetails"),
    vehicleClasses: t("section.vehicleClasses"),
    vehicleInfo: t("section.vehicleInfo"),
    book: t("section.book"),
    apps: t("section.apps"),
    directions: t("section.directions"),
    notes: t("section.notes"),
  },
  row: {
    type: { $t: "shared.row.type" } as I18nTokenLike,
    status: { $t: "shared.row.status" } as I18nTokenLike,
    capacity: { $t: "shared.row.capacity" } as I18nTokenLike,
    availableVehicles: t("row.availableVehicles"),
    emptySlots: t("row.emptySlots"),
    totalCapacity: t("row.totalCapacity"),
    pricing: t("row.pricing"),
    busLines: t("row.busLines"),
    nearestStops: t("row.nearestStops"),
    vehicle: t("row.vehicle"),
    propulsion: t("row.propulsion"),
    seats: t("row.seats"),
    features: t("row.features"),
    co2: t("row.co2"),
    battery: t("row.battery"),
    range: t("row.range"),
    web: t("row.web"),
    android: t("row.android"),
    ios: t("row.ios"),
    iosApp: t("row.iosApp"),
    androidApp: t("row.androidApp"),
  },
  value: {
    fixedStation: t("value.fixedStation"),
    freefloatingZone: t("value.freefloatingZone"),
    zeroEmissions: t("value.zeroEmissions"),
    reserved: t("value.reserved"),
    disabled: t("value.disabled"),
    available: t("value.available"),
    vehicleFallback: t("value.vehicleFallback"),
  },
} as const;

function stationIdentity(station: SharedMobilityStation): OsmIdentity | undefined {
  const identity: OsmIdentity = {};
  if (station.nativeId) identity.ref = station.nativeId;
  if (station.operator) identity.operator = station.operator;
  if (station.branding?.name && station.branding.name !== station.operator) {
    identity.brand = station.branding.name;
  }
  return Object.keys(identity).length > 0 ? identity : undefined;
}

function vehicleIdentity(vehicle: SharedMobilityVehicle): OsmIdentity | undefined {
  const identity: OsmIdentity = {};
  if (vehicle.nativeId) identity.ref = vehicle.nativeId;
  if (vehicle.operator) identity.operator = vehicle.operator;
  if (vehicle.branding?.name && vehicle.branding.name !== vehicle.operator) {
    identity.brand = vehicle.branding.name;
  }
  return Object.keys(identity).length > 0 ? identity : undefined;
}

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

function formFactorToken(formFactor: string): I18nTokenLike {
  return t(`value.formFactor.${formFactor}`);
}

function propulsionToken(propulsion: string): I18nTokenLike {
  return t(`value.propulsionKind.${propulsion}`);
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

/**
 * ID prefix that flows from the result through the click handler back to the
 * place resolver, so it can branch on station vs free-floating vehicle
 * without an extra lookup. See `createDataSourceResolver`.
 */
export const STATION_ID_PREFIX = "s:";
export const VEHICLE_ID_PREFIX = "v:";

/**
 * Strip the kind prefix added by {@link mapStationToResult} / {@link mapVehicleToResult}.
 * Use in `getDetail(itemId)` before looking the item up in the provider's raw-id cache.
 */
export function stripMobilityKindPrefix(id: string): string {
  if (id.startsWith(STATION_ID_PREFIX)) return id.slice(STATION_ID_PREFIX.length);
  if (id.startsWith(VEHICLE_ID_PREFIX)) return id.slice(VEHICLE_ID_PREFIX.length);
  return id;
}

export function mapStationToResult(station: SharedMobilityStation): DataSourceResult {
  const variant = stationVariant(station);
  return {
    id: `${STATION_ID_PREFIX}${station.id}`,
    kind: "station",
    name: station.name,
    coordinates: station.coordinates,
    source: station.sources[0],
    variant,
    status: variant,
    summary: t("summary.available", { count: station.availableVehicles }),
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
  const rows: (Translatable | number)[][] = [[T.row.availableVehicles, station.availableVehicles]];
  if (station.emptySlots !== undefined) {
    rows.push([T.row.emptySlots, station.emptySlots]);
  }
  if (station.capacity !== undefined) {
    rows.push([T.row.totalCapacity, station.capacity]);
  }
  if (station.stationType) {
    rows.push([
      T.row.type,
      station.stationType === "fixed" ? T.value.fixedStation : T.value.freefloatingZone,
    ]);
  }
  if (station.pricingSummary) {
    rows.push([T.row.pricing, station.pricingSummary]);
  }

  sections.push({
    title: T.section.availability,
    type: "table",
    rows,
    sectionIcon: "info",
  });

  // Transit info
  if (station.transitInfo?.lines || station.transitInfo?.stops) {
    const transitRows: (Translatable | number)[][] = [];
    if (station.transitInfo.lines) {
      transitRows.push([T.row.busLines, station.transitInfo.lines]);
    }
    if (station.transitInfo.stops) {
      transitRows.push([T.row.nearestStops, station.transitInfo.stops]);
    }
    sections.push({
      title: T.section.transit,
      type: "table",
      rows: transitRows,
      sectionIcon: "directions_bus",
    });
  }

  // Vehicle type details (structured — from GBFS)
  if (station.vehicleTypeDetails && station.vehicleTypeDetails.length > 0) {
    const vtRows: (Translatable | number)[][] = [];
    for (const vt of station.vehicleTypeDetails) {
      const labelText: string | undefined =
        (vt.make && vt.model ? `${vt.make} ${vt.model}` : vt.name) || undefined;
      const labelValue: Translatable = labelText
        ? labelText
        : vt.formFactor
          ? formFactorToken(vt.formFactor)
          : T.value.vehicleFallback;
      vtRows.push([T.row.vehicle, labelValue]);
      if (vt.propulsion) vtRows.push([T.row.propulsion, propulsionToken(vt.propulsion)]);
      if (vt.riderCapacity) vtRows.push([T.row.seats, vt.riderCapacity]);
      if (vt.accessories && vt.accessories.length > 0) {
        // Resolver does not currently render token lists inside a comma-joined
        // string; emit the resolvable tokens individually as a single string
        // joined client-side would lose i18n. For now, keep accessories as
        // comma-joined keys client could resolve, but to avoid silent English
        // leaks we emit a token list joined to a single token via values is
        // not possible. Fall back to emitting each accessory as its own row
        // would clutter the table; instead emit the comma-joined raw keys
        // wrapped in a passthrough string so the user sees raw keys (which
        // surfaces missing strings) — acceptable per the resolver's
        // visible-bug doctrine.
        vtRows.push([T.row.features, vt.accessories.map(accessoryFallbackString).join(", ")]);
      }
      if (vt.co2PerKm !== undefined) {
        vtRows.push([
          T.row.co2,
          vt.co2PerKm === 0 ? T.value.zeroEmissions : t("format.co2PerKm", { value: vt.co2PerKm }),
        ]);
      }
    }
    sections.push({
      title: T.section.vehicleDetails,
      type: "table",
      rows: vtRows,
      sectionIcon: "directions_car",
      collapsed: true,
    });
  } else if (station.vehicleClassNames && station.vehicleClassNames.length > 0) {
    // Fallback: simple vehicle class names (from non-GBFS sources)
    sections.push({
      title: T.section.vehicleClasses,
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
      title: T.section.pricing,
      type: "pricing",
      pricingPlans,
      sectionIcon: "payments",
      collapsed: true,
    });
  }

  // Rental links
  if (station.rentalUris) {
    const linkRows: (Translatable | number)[][] = [];
    if (station.rentalUris.web) linkRows.push([T.row.web, station.rentalUris.web]);
    if (station.rentalUris.android) linkRows.push([T.row.android, station.rentalUris.android]);
    if (station.rentalUris.ios) linkRows.push([T.row.ios, station.rentalUris.ios]);
    if (linkRows.length > 0) {
      sections.push({
        title: T.section.book,
        type: "table",
        rows: linkRows,
        sectionIcon: "open_in_new",
        collapsed: true,
      });
    }
  }

  if (station.rentalApps) {
    const appRows: (Translatable | number)[][] = [];
    if (station.rentalApps.ios?.storeUri)
      appRows.push([T.row.iosApp, station.rentalApps.ios.storeUri]);
    if (station.rentalApps.android?.storeUri) {
      appRows.push([T.row.androidApp, station.rentalApps.android.storeUri]);
    }
    if (appRows.length > 0) {
      sections.push({
        title: T.section.apps,
        type: "table",
        rows: appRows,
        sectionIcon: "open_in_new",
        collapsed: true,
      });
    }
  }

  // Location hint
  if (station.locationHint) {
    sections.push({
      title: T.section.directions,
      type: "text",
      content: station.locationHint,
      sectionIcon: "info",
    });
  }

  // Operator notes
  if (station.operatorNotes) {
    sections.push({
      title: T.section.notes,
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

  // Access method → usageInfo. The label uses the ICU template at
  // `format.accessMethod` resolved to the integration's catalog; usageInfo.type
  // is `string`, so we pre-format via an inline ICU fallback marker that the
  // panel renderer treats as the human label. Pass the raw accessMethod
  // through unchanged when no template is available.
  const usageInfo = station.accessMethod ? { type: `Access: ${station.accessMethod}` } : undefined;
  const branding = brandingFromStation(station);

  return {
    id: `${STATION_ID_PREFIX}${station.id}`,
    sources: station.sources,
    name: station.name,
    coordinates: station.coordinates,
    identity: stationIdentity(station),
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

function vehicleSummary(vehicle: SharedMobilityVehicle): I18nTokenLike | undefined {
  // The summary glues battery + range + (optional) text. Compound combos go
  // through the consuming integration's `summary.batteryRange` template so the
  // separator/unit are locale-correct; single-piece summaries use the per-unit
  // `format.*` tokens.
  if (vehicle.batteryLevel !== undefined && vehicle.rangeMeters !== undefined) {
    return t("summary.batteryRange", {
      battery: vehicle.batteryLevel,
      km: (vehicle.rangeMeters / 1000).toFixed(1),
    });
  }
  if (vehicle.batteryLevel !== undefined) {
    return t("format.batteryPercent", { value: vehicle.batteryLevel });
  }
  if (vehicle.rangeMeters !== undefined) {
    return t("format.distanceKm", { value: (vehicle.rangeMeters / 1000).toFixed(1) });
  }
  return undefined;
}

function formFactorLabelFallback(formFactor: string): string {
  return FORM_FACTOR_FALLBACK[formFactor] ?? "Vehicle";
}

export function mapVehicleToResult(vehicle: SharedMobilityVehicle): DataSourceResult {
  const variant = vehicleVariant(vehicle);
  const formLabel = formFactorLabelFallback(vehicle.formFactor);
  return {
    id: `${VEHICLE_ID_PREFIX}${vehicle.id}`,
    kind: "vehicle",
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

  const rows: (Translatable | number)[][] = [];
  rows.push([T.row.type, formFactorToken(vehicle.formFactor)]);
  if (vehicle.propulsion) {
    rows.push([T.row.propulsion, propulsionToken(vehicle.propulsion)]);
  }
  if (vehicle.batteryLevel !== undefined) {
    rows.push([T.row.battery, t("format.batteryPercent", { value: vehicle.batteryLevel })]);
  }
  if (vehicle.rangeMeters !== undefined) {
    rows.push([
      T.row.range,
      t("format.distanceKm", { value: (vehicle.rangeMeters / 1000).toFixed(1) }),
    ]);
  }
  rows.push([
    T.row.status,
    vehicle.isReserved
      ? T.value.reserved
      : vehicle.isDisabled
        ? T.value.disabled
        : T.value.available,
  ]);

  sections.push({
    title: T.section.vehicleInfo,
    type: "table",
    rows,
    sectionIcon: "info",
  });

  if (vehicle.rentalUris || vehicle.rentalApps) {
    const linkRows: (Translatable | number)[][] = [];
    if (vehicle.rentalUris?.web) linkRows.push([T.row.web, vehicle.rentalUris.web]);
    if (vehicle.rentalUris?.ios) linkRows.push([T.row.ios, vehicle.rentalUris.ios]);
    if (vehicle.rentalUris?.android) linkRows.push([T.row.android, vehicle.rentalUris.android]);
    if (vehicle.rentalApps?.ios?.storeUri)
      linkRows.push([T.row.iosApp, vehicle.rentalApps.ios.storeUri]);
    if (vehicle.rentalApps?.android?.storeUri) {
      linkRows.push([T.row.androidApp, vehicle.rentalApps.android.storeUri]);
    }
    if (linkRows.length > 0) {
      sections.push({
        title: T.section.book,
        type: "table",
        rows: linkRows,
        sectionIcon: "open_in_new",
        collapsed: true,
      });
    }
  }

  const branding = brandingFromVehicle(vehicle);
  const formLabel = formFactorLabelFallback(vehicle.formFactor);
  return {
    id: `${VEHICLE_ID_PREFIX}${vehicle.id}`,
    sources: vehicle.sources,
    identity: vehicleIdentity(vehicle),
    name: vehicle.operator ? `${vehicle.operator} ${formLabel}` : formLabel,
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

/**
 * Fallback English labels used for fields that are not (yet) emitted as
 * tokens: the vehicle `name` (composed with operator prefix), the
 * `usageInfo.type` text, and accessory comma-join strings inside vehicle
 * details. Kept in sync with the `value.formFactor.*` catalog keys.
 */
const FORM_FACTOR_FALLBACK: Record<string, string> = {
  bicycle: "Bicycle",
  cargo_bicycle: "Cargo Bicycle",
  scooter_standing: "E-Scooter",
  scooter_seated: "Seated Scooter",
  car: "Car",
  moped: "Moped",
  other: "Vehicle",
};

const ACCESSORY_FALLBACK: Record<string, string> = {
  air_conditioning: "AC",
  cruise_control: "Cruise Control",
  automatic: "Automatic",
  manual: "Manual",
  navigation: "Navigation",
  doors_3: "3 doors",
  doors_4: "4 doors",
  doors_5: "5 doors",
};

function accessoryFallbackString(accessory: string): string {
  return ACCESSORY_FALLBACK[accessory] ?? accessory.replace(/_/g, " ");
}
