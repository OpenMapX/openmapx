import {
  latticePointAt,
  planIsochroneLattice,
  type TravelTimeField,
} from "@openmapx/mobility-core/isoline";
import type { MotisInstance } from "@openmapx/mobility-core/motis-client";
import {
  MAX_TRANSIT_ISOCHRONE_AREA_KM2,
  type TransitIsochroneRequest,
} from "@openmapx/mobility-core/transit-isochrone";
import { MotisReachabilityError, runOneToManyBatch } from "./reachability.js";

/** MOTIS's own default `onetomany_max_many_`; never exceed it regardless of advertisement. */
export const MAX_ONE_TO_MANY_BATCH = 128;

export interface SampleFieldOptions {
  /** The runtime's advertised `maxOneToManySize`. */
  maxBatchSize: number;
  maxSamples: number;
  /** Wall-clock budget across every batch. */
  deadlineMs: number;
  maxAreaKm2?: number;
}

/**
 * Sample MOTIS travel times across a bounded lattice.
 *
 * Batches run sequentially: MOTIS performs one timetable search per request and
 * reuses it for the whole batch, so concurrency would multiply that search
 * without improving throughput while adding load the journey planner competes
 * with. Failure is all-or-nothing — a field missing a failed batch's samples
 * would contour that region as unreachable, which is silently wrong rather than
 * visibly broken.
 */
export async function sampleMotisTravelTimeField(
  instance: MotisInstance,
  request: TransitIsochroneRequest,
  options: SampleFieldOptions,
  signal?: AbortSignal,
): Promise<TravelTimeField> {
  const lattice = planIsochroneLattice({
    bbox: request.bbox,
    maxSamples: options.maxSamples,
    maxAreaKm2: options.maxAreaKm2 ?? MAX_TRANSIT_ISOCHRONE_AREA_KM2,
  });

  const deadline = AbortSignal.timeout(options.deadlineMs);
  const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;

  const batchSize = Math.max(1, Math.min(Math.floor(options.maxBatchSize), MAX_ONE_TO_MANY_BATCH));
  const total = lattice.nx * lattice.ny;
  const values: (number | null)[] = new Array(total).fill(null);
  let batchCount = 0;
  let unreachableCount = 0;

  try {
    for (let offset = 0; offset < total; offset += batchSize) {
      requestSignal.throwIfAborted();
      const size = Math.min(batchSize, total - offset);
      const destinations = Array.from({ length: size }, (_, index) => {
        const [lng, lat] = latticePointAt(lattice, offset + index);
        return { lat, lng };
      });
      const durations = await runOneToManyBatch(instance, request, destinations, requestSignal);
      for (let index = 0; index < size; index += 1) values[offset + index] = durations[index];
      batchCount += 1;
    }
  } catch (error) {
    if (error instanceof MotisReachabilityError) throw error;
    if (requestSignal.aborted) {
      throw new MotisReachabilityError("timeout", "MOTIS reachability sampling timed out", {
        cause: error,
      });
    }
    throw new MotisReachabilityError("upstream", "MOTIS reachability sampling failed", {
      cause: error,
    });
  }

  for (const value of values) if (value === null) unreachableCount += 1;
  return { lattice, values, batchCount, unreachableCount };
}
