import type { HttpResponse, UpstreamRuntime } from "@openmapx/integration-framework";
import { fakeHttpClient } from "@openmapx/integration-framework/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOtpGraphQlAdapter } from "../otp-graphql";
import { OTP_PROFILES, publicOtpPolicy, resolveOtpProfile } from "../otp-profiles";
import type { RegistryEntry } from "../registry-types";

const base = 1_792_713_600;
const stop = {
  __typename: "Stop",
  gtfsId: "feed:1",
  name: "Stop",
  lat: 48,
  lon: 9,
  vehicleMode: "BUS",
  platformCode: "2",
  parentStation: { gtfsId: "feed:parent" },
};
const quay = {
  __typename: "Quay",
  id: "feed:1",
  name: "Stop",
  latitude: 48,
  longitude: 9,
  publicCode: "42",
  stopPlace: { id: "feed:parent" },
};
function calls() {
  return {
    serviceDay: base,
    scheduledDeparture: 90000,
    realtimeDeparture: 90060,
    realtime: true,
    realtimeState: "CANCELED",
    headsign: "Destination",
    trip: {
      gtfsId: "feed:trip",
      route: {
        gtfsId: "feed:route",
        shortName: "42",
        longName: null,
        mode: "BUS",
        color: "ff0000",
      },
    },
  };
}
function tmCall() {
  return {
    aimedDepartureTime: new Date((base + 90000) * 1000).toISOString(),
    expectedDepartureTime: new Date((base + 90060) * 1000).toISOString(),
    realtime: true,
    realtimeState: "canceled",
    cancellation: true,
    forBoarding: true,
    destinationDisplay: { frontText: "Destination" },
    serviceJourney: {
      id: "feed:trip",
      transportMode: "bus",
      publicCode: "42",
      line: { id: "feed:route", publicCode: "42", name: null, transportMode: "bus" },
    },
  };
}
function fixture(family = "peatus", response?: unknown) {
  const profile = OTP_PROFILES.find((p) => p.family === family)!;
  const entry: RegistryEntry = {
    id: profile.id,
    slug: family,
    prefix: family + ":",
    name: family,
    protocol: "otpGraphQl",
    supportedLanguages: ["en"],
    options: { endpoint: profile.catalogEndpoint, apiKey: "untrusted-catalog-key" },
    coverage: { bbox: [-180, -90, 180, 90], tiers: [] },
  };
  const generation = new AbortController();
  let allowed = true;
  const respond = (req: { body?: unknown }) => {
    if (response !== undefined) return response;
    const body = req.body as { query: string };
    if (body.query.includes("DynamicNearby"))
      return {
        data: { nearest: { edges: [{ node: { place: family === "trufi" ? quay : stop } }] } },
      };
    if (body.query.includes("DynamicDepartures"))
      return family === "trufi"
        ? { data: { quay: { id: "feed:1", estimatedCalls: [tmCall()] } } }
        : { data: { stop: { gtfsId: "feed:1", stoptimesWithoutPatterns: [calls()] } } };
    return { data: family === "trufi" ? { quays: [quay] } : { stops: [stop] } };
  };
  const http = fakeHttpClient((req) => {
    const result = respond({
      ...req,
      body: typeof req.body === "string" ? JSON.parse(req.body) : req.body,
    });
    const response =
      typeof result === "object" && result !== null && "status" in result && "body" in result
        ? result
        : { status: 200, headers: {}, body: result };
    return { ...response, body: JSON.stringify(response.body) };
  });
  const admit = vi.fn(async (_input: { scope: string; key: string; signal?: AbortSignal }) => ({
    allowed: true as const,
    remaining: null,
  }));
  const defer = vi.fn(async () => {});
  const runtime = {
    admitSharedRequest: admit,
    deferSharedRequests: defer,
  } as unknown as UpstreamRuntime;
  const options = {
    http,
    upstreamRuntime: runtime,
    signal: generation.signal,
    isSourceAllowed: async () => allowed,
    digitransitApiKey: "operator-secret",
  };
  return {
    entry,
    http,
    generation,
    runtime,
    options,
    admit,
    defer,
    deny: () => {
      allowed = false;
    },
    adapter: createOtpGraphQlAdapter(options),
  };
}
afterEach(() => vi.useRealTimers());
describe("generated dynamic OTP acquisition", () => {
  it.each(["stadtnavi", "peatus", "torino", "digitransit", "trufi"])(
    "maps all three operations against %s exact generated contract",
    async (family) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime((base + 89900) * 1000);
      const f = fixture(family);
      expect(await f.adapter.getStopsNearby(f.entry, 48, 9, 500)).toMatchObject([
        { id: family + ":feed:1", name: "Stop", lat: 48, lng: 9 },
      ]);
      expect(await f.adapter.searchByName!(f.entry, "Stop", 1)).toHaveLength(1);
      const departures = await f.adapter.getDepartures(f.entry, f.entry.prefix + "feed:1", 10);
      expect(departures).toMatchObject([
        {
          tripId: family + ":feed:trip",
          scheduledAt: new Date((base + 90000) * 1000).toISOString(),
          expectedAt: new Date((base + 90060) * 1000).toISOString(),
          delaySeconds: 60,
          canceled: true,
          route: { id: family + ":feed:route", mode: "bus" },
        },
      ]);
      expect(f.http.calls).toHaveLength(3);
      expect(f.admit).toHaveBeenCalledTimes(3);
      for (const call of f.http.calls) {
        expect(call.options?.headers).not.toHaveProperty("ET-Client-Name");
        expect(call.options?.headers).not.toHaveProperty("Authorization");
        expect(JSON.stringify(call)).not.toContain("untrusted-catalog-key");
      }
      if (family === "digitransit")
        expect(f.http.calls[0].options?.headers).toHaveProperty(
          "digitransit-subscription-key",
          "operator-secret",
        );
      else
        expect(f.http.calls[0].options?.headers).not.toHaveProperty("digitransit-subscription-key");
    },
  );
  it.each([
    { data: { stops: [] } },
    { data: { stops: null } },
    { data: { stops: [{ ...stop, lat: null }] } },
    { data: { stops: [{ ...stop, lat: 91 }] } },
    { data: { stops: [{ ...stop, vehicleMode: "FUTURE" }] } },
    { data: { stops: [{ ...stop, gtfsId: "" }] } },
    { data: { stops: [{ ...stop, name: "" }] } },
    { data: { stops: [stop] }, errors: [{ message: "private" }] },
    { data: null },
    {},
  ])("distinguishes valid empty from invalid/errored search: %j", async (body) => {
    const f = fixture("peatus", body);
    if (
      "data" in body &&
      body.data &&
      "stops" in body.data &&
      Array.isArray(body.data.stops) &&
      body.data.stops.length === 0
    )
      expect(await f.adapter.searchByName!(f.entry, "X", 10)).toEqual([]);
    else await expect(f.adapter.searchByName!(f.entry, "X", 10)).rejects.toThrow(/^OTP /);
  });
  it.each([
    null,
    { gtfsId: "wrong", stoptimesWithoutPatterns: [] },
    { gtfsId: "feed:1", stoptimesWithoutPatterns: [{ ...calls(), serviceDay: null }] },
    { gtfsId: "feed:1", stoptimesWithoutPatterns: [{ ...calls(), scheduledDeparture: 0.5 }] },
    { gtfsId: "feed:1", stoptimesWithoutPatterns: [{ ...calls(), trip: null }] },
  ])("rejects missing/mismatched stop and unusable time/trip data", async (stopValue) => {
    const f = fixture("peatus", { data: { stop: stopValue } });
    await expect(f.adapter.getDepartures(f.entry, "peatus:feed:1", 10)).rejects.toThrow(/^OTP /);
  });
  it("does not invent realtime for scheduled calls; retains empty valid departure board", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime((base + 89900) * 1000);
    const c = { ...calls(), realtime: false, realtimeDeparture: null, realtimeState: "SCHEDULED" };
    const f = fixture("peatus", {
      data: { stop: { gtfsId: "feed:1", stoptimesWithoutPatterns: [c] } },
    });
    const result = await f.adapter.getDepartures(f.entry, "peatus:feed:1", 10);
    expect(result[0].expectedAt).toBeUndefined();
    expect(result[0].delaySeconds).toBeUndefined();
    expect(result[0].canceled).toBe(false);
    const empty = fixture("trufi", { data: { quay: { id: "feed:1", estimatedCalls: [] } } });
    expect(await empty.adapter.getDepartures(empty.entry, "trufi:feed:1", 10)).toEqual([]);
  });
  it("filters alighting-only Transmodel calls and preserves explicit null vs empty errors", async () => {
    const f = fixture("trufi", {
      data: { quay: { id: "feed:1", estimatedCalls: [{ ...tmCall(), forBoarding: false }] } },
    });
    expect(await f.adapter.getDepartures(f.entry, "trufi:feed:1", 10)).toEqual([]);
    const g = fixture("trufi", { data: { nearest: null } });
    await expect(g.adapter.getStopsNearby(g.entry, 48, 9, 100)).rejects.toThrow(
      "OTP invalid response",
    );
  });
  it.each(["unknown", "modified", "unconfigured"])(
    "fails %s profile before network",
    async (kind) => {
      const f = fixture(kind === "unconfigured" ? "digitransit" : "peatus");
      if (kind === "unknown") f.entry.id = "xx/unknown";
      if (kind === "modified") f.entry.options.endpoint = "https://evil.test";
      const adapter =
        kind === "unconfigured"
          ? createOtpGraphQlAdapter({ ...f.options, digitransitApiKey: undefined })
          : f.adapter;
      await expect(adapter.searchByName!(f.entry, "X", 1)).rejects.toThrow(/^OTP /);
      expect(f.http.calls).toHaveLength(0);
    },
  );
  it("does not acquire after denial and fences policy revocation after response", async () => {
    const f = fixture();
    f.deny();
    await expect(f.adapter.searchByName!(f.entry, "X", 1)).rejects.toThrow("OTP source denied");
    expect(f.http.calls).toHaveLength(0);
    const g = fixture();
    vi.spyOn(g.http, "postText").mockImplementation(async () => {
      g.deny();
      return { status: 200, headers: {}, body: JSON.stringify({ data: { stops: [] } }) };
    });
    await expect(g.adapter.searchByName!(g.entry, "X", 1)).rejects.toThrow("OTP source denied");
  });
  it("retires an uncooperative request and rejects its late success", async () => {
    const f = fixture();
    let finish!: (value: HttpResponse<unknown>) => void;
    vi.spyOn(f.http, "postText").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = f.adapter.searchByName!(f.entry, "X", 1);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    f.generation.abort();
    await expect(pending).rejects.toThrow("OTP request cancelled");
    finish({ status: 200, headers: {}, body: JSON.stringify({ data: { stops: [] } }) });
  });
  it("fails closed on missing/store-unavailable admission and records shared Retry-After", async () => {
    const f = fixture();
    const denied = vi.fn(async () => ({
      allowed: false as const,
      reason: "store_unavailable" as const,
      retryAfterMs: null,
    }));
    const adapter = createOtpGraphQlAdapter({
      ...f.options,
      upstreamRuntime: { ...f.runtime, admitSharedRequest: denied },
    });
    await expect(adapter.searchByName!(f.entry, "X", 1)).rejects.toThrow(
      "OTP upstream unavailable",
    );
    expect(f.http.calls).toHaveLength(0);
    const g = fixture("peatus", { status: 429, headers: { "retry-after": "37" }, body: {} });
    await expect(g.adapter.searchByName!(g.entry, "X", 1)).rejects.toThrow("OTP upstream cooldown");
    expect(g.defer).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "https://api.peatus.ee", key: "anonymous", delayMs: 37000 }),
    );
  });
  it("shares credential bucket across Digitransit regions, isolates other keys and anonymous authorities", async () => {
    const f = fixture();
    const signal = new AbortController().signal;
    const keyed = OTP_PROFILES.filter((p) => p.keyed);
    for (const p of keyed) await publicOtpPolicy(p, "same", f.runtime).beforeRequest(signal);
    const identities = f.admit.mock.calls.map((call) => call[0]);
    expect(new Set(identities.map((x) => JSON.stringify(x))).size).toBe(1);
    expect(JSON.stringify(identities)).not.toContain("same");
    await publicOtpPolicy(keyed[0], "other", f.runtime).beforeRequest(signal);
    expect(f.admit.mock.calls.at(-1)![0]).not.toEqual(identities[0]);
    expect(() =>
      resolveOtpProfile({
        ...f.entry,
        id: "fi/helsinki-otp",
        options: { endpoint: "https://evil.test" },
      }),
    ).toThrow("OTP invalid configuration");
  });
  it.each([0, -1, NaN, Infinity, 1.5, 1441])(
    "rejects bad departure windows before network: %s",
    async (minutes) => {
      const f = fixture();
      await expect(f.adapter.getDepartures(f.entry, "peatus:feed:1", minutes)).rejects.toThrow(
        "OTP invalid request",
      );
      expect(f.http.calls).toHaveLength(0);
    },
  );
});
