import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { describe, expect, it, vi } from "vitest";
import { setup as setupTransit } from "../../transit/index.js";
import { setup as setupOverlay } from "../index.js";

describe("nested alert cache budget", () => {
  for (const [path, setup] of [
    ["/alerts", setupTransit],
    ["/snapshot", setupOverlay],
  ] as const) {
    it(`${path} reserves freshness time for the national snapshot`, async () => {
      const ctx = createMockIntegrationContext();
      const cache = vi.spyOn(ctx.cache, "withCache");
      setup(ctx);
      const route = ctx.registered.routes.find((r) => r.path === path);
      if (!route) throw new Error("missing route");
      const reply = { header: vi.fn(), send: vi.fn(), status: vi.fn() };
      await route.handler(
        {
          query: {
            south: "59",
            west: "10",
            north: "61",
            east: "12",
            sw_lat: "59",
            sw_lng: "10",
            ne_lat: "61",
            ne_lng: "12",
          },
        } as never,
        reply as never,
      );
      const alertCall = cache.mock.calls.find(([key]) => key.includes("alerts"));
      expect(alertCall?.[1]).toBe(30);
      expect(reply.header).toHaveBeenCalledWith("Cache-Control", "public, max-age=15, s-maxage=15");
      expect(reply.send).toHaveBeenCalledOnce();
      // Entur's separately tested 15 s snapshot plus these caches is <= 60 s.
      expect(15 + Number(alertCall?.[1]) + 15).toBeLessThanOrEqual(60);
    });
  }
});
