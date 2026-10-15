import type { Attribution } from "@openmapx/mobility-core/attribution";
import {
  type ContributingRecord,
  contributorsForField,
  contributorsForFields,
  type FieldContributors,
  parseContributors,
} from "@openmapx/mobility-core/contributors";

export const SAVED_PLACE_FIELDS = ["name", "address", "lat", "lng"] as const;
export type SavedPlaceField = (typeof SAVED_PLACE_FIELDS)[number];
export type SavedPlaceFieldContributors = Partial<Record<SavedPlaceField, readonly Attribution[]>>;
export const MAX_SAVED_PLACE_CAPTURE_BYTES = 65_536;
const MAX_FIELD_RECEIPTS = 32;

/** Public storage/file boundary: a closed bounded map of portable receipts, never provider payloads. */
export function parseSavedPlaceContributors(
  value: unknown,
): SavedPlaceFieldContributors | undefined {
  if (typeof value === "string") {
    if (value.length > MAX_SAVED_PLACE_CAPTURE_BYTES) return undefined;
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  try {
    const serialized = JSON.stringify(value);
    if (
      serialized.length > MAX_SAVED_PLACE_CAPTURE_BYTES ||
      new TextEncoder().encode(serialized).byteLength > MAX_SAVED_PLACE_CAPTURE_BYTES
    )
      return undefined;
  } catch {
    return undefined;
  }
  const fields: SavedPlaceFieldContributors = {};
  for (const [field, raw] of Object.entries(value)) {
    if (!SAVED_PLACE_FIELDS.includes(field as SavedPlaceField)) return undefined;
    if (!Array.isArray(raw) || raw.length > MAX_FIELD_RECEIPTS) return undefined;
    const receipts = parseContributors(raw);
    if (receipts === undefined) return undefined;
    fields[field as SavedPlaceField] = receipts;
  }
  return fields;
}

/** Only captured fields are copied. Absence stays unknown; an acquired [] stays authoritative. */
export function captureSavedPlaceContributors(
  place: ContributingRecord & { fieldContributors?: FieldContributors },
): SavedPlaceFieldContributors | undefined {
  if (place.contributors === undefined && place.fieldContributors === undefined) return undefined;
  const fields: SavedPlaceFieldContributors = {};
  for (const field of SAVED_PLACE_FIELDS) {
    const coordinate = field === "lat" || field === "lng";
    const sourceField = coordinate ? `coordinates.${field === "lat" ? 1 : 0}` : field;
    if (place.fieldContributors !== undefined) {
      const known = coordinate ? [sourceField, "coordinates"] : [sourceField];
      if (!known.some((key) => Object.hasOwn(place.fieldContributors ?? {}, key))) continue;
    }
    fields[field] = contributorsForField(place, sourceField);
  }
  return parseSavedPlaceContributors(fields);
}

/** Reconstruct a Place without borrowing a current catalogue or changing acquired ownership. */
export function savedPlaceContributorsForPlace(value: unknown): {
  fieldContributors?: FieldContributors;
} {
  const fields = parseSavedPlaceContributors(value);
  if (!fields) return {};
  return {
    fieldContributors: {
      ...(fields.name === undefined ? {} : { name: fields.name }),
      ...(fields.address === undefined ? {} : { address: fields.address }),
      // Only a complete coordinate capture can certify the parent. Partial maps
      // retain child keys so the unknown axis cannot inherit a displayed union.
      ...(fields.lat !== undefined && fields.lng !== undefined
        ? { coordinates: contributorsForFields(fields, ["lat", "lng"]) }
        : {}),
      ...(fields.lat === undefined ? {} : { "coordinates.1": fields.lat }),
      ...(fields.lng === undefined ? {} : { "coordinates.0": fields.lng }),
    },
  };
}

/** Project only the frozen values actually displayed on this surface. */
export function savedPlaceContributors(
  value: unknown,
  fields: readonly SavedPlaceField[],
): Attribution[] {
  return contributorsForFields(parseSavedPlaceContributors(value), fields);
}
