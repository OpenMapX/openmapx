import type { EvChargingStation, EvChargingTariff } from "@openmapx/mobility-core/ev-charging";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mapNetherlandsPayload, mergeNetherlandsLive } from "../netherlands-mapper.js";

describe("mapNetherlandsPayload", () => {
  it("prefixes the station id nl-dotnl: and threads a single sourceItemIds entry", () => {
    const station = mapNetherlandsPayload("abc123", {
      coordinates: [5.01, 52.3],
      name: "Test Station",
      connectors: [],
    });
    expect(station.id).toBe("nl-dotnl:abc123");
    expect(station.sourceItemIds).toEqual(["nl-dotnl:abc123"]);
    expect(station.sources).toEqual(["netherlands-ev"]);
  });

  it("sets status unknown at static ingest regardless of payload contents", () => {
    const station = mapNetherlandsPayload("abc123", { coordinates: [5, 52], connectors: [] });
    expect(station.status).toBe("unknown");
  });

  it("falls back to a default name and [0,0] coordinates for a malformed payload", () => {
    const station = mapNetherlandsPayload("abc123", {});
    expect(station.name).toBe("EV Charging Station");
    expect(station.coordinates).toEqual([0, 0]);
  });

  it("passes address, operator, connectors, and tariffs through from the payload", () => {
    const tariff: EvChargingTariff = {
      elements: [{ type: "energy", price: 0.4, currency: "EUR" }],
      scope: "cpo",
      source: "netherlands-ev",
      updatedAt: "2026-07-20T10:00:00Z",
    };
    const station = mapNetherlandsPayload("abc123", {
      coordinates: [5, 52],
      address: { line1: "Street 1", town: "Town", postcode: "1234AB", country: "NL" },
      operator: { name: "Fastned" },
      connectors: [{ type: "Type 2", powerKw: 22, currentType: "AC" }],
      tariffs: [tariff],
    });
    expect(station.address).toEqual({
      line1: "Street 1",
      town: "Town",
      postcode: "1234AB",
      country: "NL",
    });
    expect(station.operator).toEqual({ name: "Fastned" });
    expect(station.connectors).toEqual([{ type: "Type 2", powerKw: 22, currentType: "AC" }]);
    expect(station.tariffs).toEqual([tariff]);
  });

  it("leaves tariffs undefined when the payload carries no tariffs", () => {
    const station = mapNetherlandsPayload("abc123", { coordinates: [5, 52], connectors: [] });
    expect(station.tariffs).toBeUndefined();
  });
});

describe("mergeNetherlandsLive", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T18:10:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const base: EvChargingStation = {
    id: "nl-dotnl:abc",
    sources: ["netherlands-ev"],
    sourceItemIds: ["nl-dotnl:abc"],
    name: "Test",
    coordinates: [5, 52],
    status: "unknown",
    connectors: [],
  };

  it("attaches availability and isLive when live data is fresh", () => {
    const live = { asOf: "2026-07-20T18:00:00Z", status: "operational", available: 1, total: 3 };
    const merged = mergeNetherlandsLive(base, live);
    expect(merged.status).toBe("operational");
    expect(merged.isLive).toBe(true);
    expect(merged.availability).toEqual({ available: 1, total: 3, updatedAt: live.asOf });
  });

  it("sets status unknown and drops availability/isLive when live data is stale", () => {
    // 50 min old > 30 min MAX_LIVE_AGE_MS.
    vi.setSystemTime(new Date("2026-07-20T18:50:00Z"));
    const live = { asOf: "2026-07-20T18:00:00Z", status: "operational", available: 1, total: 3 };
    const merged = mergeNetherlandsLive(base, live);
    expect(merged.status).toBe("unknown");
    expect(merged.isLive).toBeFalsy();
    expect(merged.availability).toBeUndefined();
  });

  it("returns base unchanged when live is null", () => {
    expect(mergeNetherlandsLive(base, null)).toBe(base);
  });

  it("returns base unchanged when live carries an invalid status value", () => {
    const merged = mergeNetherlandsLive(base, {
      asOf: "2026-07-20T18:00:00Z",
      status: "nonsense",
    });
    expect(merged).toBe(base);
  });
});
