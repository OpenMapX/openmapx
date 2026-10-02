import { getEventListeners } from "node:events";
import {
  createGeocoderSuggestionProvider,
  runWithProviderDeadline,
} from "@openmapx/integration-framework";
import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSearchSuggestionsOrchestrator } from "../search-suggestions/orchestrator.js";
import {
  enturFeatureToPlace,
  enturGeocodingService,
  lookupEnturPlaceById,
  setEnturGeocodingConfig,
} from "./provider.js";

let mockFetch: ReturnType<typeof vi.fn>;

function mockOk(data: unknown) {
  return Response.json(data);
}

const STOP_PLACE_FEATURE = {
  geometry: { coordinates: [10.75, 59.911] as [number, number] },
  properties: {
    id: "NSR:StopPlace:337",
    name: "Oslo S",
    label: "Oslo S, Oslo",
    layer: "venue",
    locality: "Oslo",
    county: "Oslo",
    country_a: "NOR",
    category: ["railStation", "busStation"],
    mode: [{ rail: null }, { bus: null }],
  },
};

const STREET_ADDRESS_FEATURE = {
  geometry: { coordinates: [10.74, 59.92] as [number, number] },
  properties: {
    id: "OSM:Address:1",
    name: "Karl Johans gate 1",
    label: "Karl Johans gate 1, Oslo",
    layer: "address",
    locality: "Oslo",
    county: "Oslo",
    country_a: "NOR",
    category: ["Street address"],
  },
};

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal("fetch", mockFetch);
  setEnturGeocodingConfig({ clientName: "test-client", boundaryCountry: "NOR" });
});

afterEach(() => {
  setEnturGeocodingConfig({});
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("enturGeocodingService.geocode", () => {
  it("maps a stop-place venue to an NSR-canonical poi search result", async () => {
    mockFetch.mockResolvedValueOnce(mockOk({ features: [STOP_PLACE_FEATURE] }));

    const results = await enturGeocodingService.geocode("Oslo S", "en");

    expect(results).toEqual([
      {
        id: "nsr:StopPlace:337",
        label: "Oslo S, Oslo",
        coordinates: [10.75, 59.911],
        type: "poi",
        confidence: 1,
        rawCategory: "railStation",
      },
    ]);
    const url = String(mockFetch.mock.calls[0]?.[0]);
    expect(url).toContain("/autocomplete");
    expect(url).toContain("text=Oslo+S");
    expect(url).toContain("size=10");
    expect(url).toContain("boundary.country=NOR");
  });

  it("maps a street address to the address result type", async () => {
    mockFetch.mockResolvedValueOnce(mockOk({ features: [STREET_ADDRESS_FEATURE] }));

    const results = await enturGeocodingService.geocode("Karl Johans gate");

    expect(results[0]).toMatchObject({
      id: "entur:OSM:Address:1",
      type: "address",
      rawCategory: "Street address",
    });
  });

  it("drops features that have no native id or coordinates", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({
        features: [
          { geometry: { coordinates: [1, 2] }, properties: { name: "no id" } },
          {
            geometry: {},
            properties: { id: "NSR:StopPlace:1", name: "no coords", layer: "venue" },
          },
        ],
      }),
    );

    expect(await enturGeocodingService.geocode("x")).toEqual([]);
  });
});

describe("enturGeocodingService.autocomplete", () => {
  it("emits a transit_stop result with an embedded transit stop for venues", async () => {
    mockFetch.mockResolvedValueOnce(mockOk({ features: [STOP_PLACE_FEATURE] }));

    const results = await enturGeocodingService.autocomplete("Oslo", "en");

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: "nsr:StopPlace:337",
      label: "Oslo S",
      type: "transit_stop",
      transitStop: {
        id: "nsr:StopPlace:337",
        primaryScheme: "nsr",
        ids: { entur: "NSR:StopPlace:337", nsr: "StopPlace:337" },
        name: "Oslo S",
        lat: 59.911,
        lng: 10.75,
        modes: ["rail", "bus"],
        provider: "entur",
      },
      rawCategory: "railStation",
    });
    expect(String(mockFetch.mock.calls[0]?.[0])).toContain("size=6");
  });

  it("emits a non-transit address result without an embedded transit stop", async () => {
    mockFetch.mockResolvedValueOnce(mockOk({ features: [STREET_ADDRESS_FEATURE] }));

    const [result] = await enturGeocodingService.autocomplete("Karl");

    expect(result?.id).toBe("entur:OSM:Address:1");
    expect(result?.type).toBe("address");
    expect(result?.transitStop).toBeUndefined();
    expect(result?.rawCategory).toBe("Street address");
  });

  it("sends the autocomplete bias as focus.point", async () => {
    mockFetch.mockImplementation(async () => mockOk({ features: [] }));

    await enturGeocodingService.autocomplete("Karl", "en", { proximity: [10.75, 59.91] });
    await enturGeocodingService.autocomplete("Karl", "en");

    const biased = new URL(String(mockFetch.mock.calls[0]?.[0])).searchParams;
    expect(biased.get("focus.point.lat")).toBe("59.91");
    expect(biased.get("focus.point.lon")).toBe("10.75");
    const unbiased = new URL(String(mockFetch.mock.calls[1]?.[0])).searchParams;
    expect(unbiased.has("focus.point.lat")).toBe(false);
  });
});

describe("enturGeocodingService.reverseGeocode", () => {
  it("returns the label and joined city for the first feature", async () => {
    mockFetch.mockResolvedValueOnce(mockOk({ features: [STOP_PLACE_FEATURE] }));

    const result = await enturGeocodingService.reverseGeocode(59.911, 10.75, "en");

    expect(result).toEqual({ address: "Oslo S, Oslo", city: "Oslo" });
    const url = String(mockFetch.mock.calls[0]?.[0]);
    expect(url).toContain("/reverse");
    expect(url).toContain("point.lat=59.911");
    expect(url).toContain("point.lon=10.75");
  });

  it("returns null when the reverse response has no features", async () => {
    mockFetch.mockResolvedValueOnce(mockOk({ features: [] }));
    expect(await enturGeocodingService.reverseGeocode(0, 0)).toBeNull();
  });
});

describe("enturFeatureToPlace", () => {
  it("builds a station place with NSR identity, city and country code", () => {
    const place = enturFeatureToPlace(STOP_PLACE_FEATURE, "en");

    expect(place).toMatchObject({
      id: "nsr:StopPlace:337",
      primaryScheme: "nsr",
      ids: { entur: "NSR:StopPlace:337", nsr: "StopPlace:337" },
      name: "Oslo S",
      address: "Oslo S, Oslo",
      city: "Oslo",
      countryCode: "no",
      coordinates: [10.75, 59.911],
      category: "station",
      rawCategory: "railStation",
    });
  });

  it.each([
    [{ geometry: { coordinates: [1, 2] }, properties: { name: "no id" } }],
    [{ geometry: {}, properties: { id: "NSR:StopPlace:1" } }],
  ])("returns null for invalid feature %#", (feature) => {
    expect(enturFeatureToPlace(feature)).toBeNull();
  });
});

describe("lookupEnturPlaceById", () => {
  it("resolves the autocomplete feature whose native id matches the request", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({
        features: [
          { geometry: { coordinates: [1, 2] }, properties: { id: "NSR:StopPlace:999" } },
          STOP_PLACE_FEATURE,
        ],
      }),
    );

    const place = await lookupEnturPlaceById("NSR:StopPlace:337", "en");

    expect(place?.id).toBe("nsr:StopPlace:337");
    expect(String(mockFetch.mock.calls[0]?.[0])).toContain("multiModal=all");
  });

  it("returns null when no feature matches the requested id", async () => {
    mockFetch.mockResolvedValueOnce(mockOk({ features: [STOP_PLACE_FEATURE] }));
    expect(await lookupEnturPlaceById("NSR:StopPlace:000")).toBeNull();
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
        (_url: string, init?: RequestInit) =>
          new Promise((resolve) => {
            downstreamSignal = init?.signal ?? undefined;
            release = () => resolve(mockOk({ features: [] }));
          }),
      );
      const provider = createGeocoderSuggestionProvider({
        id: "geocoding-entur",
        geocoder: enturGeocodingService,
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
      mockFetch.mockResolvedValueOnce(mockOk({ features: [] }));
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
    mockFetch.mockResolvedValue(mockOk({ features: [] }));
    await expect(
      enturGeocodingService.autocomplete("station", "en", undefined, { signal: controller.signal }),
    ).rejects.toBe(reason);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("autocomplete HTTP lifetime", () => {
  it("keeps the native HTTP timeout when a caller signal is supplied and cleans listeners", async () => {
    vi.useFakeTimers();
    let downstreamSignal: AbortSignal | undefined;
    mockFetch.mockImplementationOnce((_url: string, init?: RequestInit) => {
      downstreamSignal = init?.signal ?? undefined;
      return new Promise(() => {});
    });
    const controller = new AbortController();
    try {
      const pending = enturGeocodingService.autocomplete("Oslo", "en", undefined, {
        signal: controller.signal,
      });
      const assertion = expect(pending).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(4_000);
      await assertion;
      expect(downstreamSignal?.aborted).toBe(true);
      expect(controller.signal.aborted).toBe(false);
      if (!downstreamSignal) throw new Error("HTTP request never started");
      expect(getEventListeners(downstreamSignal, "abort")).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("handles a late upstream rejection after cancellation without an unhandled rejection", async () => {
    let rejectFetch!: (error: Error) => void;
    mockFetch.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectFetch = reject;
        }),
    );
    const controller = new AbortController();
    const reason = new Error("caller left");
    const pending = enturGeocodingService.autocomplete("Oslo", "en", undefined, {
      signal: controller.signal,
    });
    const assertion = expect(pending).rejects.toBe(reason);
    controller.abort(reason);
    await assertion;
    rejectFetch(new Error("late network failure"));
    await new Promise((resolve) => setImmediate(resolve));
  });
});

it.each(["deadline", "caller"] as const)(
  "preserves aggregate health and partial-result policy for actual Entur %s cancellation",
  async (mode) => {
    vi.useFakeTimers();
    let downstreamSignal: AbortSignal | undefined;
    let release!: () => void;
    const started = Promise.withResolvers<void>();
    mockFetch.mockImplementationOnce(
      (_url: string, init?: RequestInit) =>
        new Promise((resolve) => {
          downstreamSignal = init?.signal ?? undefined;
          release = () => resolve(mockOk({ features: [] }));
          started.resolve();
        }),
    );
    const provider = createGeocoderSuggestionProvider({
      id: "entur",
      geocoder: enturGeocodingService,
      attributions: () => [],
    });
    const ctx = createMockIntegrationContext();
    ctx.getIntegrationsByDomain = () => [
      {
        id: "entur",
        manifest: {} as never,
        config: {},
        directory: "",
        isBuiltIn: true,
        enabled: true,
        providers: new Map([["search-suggestions", [provider]]]),
        strings: {},
        shutdownHandlers: [],
      },
    ];
    const recordFailure = vi.fn(async () => {});
    const recordSuccess = vi.fn(async () => {});
    ctx.providerHealth = {
      isHealthy: async () => true,
      recordFailure,
      recordSuccess,
      getSnapshot: vi.fn(),
    };
    const recordProviderCall = vi.fn();
    ctx.metricsRecorder = { recordProviderCall };
    const controller = new AbortController();
    const work = createSearchSuggestionsOrchestrator(ctx).search(
      { query: "Oslo", lang: "en", limit: 8 },
      controller.signal,
    );
    const outcome = work.catch((error: Error) => error);
    try {
      await started.promise;
      if (mode === "deadline") {
        await vi.advanceTimersByTimeAsync(1_200);
        expect(await outcome).toMatchObject({ partial: true, suggestions: [] });
        expect(recordFailure).toHaveBeenCalledWith(
          "entur",
          expect.any(Number),
          "timeout",
          expect.any(String),
        );
      } else {
        controller.abort(new Error("caller left"));
        expect(await outcome).toMatchObject({ name: "ProviderCancelledError" });
        expect(recordFailure).not.toHaveBeenCalled();
      }
      expect(downstreamSignal?.aborted).toBe(true);
      expect(recordSuccess).not.toHaveBeenCalled();
      expect(recordProviderCall).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: mode === "deadline" ? "timeout" : "cancelled" }),
        expect.any(Number),
      );
    } finally {
      release();
      await outcome;
      vi.useRealTimers();
    }
  },
);
