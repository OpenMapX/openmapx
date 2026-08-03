import { describe, expect, it } from "vitest";
import {
  isCredentialedApiPath,
  isStalePrecacheName,
  offlineStyleCacheNameForVersion,
  offlineStyleVersionFromAssetPath,
} from "./swCaches";

const current = { appShell: "app-shell-NEW", style: "style-assets-NEW" };

describe("service-worker cache names", () => {
  it("keeps current build caches and removes older build caches", () => {
    expect(isStalePrecacheName("app-shell-NEW", current)).toBe(false);
    expect(isStalePrecacheName("style-assets-NEW", current)).toBe(false);
    expect(isStalePrecacheName("app-shell-OLD", current)).toBe(true);
    expect(isStalePrecacheName("style-assets-OLD", current)).toBe(true);
    expect(isStalePrecacheName("style-assets", current)).toBe(true);
  });

  it("removes caches from the retired per-tile implementation", () => {
    expect(isStalePrecacheName("offline-area-old", current)).toBe(true);
    expect(isStalePrecacheName("omx-offline-results", current)).toBe(true);
    expect(isStalePrecacheName("offline-package-style-abc", current)).toBe(false);
    expect(isStalePrecacheName("pages", current)).toBe(false);
  });

  it("uses a stable, cache-safe package style name", () => {
    expect(offlineStyleCacheNameForVersion("style/v1?x")).toBe("offline-package-style-style_v1_x");
  });

  it("extracts the version from an unquery-pinned package asset path", () => {
    expect(
      offlineStyleVersionFromAssetPath(
        "/api/offline/packages/assets/openmapx/style-v1/styles/osm-bright/sprite.json",
      ),
    ).toBe("style-v1");
    expect(
      offlineStyleVersionFromAssetPath("/api/offline/packages/assets/maptiler/style-v1"),
    ).toBeUndefined();
  });
});

describe("isCredentialedApiPath", () => {
  it("matches credentialed paths", () => {
    for (const path of [
      "/api/auth/get-session",
      "/api/auth/sign-out",
      "/api/me",
      "/api/reviews/keypair",
      "/api/reviews/keypair/wraps",
      "/api/admin/audit",
      "/api/saved/lists",
    ])
      expect(isCredentialedApiPath(path)).toBe(true);
  });

  it("does not match cacheable paths", () => {
    for (const path of [
      "/api/places/123",
      "/api/places/search",
      "/api/integrations/geocoding/geocode",
      "/api/maptiler/tiles.json",
      "/styles/openmapx-streets.json",
      "/tiles/14/8/5.pbf",
      "/",
    ])
      expect(isCredentialedApiPath(path)).toBe(false);
  });
});
