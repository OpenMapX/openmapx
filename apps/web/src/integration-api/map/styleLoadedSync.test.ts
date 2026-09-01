import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createFakeMap } from "@/test";
import { subscribeStyleLoaded } from "./styleLoadedSync";

describe("subscribeStyleLoaded", () => {
  it("deduplicates delayed retries and removes every listener on dispose", () => {
    const fake = createFakeMap({ styleLoaded: false });
    const apply = vi.fn();
    const dispose = subscribeStyleLoaded(fake.map, apply);

    fake.emit("styledata");
    fake.emit("styledata");
    expect(fake.state.handlers.get("idle")?.size).toBe(1);

    dispose();
    expect(fake.state.handlers.get("styledata")?.size).toBe(0);
    expect(fake.state.handlers.get("idle")?.size).toBe(0);

    fake.state.styleLoaded = true;
    fake.emit("idle");
    expect(apply).not.toHaveBeenCalled();
  });

  it("runs only the current subscriber after a rapid replacement", () => {
    const fake = createFakeMap({ styleLoaded: false });
    const stale = vi.fn();
    const current = vi.fn();

    subscribeStyleLoaded(fake.map, stale)();
    subscribeStyleLoaded(fake.map, current);
    fake.state.styleLoaded = true;
    fake.emit("idle");

    expect(stale).not.toHaveBeenCalled();
    expect(current).toHaveBeenCalledTimes(1);
    expect(fake.state.handlers.get("idle")?.size).toBe(0);
  });

  it("is the lifecycle boundary used by every multi-layer style effect", () => {
    const files = [
      "apps/web/src/components/map/layers/DataSourceLayer.tsx",
      "apps/web/src/components/map/CategoryResultMarkers.tsx",
      "apps/web/src/components/map/layers/RasterBaseLayer.tsx",
      "apps/web/src/components/map/layers/ImportedGeometryLayer.tsx",
      "apps/web/src/integration-api/components/StreetLevelCoverageLayer.tsx",
    ];

    for (const file of files) {
      const source = readFileSync(resolve(process.cwd(), file), "utf8");
      expect(source).toContain("subscribeStyleLoaded(map");
      expect(source).not.toContain('once("idle"');
    }
  });
});
