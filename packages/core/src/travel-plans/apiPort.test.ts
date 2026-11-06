import { describe, expect, it, vi } from "vitest";
import { type ApiClient, ApiClientError } from "../api/client";
import { providerPlanSelection } from "./__fixtures__/providerPlan";
import { createTravelPlanPort } from "./apiPort";

const fresh = { fetchedAt: "2026-11-06T20:00:00Z", hasRealtimeData: false, isStale: false };
describe("travel-plan API acquisition", () => {
  it("returns the unchanged normal search and exact-reference envelopes", async () => {
    const envelope = providerPlanSelection().plan;
    const get = vi.fn().mockResolvedValue(envelope);
    const post = vi.fn().mockResolvedValue(envelope);
    const port = createTravelPlanPort({ get, post } as unknown as ApiClient);
    const signal = new AbortController().signal;
    expect(
      await port.plan(
        { origin: [6, 50], destination: [7, 51], time: "2026-11-06T20:16:00.000Z" },
        signal,
      ),
    ).toBe(envelope);
    const params = {
      reference: {
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
      wheelchairRequired: true,
    };
    expect(await port.resolveTrip(params, signal)).toBe(envelope);
    expect(post).toHaveBeenCalledWith("/api/integrations/transit/plan/resolve", params, {
      signal,
      timeoutMs: 15000,
    });
    get.mockRejectedValue(new ApiClientError(503, null, null));
    await expect(
      port.plan(
        { origin: [6, 50], destination: [7, 51], time: "2026-11-06T20:16:00.000Z" },
        signal,
      ),
    ).resolves.toBeNull();
  });
  it("sends the anchor and provider-qualified id, keeps abort/timeout and distinguishes unsupported from failure", async () => {
    const get = vi.fn().mockResolvedValue({ data: [], attributions: [], freshness: fresh });
    const port = createTravelPlanPort({ get } as unknown as ApiClient);
    const signal = new AbortController().signal;
    await port.departures("ms:station/1", "2026-11-06T20:17:00.000Z", signal);
    expect(get).toHaveBeenCalledWith(
      "/api/integrations/transit/stops/ms%3Astation%2F1/departures",
      { time: "2026-11-06T20:17:00.000Z", minutes: "60" },
      { signal, timeoutMs: 15000 },
    );
    get.mockRejectedValue(new ApiClientError(501, null, null));
    await expect(port.departures("ms:a", "time", signal)).resolves.toBeNull();
    get.mockRejectedValue(new ApiClientError(503, null, null));
    await expect(port.departures("ms:a", "time", signal)).rejects.toBeDefined();
  });
  it("refuses partial or stale acquisition as exact-trip evidence", async () => {
    const get = vi
      .fn()
      .mockResolvedValue({ data: [], attributions: [], freshness: { ...fresh, isPartial: true } });
    const port = createTravelPlanPort({ get } as unknown as ApiClient);
    await expect(
      port.departures("ms:Aachen", "time", new AbortController().signal),
    ).rejects.toMatchObject({ code: "unavailable" });
  });
});

it.each([{ modes: ["rail"] }, { modes: [] }])(
  "corroborates partial name search with modes=$modes using nearby rail stops",
  async ({ modes }) => {
    const anchor = {
      id: "ir:A",
      name: "Berlin Hbf",
      lat: 52.525,
      lng: 13.369,
      modes,
      provider: "ir",
    };
    const nearby = {
      ...anchor,
      id: "mo:B",
      name: "S+U Berlin Hauptbahnhof",
      provider: "mo",
      modes: ["rail"],
    };
    const corner = { ...nearby, id: "mo:corner", lat: 52.537, lng: 13.388 };
    const get = vi
      .fn()
      .mockResolvedValueOnce({
        data: [anchor],
        attributions: [],
        freshness: { ...fresh, isPartial: true },
      })
      .mockResolvedValueOnce({ data: [nearby, corner], attributions: [], freshness: fresh });
    const stops = await createTravelPlanPort({ get } as unknown as ApiClient).searchStops(
      "Berlin Hbf",
      new AbortController().signal,
    );
    expect(stops.map((s) => s.id)).toEqual(["ir:A", "mo:B"]);
    expect(get.mock.calls[1][1]).toMatchObject({ radius: "1500", modes: "rail" });
  },
);
