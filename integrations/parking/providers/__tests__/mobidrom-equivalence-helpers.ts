import type { ParkingFacility, ParkingType } from "@openmapx/mobility-core/parking";
import { afterEach, beforeEach, vi } from "vitest";
import { makeMobidromBundledParser } from "../mobidrom-bundled-parser.js";
import {
  fixMojibakeString,
  type MobidromMapOptions,
  type MobidromSiteBean,
} from "../mobidrom-common.js";
import { makeMobidromMapper, mergeMobidromLive } from "../mobidrom-mapper.js";
import { parkingEquivalenceContract } from "./support/parking-equivalence-contract.js";

/**
 * Reference implementation of the pre-migration `mapMobidromSite` + URL fetcher
 * loop, lifted verbatim from the prior `mobidrom-common.ts` for byte-identical
 * equivalence checks. All five Mobidrom-family equivalence tests share this
 * file so the reference is unambiguous.
 */

export function refParseFeed(buffer: Buffer): MobidromSiteBean[] {
  const text = buffer.toString("utf-8");
  return JSON.parse(text, (_k, v) => (typeof v === "string" ? fixMojibakeString(v) : v));
}

function normalizeCoordinates(raw: [number, number] | undefined): [number, number] | null {
  if (raw?.length !== 2) return null;
  const [a, b] = raw;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (a > 20 && b < 20) return [b, a];
  return [a, b];
}

function refMapParkingType(site: MobidromSiteBean): ParkingType {
  if (site.type === "CAR_PARK") return "garage";
  if (site.type === "OFF_STREET_PARKING_GROUND") return "surface";
  const desc = `${site.name ?? ""} ${site.description ?? ""}`.toLowerCase();
  if (desc.includes("tiefgarage")) return "underground";
  if (desc.includes("parkhaus")) return "garage";
  if (desc.includes("parkplatz")) return "surface";
  return "unknown";
}

function refMapFee(site: MobidromSiteBean): "free" | "paid" | "unknown" | undefined {
  if (site.freeParking === true) return "free";
  if (site.freeParking === false) return "paid";
  if (site.tariffDescription && site.tariffDescription.length > 0) return "paid";
  return undefined;
}

function refExtractDisabledSpaces(site: MobidromSiteBean): number | undefined {
  for (const a of site.assignedFor ?? []) {
    const isDisabled = a.user === "DISABLED" || a.additionalAssignment === "DISABLED";
    if (isDisabled) return a.availableSpaces ?? 1;
  }
  if ((site.equipmentAndServices ?? []).some((e) => /behinderten/i.test(e))) {
    return 1;
  }
  return undefined;
}

function refExtractChargingSpaces(site: MobidromSiteBean): number | undefined {
  for (const a of site.assignedFor ?? []) {
    if (a.fuelType === "BATTERY" || a.fuelType === "ELECTRIC") {
      return a.availableSpaces ?? 1;
    }
  }
  if ((site.equipmentAndServices ?? []).some((e) => /aufladen|ladesäule|ladestation/i.test(e))) {
    return 1;
  }
  return undefined;
}

function refParkAndRide(site: MobidromSiteBean): boolean | undefined {
  const haystack = [site.name ?? "", site.description ?? "", ...(site.zoneDescription ?? [])]
    .join(" ")
    .toLowerCase();
  if (/p\+r|park\s*&\s*ride|park\+ride|parkandride/.test(haystack)) return true;
  return undefined;
}

export function refMapMobidromSite(
  site: MobidromSiteBean,
  opts: MobidromMapOptions,
): ParkingFacility | null {
  const coords = normalizeCoordinates(
    site.locationAndDimension?.coordinatesForDisplay?.geometry?.coordinates,
  );
  if (!coords) return null;
  const name = site.name || site.description || "Parking";
  const openingHours = site.openingTimesDescription?.filter(Boolean).join("; ") || undefined;
  const tariffText = site.tariffDescription?.filter(Boolean).join("\n") || undefined;
  const maxHeightMeters = site.locationAndDimension?.dimension?.height ?? undefined;
  return {
    id: `${opts.idPrefix}:${site.externalId}`,
    name,
    coordinates: coords,
    sources: [opts.sourceId],
    parkingType: refMapParkingType(site),
    capacity: site.numberOfSpaces ?? undefined,
    freeSpaces: site.availableSpaces ?? undefined,
    hasRealtimeData: site.availableSpaces != null,
    disabledSpaces: refExtractDisabledSpaces(site),
    chargingSpaces: refExtractChargingSpaces(site),
    maxHeight: maxHeightMeters != null ? Math.round(maxHeightMeters * 100) : undefined,
    fee: refMapFee(site),
    feeDescription: tariffText,
    operator: opts.operatorName,
    address: site.locationAndDimension?.locationDescriptor ?? undefined,
    openingHours,
    state: site.isOpenNow === false ? "closed" : site.isOpenNow === true ? "open" : "unknown",
    parkAndRide: opts.forceParkAndRide || refParkAndRide(site),
    url: site.urlLinkAddress ?? undefined,
  };
}

export function refRunAll(buffer: Buffer, opts: MobidromMapOptions): ParkingFacility[] {
  const sites = refParseFeed(buffer);
  const out: ParkingFacility[] = [];
  for (const site of sites) {
    const facility = refMapMobidromSite(site, opts);
    if (facility) out.push(facility);
  }
  return out;
}

const noopLog = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

/**
 * Run the migrated bundled-parse → mapper → mergeLive pipeline end-to-end
 * against a feed buffer, with one normalisation: the post-migration live
 * `asOf` is materialised in the merged facility (`dataUpdatedAt`/
 * `realtimeDataUpdatedAt`), but the pre-migration mapper never wrote those
 * fields. We strip them before comparing so equivalence is over the fields
 * the old code populated.
 */
export async function migratedRunAll(
  buffer: Buffer,
  opts: MobidromMapOptions,
): Promise<ParkingFacility[]> {
  const parser = makeMobidromBundledParser(opts);
  const { static: rows, live } = await parser(buffer, { log: noopLog });
  const mapper = makeMobidromMapper(opts);
  return rows.map((row) => {
    const base = mapper(row.poiId, row.payload);
    const merged = mergeMobidromLive(base, live.get(row.poiId) ?? null);
    // Drop fields the pre-migration impl did not write so the equivalence
    // check stays strict on the fields it did write.
    const { dataUpdatedAt: _d, realtimeDataUpdatedAt: _r, ...rest } = merged;
    return rest as ParkingFacility;
  });
}

export function mobidromParkingEquivalenceContract(
  name: string,
  buffer: Buffer,
  options: MobidromMapOptions,
): void {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-23T10:10:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  parkingEquivalenceContract({
    name,
    reference: () => refRunAll(buffer, options),
    migrated: () => migratedRunAll(buffer, options),
    fields: [
      "id",
      "name",
      "coordinates",
      "sources",
      "parkingType",
      "capacity",
      "freeSpaces",
      "hasRealtimeData",
      "disabledSpaces",
      "chargingSpaces",
      "maxHeight",
      "fee",
      "feeDescription",
      "operator",
      "address",
      "openingHours",
      "state",
      "parkAndRide",
      "url",
    ],
  });
}
