import type { ApiClient, ApiRequestOptions } from "@openmapx/core/navigation/api";
import { fetchJourneyCaptures } from "./journeyCaptures";

const OPTIONS: ApiRequestOptions = { timeoutMs: 5_000 };

function tripIdFromPath(path: string): string {
  return decodeURIComponent(path.slice(path.lastIndexOf("/") + 1));
}

describe("fetchJourneyCaptures", () => {
  it("never exceeds the configured concurrency", async () => {
    let active = 0;
    let peak = 0;
    const client = {
      get: async (path: string) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
        return { data: { stops: [{ tripId: tripIdFromPath(path) }] } };
      },
    } as unknown as ApiClient;

    await fetchJourneyCaptures(
      Array.from({ length: 11 }, (_, index) => `trip-${index}`),
      client,
      OPTIONS,
      3,
    );

    expect(peak).toBe(3);
  });

  it("assembles captures by trip id regardless of input order", async () => {
    const client = {
      get: async (path: string) => {
        const tripId = tripIdFromPath(path);
        return { data: { stops: [{ stopId: `stop-${tripId}` }] } };
      },
    } as unknown as ApiClient;

    const expected = {
      "trip-a": [{ stopId: "stop-trip-a" }],
      "trip-b": [{ stopId: "stop-trip-b" }],
      "trip-c": [{ stopId: "stop-trip-c" }],
    };

    await expect(
      fetchJourneyCaptures(["trip-c", "trip-a", "trip-b"], client, OPTIONS, 2),
    ).resolves.toEqual(expected);
    await expect(
      fetchJourneyCaptures(["trip-a", "trip-b", "trip-c"], client, OPTIONS, 2),
    ).resolves.toEqual(expected);
  });

  it("keeps successful captures when one request fails", async () => {
    const client = {
      get: async (path: string) => {
        const tripId = tripIdFromPath(path);
        if (tripId === "trip-b") throw new Error("unavailable");
        return { data: { stops: [{ stopId: `stop-${tripId}` }] } };
      },
    } as unknown as ApiClient;

    await expect(
      fetchJourneyCaptures(["trip-a", "trip-b", "trip-c"], client, OPTIONS, 2),
    ).resolves.toEqual({
      "trip-a": [{ stopId: "stop-trip-a" }],
      "trip-b": undefined,
      "trip-c": [{ stopId: "stop-trip-c" }],
    });
  });

  it("marks a response without a stop array as unavailable", async () => {
    const client = {
      get: async () => ({ data: { stops: "invalid" } }),
    } as unknown as ApiClient;

    await expect(fetchJourneyCaptures(["trip-a"], client, OPTIONS, 1)).resolves.toEqual({
      "trip-a": undefined,
    });
  });

  it("rejects an invalid concurrency instead of entering an unbounded loop", async () => {
    await expect(fetchJourneyCaptures([], {} as ApiClient, OPTIONS, 0)).rejects.toThrow(
      "concurrency must be a positive integer",
    );
  });
});
