import {
  createMockIntegrationContext,
  fakeHttpClient,
} from "@openmapx/integration-framework/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setup } from "./index";
import manifest from "./manifest.json";

const start = "2026-10-25T02:15:00+02:00";
const end = "2026-10-25T02:30:00+02:00";
const place = (name: string, lat = 48.1, lon = 11.5) => ({
  name,
  lat,
  lon,
  stop: { gtfsId: `feed:${name}` },
});
function payload() {
  return {
    data: {
      planConnection: {
        routingErrors: [],
        edges: [
          {
            node: {
              start,
              end,
              duration: 900,
              numberOfTransfers: 0,
              walkDistance: 12,
              legs: [
                {
                  mode: "BUS",
                  start: { scheduledTime: start, estimated: null },
                  end: { scheduledTime: end, estimated: null },
                  from: place("A"),
                  to: place("B", 48.2, 11.6),
                  route: { shortName: "42", longName: null, color: "ff0000" },
                  trip: { gtfsId: "feed:trip" },
                  tripOnServiceDate: { realTimeTripState: { canceled: true, updated: true } },
                  legGeometry: { points: "_p~iF~ps|U_ulLnnqC_mqNvxq`@" },
                  stopCalls: [
                    { __typename: "StopCall" },
                    { __typename: "StopCall" },
                    { __typename: "StopCall" },
                  ],
                },
              ],
            },
          },
        ],
      },
    },
  };
}
function fixture(
  endpoint = "http://otp.one:8080",
  response: () => unknown = payload,
  onPolicyCheck: () => Promise<void> = async () => {},
) {
  let denied = new Set<string>();
  const http = fakeHttpClient((req) =>
    String((req.body as { query: string }).query).includes("OtpReadiness")
      ? { data: { __typename: "QueryType" } }
      : response(),
  );
  const ctx = createMockIntegrationContext({
    id: "transit-otp",
    manifest,
    config: { endpoint },
    http,
  });
  const shutdown: (() => Promise<void>)[] = [];
  setup({
    ...ctx,
    onShutdown: (fn) => shutdown.push(fn),
    getDisallowedSourceIds: async () => {
      await onPolicyCheck();
      return denied;
    },
  });
  const provider = ctx.registered.transit[0];
  if (!provider?.planTrip) throw new Error("OTP planner not registered");
  return {
    ctx,
    http,
    plan: provider.planTrip.bind(provider),
    shutdown: () => Promise.all(shutdown.map((fn) => fn())),
    deny: () => {
      denied = new Set(["otp"]);
    },
  };
}
const request = {
  from: { lat: 48.1, lng: 11.5 },
  to: { lat: 48.2, lng: 11.6 },
  departureTime: start,
};
afterEach(() => vi.unstubAllGlobals());
describe("self-hosted generated OTP planning", () => {
  it("registers without network, maps modern validated data and credits its source", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("global fetch forbidden");
      }),
    );
    const f = fixture();
    expect(f.http.calls).toHaveLength(0);
    const result = await f.plan(request);
    expect(result.data[0].itineraries[0]).toMatchObject({
      duration: 900,
      startTime: "2026-10-25T00:15:00.000Z",
      endTime: "2026-10-25T00:30:00.000Z",
      transfers: 0,
      walkDistance: 12,
      legs: [
        {
          mode: "bus",
          tripId: "feed:trip",
          cancelled: true,
          realtime: true,
          _intermediateStopCount: 1,
          route: { shortName: "42", longName: "", color: "ff0000" },
        },
      ],
    });
    expect(result.data[0].itineraries[0].legs[0].geometry.coordinates).toHaveLength(3);
    expect(result.attributions.length).toBeGreaterThan(0);
    expect(f.http.calls).toHaveLength(1);
    expect(f.http.calls[0].body).toMatchObject({
      variables: { dateTime: { earliestDeparture: start }, first: 3 },
    });
  });
  it("uses latestArrival with the full supplied offset and mapped mode preferences", async () => {
    const f = fixture();
    await f.plan({
      ...request,
      arrivalTime: end,
      modes: ["REGIONAL_RAIL", "SUBURBAN", "TRAM", "COACH"],
      numItineraries: 5,
    });
    expect(f.http.calls[0].body).toMatchObject({
      variables: {
        dateTime: { latestArrival: end },
        first: 5,
        modes: {
          direct: ["WALK"],
          transit: { transit: [{ mode: "RAIL" }, { mode: "TRAM" }, { mode: "BUS" }] },
        },
      },
    });
  });
  it("isolates endpoints and lifetime across two setups", async () => {
    const a = fixture();
    const b = fixture("http://otp.two:8080");
    await a.plan(request);
    await b.plan(request);
    await a.shutdown();
    await expect(a.plan(request)).rejects.toThrow("OTP request cancelled");
    await b.plan(request);
    expect(a.http.calls[0].url).toBe("http://otp.one:8080/otp/gtfs/v1");
    expect(b.http.calls[0].url).toBe("http://otp.two:8080/otp/gtfs/v1");
  });
  it("recovers after a failed initial health probe", async () => {
    const f = fixture();
    const post = vi.spyOn(f.http, "postResponse");
    post.mockRejectedValueOnce(new Error("starting"));
    expect(await f.ctx.registered.healthChecks[0]()).toMatchObject({ status: "down" });
    expect(await f.ctx.registered.healthChecks[0]()).toEqual({ status: "up" });
    expect((await f.plan(request)).data).toHaveLength(1);
  });
  it("retains D-ticket exclusion and distinguishes genuine no-journey from routing failure", async () => {
    const f = fixture();
    expect((await f.plan({ ...request, deutschlandticketOnly: true })).data).toEqual([]);
    expect(f.http.calls).toHaveLength(0);
    const empty = fixture(undefined, () => ({
      data: { planConnection: { edges: [], routingErrors: [] } },
    }));
    expect((await empty.plan(request)).data[0].itineraries).toEqual([]);
    const fail = fixture(undefined, () => ({
      data: { planConnection: { edges: [], routingErrors: [{ code: "NO_TRANSIT_CONNECTION" }] } },
    }));
    await expect(fail.plan(request)).rejects.toThrow(/^OTP /);
  });
  it.each(["coordinate", "timestamp", "polyline", "null-leg", "missing-plan", "negative-duration"])(
    "rejects malformed canonical data: %s",
    async (problem) => {
      const data = payload();
      const itinerary = data.data.planConnection.edges[0].node;
      const leg = itinerary.legs[0];
      if (problem === "coordinate") leg.from.lat = 100;
      if (problem === "timestamp") leg.start.scheduledTime = "invalid";
      if (problem === "polyline") leg.legGeometry.points = "?";
      if (problem === "null-leg") Object.assign(itinerary, { legs: [null] });
      if (problem === "missing-plan") Object.assign(data.data, { planConnection: null });
      if (problem === "negative-duration") itinerary.duration = -1;
      await expect(fixture(undefined, () => data).plan(request)).rejects.toThrow(/^OTP /);
    },
  );
  it("fails before network on denied sources or invalid input", async () => {
    const f = fixture();
    f.deny();
    await expect(f.plan(request)).rejects.toThrow("OTP source denied");
    expect(f.http.calls).toHaveLength(0);
    const g = fixture();
    await expect(g.plan({ ...request, departureTime: "2026-10-25T02:15:00" })).rejects.toThrow(
      "OTP invalid request",
    );
    expect(g.http.calls).toHaveLength(0);
  });
});

describe("OTP routing diagnostics", () => {
  it("retains an explicitly better walking itinerary instead of treating the diagnostic as acquisition failure", async () => {
    const response = payload();
    Object.assign(response.data.planConnection, {
      routingErrors: [{ code: "WALKING_BETTER_THAN_TRANSIT" }],
    });
    response.data.planConnection.edges[0].node.legs[0].mode = "WALK";
    const result = await fixture(undefined, () => response).plan(request);
    expect(result.data[0].itineraries).toHaveLength(1);
  });
});

describe("OTP result realtime evidence", () => {
  it("marks empty and excluded plans as having no realtime data", async () => {
    const excluded = await fixture().plan({ ...request, deutschlandticketOnly: true });
    expect(excluded.freshness.hasRealtimeData).toBe(false);
    const empty = await fixture(undefined, () => ({
      data: { planConnection: { edges: [], routingErrors: [] } },
    })).plan(request);
    expect(empty.freshness.hasRealtimeData).toBe(false);
  });
  it.each(["scheduled", "walking", "estimated", "updated", "cancelled"])(
    "derives realtime evidence from retained %s legs",
    async (kind) => {
      const data = payload();
      const leg = data.data.planConnection.edges[0].node.legs[0];
      Object.assign(leg, {
        tripOnServiceDate: {
          realTimeTripState: { canceled: kind === "cancelled", updated: kind === "updated" },
        },
      });
      if (kind === "walking") {
        leg.mode = "WALK";
        Object.assign(leg, { tripOnServiceDate: null });
      }
      if (kind === "estimated")
        Object.assign(leg.start, { estimated: { time: start, delay: "PT0S" } });
      const result = await fixture(undefined, () => data).plan(request);
      expect(result.freshness.hasRealtimeData).toBe(
        ["estimated", "updated", "cancelled"].includes(kind),
      );
      expect(result.data[0].itineraries[0].legs[0].realtime).toBe(
        ["estimated", "updated", "cancelled"].includes(kind),
      );
    },
  );
});

describe("OTP publication fences at every policy await", () => {
  it.each(
    [1, 2, 3, 4, 5].flatMap((boundary) =>
      ["retire", "deny"].map((action) => ({ boundary, action })),
    ),
  )("prevents publication after $action at boundary $boundary", async ({ boundary, action }) => {
    let checks = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = fixture(undefined, payload, async () => {
      if (++checks === boundary) await held;
    });
    const assertion = expect(f.plan(request)).rejects.toThrow(
      action === "retire" ? "OTP request cancelled" : "OTP source denied",
    );
    try {
      await vi.waitFor(() => expect(checks).toBe(boundary));
      if (action === "retire") await f.shutdown();
      else f.deny();
      release();
      await assertion;
      expect(f.http.calls).toHaveLength(boundary <= 2 ? 0 : 1);
    } finally {
      release();
    }
  });
});
