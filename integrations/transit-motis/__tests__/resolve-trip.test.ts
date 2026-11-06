import { encodePolyline } from "@openmapx/core";
import { createMotisInstance } from "@openmapx/mobility-core/motis-client";
import type { TransitTripResolveRequest } from "@openmapx/mobility-core/transit";
import { describe, expect, it, vi } from "vitest";
import { resolveMotisTrip, supportsStructuredTripResolution } from "../resolve-trip.js";

const coordinates: [number, number][] = [
  [6.091, 50.768],
  [6.5, 50.9],
  [6.959, 50.943],
];
function rawTrip() {
  const from = {
    stopId: "a",
    name: "Provider Aachen",
    lat: 50.768,
    lon: 6.091,
    scheduledDeparture: "2026-11-06T20:18:00Z",
    departure: "2026-11-06T20:23:00Z",
    track: "17",
  };
  const to = {
    stopId: "b",
    name: "Provider Koeln",
    lat: 50.943,
    lon: 6.959,
    scheduledArrival: "2026-11-06T21:11:00Z",
    arrival: "2026-11-06T21:16:00Z",
    track: "8",
  };
  return {
    id: "native-reference-id",
    duration: 3180,
    transfers: 0,
    legs: [
      {
        mode: "REGIONAL_FAST_RAIL",
        tripId: "10935",
        displayName: "RE9 (10935)",
        routeShortName: "RE9",
        routeLongName: "Provider route",
        tripShortName: "10935",
        routeId: "provider-route",
        startTime: from.departure,
        endTime: to.arrival,
        scheduledStartTime: from.scheduledDeparture,
        scheduledEndTime: to.scheduledArrival,
        from,
        to,
        duration: 3180,
        realTime: true,
        scheduled: true,
        legGeometry: { points: encodePolyline(coordinates, 6), precision: 6 },
      },
    ],
  };
}
function fixture() {
  const original = rawTrip();
  let reconstructed = structuredClone(original);
  const requests: Request[] = [];
  const fetch = vi.fn(async (...args: unknown[]) => {
    const req = new Request(args[0] as Request);
    requests.push(req.clone());
    return Response.json(req.method === "POST" ? reconstructed : original);
  });
  const instance = createMotisInstance({
    baseUrl: "https://motis.example",
    prefix: "ms:",
    provider: "ms",
  });
  instance.client.setConfig({ fetch });
  const params: TransitTripResolveRequest = {
    reference: {
      datasetEpoch: "E",
      legs: [
        {
          tripId: "ms:10935",
          fromStopId: "ms:a",
          toStopId: "ms:b",
          scheduledDeparture: "2026-11-06T20:18:00.000Z",
          scheduledArrival: "2026-11-06T21:11:00.000Z",
        },
      ],
    },
  };
  return {
    original,
    instance,
    params,
    requests,
    response: (value: typeof original) => {
      reconstructed = value;
    },
  };
}

describe("provider-native exact trip reconstruction", () => {
  it("serializes detailed POST options and maps only real provider data through the normal normalizer", async () => {
    const f = fixture();
    expect(supportsStructuredTripResolution(f.instance)).toBe(false);
    const result = await resolveMotisTrip(f.instance, f.params, { datasetEpoch: "E" });
    expect(result?.itineraries[0]).toMatchObject({
      id: "native-reference-id",
      legs: [
        {
          tripId: "ms:10935",
          startTime: "2026-11-06T20:23:00Z",
          from: { name: "Provider Aachen", platformCode: "17" },
          to: { name: "Provider Koeln", platformCode: "8" },
          geometry: { type: "LineString", coordinates },
        },
      ],
    });
    const post = f.requests.find((r) => r.method === "POST");
    expect(post).toBeDefined();
    const query = new URL(post?.url ?? "https://invalid").searchParams;
    expect(Object.fromEntries(query)).toMatchObject({
      detailedLegs: "true",
      detailedTransfers: "true",
      requireDisplayNameMatch: "true",
      joinInterlinedLegs: "false",
    });
    const body = await post?.json();
    expect(body).toMatchObject({
      id: {
        legs: [
          {
            displayName: "RE9 (10935)",
            tripId: "10935",
            fromId: "a",
            toId: "b",
            fromLat: 50.768,
            scheduled: true,
          },
        ],
      },
    });
    expect(supportsStructuredTripResolution(f.instance)).toBe(true);
  });

  it.each(["trip", "boarding", "arrival", "dummy"])(
    "rejects native %s substitution before mapping",
    async (kind) => {
      const f = fixture();
      const changed = rawTrip();
      if (kind === "trip") changed.legs[0].tripId = "another";
      if (kind === "boarding") changed.legs[0].from.stopId = "nearby";
      if (kind === "arrival") changed.legs[0].scheduledEndTime = "2026-11-06T21:12:00Z";
      if (kind === "dummy")
        Object.assign(changed.legs[0], {
          tripId: undefined,
          routeId: undefined,
          routeShortName: undefined,
          routeLongName: undefined,
          cancelled: true,
        });
      f.response(changed);
      await expect(
        resolveMotisTrip(f.instance, f.params, { datasetEpoch: "E" }),
      ).resolves.toBeNull();
    },
  );

  it("keeps a genuine cancelled train with matching provider identity", async () => {
    const f = fixture();
    const changed = rawTrip();
    Object.assign(changed.legs[0], { cancelled: true });
    f.response(changed);
    const result = await resolveMotisTrip(f.instance, f.params, { datasetEpoch: "E" });
    expect(result?.itineraries[0].legs[0]).toMatchObject({ tripId: "ms:10935", cancelled: true });
  });

  it("refuses a stale epoch before any provider request", async () => {
    const f = fixture();
    await expect(
      resolveMotisTrip(f.instance, f.params, { datasetEpoch: "new" }),
    ).resolves.toBeNull();
    expect(f.requests).toHaveLength(0);
  });

  it.each([false, undefined])(
    "preserves a native scheduled=%s flag or rejects an unknown flag",
    async (scheduled) => {
      const f = fixture();
      Object.assign(f.original.legs[0], { scheduled });
      const result = await resolveMotisTrip(f.instance, f.params, { datasetEpoch: "E" });
      if (scheduled === undefined) {
        expect(result).toBeNull();
        expect(f.requests).toHaveLength(1);
      } else {
        expect(result).not.toBeNull();
        expect(await f.requests[1].json()).toMatchObject({ id: { legs: [{ scheduled: false }] } });
      }
    },
  );

  it.each([false, true])(
    "requests a native cross-platform transfer and rejects a dummy transfer (%s)",
    async (dummy) => {
      const f = fixture();
      const second = rawTrip();
      Object.assign(second.legs[0], {
        tripId: "1541",
        scheduledStartTime: "2026-11-06T21:27:00Z",
        scheduledEndTime: "2026-11-07T05:04:00Z",
      });
      Object.assign(second.legs[0].from, {
        stopId: "b-platform-2",
        scheduledDeparture: "2026-11-06T21:27:00Z",
      });
      Object.assign(second.legs[0].to, { stopId: "c", scheduledArrival: "2026-11-07T05:04:00Z" });
      const walk = {
        mode: "WALK",
        from: f.original.legs[0].to,
        to: second.legs[0].from,
        startTime: "2026-11-06T21:16:00Z",
        endTime: "2026-11-06T21:20:00Z",
        duration: 240,
        cancelled: dummy,
      };
      const postRequests: Request[] = [];
      f.instance.client.setConfig({
        fetch: async (input) => {
          const req = new Request(input);
          if (req.method === "POST") {
            postRequests.push(req.clone());
            return Response.json({
              ...f.original,
              legs: [f.original.legs[0], walk, second.legs[0]],
            });
          }
          return Response.json(
            new URL(req.url).searchParams.get("tripId") === "1541" ? second : f.original,
          );
        },
      });
      f.params.reference.legs.push({
        tripId: "ms:1541",
        fromStopId: "ms:b-platform-2",
        toStopId: "ms:c",
        scheduledDeparture: "2026-11-06T21:27:00Z",
        scheduledArrival: "2026-11-07T05:04:00Z",
      });
      const result = await resolveMotisTrip(f.instance, f.params, { datasetEpoch: "E" });
      expect(await postRequests[0].json()).toMatchObject({
        id: {
          legs: [
            { tripId: "10935" },
            { mode: "WALK", fromId: "b", toId: "b-platform-2" },
            { tripId: "1541" },
          ],
        },
      });
      if (dummy) expect(result).toBeNull();
      else
        expect(result?.itineraries[0].legs.map((leg) => leg.mode)).toEqual([
          "rail",
          "walking",
          "rail",
        ]);
    },
  );

  it("remembers an unsupported hosted endpoint without repeatedly fetching trips", async () => {
    const f = fixture();
    const fetch = vi.fn(async (input: Request) =>
      new Request(input).method === "POST"
        ? Response.json({ error: "not supported" }, { status: 405 })
        : Response.json(f.original),
    );
    f.instance.client.setConfig({ fetch });
    await expect(resolveMotisTrip(f.instance, f.params, { datasetEpoch: "E" })).rejects.toThrow(
      /unsupported/i,
    );
    await expect(resolveMotisTrip(f.instance, f.params, { datasetEpoch: "E" })).rejects.toThrow(
      /unsupported/i,
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(supportsStructuredTripResolution(f.instance)).toBe(false);
  });
});

it.each(["GET", "POST"])(
  "reports a %s upstream outage instead of a successful empty resolution",
  async (method) => {
    const f = fixture();
    f.instance.client.setConfig({
      fetch: async (request) =>
        new Request(request).method === method
          ? Response.json({ error: "upstream down" }, { status: 503 })
          : Response.json(f.original),
    });
    await expect(resolveMotisTrip(f.instance, f.params, { datasetEpoch: "E" })).rejects.toThrow(
      /unavailable/i,
    );
    expect(supportsStructuredTripResolution(f.instance)).toBe(false);
  },
);

it("does not disable reconstruction after a request-specific native 404", async () => {
  const f = fixture();
  let posts = 0;
  f.instance.client.setConfig({
    fetch: async (input) => {
      if (new Request(input).method === "POST" && ++posts === 1)
        return Response.json({ error: "trip not found" }, { status: 404 });
      return Response.json(f.original);
    },
  });
  await expect(resolveMotisTrip(f.instance, f.params, { datasetEpoch: "E" })).resolves.toBeNull();
  await expect(
    resolveMotisTrip(f.instance, f.params, { datasetEpoch: "E" }),
  ).resolves.not.toBeNull();
  expect(posts).toBe(2);
});

it("uses the host HTTP client for both native requests, retaining SDK query/body and cancellation", async () => {
  const f = fixture();
  f.instance.client.setConfig({
    headers: { "User-Agent": "OpenMapX-test" },
    fetch: async () => {
      throw new Error("bypassed host HTTP");
    },
  });
  const http = {
    getResponse: vi.fn(async () => ({ status: 200, headers: {}, body: f.original })),
    postResponse: vi.fn(async () => ({ status: 200, headers: {}, body: f.original })),
  };
  const options = {
    datasetEpoch: "E",
    http: http as unknown as import("@openmapx/integration-framework").HttpClient,
  };
  const result = await resolveMotisTrip(f.instance, f.params, options);
  expect(result?.itineraries[0].legs[0].tripId).toBe("ms:10935");
  expect(http.getResponse).toHaveBeenCalledWith(
    expect.stringContaining("/api/v6/trip?tripId=10935"),
    expect.objectContaining({
      signal: expect.any(AbortSignal),
      headers: expect.objectContaining({ "user-agent": "OpenMapX-test" }),
      maxBytes: 8 * 1024 * 1024,
    }),
  );
  expect(http.postResponse).toHaveBeenCalledWith(
    expect.stringContaining("/api/v6/refresh-itinerary?"),
    expect.objectContaining({
      id: { legs: [expect.objectContaining({ tripId: "10935", scheduled: true })] },
    }),
    expect.objectContaining({
      signal: expect.any(AbortSignal),
      contentTypes: ["application/json"],
    }),
  );
});
