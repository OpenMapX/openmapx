import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeMobidromBundledParser, mobidromSiteToPayload } from "../mobidrom-bundled-parser.js";
import type { MobidromSiteBean } from "../mobidrom-common.js";
import { makeMobidromMapper, mergeMobidromLive } from "../mobidrom-mapper.js";

// Fixture asOf is 2026-05-23T10:00:00Z; anchor wall-clock 10 min later so the
// shared isLiveTooStale gate (30 min) leaves hasRealtimeData=true.
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-05-23T10:10:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

const FIXTURE = readFileSync(join(__dirname, "fixtures", "mobidrom-sample.json"));

const noopLog = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

describe("makeMobidromBundledParser", () => {
  it("emits one static row per geolocated record and skips records without coords", async () => {
    const parser = makeMobidromBundledParser({
      idPrefix: "nrw",
      sourceId: "nrw-mobidrom-parking",
    });
    const { static: rows, live } = await parser(FIXTURE, { log: noopLog });
    expect(rows.map((r) => r.poiId)).toEqual(["MS-001", "DUS-PR-7", "AC-44"]);
    // Only the records with availableSpaces != null land in the live map.
    expect([...live.keys()].sort()).toEqual(["AC-44", "MS-001"]);
  });

  it("normalises [lat,lng] records into GeoJSON [lng,lat]", async () => {
    const parser = makeMobidromBundledParser({
      idPrefix: "x",
      sourceId: "nrw-mobidrom-parking",
    });
    const { static: rows } = await parser(FIXTURE, { log: noopLog });
    // AC-44's source coords are [50.78, 6.08] (lat,lng-shaped) → must be flipped.
    const ac = rows.find((r) => r.poiId === "AC-44");
    expect(ac).toBeDefined();
    expect(ac?.lng).toBeCloseTo(6.08, 5);
    expect(ac?.lat).toBeCloseTo(50.78, 5);
  });

  it("captures the upstream publicationTime in live.asOf when present", async () => {
    const parser = makeMobidromBundledParser({
      idPrefix: "nrw",
      sourceId: "nrw-mobidrom-parking",
    });
    const { live } = await parser(FIXTURE, { log: noopLog });
    expect(live.get("MS-001")?.asOf).toBe("2026-05-23T10:00:00Z");
    // AC-44 has no publicationTime → falls back to "now" (ISO 8601 string).
    const acAsOf = live.get("AC-44")?.asOf;
    expect(typeof acAsOf).toBe("string");
    expect(acAsOf && Date.parse(acAsOf)).toBeGreaterThan(0);
  });

  it("honours forceParkAndRide for the P+R feed", async () => {
    const parser = makeMobidromBundledParser({
      idPrefix: "nrw-pr",
      sourceId: "nrw-mobidrom-pr",
      forceParkAndRide: true,
    });
    const { static: rows } = await parser(FIXTURE, { log: noopLog });
    for (const r of rows) {
      expect((r.payload as { parkAndRide?: boolean }).parkAndRide).toBe(true);
    }
  });
});

describe("mobidromSiteToPayload", () => {
  it("derives tiefgarage → underground from text when type is absent", () => {
    const site: MobidromSiteBean = {
      externalId: "T-1",
      name: "Tiefgarage am Markt",
      description: null,
      numberOfSpaces: 100,
    };
    const payload = mobidromSiteToPayload(site, {}, [6.0, 50.0]);
    expect(payload.parkingType).toBe("underground");
  });

  it("derives paid fee from tariff descriptions when freeParking is absent", () => {
    const site: MobidromSiteBean = {
      externalId: "F-1",
      tariffDescription: ["1h: 2 EUR"],
    };
    const payload = mobidromSiteToPayload(site, {}, [6.0, 50.0]);
    expect(payload.fee).toBe("paid");
  });

  it("extracts disabled spaces from assignedFor and falls back to equipment keyword", () => {
    const site: MobidromSiteBean = {
      externalId: "D-1",
      assignedFor: [{ user: "DISABLED", availableSpaces: 3 }],
    };
    expect(mobidromSiteToPayload(site, {}, [6, 50]).disabledSpaces).toBe(3);
    const site2: MobidromSiteBean = {
      externalId: "D-2",
      equipmentAndServices: ["behindertengerechte Plätze"],
    };
    expect(mobidromSiteToPayload(site2, {}, [6, 50]).disabledSpaces).toBe(1);
  });

  it("converts max height meters to centimeters", () => {
    const site: MobidromSiteBean = {
      externalId: "H-1",
      locationAndDimension: { dimension: { height: 2.05 } },
    };
    expect(mobidromSiteToPayload(site, {}, [6, 50]).maxHeight).toBe(205);
  });

  it("maps isOpenNow to state and defaults to unknown", () => {
    expect(mobidromSiteToPayload({ externalId: "X", isOpenNow: true }, {}, [6, 50]).state).toBe(
      "open",
    );
    expect(mobidromSiteToPayload({ externalId: "X", isOpenNow: false }, {}, [6, 50]).state).toBe(
      "closed",
    );
    expect(mobidromSiteToPayload({ externalId: "X" }, {}, [6, 50]).state).toBe("unknown");
  });
});

describe("makeMobidromMapper + mergeMobidromLive", () => {
  it("reconstructs a ParkingFacility with hasRealtimeData=false from payload alone", () => {
    const mapper = makeMobidromMapper({ sourceId: "apag", idPrefix: "apag" });
    const facility = mapper("XYZ", {
      coordinates: [6.08, 50.78],
      name: "Parkhaus Foo",
      parkingType: "garage",
      capacity: 100,
      state: "open",
      fee: "paid",
    });
    expect(facility.id).toBe("apag:XYZ");
    expect(facility.sources).toEqual(["apag"]);
    expect(facility.hasRealtimeData).toBe(false);
    expect(facility.freeSpaces).toBeUndefined();
  });

  it("falls back to the registered operatorName when payload omits operator", () => {
    const mapper = makeMobidromMapper({
      sourceId: "apag",
      idPrefix: "apag",
      operatorName: "APAG",
    });
    const f = mapper("Z", { coordinates: [6, 50], name: "P" });
    expect(f.operator).toBe("APAG");
  });

  it("mergeMobidromLive flips hasRealtimeData and writes freshness fields", () => {
    const mapper = makeMobidromMapper({ sourceId: "apag", idPrefix: "apag" });
    const base = mapper("XYZ", { coordinates: [6, 50], name: "P", capacity: 100 });
    const merged = mergeMobidromLive(base, {
      asOf: "2026-05-23T11:00:00Z",
      freeSpaces: 12,
      capacity: 100,
    });
    expect(merged.freeSpaces).toBe(12);
    expect(merged.hasRealtimeData).toBe(true);
    expect(merged.dataUpdatedAt).toBe("2026-05-23T11:00:00Z");
    expect(merged.realtimeDataUpdatedAt).toBe("2026-05-23T11:00:00Z");
  });

  it("mergeMobidromLive is a no-op when live is null or carries no freeSpaces", () => {
    const mapper = makeMobidromMapper({ sourceId: "apag", idPrefix: "apag" });
    const base = mapper("XYZ", { coordinates: [6, 50], name: "P" });
    expect(mergeMobidromLive(base, null)).toBe(base);
    expect(mergeMobidromLive(base, { asOf: "2026-05-23T11:00:00Z" })).toBe(base);
  });
});
