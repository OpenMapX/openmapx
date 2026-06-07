import { describe, expect, it } from "vitest";
import { isStalePrecacheName } from "./swCaches";

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
