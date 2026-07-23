import { describe, expect, it } from "vitest";
import { mapDeOcpdbPayload, mergeDeOcpdbLive } from "../de-ocpdb-mapper.js";

describe("de-ocpdb mapper", () => {
  it("maps payload to a station with the de-ocpdb prefix and source", () => {
    const station = mapDeOcpdbPayload("42", {
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
    const base = mapDeOcpdbPayload("42", { coordinates: [8.4, 49.0] });
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
