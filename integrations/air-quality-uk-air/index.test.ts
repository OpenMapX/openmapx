import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { describe, expect, it } from "vitest";

import { setup } from "./index.js";

describe("UK-AIR integration", () => {
  it("registers its canonical air-quality provider", () => {
    const ctx = createMockIntegrationContext();
    setup(ctx);
    expect(ctx.registered.airQuality).toHaveLength(1);
    expect(ctx.registered.airQuality[0]).toMatchObject({
      id: "uk-air",
      sourceIds: ["uk-air-current-site-levels"],
      priority: 100,
    });
    expect([...(ctx.registered.airQuality[0]?.capabilities ?? [])].sort()).toEqual([
      "current",
      "published-index",
    ]);
  });
});
