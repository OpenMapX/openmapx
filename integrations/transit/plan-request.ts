import { parseWgs84Point, type TripPlanRequest } from "@openmapx/integration-framework";
import { transitRequestFingerprint, verifyTransitPageToken } from "./page-token.js";
import { parseModes } from "./route-helpers.js";

const FORM_FACTORS = [
  "BICYCLE",
  "CARGO_BICYCLE",
  "SCOOTER_STANDING",
  "SCOOTER_SEATED",
  "CAR",
  "MOPED",
] as const;
type RentalFormFactor = (typeof FORM_FACTORS)[number];
const RENTAL_FORM_FACTORS: ReadonlySet<string> = new Set(FORM_FACTORS);

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function parseBoundedList(raw: string | undefined, allowed?: ReadonlySet<string>): string[] {
  return [
    ...new Set(
      (raw ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value && (!allowed || allowed.has(value))),
    ),
  ].slice(0, 50);
}

/**
 * The requested planning instant as a UTC ISO string, or null when the input is
 * malformed. A `time` containing `T` is a full date-time; otherwise `date`
 * (default today) and `time` (default now) are a UTC calendar date and clock.
 */
export function planInstant(
  date: string | undefined,
  time: string | undefined,
  now = new Date(),
): string | null {
  if (time?.includes("T")) {
    const instant = new Date(time);
    return Number.isFinite(instant.getTime()) ? `${instant.toISOString().slice(0, 19)}Z` : null;
  }
  if (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  if (time !== undefined && !/^\d{2}:\d{2}(:\d{2})?$/.test(time)) return null;
  const day = date ?? now.toISOString().slice(0, 10);
  const clock = time ? (time.length === 5 ? `${time}:00` : time) : now.toISOString().slice(11, 19);
  const instant = new Date(`${day}T${clock}Z`);
  if (!Number.isFinite(instant.getTime())) return null;
  // Reject calendar or clock values the parser would roll over, such as 02-30 or 24:00.
  if (instant.toISOString().slice(0, 19) !== `${day}T${clock}`) return null;
  return `${day}T${clock}Z`;
}

/** The trip's two ends and its departure or arrival instant. */
export interface PlanEndpoints {
  from: { lat: number; lng: number };
  to: { lat: number; lng: number };
  when: string;
}

/** Read the `/plan` origin, destination and instant from its query. */
export function parsePlanEndpoints(q: Record<string, string>): Parsed<PlanEndpoints> {
  const from = parseWgs84Point(q.from_lng, q.from_lat);
  const to = parseWgs84Point(q.to_lng, q.to_lat);
  if (!from || !to) {
    return {
      ok: false,
      error: "Invalid or missing coordinate params (from_lat, from_lng, to_lat, to_lng)",
    };
  }
  const when = planInstant(q.date, q.time);
  if (!when) {
    return {
      ok: false,
      error: "time must be an ISO 8601 date-time, or HH:MM[:SS] with an optional YYYY-MM-DD date",
    };
  }
  return {
    ok: true,
    value: { from: { lat: from[1], lng: from[0] }, to: { lat: to[1], lng: to[0] }, when },
  };
}

/** A validated `/plan` request and the fingerprint its page tokens are bound to. */
export interface PlanRequest {
  request: TripPlanRequest;
  fingerprint: string;
}

/**
 * Read the `/plan` options from its query and build the planner request. A page
 * token must verify under `pageSecret`, match this query's fingerprint and,
 * when the query names one, its capability epoch.
 */
export function parsePlanOptions(
  q: Record<string, string>,
  endpoints: PlanEndpoints,
  pageSecret: string,
): Parsed<PlanRequest> {
  // `time` is an arrival deadline when arrive_by is set, otherwise a departure.
  const arriveBy = q.arrive_by === "true";
  const numItinerariesRaw = Number(q.num_itineraries);
  const numItineraries =
    Number.isFinite(numItinerariesRaw) && numItinerariesRaw > 0
      ? Math.min(Math.floor(numItinerariesRaw), 10)
      : undefined;
  const maxTransfersRaw = q.max_transfers === undefined ? undefined : Number(q.max_transfers);
  if (
    maxTransfersRaw !== undefined &&
    (!Number.isInteger(maxTransfersRaw) || maxTransfersRaw < 0 || maxTransfersRaw > 8)
  ) {
    return { ok: false, error: "max_transfers must be an integer from 0 to 8" };
  }
  const transferBuffer = q.transfer_buffer ?? "standard";
  if (!["standard", "relaxed", "extra"].includes(transferBuffer)) {
    return { ok: false, error: "transfer_buffer must be standard, relaxed, or extra" };
  }
  const bikeHillPreference = q.bike_hill_preference ?? "default";
  if (!["default", "avoid", "strongly-avoid"].includes(bikeHillPreference)) {
    return { ok: false, error: "invalid bike_hill_preference" };
  }
  const rentalFormFactors = parseBoundedList(q.rental_form_factors, RENTAL_FORM_FACTORS);
  const rentalProviderIds = parseBoundedList(q.rental_provider_ids);
  const rentalGroupIds = parseBoundedList(q.rental_group_ids);
  const hasRentalSelection =
    rentalFormFactors.length > 0 || rentalProviderIds.length > 0 || rentalGroupIds.length > 0;
  const hasRentalMode = [q.pre_modes, q.post_modes, q.direct_modes].some((modes) =>
    (modes ?? "").split(",").includes("RENTAL"),
  );
  if (hasRentalSelection && !hasRentalMode) {
    return { ok: false, error: "rental filters require an explicit rental access mode" };
  }
  if (q.require_bike_transport === "true" && rentalFormFactors.includes("CAR")) {
    return { ok: false, error: "bike transport cannot be combined with car share" };
  }
  if (
    (rentalProviderIds.length > 0 || rentalGroupIds.length > 0) &&
    (!q.rental_source || !q.rental_instance || !q.capability_epoch)
  ) {
    return {
      ok: false,
      error: "provider/group rental filters require source, instance, and capability epoch",
    };
  }
  const rentalFilter = hasRentalSelection
    ? {
        formFactors: rentalFormFactors as RentalFormFactor[],
        providerIds: rentalProviderIds,
        groupIds: rentalGroupIds,
        source: q.rental_source ?? "transit-motis-local",
        instance: q.rental_instance ?? "local",
        datasetEpoch: q.capability_epoch ?? "active",
      }
    : undefined;
  const fingerprint = transitRequestFingerprint(q);
  let pageCursor: string | undefined;
  if (q.page_token) {
    try {
      const token = verifyTransitPageToken(q.page_token, pageSecret, fingerprint);
      if (q.capability_epoch && token.datasetEpoch !== q.capability_epoch) {
        throw new Error("dataset epoch changed");
      }
      pageCursor = token.cursor;
    } catch {
      return { ok: false, error: "Invalid, expired, or stale transit page token" };
    }
  }
  const { from, to, when } = endpoints;
  return {
    ok: true,
    value: {
      fingerprint,
      request: {
        regionalAlternatives: true,
        from,
        to,
        ...(arriveBy ? { arrivalTime: when } : { departureTime: when }),
        numItineraries,
        modes: (q.modes ?? "TRANSIT").split(",").map((m) => m.trim()),
        wheelchairRequired: q.wheelchair === "true",
        maxTransfers: maxTransfersRaw,
        transferBuffer: transferBuffer as "standard" | "relaxed" | "extra",
        requireBikeTransport: q.require_bike_transport === "true",
        bikeHillPreference: bikeHillPreference as "default" | "avoid" | "strongly-avoid",
        rentalFilters: rentalFilter
          ? { direct: rentalFilter, preTransit: rentalFilter, postTransit: rentalFilter }
          : undefined,
        capabilityEpoch: q.capability_epoch,
        pageCursor,
        preTransitModes: parseModes(q.pre_modes),
        postTransitModes: parseModes(q.post_modes),
        directModes: parseModes(q.direct_modes),
        deutschlandticketOnly: q.deutschlandticket === "true",
      },
    },
  };
}
