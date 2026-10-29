import type { ApiClient } from "@openmapx/core/navigation/api";
import type { TripItinerary } from "@openmapx/mobility-core/transit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CAPTURE_CONCURRENCY, degradedLegIndices, prepareTransitStart } from "./transitCapture";

function stop(id: string, index: number) {
  return {
    stopId: id,
    name: `Stop ${id}`,
    lat: 50 + index * 0.01,
    lng: 8 + index * 0.01,
    scheduledArrival: "2026-06-01T10:00:00Z",
    scheduledDeparture: "2026-06-01T10:01:00Z",
  };
}

function itineraryWith(tripIds: (string | null)[]): TripItinerary {
  return {
    duration: 1_800,
    startTime: "2026-06-01T10:00:00Z",
    endTime: "2026-06-01T10:30:00Z",
    transfers: tripIds.length - 1,
    walkDistance: 200,
    legs: tripIds.map((tripId, index) => ({
      mode: tripId ? "rail" : "walking",
      ...(tripId ? { tripId } : {}),
      startTime: "2026-06-01T10:00:00Z",
      endTime: "2026-06-01T10:10:00Z",
      scheduledStartTime: "2026-06-01T10:00:00Z",
      scheduledEndTime: "2026-06-01T10:10:00Z",
      from: { stopId: `a${index}`, name: "A", lat: 50, lng: 8 },
      to: { stopId: `b${index}`, name: "B", lat: 50.1, lng: 8.1 },
    })),
  } as unknown as TripItinerary;
}

/** Records every trip id fetched and answers with whatever the test decides. */
function fakeClient(answer: (tripId: string) => unknown | Promise<unknown>) {
  const fetched: string[] = [];
  let inFlight = 0;
  let peak = 0;

  const get = vi.fn(async (...args: unknown[]) => {
    const tripId = decodeURIComponent(String(args[0]).split("/").pop() ?? "");
    fetched.push(tripId);
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    try {
      return await answer(tripId);
    } finally {
      inFlight -= 1;
    }
  });

  return { client: { get } as unknown as ApiClient, fetched, peak: () => peak };
}

const withStops = (count: number) => ({
  data: { stops: Array.from({ length: count }, (_, index) => stop(`s${index}`, index)) },
});

const baseInput = {
  locale: "en" as const,
  units: "metric" as const,
  settings: { voiceEnabled: true, keepScreenOn: true, alightAlertsEnabled: true },
  capturedAtMs: 1_700_000_000_000,
};

afterEach(() => vi.useRealTimers());

describe("prepareTransitStart", () => {
  it("does not start journey or area requests for an already-aborted preparation", async () => {
    const controller = new AbortController();
    controller.abort();
    const { client } = fakeClient(() => withStops(2));
    const getOptional = vi.fn(async () => null);
    (client as unknown as { getOptional: unknown }).getOptional = getOptional;
    expect(
      await prepareTransitStart({
        ...baseInput,
        itinerary: itineraryWith(["t1", "t2"]),
        client,
        signal: controller.signal,
      }),
    ).toEqual({ ok: false, code: "aborted" });
    expect(client.get).not.toHaveBeenCalled();
    expect(getOptional).not.toHaveBeenCalled();
  });

  it("stops scheduling queued journeys when preparation is cancelled", async () => {
    const controller = new AbortController();
    const release = Promise.withResolvers<void>();
    const { client, fetched } = fakeClient(async () => {
      await release.promise;
      return withStops(2);
    });
    const work = prepareTransitStart({
      ...baseInput,
      itinerary: itineraryWith(["t1", "t2", "t3", "t4", "t5", "t6"]),
      client,
      signal: controller.signal,
    });
    try {
      // Let scheduled callbacks reach the blocked fake client before the next timer turn.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(fetched).toHaveLength(CAPTURE_CONCURRENCY);
      controller.abort();
    } finally {
      release.resolve();
    }
    expect(await work).toEqual({ ok: false, code: "aborted" });
    expect(fetched).toHaveLength(CAPTURE_CONCURRENCY);
  });

  it("captures each ridden leg", async () => {
    const { client } = fakeClient(() => withStops(4));

    const result = await prepareTransitStart({
      ...baseInput,
      itinerary: itineraryWith(["t1", "t2"]),
      client,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcomes.map((outcome) => outcome.status)).toEqual(["captured", "captured"]);
  });

  it("carries the stops' shapes, leaving out any it could not get", async () => {
    const { client } = fakeClient(() => withStops(4));
    const shape = { type: "point", coordinates: [8, 50], bufferMeters: 12 };
    (client as unknown as { getOptional: unknown }).getOptional = vi.fn(async (path: unknown) => {
      if (String(path).includes("a0")) {
        return { data: { stopId: "a0", platform: [shape], station: [], source: "osm" } };
      }
      throw new Error("Overpass is busy");
    });

    const result = await prepareTransitStart({
      ...baseInput,
      itinerary: itineraryWith(["t1"]),
      client,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.startPackage.stopAreas ?? {})).toEqual(["a0|"]);
    expect(result.startPackage.stopAreas?.["a0|"]?.platform).toEqual([shape]);
  });

  it("drops a malformed stop area instead of refusing the trip", async () => {
    const { client } = fakeClient(() => withStops(4));
    const broken = { type: "line", coordinates: [[8, 50]], bufferMeters: 4 };
    (client as unknown as { getOptional: unknown }).getOptional = vi.fn(async () => ({
      data: { stopId: "a0", platform: [broken], station: [], source: "osm" },
    }));

    const result = await prepareTransitStart({
      ...baseInput,
      itinerary: itineraryWith(["t1"]),
      client,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.startPackage.stopAreas).toBeUndefined();
  });

  it("fetches a repeated trip once", async () => {
    const { client, fetched } = fakeClient(() => withStops(4));

    await prepareTransitStart({
      ...baseInput,
      itinerary: itineraryWith(["t1", "t1", "t1"]),
      client,
    });

    // A circular route can legitimately ride the same trip twice; fetching it
    // twice buys nothing but latency at the worst possible moment.
    expect(fetched).toEqual(["t1"]);
  });

  it("fetches nothing for a walking leg", async () => {
    const { client, fetched } = fakeClient(() => withStops(4));

    await prepareTransitStart({ ...baseInput, itinerary: itineraryWith([null, "t1"]), client });

    expect(fetched).toEqual(["t1"]);
  });

  it("reports a leg whose journey could not be had as missing, without inventing stops", async () => {
    const { client } = fakeClient((tripId) => {
      if (tripId === "t2") throw new Error("provider down");
      return withStops(4);
    });

    const result = await prepareTransitStart({
      ...baseInput,
      itinerary: itineraryWith(["t1", "t2"]),
      client,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Guessing intermediate stops is how somebody gets off at the wrong station.
    expect(result.outcomes).toEqual([
      { tripId: "t1", status: "captured" },
      { tripId: "t2", status: "missing" },
    ]);
  });

  it("still produces a startable package when a capture is missing", async () => {
    const { client } = fakeClient(() => {
      throw new Error("provider down");
    });

    const result = await prepareTransitStart({
      ...baseInput,
      itinerary: itineraryWith(["t1"]),
      client,
    });

    // A failed capture degrades one leg; it does not block the whole trip.
    expect(result.ok).toBe(true);
  });

  it("holds itself to four concurrent journey fetches", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;
    const { client, peak } = fakeClient(async () => {
      started += 1;
      if (started <= CAPTURE_CONCURRENCY) await gate;
      return withStops(2);
    });

    const pending = prepareTransitStart({
      ...baseInput,
      itinerary: itineraryWith(["t1", "t2", "t3", "t4", "t5", "t6"]),
      client,
    });
    await Promise.resolve();
    release();
    await pending;

    expect(peak()).toBeLessThanOrEqual(CAPTURE_CONCURRENCY);
  });

  it("bounds journeys and stop areas independently without changing their output order", async () => {
    const journeys = Promise.withResolvers<void>();
    const areas = Promise.withResolvers<void>();
    const { client, fetched, peak } = fakeClient(async () => {
      await journeys.promise;
      return withStops(2);
    });
    let activeAreas = 0;
    let areaPeak = 0;
    let startedAreas = 0;
    (client as unknown as { getOptional: unknown }).getOptional = vi.fn(async () => {
      activeAreas++;
      startedAreas++;
      areaPeak = Math.max(areaPeak, activeAreas);
      try {
        await areas.promise;
        return null;
      } finally {
        activeAreas--;
      }
    });
    const ids = ["t1", "t2", "t3", "t4", "t5", "t6"];
    const work = prepareTransitStart({ ...baseInput, itinerary: itineraryWith(ids), client });
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(fetched).toHaveLength(CAPTURE_CONCURRENCY);
      expect(startedAreas).toBe(CAPTURE_CONCURRENCY);
    } finally {
      journeys.resolve();
      areas.resolve();
    }
    const result = await work;
    expect(peak()).toBe(CAPTURE_CONCURRENCY);
    expect(areaPeak).toBe(CAPTURE_CONCURRENCY);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.outcomes.map((outcome) => outcome.tripId)).toEqual(ids);
  });

  it("reports an aborted preparation rather than a degraded package", async () => {
    const controller = new AbortController();
    const { client } = fakeClient(() => {
      controller.abort();
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    });

    const result = await prepareTransitStart({
      ...baseInput,
      itinerary: itineraryWith(["t1"]),
      client,
      signal: controller.signal,
    });

    // The user closed the dialog or picked another route; a package built from
    // half-finished captures would be worse than none.
    expect(result).toEqual({ ok: false, code: "aborted" });
  });

  it("keeps the refresh token only inside the itinerary it already lives in", async () => {
    const { client } = fakeClient(() => withStops(2));
    const itinerary = itineraryWith(["t1"]);
    (itinerary as unknown as Record<string, unknown>).refreshToken = "rotating-secret";

    const result = await prepareTransitStart({ ...baseInput, itinerary, client });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const pkg = result.startPackage as unknown as Record<string, unknown>;
    // One place it can leak from is one place to strip it.
    expect(pkg.refreshToken).toBeUndefined();
    expect((pkg.itinerary as Record<string, unknown>).refreshToken).toBe("rotating-secret");
  });
});

describe("degradedLegIndices", () => {
  it("names the legs running on schedule data alone", () => {
    const itinerary = itineraryWith(["t1", null, "t2"]);

    expect(
      degradedLegIndices(itinerary, [
        { tripId: "t1", status: "captured" },
        { tripId: "t2", status: "missing" },
      ]),
    ).toEqual([2]);
  });

  it("names nothing when every ridden leg was captured", () => {
    expect(
      degradedLegIndices(itineraryWith(["t1"]), [{ tripId: "t1", status: "captured" }]),
    ).toEqual([]);
  });
});
