import type { BBox } from "@openmapx/core";
import type { ServiceVehicle, ServiceVehicleProvider } from "@openmapx/integration-framework";
import type { OpenConditionsClient } from "../client.js";
import {
  boxAround,
  type Excluded,
  excludedBy,
  FeaturePositions,
  partialCoverage,
} from "../features/read.js";
import { type Rec, rec, str } from "../features/record.js";
import type { LiveSources } from "../sources.js";
import { readingToServiceVehicle } from "./map.js";

const PROVIDER_ID = "service-vehicles-openconditions";
/** Positions per page of `/observations/latest`. */
const PAGE = 1000;
/** The largest page read, in bytes: a position carries its full credit. */
const PAGE_MAX_BYTES = 16 * 1024 * 1024;
/** A read stops after this many positions; the view is then only part of the area. */
const MAX_POSITIONS = 3000;
/** How many searched positions the provider remembers the place of. */
const REMEMBERED = 5000;
/**
 * Half the side of the box a remembered position is followed in, in metres:
 * far enough for a vehicle that drove on for a few minutes.
 */
const FOLLOW_HALF_SIDE_M = 5000;

/** Whether two positions are the same place, to the publisher's six decimals. */
const samePlace = (a: readonly number[], b: readonly number[]): boolean =>
  Math.abs(a[0]! - b[0]!) < 1e-6 && Math.abs(a[1]! - b[1]!) < 1e-6;

interface WirePage {
  records?: unknown;
  next?: unknown;
  coverage?: { partial?: unknown; sources?: unknown };
}

export interface ServiceVehicleProviderOptions {
  remembered?: number;
  /** The clock a position's expiry is judged by. */
  now?: () => Date;
}

/**
 * A `service-vehicles` provider backed by the OpenConditions record API:
 * the `vehicle.position` readings in effect from `GET /observations/latest`.
 * A position names no vehicle, and its id changes each time the vehicle
 * reports (OpenConditions keeps one position per vehicle, replacing the
 * last), so there is nothing to open by id: a position a search returned is
 * opened by reading the area around where it was, and found by its id or
 * else by the next position of the same vehicle, the one that stands where
 * it stood or whose trail passes there. It is gone once it expired.
 *
 * It fails closed on the live source list: until the first list arrives
 * every search is empty and `unavailable`; after it, a position whose source
 * is not listed is left out, as is one of an excluded source. A read stops at
 * 3000 positions and then says the area is only partly covered.
 */
export function createServiceVehicleProvider(
  client: OpenConditionsClient,
  sources: LiveSources,
  options: ServiceVehicleProviderOptions = {},
): ServiceVehicleProvider {
  const now = options.now ?? (() => new Date());
  const seen = new FeaturePositions(options.remembered ?? REMEMBERED);

  const admitted = (record: Rec, excluded: Excluded, at: number): boolean => {
    const sourceId = str(rec(record.provenance).sourceId);
    if (sourceId === undefined || excluded(sourceId)) return false;
    const expires = Date.parse(str(rec(record.freshness).expiresAt) ?? "");
    return !(Number.isFinite(expires) && expires <= at);
  };

  async function read(
    bbox: BBox,
    excluded: Excluded,
  ): Promise<{ vehicles: ServiceVehicle[]; partArea: boolean }> {
    const vehicles: ServiceVehicle[] = [];
    let partArea = false;
    let read = 0;
    let cursor: string | null = null;
    let progressed = true;
    do {
      const page: WirePage = await client.get<WirePage>(
        "/observations/latest",
        {
          bbox: bbox.join(","),
          property: "vehicle.position",
          limit: Math.min(PAGE, MAX_POSITIONS - read),
          ...(cursor !== null ? { cursor } : {}),
        },
        { maxResponseBytes: PAGE_MAX_BYTES },
      );
      if (!Array.isArray(page.records) || (page.next != null && typeof page.next !== "string")) {
        throw new Error("Malformed /observations/latest page");
      }
      partArea ||= partialCoverage(page.coverage);
      cursor = (page.next as string | null | undefined) ?? null;
      read += page.records.length;
      // An empty page that points to another would be followed forever.
      progressed = page.records.length > 0;
      const at = now().getTime();
      for (const entry of page.records) {
        const record = rec(entry);
        if (!admitted(record, excluded, at)) continue;
        const vehicle = readingToServiceVehicle(record, sources);
        if (!vehicle) continue;
        seen.set([vehicle.id], vehicle.coordinates);
        vehicles.push(vehicle);
      }
    } while (cursor !== null && progressed && read < MAX_POSITIONS);
    return { vehicles, partArea: partArea || cursor !== null };
  }

  return {
    id: PROVIDER_ID,
    async searchVehicles(bbox, q) {
      // No list yet: every vehicle is missing until it arrives, whatever the view.
      if (!sources.ready) return { vehicles: [], partial: "unavailable" };
      const { vehicles, partArea } = await read(bbox, excludedBy(sources, q?.excludedSourceIds));
      return partArea ? { vehicles, partial: "area" } : { vehicles };
    },
    async getVehicle(id, q) {
      if (!sources.ready) return null;
      const at = seen.get(id);
      if (at === undefined) return null;
      const { vehicles } = await read(
        boxAround(at, FOLLOW_HALF_SIDE_M),
        excludedBy(sources, q?.excludedSourceIds),
      );
      const same = vehicles.find((v) => v.id === id);
      if (same) return same;
      // The vehicle reported again: its next position stands where it stood, or
      // its trail passes there. Without a trail through it, it is gone.
      const next = vehicles.find(
        (v) => samePlace(v.coordinates, at) || (v.trail ?? []).some((p) => samePlace(p, at)),
      );
      if (!next) return null;
      seen.set([id, next.id], next.coordinates);
      return { ...next, id };
    },
  };
}
