import { getEventListeners } from "node:events";
import {
  createGeocoderSuggestionProvider,
  ProviderTimeoutError,
  runWithProviderDeadline,
} from "@openmapx/integration-framework";
import {
  createMockIntegrationContext,
  type FakeHttpRequest,
} from "@openmapx/integration-framework/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSearchSuggestionsOrchestrator } from "../search-suggestions/orchestrator.js";
import { collection, fixture, LAYERS } from "./test-support.js";

let mockHttp: ReturnType<typeof vi.fn>;
let entur: ReturnType<typeof fixture>;
beforeEach(() => {
  mockHttp = vi.fn().mockResolvedValue(JSON.stringify(collection()));
  entur = fixture({ responder: mockHttp });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
describe("native geocoder projections", () => {
  it.each(["address", "street", "stopPlace", "groupOfStopPlaces", "poi", "place"] as const)(
    "maps %s independently of legacy categories",
    async (layer) => {
      const feature = LAYERS[layer];
      mockHttp.mockResolvedValue(JSON.stringify(collection([feature])));
      const [search] = await entur.provider.geocode("Oslo", "en", [0, 0]);
      const [suggestion] = await entur.provider.autocomplete("Oslo", "en");
      const place = await entur.lookupPlaceById(feature.properties.id, "en");
      expect(search.type).toBe(
        layer === "address"
          ? "address"
          : layer === "street"
            ? "street"
            : layer === "place"
              ? "region"
              : "poi",
      );
      expect(suggestion.type).toBe(layer === "stopPlace" ? "transit_stop" : search.type);
      expect(place?.category).toBe(suggestion.type === "transit_stop" ? "station" : search.type);
      expect(suggestion.contributors?.map((x) => x.sourceId)).toEqual([
        "entur-geocoder",
        {
          address: "entur-geocoder-kartverket-addresses",
          street: "entur-geocoder-kartverket-addresses",
          stopPlace: "entur-geocoder-nsr",
          groupOfStopPlaces: "entur-geocoder-nsr",
          poi: "entur-geocoder-osm",
          place: "entur-geocoder-kartverket-place-names",
        }[layer],
      ]);
      expect(search.ids).toEqual(place?.ids);
      expect(place?.fieldContributors?.["ids.entur"]).toEqual(place?.contributors);
      expect(place?.fieldContributors?.name).toEqual(place?.contributors);
      expect(place?.countryCode).toBe("no");
      if (suggestion.transitStop) expect(suggestion.transitStop.modes).toEqual(["rail", "bus"]);
      else if (layer === "poi") expect(suggestion.rawCategory).toBe("cafe");
    },
  );
  it("uses native focus and limits, reverse layers, exact place IDs and language", async () => {
    await entur.provider.geocode("Oslo", "en", [0, 0]);
    await entur.provider.autocomplete("Oslo", "en");
    await entur.provider.reverseGeocode(0, 0, "en");
    const place = await entur.lookupPlaceById("NSR:StopPlace:337", "en");
    const urls = entur.http.calls.map((c) => new URL(c.url));
    expect(urls[0].searchParams.get("lat")).toBe("0");
    expect(urls[0].searchParams.get("lon")).toBe("0");
    expect(urls[0].searchParams.get("limit")).toBe("10");
    expect(urls[1].searchParams.get("limit")).toBe("6");
    expect(urls[1].searchParams.has("radius")).toBe(false);
    expect(urls[1].searchParams.has("weight")).toBe(false);
    expect(urls[2].searchParams.get("layers")).toBe("address,street,place");
    expect(urls[2].searchParams.get("limit")).toBe("1");
    expect(urls[2].searchParams.has("radius")).toBe(false);
    expect(urls[3].pathname).toBe("/geocoder/v3/place");
    expect(urls[3].searchParams.get("ids")).toBe("NSR:StopPlace:337");
    expect(urls[3].searchParams.has("q")).toBe(false);
    expect(urls[3].searchParams.has("countries")).toBe(false);
    expect(place?.description).toBe("Main stop");
    expect(place?.ids).toEqual({ entur: "NSR:StopPlace:337", nsr: "StopPlace:337" });
    expect(await entur.lookupPlaceById("NSR:StopPlace:999")).toBeNull();
  });
  it.each(["malformed", "quota", "policy"] as const)(
    "never turns %s into successful emptiness",
    async (mode) => {
      const f = fixture({
        responder: () => (mode === "quota" ? { status: 429, headers: {}, body: "{}" } : "{}"),
        allowed: async () => mode !== "policy",
      });
      await expect(f.provider.geocode("Oslo")).rejects.toThrow();
    },
  );
  it.each(["http", "policy"] as const)(
    "classifies the owned four second %s deadline as provider timeout",
    async (mode) => {
      vi.useFakeTimers();
      const f = fixture({
        responder: () => new Promise(() => {}),
        allowed: mode === "policy" ? () => new Promise(() => {}) : undefined,
      });
      const work = f.provider.autocomplete("Oslo");
      const assertion = expect(work).rejects.toBeInstanceOf(ProviderTimeoutError);
      await vi.advanceTimersByTimeAsync(4000);
      await assertion;
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
// These use the real suggestion adapter and provider, replacing only upstream I/O.
describe("autocomplete cancellation through the suggestion adapter", () => {
  it.each(["deadline", "caller"] as const)(
    "aborts downstream I/O on %s and permits retry",
    async (mode) => {
      let downstreamSignal: AbortSignal | undefined;
      let release!: () => void;
      mockHttp.mockImplementationOnce(
        (request: FakeHttpRequest) =>
          new Promise((resolve) => {
            downstreamSignal = request.options?.signal ?? undefined;
            release = () => resolve(JSON.stringify(collection([])));
          }),
      );
      const provider = createGeocoderSuggestionProvider({
        id: "geocoding-entur",
        geocoder: entur.provider,
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
        await vi.waitFor(() => expect(downstreamSignal).toBeDefined());
        if (mode === "caller") controller.abort(new Error("caller left"));
        expect(((await outcome) as Error).name).toBe(
          mode === "deadline" ? "ProviderTimeoutError" : "ProviderCancelledError",
        );
        expect(downstreamSignal?.aborted).toBe(true);
      } finally {
        release();
        await outcome;
      }
      mockHttp.mockResolvedValueOnce(JSON.stringify(collection([])));
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
    mockHttp.mockResolvedValue(JSON.stringify(collection([])));
    await expect(
      entur.provider.autocomplete("station", "en", undefined, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "ProviderCancelledError" });
    expect(mockHttp).not.toHaveBeenCalled();
  });
});

describe("autocomplete HTTP lifetime", () => {
  it("keeps the native HTTP timeout when a caller signal is supplied and cleans listeners", async () => {
    vi.useFakeTimers();
    let downstreamSignal: AbortSignal | undefined;
    mockHttp.mockImplementationOnce((request: FakeHttpRequest) => {
      downstreamSignal = request.options?.signal ?? undefined;
      return new Promise(() => {});
    });
    const controller = new AbortController();
    try {
      const pending = entur.provider.autocomplete("Oslo", "en", undefined, {
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
    mockHttp.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectFetch = reject;
        }),
    );
    const controller = new AbortController();
    const reason = new Error("caller left");
    const pending = entur.provider.autocomplete("Oslo", "en", undefined, {
      signal: controller.signal,
    });
    const assertion = expect(pending).rejects.toMatchObject({ name: "ProviderCancelledError" });
    await vi.waitFor(() => expect(rejectFetch).toBeDefined());
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
    mockHttp.mockImplementationOnce(
      (request: FakeHttpRequest) =>
        new Promise((resolve) => {
          downstreamSignal = request.options?.signal ?? undefined;
          release = () => resolve(JSON.stringify(collection([])));
          started.resolve();
        }),
    );
    const provider = createGeocoderSuggestionProvider({
      id: "entur",
      geocoder: entur.provider,
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
