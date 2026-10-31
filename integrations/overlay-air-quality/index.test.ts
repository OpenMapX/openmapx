import type { IntegrationContext } from "@openmapx/integration-framework";
import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { describe, expect, it } from "vitest";
import { setup } from "./index.js";
import manifest from "./manifest.json";
import { MemoryUpstreamRuntime } from "./test-helpers.js";

function context(config: Record<string, unknown> = {}) {
  const ctx = createMockIntegrationContext({
    id: "overlay-air-quality",
    config,
    manifest: manifest as IntegrationContext["manifest"],
  });
  Object.assign(ctx, { upstreamRuntime: new MemoryUpstreamRuntime() });
  setup(ctx);
  return ctx;
}

describe("overlay-air-quality setup", () => {
  it("serves OpenAQ stations only through the canonical air-quality API", () => {
    const ctx = context({ openAqApiKey: "redacted" });
    expect(ctx.id).toBe("overlay-air-quality");
    expect(manifest.domains).toEqual(["air-quality"]);
    expect(ctx.registered.airQuality).toHaveLength(1);
    // The deprecated `/air-quality/stations` route, superseded by `/api/integrations/air-quality/stations`, is gone.
    expect(ctx.registered.routes).toEqual([]);
  });

  it("registers no provider without an OpenAQ key", () => {
    const ctx = context();
    expect(ctx.registered.airQuality).toEqual([]);
    expect(ctx.registered.routes).toEqual([]);
  });
});
