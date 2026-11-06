import { itineraryMatchesTransitReference, TRANSIT_PREFER_MOTIS_MODES } from "@openmapx/core";
import type { TransitTripResolveRequest } from "@openmapx/mobility-core/transit";

export class TripReferenceValidationError extends Error {}
export class TripReferenceUnavailableError extends Error {}
export class TripReferenceUnsupportedError extends Error {}
export class TripReferenceEpochError extends Error {}
const fail = (message: string): never => {
  throw new TripReferenceValidationError(message);
};
function object(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail("Expected an object");
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !fields.includes(key))) fail("Unexpected reference field");
  return result;
}
function id(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    hasControl(value) ||
    !/^[a-z0-9][a-z0-9_-]*:.+$/i.test(value)
  )
    return fail("Invalid provider-qualified ID");
  return value;
}
function hasControl(value: string): boolean {
  return Array.from(value).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
}
function instant(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 30 ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 10) !== value.slice(0, 10)
  )
    return fail("Invalid scheduled UTC instant");
  return new Date(value).toISOString();
}
export function parseTripReferenceRequest(value: unknown): TransitTripResolveRequest {
  const body = object(value, [
    "reference",
    "modes",
    "wheelchairRequired",
    "requireBikeTransport",
    "bikeHillPreference",
  ]);
  const reference = object(body.reference, ["legs", "datasetEpoch"]);
  if (!Array.isArray(reference.legs) || reference.legs.length < 1 || reference.legs.length > 8)
    fail("Expected 1..8 transit references");
  const legs = (reference.legs as unknown[]).map((value) => {
    const leg = object(value, [
      "tripId",
      "fromStopId",
      "toStopId",
      "scheduledDeparture",
      "scheduledArrival",
    ]);
    return {
      tripId: id(leg.tripId),
      fromStopId: id(leg.fromStopId),
      toStopId: id(leg.toStopId),
      scheduledDeparture: instant(leg.scheduledDeparture),
      scheduledArrival: instant(leg.scheduledArrival),
    };
  });
  const prefixes = new Set(
    legs.flatMap((r) =>
      [r.tripId, r.fromStopId, r.toStopId].map((v) => v.slice(0, v.indexOf(":"))),
    ),
  );
  if (
    prefixes.size !== 1 ||
    legs.some(
      (r, i) =>
        Date.parse(r.scheduledArrival) <= Date.parse(r.scheduledDeparture) ||
        (i > 0 && Date.parse(r.scheduledDeparture) < Date.parse(legs[i - 1].scheduledArrival)),
    ) ||
    Date.parse(legs.at(-1)?.scheduledArrival ?? "") - Date.parse(legs[0].scheduledDeparture) >
      72 * 3600000
  )
    fail("Invalid reference sequence");
  if (
    reference.datasetEpoch !== undefined &&
    (typeof reference.datasetEpoch !== "string" ||
      !reference.datasetEpoch.length ||
      reference.datasetEpoch.length > 256 ||
      hasControl(reference.datasetEpoch))
  )
    fail("Invalid dataset epoch");
  for (const key of ["wheelchairRequired", "requireBikeTransport"])
    if (body[key] !== undefined && typeof body[key] !== "boolean") fail(`Invalid ${key}`);
  const modes = new Set(["TRANSIT", "RAIL", ...Object.values(TRANSIT_PREFER_MOTIS_MODES).flat()]);
  if (
    body.modes !== undefined &&
    (!Array.isArray(body.modes) ||
      body.modes.length > 16 ||
      body.modes.some((m) => typeof m !== "string" || !modes.has(m)))
  )
    fail("Invalid transit modes");
  if (
    body.bikeHillPreference !== undefined &&
    !["default", "avoid", "strongly-avoid"].includes(String(body.bikeHillPreference))
  )
    fail("Invalid bike preference");
  return {
    reference: { legs, datasetEpoch: reference.datasetEpoch as string | undefined },
    modes: body.modes === undefined ? undefined : [...new Set(body.modes as string[])].sort(),
    wheelchairRequired: body.wheelchairRequired as boolean | undefined,
    requireBikeTransport: body.requireBikeTransport as boolean | undefined,
    bikeHillPreference: body.bikeHillPreference as TransitTripResolveRequest["bikeHillPreference"],
  };
}

export const itineraryMatchesReference = itineraryMatchesTransitReference;
