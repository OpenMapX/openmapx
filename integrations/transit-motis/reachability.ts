import type { Mode, OneToManyIntermodalResponse, Place } from "@motis-project/motis-client";
import { oneToAll, oneToManyIntermodalPost } from "@motis-project/motis-client";
import {
  TRANSIT_WALK_PROFILE,
  type TransitReachabilityCapabilities,
  type TransitReachabilityCheckRequest,
  type TransitReachabilityCheckResult,
  type TransitReachabilitySeed,
  type TransitReachabilitySurfaceRequest,
} from "@openmapx/mobility-core/transit-reachability";
import type { MotisInstance } from "./instances.js";
import { uniqueModes } from "./mode-map.js";

export type MotisReachabilityErrorCode =
  | "unavailable"
  | "timeout"
  | "invalid-response"
  | "unsupported"
  | "upstream";

export class MotisReachabilityError extends Error {
  constructor(
    readonly code: MotisReachabilityErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MotisReachabilityError";
  }
}

export interface ObservedMotisReachabilityCapabilities {
  hasStreetRouting?: boolean;
  maxOneToManySize?: number;
  maxOneToAllTravelTimeMinutes?: number;
  maxPrePostTransitSeconds?: number;
  maxDirectSeconds?: number;
  oneToManyIntermodalVerified?: boolean;
}

export function resolveMotisReachabilityCapabilities(options: {
  source: "self-hosted-motis" | "transitous";
  runtimeHealthy: boolean;
  operatorEnabled: boolean;
  datasetEpoch?: string;
  observed?: ObservedMotisReachabilityCapabilities;
}): TransitReachabilityCapabilities {
  const { source, runtimeHealthy, operatorEnabled, observed } = options;
  const maxTravelTimeMinutes = Math.max(0, observed?.maxOneToAllTravelTimeMinutes ?? 90);
  let exactPointCheckReason: TransitReachabilityCapabilities["exactPointCheckReason"] = "available";
  if (!runtimeHealthy) exactPointCheckReason = "runtime-unhealthy";
  else if (source === "transitous") exactPointCheckReason = "hosted-source";
  else if (!operatorEnabled) exactPointCheckReason = "operator-disabled";
  else if (observed?.hasStreetRouting !== true) exactPointCheckReason = "street-routing-disabled";
  else if (
    observed.oneToManyIntermodalVerified !== true ||
    !Number.isFinite(observed.maxOneToManySize) ||
    (observed.maxOneToManySize ?? 0) < 1 ||
    (observed.maxOneToAllTravelTimeMinutes ?? 0) < 90 ||
    (observed.maxPrePostTransitSeconds ?? 0) < TRANSIT_WALK_PROFILE.egressSeconds ||
    (observed.maxDirectSeconds ?? 0) < TRANSIT_WALK_PROFILE.directSeconds
  ) {
    exactPointCheckReason = "endpoint-unverified";
  }
  return {
    estimatedSurface: runtimeHealthy,
    exactPointChecks: exactPointCheckReason === "available",
    exactPointCheckReason,
    maxDestinationsPerBatch:
      source === "self-hosted-motis" && (observed?.maxOneToManySize ?? 0) > 0
        ? Math.min(Math.floor(observed?.maxOneToManySize ?? 0), 128)
        : null,
    maxTravelTimeMinutes,
    datasetEpoch: options.datasetEpoch ?? null,
  };
}

function combinedSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(30_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function asError(error: unknown, signal: AbortSignal): MotisReachabilityError {
  if (error instanceof MotisReachabilityError) return error;
  if (signal.aborted) {
    return new MotisReachabilityError("timeout", "MOTIS reachability request timed out", {
      cause: error,
    });
  }
  return new MotisReachabilityError("upstream", "MOTIS reachability request failed", {
    cause: error,
  });
}

function placeSeed(
  instance: MotisInstance,
  place: Place & { lat: number; lon: number },
  arrivalSeconds: number,
): TransitReachabilitySeed {
  return {
    lng: place.lon,
    lat: place.lat,
    arrivalSeconds,
    stop: {
      id: `${instance.prefix}${place.stopId ?? ""}`,
      name: place.name ?? "Unknown",
      modes: uniqueModes(place.modes ?? []),
      provider: instance.provider,
    },
  };
}

export async function getMotisReachabilitySeeds(
  instance: MotisInstance,
  request: TransitReachabilitySurfaceRequest,
  signal?: AbortSignal,
): Promise<TransitReachabilitySeed[]> {
  const requestSignal = combinedSignal(signal);
  try {
    const maxTravelTime = Math.max(...request.thresholdsMinutes);
    const result = await oneToAll({
      client: instance.client,
      signal: requestSignal,
      query: {
        one: `${request.origin.lat},${request.origin.lng}`,
        time: request.queryTime,
        arriveBy: false,
        maxTravelTime,
        pedestrianProfile: TRANSIT_WALK_PROFILE.pedestrianProfile,
        pedestrianSpeed: TRANSIT_WALK_PROFILE.speedMetresPerSecond,
        maxPreTransitTime: TRANSIT_WALK_PROFILE.accessSeconds,
        maxPostTransitTime: TRANSIT_WALK_PROFILE.egressSeconds,
        preTransitModes: ["WALK"],
        postTransitModes: ["WALK"],
        ...(request.transitModes?.length ? { transitModes: request.transitModes as Mode[] } : {}),
      },
    });
    if (!result.data || !Array.isArray(result.data.all)) {
      throw new MotisReachabilityError("invalid-response", "MOTIS one-to-all response is invalid");
    }
    const seeds: TransitReachabilitySeed[] = [];
    for (const reachable of result.data.all) {
      const place = reachable.place;
      if (
        !place?.stopId ||
        typeof place.lon !== "number" ||
        !Number.isFinite(place.lon) ||
        place.lon < -180 ||
        place.lon > 180 ||
        typeof place.lat !== "number" ||
        !Number.isFinite(place.lat) ||
        place.lat < -90 ||
        place.lat > 90 ||
        typeof reachable.duration !== "number" ||
        !Number.isFinite(reachable.duration) ||
        reachable.duration < 0
      ) {
        throw new MotisReachabilityError(
          "invalid-response",
          "MOTIS one-to-all response contains an invalid seed",
        );
      }
      seeds.push(placeSeed(instance, place, reachable.duration * 60));
    }
    return seeds;
  } catch (error) {
    throw asError(error, requestSignal);
  }
}

function bestDuration(response: OneToManyIntermodalResponse, index: number): number | null {
  const candidates: number[] = [];
  const street = response.street_durations?.[index]?.duration;
  if (typeof street === "number" && Number.isFinite(street)) candidates.push(street);
  for (const entry of response.transit_durations?.[index] ?? []) {
    if (typeof entry.duration === "number" && Number.isFinite(entry.duration)) {
      candidates.push(entry.duration);
    }
  }
  return candidates.length > 0 ? Math.min(...candidates) : null;
}

export async function checkMotisReachabilityDestinations(
  instance: MotisInstance,
  request: TransitReachabilityCheckRequest,
  maxBatchSize: number,
  signal?: AbortSignal,
): Promise<TransitReachabilityCheckResult> {
  if (!Number.isInteger(maxBatchSize) || maxBatchSize < 1) {
    throw new MotisReachabilityError("unsupported", "MOTIS exact reachability is not configured");
  }
  const requestSignal = combinedSignal(signal);
  const batchSize = Math.min(maxBatchSize, 128);
  const maxTravelTime = Math.max(...request.thresholdsMinutes);
  const results: TransitReachabilityCheckResult["results"] = [];
  try {
    for (let offset = 0; offset < request.destinations.length; offset += batchSize) {
      requestSignal.throwIfAborted();
      const destinations = request.destinations.slice(offset, offset + batchSize);
      const response = await oneToManyIntermodalPost({
        client: instance.client,
        signal: requestSignal,
        body: {
          one: `${request.origin.lat},${request.origin.lng}`,
          many: destinations.map(({ lat, lng }) => `${lat},${lng}`),
          time: request.queryTime,
          arriveBy: false,
          maxTravelTime,
          pedestrianProfile: TRANSIT_WALK_PROFILE.pedestrianProfile,
          pedestrianSpeed: TRANSIT_WALK_PROFILE.speedMetresPerSecond,
          transitModes: request.transitModes as Mode[] | undefined,
          preTransitModes: ["WALK"],
          postTransitModes: ["WALK"],
          directMode: "WALK",
          maxPreTransitTime: TRANSIT_WALK_PROFILE.accessSeconds,
          maxPostTransitTime: TRANSIT_WALK_PROFILE.egressSeconds,
          maxDirectTime: TRANSIT_WALK_PROFILE.directSeconds,
        },
      });
      const data = response.data;
      if (
        !data ||
        !Array.isArray(data.street_durations) ||
        !Array.isArray(data.transit_durations) ||
        data.street_durations.length !== destinations.length ||
        data.transit_durations.length !== destinations.length
      ) {
        throw new MotisReachabilityError(
          "invalid-response",
          "MOTIS one-to-many response does not align with destinations",
        );
      }
      for (let index = 0; index < destinations.length; index += 1) {
        const durationSeconds = bestDuration(data, index);
        results.push({
          id: destinations[index].id,
          durationSeconds,
          reachable: durationSeconds !== null && durationSeconds <= maxTravelTime * 60,
        });
      }
    }
    return { queryTime: request.queryTime, results };
  } catch (error) {
    throw asError(error, requestSignal);
  }
}
