import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appShellCacheNames,
  isCredentialedApiPath,
  isMapLibreRuntimeAssetPath,
  isOfflinePackageArchivePath,
  isOnlineStyleReachabilityProbe,
  isStalePrecacheName,
  MAPLIBRE_RUNTIME_CACHE,
  offlineGlyphCacheNameForVersion,
  offlineGlyphVersionFromPath,
} from "./swCaches";

afterEach(() => {
  vi.unstubAllGlobals();
});

const packageId = `omp2-${"a".repeat(64)}`;

const current = { appShell: "app-shell-NEW", style: "style-assets-NEW" };

describe("service-worker cache names", () => {
  it("lists only existing app-shell caches", async () => {
    vi.stubGlobal("caches", {
      keys: async () => ["app-shell-abc", "style-assets-abc", "pages", "offline-area-1"],
    });

    expect(await appShellCacheNames()).toEqual(["app-shell-abc"]);
  });

  it("returns no app-shell caches when Cache Storage is unavailable", async () => {
    vi.stubGlobal("caches", undefined);

    expect(await appShellCacheNames()).toEqual([]);
  });

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
    expect(isStalePrecacheName("offline-package-glyphs-abc", current)).toBe(false);
    expect(isStalePrecacheName(MAPLIBRE_RUNTIME_CACHE, current)).toBe(false);
    expect(isStalePrecacheName("pages", current)).toBe(false);
  });

  it("uses a stable, cache-safe package style name", () => {
    expect(offlineGlyphCacheNameForVersion("glyphs/v1?x")).toBe(
      "offline-package-glyphs-glyphs_v1_x",
    );
  });

  it("extracts the version from an unquery-pinned package asset path", () => {
    expect(
      offlineGlyphVersionFromPath("/api/offline/packages/glyphs/glyphs-v1/Metropolis/0-255.pbf"),
    ).toBe("glyphs-v1");
    expect(
      offlineGlyphVersionFromPath("/api/offline/packages/assets/maptiler/style-v1"),
    ).toBeUndefined();
  });
});

describe("MapLibre runtime cache", () => {
  it("recognizes current and retained older versioned worker modules", () => {
    for (const path of [
      "/runtime/maplibre-gl/6.1.0/maplibre-gl-worker.mjs",
      "/runtime/maplibre-gl/5.24.0/maplibre-gl-shared.mjs",
    ])
      expect(isMapLibreRuntimeAssetPath(path)).toBe(true);
  });

  it("rejects unversioned, malformed, and unrelated runtime paths", () => {
    for (const path of [
      "/runtime/maplibre-gl/maplibre-gl-worker.mjs",
      "/runtime/maplibre-gl/6.1.0/maplibre-gl.mjs",
      "/runtime/maplibre-gl/6.1.0/nested/maplibre-gl-worker.mjs",
      "/runtime/react.js",
    ])
      expect(isMapLibreRuntimeAssetPath(path)).toBe(false);
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
      "/api/timeline/connection",
      "/api/timeline/connection/test",
      "/api/timeline/day/2026-08-09",
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

describe("network-only offline map requests", () => {
  it("matches only canonical offline package archive paths", () => {
    expect(isOfflinePackageArchivePath(`/api/offline/packages/${packageId}/archive`)).toBe(true);

    for (const path of [
      `/api/offline/packages/${packageId}`,
      `/api/offline/packages/${packageId}/archive/extra`,
      "/api/offline/packages/not-a-package/archive",
      `/offline/packages/${packageId}/archive`,
      "/api/offline/packages/glyphs/glyphs-v1/font/0-255.pbf",
    ])
      expect(isOfflinePackageArchivePath(path)).toBe(false);
  });

  it("recognizes only explicit online-style reachability probes", () => {
    expect(
      isOnlineStyleReachabilityProbe(
        new URL("https://maps.example/api/maptiler/tiles.json?openmapxReachability=1"),
      ),
    ).toBe(true);

    for (const url of [
      "https://maps.example/api/maptiler/tiles.json",
      "https://maps.example/api/maptiler/tiles.json?openmapxReachability=0",
      "https://maps.example/api/maptiler/tiles.json?openmapxReachability=true",
    ])
      expect(isOnlineStyleReachabilityProbe(new URL(url))).toBe(false);
  });
});
