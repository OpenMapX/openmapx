import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createFakeMap } from "@/test";
import { subscribeStyleLoaded } from "./styleLoadedSync";

function unparsedMap() {
  const fake = createFakeMap({ styleLoaded: false });
  const parsedStyle = fake.map.getStyle();
  vi.spyOn(fake.map, "getStyle").mockImplementation(() =>
    fake.state.styleLoaded ? parsedStyle : (undefined as never),
  );
  return fake;
}

describe("subscribeStyleLoaded", () => {
  it("applies against a parsed style while sources are still loading", () => {
    const fake = createFakeMap({ styleLoaded: false });
    const apply = vi.fn();
    const dispose = subscribeStyleLoaded(fake.map, apply);
    expect(fake.map.isStyleLoaded()).toBe(false);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(fake.state.handlers.get("render")?.size ?? 0).toBe(0);
    dispose();
  });

  it("retries on style.load without requiring sources to finish", () => {
    const fake = createFakeMap({ styleLoaded: false });
    const style = fake.map.getStyle();
    let parsed = false;
    vi.spyOn(fake.map, "getStyle").mockImplementation(() =>
      parsed ? style : (undefined as never),
    );
    const apply = vi.fn();
    const dispose = subscribeStyleLoaded(fake.map, apply);
    expect(apply).not.toHaveBeenCalled();
    parsed = true;
    fake.emit("style.load");
    expect(apply).toHaveBeenCalledTimes(1);
    expect(fake.map.isStyleLoaded()).toBe(false);
    expect(fake.state.handlers.get("render")?.size).toBe(0);
    dispose();
    expect(fake.state.handlers.get("style.load")?.size).toBe(0);
  });

  it("does not swallow callback errors", () => {
    const fake = createFakeMap();
    expect(() =>
      subscribeStyleLoaded(fake.map, () => {
        throw new Error("broken layer");
      }),
    ).toThrow("broken layer");
  });

  it("deduplicates delayed retries and removes every listener on dispose", () => {
    const fake = unparsedMap();
    const apply = vi.fn();
    const dispose = subscribeStyleLoaded(fake.map, apply);

    fake.emit("styledata");
    fake.emit("styledata");
    expect(fake.state.handlers.get("idle")?.size).toBe(1);
    expect(fake.state.handlers.get("render")?.size).toBe(1);

    dispose();
    expect(fake.state.handlers.get("styledata")?.size).toBe(0);
    expect(fake.state.handlers.get("style.load")?.size).toBe(0);
    expect(fake.state.handlers.get("idle")?.size).toBe(0);
    expect(fake.state.handlers.get("render")?.size).toBe(0);

    fake.state.styleLoaded = true;
    fake.emit("idle");
    expect(apply).not.toHaveBeenCalled();
  });

  it("retries during continuous rendering without waiting for idle or new styledata", () => {
    const fake = unparsedMap();
    const apply = vi.fn();
    const dispose = subscribeStyleLoaded(fake.map, apply);
    for (let i = 0; i < 100; i++) fake.emit("render");
    expect(apply).not.toHaveBeenCalled();
    expect(fake.state.handlers.get("render")?.size).toBe(1);
    fake.state.styleLoaded = true;
    fake.emit("render");
    expect(apply).toHaveBeenCalledTimes(1);
    expect(fake.state.handlers.get("render")?.size).toBe(0);
    expect(fake.state.handlers.get("idle")?.size).toBe(0);
    for (let i = 0; i < 100; i++) fake.emit("render");
    expect(apply).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("runs only the current subscriber after a rapid replacement", () => {
    const fake = unparsedMap();
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
