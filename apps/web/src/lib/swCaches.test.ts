import { describe, expect, it } from "vitest";
import { isStalePrecacheName, offlineFallback, refreshPinnedStyleAssets } from "./swCaches";

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

describe("refreshPinnedStyleAssets", () => {
  function deps(opts: {
    entries: { url: string; etag: string | null }[];
    fetchFresh: (url: string, etag: string | null) => Promise<{ status: number } | null>;
    puts: string[];
    seen?: { url: string; etag: string | null }[];
  }) {
    return {
      listAreaCacheNames: () => Promise.resolve(["offline-area-1"]),
      openCache: () =>
        Promise.resolve({
          keys: () => Promise.resolve(opts.entries.map((e) => ({ url: e.url }))),
          match: (url: string) => {
            const etag = opts.entries.find((e) => e.url === url)?.etag ?? null;
            return Promise.resolve({ headers: { get: () => etag } });
          },
          put: (url: string) => {
            opts.puts.push(url);
            return Promise.resolve();
          },
        }),
      isStyleUrl: (url: string) => url.includes("/styles/"),
      fetchFresh: (url: string, etag: string | null) => {
        opts.seen?.push({ url, etag });
        return opts.fetchFresh(url, etag);
      },
    };
  }

  it("replaces only changed (200) style assets, skipping 304 and non-style URLs", async () => {
    const puts: string[] = [];
    const n = await refreshPinnedStyleAssets(
      deps({
        entries: [
          { url: "https://x/styles/openmapx-streets.json", etag: "a" },
          { url: "https://x/styles/sprite.png", etag: "b" },
          { url: "https://x/tiles/14/8/5.pbf", etag: "c" },
        ],
        puts,
        fetchFresh: (url) =>
          Promise.resolve({ status: url.endsWith("openmapx-streets.json") ? 200 : 304 }),
      }),
    );
    expect(n).toBe(1);
    expect(puts).toEqual(["https://x/styles/openmapx-streets.json"]);
  });

  it("does nothing when offline (fetchFresh returns null)", async () => {
    const puts: string[] = [];
    const n = await refreshPinnedStyleAssets(
      deps({
        entries: [{ url: "https://x/styles/openmapx-streets.json", etag: "a" }],
        puts,
        fetchFresh: () => Promise.resolve(null),
      }),
    );
    expect(n).toBe(0);
    expect(puts).toEqual([]);
  });

  it("sends the pinned ETag so the request is conditional", async () => {
    const seen: { url: string; etag: string | null }[] = [];
    await refreshPinnedStyleAssets(
      deps({
        entries: [{ url: "https://x/styles/openmapx-streets.json", etag: 'W/"abc"' }],
        puts: [],
        seen,
        fetchFresh: () => Promise.resolve({ status: 304 }),
      }),
    );
    expect(seen).toEqual([{ url: "https://x/styles/openmapx-streets.json", etag: 'W/"abc"' }]);
  });
});
