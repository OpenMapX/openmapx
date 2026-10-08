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
      { signal },
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
      {},
    );
  });
});
