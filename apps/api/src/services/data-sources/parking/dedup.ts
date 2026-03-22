import { mergeAttributions } from "../../../utils/geo.js";
import type { ParkingAttribution, ParkingFacility } from "./types.js";

/**
 * Source priority for deduplication (lower = higher priority).
 * Higher-priority sources provide the base identity (name, coordinates, source, id),
 * but fields from all matching sources are merged to maximize information.
 */
const SOURCE_PRIORITY: Record<string, number> = {
  "db-bahnpark": 0,
  "parkapi-v3": 1,
  "parkapi-v2": 2, // prefix match — actual source is "parkapi-v2/CityName"
  "osm-parking": 3,
};

function getSourcePriority(source: string): number {
  if (SOURCE_PRIORITY[source] !== undefined) return SOURCE_PRIORITY[source];
  const prefix = source.split("/")[0];
  return SOURCE_PRIORITY[prefix] ?? 99;
}

/**
 * Merge two facilities. The `primary` provides the base identity;
 * the `secondary` fills in any missing fields.
 * Attributions from both sources are combined.
 */
function mergeFacilities(primary: ParkingFacility, secondary: ParkingFacility): ParkingFacility {
  return {
    // Identity fields always from primary
    id: primary.id,
    name: primary.name,
    coordinates: primary.coordinates,
    source: primary.source,
    attribution: mergeAttributions(primary.attribution, secondary.attribution) as
      | ParkingAttribution
      | ParkingAttribution[],

    // Real-time data: prefer whichever has it
    hasRealtimeData: primary.hasRealtimeData || secondary.hasRealtimeData,
    freeSpaces: primary.freeSpaces ?? secondary.freeSpaces,
    state:
      primary.state && primary.state !== "unknown"
        ? primary.state
        : (secondary.state ?? primary.state),

    // Enrich from either source — primary wins when both have data
    parkingType: primary.parkingType !== "unknown" ? primary.parkingType : secondary.parkingType,
    capacity: primary.capacity ?? secondary.capacity,
    disabledSpaces: primary.disabledSpaces ?? secondary.disabledSpaces,
    chargingSpaces: primary.chargingSpaces ?? secondary.chargingSpaces,
    maxHeight: primary.maxHeight ?? secondary.maxHeight,
    fee: primary.fee && primary.fee !== "unknown" ? primary.fee : (secondary.fee ?? primary.fee),
    feeDescription: primary.feeDescription ?? secondary.feeDescription,
    tariffRows: primary.tariffRows ?? secondary.tariffRows,
    access: primary.access ?? secondary.access,
    operator: primary.operator ?? secondary.operator,
    address: primary.address ?? secondary.address,
    openingHours: primary.openingHours ?? secondary.openingHours,
    parkAndRide: primary.parkAndRide ?? secondary.parkAndRide,
    nearestStation: primary.nearestStation ?? secondary.nearestStation,
    chargingDetails: primary.chargingDetails ?? secondary.chargingDetails,
    paymentMethods: primary.paymentMethods ?? secondary.paymentMethods,
    url: primary.url ?? secondary.url,
  };
}

/**
 * Deduplicates and merges parking facilities by rounding coordinates
 * to 3 decimal places (~111m). When two facilities collide, the one
 * with higher source priority provides the base identity but fields
 * are merged from both to maximize information.
 */
export function deduplicateParking(facilities: ParkingFacility[]): ParkingFacility[] {
  const seen = new Map<string, ParkingFacility>();

  for (const facility of facilities) {
    const [lng, lat] = facility.coordinates;
    const key = `${Math.round(lat * 1000)},${Math.round(lng * 1000)}`;

    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, facility);
      continue;
    }

    const existingPriority = getSourcePriority(existing.source);
    const newPriority = getSourcePriority(facility.source);

    if (newPriority < existingPriority) {
      // New source is higher priority — it becomes the primary
      seen.set(key, mergeFacilities(facility, existing));
    } else {
      // Existing is higher or equal priority — merge new data into it
      seen.set(key, mergeFacilities(existing, facility));
    }
  }

  return Array.from(seen.values());
}
