import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "./client";
import { fetchDirections } from "./directions";

describe("fetchDirections", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("forwards the provider pin and cancellation signal", async () => {
    const signal = new AbortController().signal;
    const spy = vi.spyOn(apiClient, "get").mockResolvedValue({ routes: [] } as never);
    await fetchDirections(
      {
        waypoints: [
          [1, 2],
          [3, 4],
        ],
        provider: "routing-valhalla",
      },
      apiClient,
      { signal },
    );
    expect(spy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ provider: "routing-valhalla" }),
      expect.objectContaining({ signal }),
    );
  });

  it("serializes waypoints and forwards options to apiClient.get", async () => {
    const spy = vi.spyOn(apiClient, "get").mockResolvedValue({ routes: [] } as never);
    await fetchDirections({
      waypoints: [
        [1, 2],
        [3, 4],
      ],
      mode: "driving",
      avoidHighways: true,
      units: "metric",
      lang: "en",
    });
    expect(spy).toHaveBeenCalledWith(
      "/api/integrations/routing/directions",
      expect.objectContaining({
        waypoints: "1,2;3,4",
        mode: "driving",
        avoidHighways: "true",
        lang: "en",
      }),
      // Request options are forwarded as a third argument so a native caller
      // can supply a timeout or abort signal.
      expect.objectContaining({ maxBytes: expect.any(Number) }),
    );
  });

  it("accepts a reply with alternatives above the client's 8 MiB default through the transport", async () => {
    // Three alternatives of 140,000 points each: a long cross-country plan.
    const route = {
      geometry: Array.from({ length: 140_000 }, (_, i) => [9.1234567 + i / 1e5, 50.1234567]),
      distance: 1_400_000,
      duration: 50_000,
      steps: [],
    };
    const body = {
      waypoints: [
        [1, 2],
        [3, 4],
      ],
      routes: [route, route, route],
      activeRouteIndex: 0,
    };
    expect(JSON.stringify(body).length).toBeGreaterThan(8 * 1024 * 1024);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(body)),
    );
    try {
      const result = await fetchDirections({
        waypoints: [
          [1, 2],
          [3, 4],
        ],
      });
      expect(result.routes).toHaveLength(3);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
