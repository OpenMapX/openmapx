import { describe, expect, it, vi } from "vitest";
import { EvChargingProvider } from "./provider.js";

describe("EvChargingProvider.searchStations", () => {
  it("returns merged canonical stations with connectors intact", async () => {
    const station = {
      id: "s1",
      name: "A",
      coordinates: [6.9, 50.9] as [number, number],
      sources: ["ocm"],
      connectors: [{ type: "CCS", powerKw: 150, currentType: "dc" }],
    };
    const provider = new EvChargingProvider([
      { id: "ocm", priority: 1, search: vi.fn().mockResolvedValue([station]) },
    ]);
    const out = await provider.searchStations({ west: 6.8, south: 50.8, east: 7.0, north: 51.0 });
    expect(out).toHaveLength(1);
    expect(out[0].connectors[0].powerKw).toBe(150);
  });
});
