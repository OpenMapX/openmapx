import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { describe, expect, it } from "vitest";

import { setup } from "./index.js";

describe("ECCC AQHI integration", () => {
  it("registers current and forecast as published, non-calculating evidence", () => {
    const ctx = createMockIntegrationContext();
    setup(ctx);
    expect(ctx.registered.airQuality).toHaveLength(1);
    expect(ctx.registered.airQuality[0]).toMatchObject({
      id: "eccc-aqhi",
      sourceIds: ["eccc-aqhi-geomet"],
      priority: 110,
    });
    expect([...(ctx.registered.airQuality[0]?.capabilities ?? [])].sort()).toEqual([
      "current",
      "forecast",
      "published-index",
    ]);
  });
});
