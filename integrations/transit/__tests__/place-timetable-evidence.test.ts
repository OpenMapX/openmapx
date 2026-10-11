import type { IntegrationContext } from "@openmapx/integration-framework";
import type { MobilityResult } from "@openmapx/mobility-core/result";
import type { Departure, TransitStop } from "@openmapx/mobility-core/transit";
import { describe, expect, it, vi } from "vitest";
import type { TransitOrchestrator } from "../orchestrator.js";
import { createPlaceTransit } from "../place-transit.js";

const stops: TransitStop[] = ["ms", "mo"].map((provider) => ({
  id: `${provider}:root`,
  provider,
  name: "Aachen Central",
  lat: 50.775,
  lng: 6.084,
  modes: ["rail"],
}));
function result<T>(data: T): MobilityResult<T> {
  return {
    data,
    attributions: [],
    freshness: { fetchedAt: "2026-10-07T08:00:00Z", hasRealtimeData: false, isStale: false },
  };
}
const departure: Departure = {
  tripId: "ms:trip",
  route: { id: "ms:line", shortName: "RE1", longName: "", mode: "rail" },
  headsign: "Düren",
  scheduledAt: "2026-10-07T08:10:00Z",
};
function resolver(fetch: (id: string) => Promise<MobilityResult<Departure[]>>, discovered = stops) {
  const ctx = {
    cache: { withCache: (_key: string, _ttl: number, load: () => unknown) => load() },
  } as unknown as IntegrationContext;
  const orchestrator = {
    searchByNameRaw: vi.fn(async () => result(discovered)),
    getDepartures: fetch,
    getArrivals: fetch,
  } as unknown as TransitOrchestrator;
  return createPlaceTransit(ctx, orchestrator);
}

describe("linked timetable source failures", () => {
  it.each(["getMergedDepartures", "getMergedArrivals"] as const)(
    "%s retains successful scheduled results with explicit incomplete coverage",
    async (method) => {
      const api = resolver(async (id) => {
        if (id.startsWith("mo:")) throw new Error("upstream failed");
        return result([departure]);
      });
      const response = await api[method](50.775, 6.084, "Aachen Central", 60);
      expect(response.data).toHaveLength(1);
      expect(response.data[0]).toMatchObject({
        tripId: "ms:trip",
        route: { id: "ms:line" },
        providers: ["ms"],
      });
      expect(response.freshness).toMatchObject({ isPartial: true, hasRealtimeData: false });
    },
  );
  it("rejects total provider failure so a cached timetable is not replaced by a successful empty answer", async () => {
    const api = resolver(async () => {
      throw new Error("secret upstream details");
    });
    await expect(api.getMergedDepartures(50.775, 6.084, "Aachen Central", 60)).rejects.toThrow(
      "Transit timetable sources unavailable",
    );
  });
  it("keeps an independently successful empty timetable and zero linked stops valid", async () => {
    const fetch = vi.fn(async () => result<Departure[]>([]));
    expect(
      (await resolver(fetch).getMergedDepartures(50.775, 6.084, "Aachen Central", 60)).data,
    ).toEqual([]);
    expect(
      (await resolver(fetch, []).getMergedDepartures(50.775, 6.084, "Aachen Central", 60)).data,
    ).toEqual([]);
  });
});
