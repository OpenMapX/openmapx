import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { describe, expect, it } from "vitest";
import { setup } from "./index.js";

const request = {
  pickup: [13.405, 52.52] as [number, number],
  dropoff: [13.377, 52.516] as [number, number],
};

describe("ride-deeplink setup", () => {
  it("registers one ride provider per deep-link app", () => {
    const ctx = createMockIntegrationContext({ id: "ride-deeplink", config: {} });
    setup(ctx);
    expect(ctx.registered.ride.map((p) => p.id)).toEqual([
      "uber",
      "lyft",
      "bolt",
      "freenow",
      "yango",
    ]);
  });

  it("declares deepLink only, and never permits comparison", () => {
    const ctx = createMockIntegrationContext({ id: "ride-deeplink", config: {} });
    setup(ctx);
    for (const p of ctx.registered.ride) {
      expect(p.capabilities).toEqual({
        deepLink: true,
        quote: false,
        booking: false,
        tracking: false,
      });
      expect(p.permitsComparison).toBe(false);
      expect(p.getQuotes).toBeUndefined();
    }
  });

  it("reports availability without claiming a coverage check", async () => {
    const ctx = createMockIntegrationContext({ id: "ride-deeplink", config: {} });
    setup(ctx);
    const result = await ctx.registered.ride[0].getAvailability(request);
    expect(result.data.available).toBe(true);
    expect(result.data.coverageChecked).toBe(false);
    expect(result.data.products).toEqual([]);
  });

  it("honours the configured affiliate id", async () => {
    const ctx = createMockIntegrationContext({
      id: "ride-deeplink",
      config: { uberClientId: "abc123" },
    });
    setup(ctx);
    const uber = ctx.registered.ride.find((p) => p.id === "uber");
    const handoff = await uber?.createHandoff(request);
    expect(handoff?.webUrl).toContain("client_id=abc123");
  });

  it("only registers providers named in enabledProviders", () => {
    const ctx = createMockIntegrationContext({
      id: "ride-deeplink",
      config: { enabledProviders: ["uber", "bolt"] },
    });
    setup(ctx);
    expect(ctx.registered.ride.map((p) => p.id)).toEqual(["uber", "bolt"]);
  });
});
