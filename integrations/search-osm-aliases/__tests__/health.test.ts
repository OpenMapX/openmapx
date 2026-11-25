import { OSM_SEARCH_SCHEMA_VERSION } from "@openmapx/core/published-data";
import { createMockIntegrationContext, nth } from "@openmapx/integration-framework/testing";
import { describe, expect, it, vi } from "vitest";
import { setup } from "../index.js";

describe("OSM alias index health", () => {
  it("is unconfigured without PostGIS", async () => {
    const ctx = createMockIntegrationContext();
    setup(ctx);
    await expect(nth(ctx.registered.healthChecks, 0)()).resolves.toMatchObject({
      status: "unconfigured",
    });
  });

  it("keeps a stale published index up with an explanation", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([{ relation: "osm_search.index_state" }])
      .mockResolvedValueOnce([
        {
          status: "ready",
          source_fingerprint: "old",
          current_fingerprint: "new",
          schema_version: OSM_SEARCH_SCHEMA_VERSION,
        },
      ]);
    const ctx = createMockIntegrationContext({ db: { execute } });
    setup(ctx);
    await expect(nth(ctx.registered.healthChecks, 0)()).resolves.toMatchObject({
      status: "up",
      error: expect.stringContaining("stale"),
    });
  });

  it("reports an index an older builder wrote as down until its rebuild", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([{ relation: "osm_search.index_state" }])
      .mockResolvedValueOnce([
        {
          status: "ready",
          source_fingerprint: "a",
          current_fingerprint: "a",
          schema_version: OSM_SEARCH_SCHEMA_VERSION + 1,
        },
      ]);
    const ctx = createMockIntegrationContext({ db: { execute } });
    setup(ctx);
    await expect(nth(ctx.registered.healthChecks, 0)()).resolves.toMatchObject({
      status: "down",
      error: expect.stringContaining("outdated layout"),
    });
  });
});
