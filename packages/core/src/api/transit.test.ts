import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "./client";
import {
  buildTransitPlanParams,
  fetchTransitPlan,
  fetchVehicleJourney,
  refreshTransitItinerary,
  type TransitPlanParams,
} from "./transit";

let calls: Array<{ url: string; init: RequestInit }> = [];

function mockFetch(body: unknown = { data: {} }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init: RequestInit = {}) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
}

const client = () => createApiClient({ baseUrl: "https://api.example/", credentials: "omit" });

const BASE: TransitPlanParams = {
  origin: [8.6, 50.1],
  destination: [8.7, 50.2],
  time: "2026-08-10T09:00:00Z",
};

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("buildTransitPlanParams", () => {
  it("maps origin, destination and time", () => {
    expect(buildTransitPlanParams(BASE)).toEqual({
      from_lat: "50.1",
      from_lng: "8.6",
      to_lat: "50.2",
      to_lng: "8.7",
      time: "2026-08-10T09:00:00Z",
    });
  });

  it("omits every optional parameter that was not asked for", () => {
    expect(Object.keys(buildTransitPlanParams(BASE)).sort()).toEqual([
      "from_lat",
      "from_lng",
      "time",
      "to_lat",
      "to_lng",
    ]);
  });

  it("carries every user option the planner supports", () => {
    const query = buildTransitPlanParams({
      ...BASE,
      arriveBy: true,
      numItineraries: 5,
      lang: "de",
      modes: ["TRAM", "BUS"],
      wheelchairRequired: true,
      maxTransfers: 2,
      transferBuffer: "relaxed",
      requireBikeTransport: true,
      bikeHillPreference: "avoid",
      rentalFormFactors: ["scooter", "bicycle"],
      preTransitModes: ["BIKE"],
      postTransitModes: ["WALK"],
      directModes: ["CAR"],
      deutschlandticketOnly: true,
      pageToken: "tok",
      capabilityEpoch: "e1",
      rentalSource: "src",
      rentalInstance: "inst",
    });
    expect(query).toMatchObject({
      arrive_by: "true",
      num_itineraries: "5",
      lang: "de",
      modes: "BUS,TRAM",
      wheelchair: "true",
      max_transfers: "2",
      transfer_buffer: "relaxed",
      require_bike_transport: "true",
      bike_hill_preference: "avoid",
      rental_form_factors: "bicycle,scooter",
      pre_modes: "BIKE",
      post_modes: "WALK",
      direct_modes: "CAR",
      deutschlandticket: "true",
      page_token: "tok",
      capability_epoch: "e1",
      rental_source: "src",
      rental_instance: "inst",
    });
  });

  it("sorts list parameters so the same set always produces one key", () => {
    const a = buildTransitPlanParams({ ...BASE, modes: ["TRAM", "BUS"] });
    const b = buildTransitPlanParams({ ...BASE, modes: ["BUS", "TRAM"] });
    expect(a.modes).toBe(b.modes);
  });

  it("deduplicates a repeated list value", () => {
    expect(buildTransitPlanParams({ ...BASE, modes: ["BUS", "BUS"] }).modes).toBe("BUS");
  });

  it("treats the default itinerary count and transfer buffer as unset", () => {
    const query = buildTransitPlanParams({
      ...BASE,
      numItineraries: 3,
      transferBuffer: "standard",
      bikeHillPreference: "default",
    });
    expect(query.num_itineraries).toBeUndefined();
    expect(query.transfer_buffer).toBeUndefined();
    expect(query.bike_hill_preference).toBeUndefined();
  });

  it("treats wheelchairRequired as implying wheelchair routing", () => {
    expect(buildTransitPlanParams({ ...BASE, wheelchairRequired: true }).wheelchair).toBe("true");
  });

  it("keeps max_transfers of zero, which is a meaningful request", () => {
    expect(buildTransitPlanParams({ ...BASE, maxTransfers: 0 }).max_transfers).toBe("0");
  });
});

describe("fetchTransitPlan", () => {
  it("uses the supplied client's origin and omits credentials", async () => {
    mockFetch();
    await fetchTransitPlan(BASE, client());
    expect(calls[0].url.startsWith("https://api.example/api/integrations/transit/plan")).toBe(true);
    expect(calls[0].init.credentials).toBe("omit");
  });

  it("passes request options through to the client", async () => {
    mockFetch();
    const controller = new AbortController();
    await fetchTransitPlan(BASE, client(), { signal: controller.signal });
    expect(calls).toHaveLength(1);
  });
});

describe("refreshTransitItinerary", () => {
  it("sends exactly the one supplied token", async () => {
    mockFetch({ data: { itinerary: {}, fallbackOccurred: false } });
    await refreshTransitItinerary("token-1", client());
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ token: "token-1" });
  });

  it("returns the replacement itinerary without retaining anything globally", async () => {
    mockFetch({ data: { itinerary: { legs: [] }, fallbackOccurred: true } });
    const first = await refreshTransitItinerary("token-1", client());
    expect(first.data?.fallbackOccurred).toBe(true);

    mockFetch({ data: { itinerary: { legs: [] }, fallbackOccurred: false } });
    const second = await refreshTransitItinerary("token-2", client());
    expect(second.data?.fallbackOccurred).toBe(false);
    expect(JSON.parse(String(calls.at(-1)?.init.body))).toEqual({ token: "token-2" });
  });

  it("never puts the token in the URL, where it could reach a server log", async () => {
    mockFetch({ data: { itinerary: {}, fallbackOccurred: false } });
    await refreshTransitItinerary("super-secret-token", client());
    expect(calls[0].url).not.toContain("super-secret-token");
  });
});

describe("fetchVehicleJourney", () => {
  it("substitutes the trip id into the path", async () => {
    mockFetch();
    await fetchVehicleJourney({ tripId: "trip/1" }, client());
    expect(calls[0].url).toContain("/vehicles/trip%2F1");
  });

  it("sends fallback ids as one comma-joined parameter", async () => {
    mockFetch();
    await fetchVehicleJourney({ tripId: "t1", fallbackIds: ["a", "b"] }, client());
    expect(calls[0].url).toContain("fallback_ids=a%2Cb");
  });

  it("omits the parameter when there are no fallbacks", async () => {
    mockFetch();
    await fetchVehicleJourney({ tripId: "t1" }, client());
    expect(calls[0].url).not.toContain("fallback_ids");
  });
});
