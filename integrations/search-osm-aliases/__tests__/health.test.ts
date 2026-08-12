import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { describe, expect, it, vi } from "vitest";
import { setup } from "../index.js";

describe("OSM alias index health", () => {
  it("is unconfigured without PostGIS", async () => {
    const ctx = createMockIntegrationContext();
    setup(ctx);
    await expect(ctx.registered.healthChecks[0]()).resolves.toMatchObject({
      status: "unconfigured",
    });
  });

  it("keeps a stale published index up with an explanation", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([{ relation: "osm_search.index_state" }])
      .mockResolvedValueOnce([
        { status: "ready", source_fingerprint: "old", current_fingerprint: "new" },
      ]);
    const ctx = createMockIntegrationContext({ db: { execute } });
    setup(ctx);
    await expect(ctx.registered.healthChecks[0]()).resolves.toMatchObject({
      status: "up",
      error: expect.stringContaining("stale"),
    });
  });
});
