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
    cache: {
      get: async () => null,
      set: async () => {},
      withCache: (_key: string, _ttl: number, load: () => unknown) => load(),
    },
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
      const response = await api[method]({ lat: 50.775, lng: 6.084, name: "Aachen Central" }, 60);
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
    await expect(
      api.getMergedDepartures({ lat: 50.775, lng: 6.084, name: "Aachen Central" }, 60),
    ).rejects.toThrow("Transit timetable sources unavailable");
  });
  it("keeps an independently successful empty timetable and zero linked stops valid", async () => {
    const fetch = vi.fn(async () => result<Departure[]>([]));
    expect(
      (
        await resolver(fetch).getMergedDepartures(
          { lat: 50.775, lng: 6.084, name: "Aachen Central" },
          60,
        )
      ).data,
    ).toEqual([]);
    expect(
      (
        await resolver(fetch, []).getMergedDepartures(
          { lat: 50.775, lng: 6.084, name: "Aachen Central" },
          60,
        )
      ).data,
    ).toEqual([]);
  });
});

describe("linked stop discovery failures", () => {
  function discovering(search: TransitOrchestrator["searchByNameRaw"]) {
    const ctx = {
      cache: {
        get: async () => null,
        set: async () => {},
        withCache: (_key: string, _ttl: number, load: () => unknown) => load(),
      },
    } as unknown as IntegrationContext;
    const fetch = vi.fn(async () => result([departure]));
    const orchestrator = {
      searchByNameRaw: search,
      getDepartures: fetch,
      getArrivals: fetch,
    } as unknown as TransitOrchestrator;
    return createPlaceTransit(ctx, orchestrator);
  }

  it("answers an empty board from a partial discovery as incomplete, not as no service", async () => {
    const partial = result<TransitStop[]>([]);
    partial.freshness.isPartial = true;
    const api = discovering(vi.fn(async () => partial));

    const board = await api.getMergedDepartures(
      { lat: 50.775, lng: 6.084, name: "Aachen Central" },
      60,
    );

    expect(board.data).toEqual([]);
    expect(board.freshness.isPartial).toBe(true);
  });

  it("keeps the stops found by one name variant when another variant's search fails", async () => {
    const search = vi.fn(async (query: string) => {
      if (query === "Aachen Hauptbahnhof") throw new Error("Transit stop sources unavailable");
      return result(stops.map((stop) => ({ ...stop, name: "Aachen Hbf" })));
    });
    const api = discovering(search as unknown as TransitOrchestrator["searchByNameRaw"]);

    const linked = await api.getLinkedStops({ lat: 50.775, lng: 6.084, name: "Aachen Hbf" });

    expect(search.mock.calls.map(([query]) => query)).toEqual(
      expect.arrayContaining(["Aachen Hbf", "Aachen Hauptbahnhof"]),
    );
    expect(linked.data.map((stop) => stop.id)).toEqual(["ms:root", "mo:root"]);
    expect(linked.freshness.isPartial).toBe(true);
  });

  it("rejects when no stop search answered, so the board reports a failure", async () => {
    const api = discovering(
      vi.fn(async () => {
        throw new Error("Transit stop sources unavailable");
      }),
    );

    await expect(
      api.getMergedDepartures({ lat: 50.775, lng: 6.084, name: "Aachen Central" }, 60),
    ).rejects.toThrow("Transit stop sources unavailable");
  });
});

describe("linked stop line, alert and facility failures", () => {
  const panels = {
    getMergedRoutes: ["getRoutesForStop", "route"],
    getMergedAlerts: ["getStopAlerts", "alert"],
    getMergedFacilities: ["getFacilities", "facility"],
  } as const;

  function linked(lookup: (id: string) => Promise<MobilityResult<unknown[]>>) {
    const ctx = {
      cache: {
        get: async () => null,
        set: async () => {},
        withCache: (_key: string, _ttl: number, load: () => unknown) => load(),
      },
    } as unknown as IntegrationContext;
    const orchestrator = {
      searchByNameRaw: vi.fn(async () => result(stops)),
      collectProviders: () => [],
      getRoutesForStop: lookup,
      getStopAlerts: lookup,
      getFacilities: lookup,
    } as unknown as TransitOrchestrator;
    return createPlaceTransit(ctx, orchestrator);
  }

  it.each(Object.keys(panels) as (keyof typeof panels)[])(
    "%s keeps what one stop answered and marks the panel incomplete when another stop failed",
    async (panel) => {
      const api = linked(async (id) => {
        if (id.startsWith("mo:")) throw new Error("upstream failed");
        return result([]);
      });
      const response = await api[panel]({ lat: 50.775, lng: 6.084, name: "Aachen Central" });
      expect(response.freshness.isPartial).toBe(true);
    },
  );

  it.each(Object.entries(panels) as [keyof typeof panels, (typeof panels)[keyof typeof panels]][])(
    "%s rejects when every linked stop's lookup failed",
    async (panel, [, what]) => {
      const api = linked(async () => {
        throw new Error("upstream failed");
      });
      await expect(api[panel]({ lat: 50.775, lng: 6.084, name: "Aachen Central" })).rejects.toThrow(
        `Transit ${what} sources unavailable`,
      );
    },
  );
});
