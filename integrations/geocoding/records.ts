import { ProviderPayloadError } from "@openmapx/integration-framework";

/** A WGS84 `[lng, lat]` pair in range, or null. */
export function lngLatOrNull(lng: unknown, lat: unknown): [number, number] | null {
  return typeof lng === "number" &&
    typeof lat === "number" &&
    Number.isFinite(lng) &&
    Number.isFinite(lat) &&
    Math.abs(lng) <= 180 &&
    Math.abs(lat) <= 90
    ? [lng, lat]
    : null;
}

/**
 * The geocoder records that can be shown: coordinates in range and a
 * non-empty label. Others are dropped; when records came back but none can be
 * shown, the payload is invalid.
 */
export function usableGeocoderRecords<T>(
  records: readonly T[],
  read: (record: T) => { coordinates: [number, number] | null; label: string | null | undefined },
  what: string,
): Array<{ record: T; coordinates: [number, number] }> {
  const usable = records.flatMap((record) => {
    const { coordinates, label } = read(record);
    return coordinates && label?.trim() ? [{ record, coordinates }] : [];
  });
  if (records.length > 0 && usable.length === 0) {
    throw new ProviderPayloadError(`${what}: no usable records`);
  }
  return usable;
}
