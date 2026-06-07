import { describe, expect, it } from "vitest";
import { isStalePrecacheName, offlineFallback } from "./swCaches";

const current = { appShell: "app-shell-NEW", style: "style-assets-NEW" };

describe("isStalePrecacheName", () => {
  it("flags an older app-shell cache", () => {
    expect(isStalePrecacheName("app-shell-v1", current)).toBe(true);
    expect(isStalePrecacheName("app-shell-OLD", current)).toBe(true);
  });

  it("keeps the current app-shell cache", () => {
    expect(isStalePrecacheName("app-shell-NEW", current)).toBe(false);
  });

  it("flags the legacy unversioned style cache and older versioned ones", () => {
    expect(isStalePrecacheName("style-assets", current)).toBe(true);
    expect(isStalePrecacheName("style-assets-OLD", current)).toBe(true);
  });

  it("keeps the current style cache", () => {
    expect(isStalePrecacheName("style-assets-NEW", current)).toBe(false);
  });

  it("never touches offline-area pins or other runtime caches", () => {
    for (const name of ["offline-area-123", "pages", "mapillary-tiles", "api-geodata"]) {
      expect(isStalePrecacheName(name, current)).toBe(false);
    }
  });
});

describe("offlineFallback", () => {
  it("uses the runtime strategy when it returns a response (online wins; pin not consulted)", async () => {
    let offlineConsulted = false;
    const out = await offlineFallback(
      () => Promise.resolve("fresh"),
      () => {
        offlineConsulted = true;
        return Promise.resolve("pinned");
      },
    );
    expect(out).toBe("fresh");
    expect(offlineConsulted).toBe(false);
  });

  it("falls back to the offline-area pin when the strategy yields nothing", async () => {
    const out = await offlineFallback(
      () => Promise.resolve(null),
      () => Promise.resolve("pinned"),
    );
    expect(out).toBe("pinned");
  });

  it("falls back to the offline-area pin when the strategy throws (offline)", async () => {
    const out = await offlineFallback(
      () => Promise.reject(new Error("network down")),
      () => Promise.resolve("pinned"),
    );
    expect(out).toBe("pinned");
  });

  it("rethrows when the strategy fails and there is no pin", async () => {
    let caught: Error | undefined;
    try {
      await offlineFallback(
        () => Promise.reject(new Error("network down")),
        () => Promise.resolve(null),
      );
    } catch (e) {
      caught = e as Error;
    }
    expect(caught?.message).toBe("network down");
  });
});
