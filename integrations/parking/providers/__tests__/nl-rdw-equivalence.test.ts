import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ParkingFacility,
  ParkingType,
  RdwGeoRecord,
  RdwSpecsRecord,
} from "@openmapx/mobility-core/parking";
import { afterEach, beforeEach, vi } from "vitest";
import { mapNlRdwPayload } from "../nl-rdw-mapper.js";
import { parseNlRdwStatic } from "../nl-rdw-parser.js";
import { parkingEquivalenceContract } from "./support/parking-equivalence-contract.js";

/**
 * Pre-migration reference: query 3 GEO datasets + specs, join by
 * (areamanagerid, areaid). Source id is `nl-rdw` (prefix `nl-rdw:`).
 */

const TYPE_MAP: Record<string, ParkingType> = {
  GARAGEP: "garage",
  PARKRIDE: "surface",
  CARPOOL: "surface",
};

const GARAGE = JSON.parse(readFileSync(join(__dirname, "fixtures", "rdw-nl-garage.json"), "utf-8"));
const PNR = JSON.parse(readFileSync(join(__dirname, "fixtures", "rdw-nl-pnr.json"), "utf-8"));
const CARPOOL = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "rdw-nl-carpool.json"), "utf-8"),
);
const SPECS = readFileSync(join(__dirname, "fixtures", "rdw-nl-specs.json"));

const noopLog = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

function parsePositiveInt(v?: string): number | undefined {
  if (!v) return undefined;
  const n = Number.parseInt(v, 10);
  return !Number.isNaN(n) && n > 0 ? n : undefined;
}
function parseHeightCm(v?: string): number | undefined {
  if (!v) return undefined;
  const n = Number.parseFloat(v);
  if (Number.isNaN(n) || n <= 0) return undefined;
  return n < 10 ? Math.round(n * 100) : Math.round(n);
}

function refBuild(record: RdwGeoRecord, specs: RdwSpecsRecord | undefined): ParkingFacility | null {
  const lat = Number.parseFloat(record.location?.latitude);
  const lng = Number.parseFloat(record.location?.longitude);
  if (Number.isNaN(lat) || Number.isNaN(lng)) return null;
  const usageid = record.usageid ?? "GARAGEP";
  const isPnR = usageid === "PARKRIDE";

  const capacity =
    parsePositiveInt(specs?.capacity) ?? parsePositiveInt(record.aantal_parkeer_plaatsen);
  const chargingSpaces =
    parsePositiveInt(specs?.chargingpointcapacity) ?? parsePositiveInt(record.aantal_laad_punten);
  const maxHeight =
    parseHeightCm(specs?.maximumvehicleheight) ?? parseHeightCm(record.maximale_inrij_hoogte);
  const hasDisabledAccess =
    specs?.disabledaccess === "True" || record.toegankelijk_voor_gehandicapten === "Ja";

  return {
    id: `nl-rdw:${record.areamanagerid}/${record.areaid}`,
    name: record.areadesc || "Parking",
    coordinates: [lng, lat],
    sources: ["nl-rdw"],
    parkingType: TYPE_MAP[usageid] ?? "unknown",
    capacity,
    hasRealtimeData: false,
    disabledSpaces: hasDisabledAccess ? 1 : undefined,
    chargingSpaces,
    maxHeight,
    fee: "unknown",
    parkAndRide: isPnR || undefined,
  };
}

function runReference(): ParkingFacility[] {
  const specsList = JSON.parse(SPECS.toString("utf-8")) as RdwSpecsRecord[];
  const specsMap = new Map<string, RdwSpecsRecord>();
  for (const s of specsList) specsMap.set(`${s.areamanagerid}:${s.areaid}`, s);

  const all = [
    ...(GARAGE as RdwGeoRecord[]),
    ...(PNR as RdwGeoRecord[]),
    ...(CARPOOL as RdwGeoRecord[]),
  ];
  const out: ParkingFacility[] = [];
  for (const r of all) {
    const f = refBuild(r, specsMap.get(`${r.areamanagerid}:${r.areaid}`));
    if (f) out.push(f);
  }
  return out;
}

async function runMigrated(): Promise<ParkingFacility[]> {
  const iter = parseNlRdwStatic(SPECS, { log: noopLog });
  const list: ParkingFacility[] = [];
  for await (const row of iter) {
    list.push(mapNlRdwPayload(row.poiId, row.payload));
  }
  return list;
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("t5pc-eb34")) {
        return new Response(JSON.stringify(GARAGE), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("6wzd-evwu")) {
        return new Response(JSON.stringify(PNR), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("9c54-cmfx")) {
        return new Response(JSON.stringify(CARPOOL), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

parkingEquivalenceContract({
  name: "Dutch RDW",
  reference: runReference,
  migrated: runMigrated,
  fields: [
    "id",
    "name",
    "coordinates",
    "sources",
    "parkingType",
    "capacity",
    "hasRealtimeData",
    "disabledSpaces",
    "chargingSpaces",
    "maxHeight",
    "fee",
    "parkAndRide",
  ],
});
