import {
  createGeocoderSuggestionProvider,
  runWithProviderDeadline,
} from "@openmapx/integration-framework";
import {
  type FakeMobilityHttpTransport,
  fakeMobilityHttpTransport,
} from "@openmapx/integration-framework/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dbRisGeocodingService, lookupDbStation, setRisCredentials } from "./provider.js";
import type { RisStopPlace } from "./stations-types.js";

let mockFetch: ReturnType<typeof vi.fn>;
let transport: FakeMobilityHttpTransport;

function mockOk(data: unknown) {
  return data;
}

const KOELN_HBF: RisStopPlace = {
  evaNumber: "8000207",
  names: { DE: { nameLong: "Köln Hbf" }, EN: { nameLong: "Cologne Central" } },
  metropolis: { DE: "Köln", EN: "Cologne" },
  position: { longitude: 6.9589, latitude: 50.9431 },
  availableTransports: [{ type: "HIGH_SPEED_TRAIN" }, { type: "SUBWAY" }, { type: "BUS" }],
};

beforeEach(() => {
  mockFetch = vi.fn();
  transport = fakeMobilityHttpTransport(mockFetch);
  setRisCredentials({ clientId: "cid", apiKey: "key" }, transport);
});

afterEach(() => {
  setRisCredentials({}, transport);
  vi.restoreAllMocks();
});

describe("dbRisGeocodingService.geocode", () => {
  it("maps stop places to eva-prefixed search results", async () => {
    mockFetch.mockResolvedValueOnce(mockOk({ stopPlaces: [KOELN_HBF] }));

    const results = await dbRisGeocodingService.geocode("Köln", "en");

    expect(results).toEqual([
      {
        id: "eva:8000207",
        label: "Cologne Central, Cologne",
        coordinates: [6.9589, 50.9431],
        type: "poi",
        confidence: 1,
        rawCategory: "railway/station",
      },
    ]);
    const url = transport.calls[0]?.url ?? "";
    expect(url).toContain("/stop-places/by-name/");
    expect(url).toContain("limit=10");
  });

  it("returns an empty array when credentials are not configured", async () => {
    setRisCredentials({}, transport);
    expect(await dbRisGeocodingService.geocode("Köln")).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("swallows upstream errors and returns an empty array", async () => {
    mockFetch.mockRejectedValueOnce(new Error("HTTP 503"));
    expect(await dbRisGeocodingService.geocode("Köln")).toEqual([]);
  });
});

describe("dbRisGeocodingService.autocomplete", () => {
  it("maps stop places to transit_stop autocomplete results", async () => {
    mockFetch.mockResolvedValueOnce(mockOk({ stopPlaces: [KOELN_HBF] }));

    const results = await dbRisGeocodingService.autocomplete("Köln");

    expect(results).toEqual([
      {
        id: "eva:8000207",
        ids: { eva: "8000207" },
        label: "Köln Hbf",
        sublabel: "Köln",
        coordinates: [6.9589, 50.9431],
        type: "transit_stop",
        transitStop: {
          id: "eva:8000207",
          primaryScheme: "eva",
          ids: { eva: "8000207" },
          name: "Köln Hbf",
          lat: 50.9431,
          lng: 6.9589,
          modes: ["rail", "subway", "bus"],
          provider: "db-ris",
        },
        rawCategory: "railway/station",
      },
    ]);
    expect(transport.calls[0]?.url).toContain("limit=6");
  });
});

describe("dbRisGeocodingService.reverseGeocode", () => {
  it("returns the nearest station name and city for the requested language", async () => {
    mockFetch.mockResolvedValueOnce(mockOk({ stopPlaces: [KOELN_HBF] }));

    const result = await dbRisGeocodingService.reverseGeocode(50.9431, 6.9589, "en");

    expect(result).toEqual({ address: "Cologne Central", city: "Cologne" });
    const url = transport.calls[0]?.url ?? "";
    expect(url).toContain("/stop-places/by-position");
    expect(url).toContain("latitude=50.9431");
    expect(url).toContain("radius=200");
  });

  it("falls back to the EVA number when no localized name exists", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({
        stopPlaces: [{ evaNumber: "999", names: {}, position: { longitude: 1, latitude: 2 } }],
      }),
    );

    const result = await dbRisGeocodingService.reverseGeocode(2, 1);
    expect(result).toEqual({ address: "EVA 999", city: "" });
  });

  it("returns null when no station is near the point", async () => {
    mockFetch.mockResolvedValueOnce(mockOk({ stopPlaces: [] }));
    expect(await dbRisGeocodingService.reverseGeocode(0, 0)).toBeNull();
  });
});

describe("lookupDbStation", () => {
  it("merges the base place with a station detail built from all sub-endpoints", async () => {
    mockFetch
      .mockResolvedValueOnce(mockOk(KOELN_HBF))
      .mockResolvedValueOnce(
        mockOk({
          platforms: [{ name: "1", length: 400, accessibility: { stepFreeAccess: true } }],
        }),
      )
      .mockResolvedValueOnce(
        mockOk({ connectingTimes: [{ type: "COMMUTER", defaultDuration: 5 }] }),
      )
      .mockResolvedValueOnce(mockOk({ localServices: [{ name: "Lockers", category: "storage" }] }));

    const result = await lookupDbStation("8000207", "en");

    expect(result).toMatchObject({
      id: "eva:8000207",
      name: "Cologne Central",
      city: "Cologne",
    });
    const detail = result.dataSourceDetail as { source: string; sections: unknown[] };
    expect(detail.source).toBe("db-station");
    expect(detail.sections).toHaveLength(3);
  });

  it("tolerates failures in the optional detail endpoints", async () => {
    mockFetch
      .mockResolvedValueOnce(mockOk(KOELN_HBF))
      .mockRejectedValueOnce(new Error("HTTP 500"))
      .mockRejectedValueOnce(new Error("HTTP 500"))
      .mockRejectedValueOnce(new Error("HTTP 500"));

    const result = await lookupDbStation("8000207");
    const detail = result.dataSourceDetail as { sections: unknown[] };
    expect(detail.sections).toEqual([]);
  });
});

// These use the real suggestion adapter and provider, replacing only upstream I/O.
describe("autocomplete cancellation through the suggestion adapter", () => {
  it.each(["deadline", "caller"] as const)(
    "aborts downstream I/O on %s and permits retry",
    async (mode) => {
      let downstreamSignal: AbortSignal | undefined;
      let release!: () => void;
      mockFetch.mockImplementationOnce(
        (request: { options?: { signal?: AbortSignal } }) =>
          new Promise((resolve) => {
            downstreamSignal = request.options?.signal;
            release = () => resolve(mockOk({ stopPlaces: [] }));
          }),
      );
      const provider = createGeocoderSuggestionProvider({
        id: "geocoding-db-ris",
        geocoder: dbRisGeocodingService,
        attributions: () => [],
      });
      const controller = new AbortController();
      const pending = runWithProviderDeadline(
        (context) =>
          provider.searchSuggestions({ query: "station", lang: "en", limit: 8 }, context),
        { signal: controller.signal, timeoutMs: mode === "deadline" ? 30 : 1_000 },
      );
      const outcome = pending.catch((error: Error) => error);
      try {
        // I/O starts synchronously once the provider's microtask is dispatched.
        await Promise.resolve();
        await Promise.resolve();
        if (mode === "caller") controller.abort(new Error("caller left"));
        expect((await outcome).name).toBe(
          mode === "deadline" ? "ProviderTimeoutError" : "ProviderCancelledError",
        );
        expect(downstreamSignal?.aborted).toBe(true);
      } finally {
        release();
        await outcome;
      }
      mockFetch.mockResolvedValueOnce(mockOk({ stopPlaces: [] }));
      await expect(
        provider.searchSuggestions(
          { query: "station", lang: "en", limit: 8 },
          { signal: new AbortController().signal, deadlineAt: Date.now() + 1_000 },
        ),
      ).resolves.toMatchObject({ suggestions: [] });
    },
  );

  it("rejects an already-cancelled direct autocomplete without upstream I/O", async () => {
    const controller = new AbortController();
    const reason = new Error("caller left before autocomplete");
    controller.abort(reason);
    mockFetch.mockResolvedValue(mockOk({ stopPlaces: [] }));
    await expect(
      dbRisGeocodingService.autocomplete("station", "en", undefined, { signal: controller.signal }),
    ).rejects.toBe(reason);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

it("does not convert an aborted autocomplete into an empty success when transport rejects late", async () => {
  let rejectFetch!: (error: Error) => void;
  mockFetch.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        rejectFetch = reject;
      }),
  );
  const controller = new AbortController();
  const reason = new Error("provider cancelled");
  const pending = dbRisGeocodingService.autocomplete("Köln", "en", undefined, {
    signal: controller.signal,
  });
  const assertion = expect(pending).rejects.toBe(reason);
  controller.abort(reason);
  rejectFetch(new Error("late connection error"));
  await assertion;
});

it("preserves empty fallback for ordinary autocomplete upstream errors", async () => {
  mockFetch.mockRejectedValueOnce(new Error("HTTP 503"));
  await expect(
    dbRisGeocodingService.autocomplete("Köln", "en", undefined, {
      signal: new AbortController().signal,
    }),
  ).resolves.toEqual([]);
});
