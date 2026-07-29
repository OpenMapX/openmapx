import { describe, expect, it } from "vitest";
import { mergeDeOcpdbLive } from "../de-ocpdb-mapper.js";
import { createPayloadStationMapper } from "../payload-station.js";

// de-ocpdb now rehydrates its static tier through the shared mapper (see
// de-ocpdb.ts); its live-merge stays bespoke.
const mapStatic = createPayloadStationMapper({
  sourceId: "de-ocpdb",
  stationIdPrefix: "de-ocpdb:",
});

describe("de-ocpdb mapper", () => {
  it("maps payload to a station with the de-ocpdb prefix and source", () => {
    const station = mapStatic("42", {
      coordinates: [8.4, 49.0],
      name: "Test",
      connectors: [{ type: "Type 2" }],
      tariffs: [{ elements: [{ type: "energy", price: 0.66, currency: "EUR" }] }],
    });
    expect(station.id).toBe("de-ocpdb:42");
    expect(station.sources).toEqual(["de-ocpdb"]);
    expect(station.status).toBe("unknown");
    expect(station.tariffs).toHaveLength(1);
  });

  it("merges fresh live availability", () => {
    const base = mapStatic("42", { coordinates: [8.4, 49.0] });
    const merged = mergeDeOcpdbLive(base, {
      asOf: new Date().toISOString(),
      status: "operational",
      available: 2,
      total: 3,
    });
    expect(merged.status).toBe("operational");
    expect(merged.isLive).toBe(true);
    expect(merged.availability).toMatchObject({ available: 2, total: 3 });
  });
});
