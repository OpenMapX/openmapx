import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listMirrorArchives,
  type MirrorArchive,
  mirrorArchives,
  rewriteRtUrls,
  TRANSITOUS_FEED_PROXY_URL,
} from "../src/mirror.js";

let tmp: string | undefined;

afterEach(() => {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  }
});

function catalogWithFeeds(feeds: Record<string, unknown>): string {
  tmp = mkdtempSync(join(tmpdir(), "openmapx-mirror-core-"));
  const feedsDir = join(tmp, "feeds");
  mkdirSync(feedsDir, { recursive: true });
  for (const [file, content] of Object.entries(feeds)) {
    writeFileSync(join(feedsDir, file), JSON.stringify(content));
  }
  return tmp;
}

describe("listMirrorArchives", () => {
  it("lists schedule sources for the requested countries", () => {
    const catalog = catalogWithFeeds({
      "de.json": { sources: [{ name: "DELFI" }, { name: "VBB", spec: "gtfs" }] },
      "fr.json": { sources: [{ name: "SNCF" }] },
    });
    const archives = listMirrorArchives(catalog, ["de"]);
    expect(archives).toEqual([
      { region: "de", name: "DELFI" },
      { region: "de", name: "VBB" },
    ]);
  });

  it("matches a region's country code prefix (us-pa belongs to us)", () => {
    const catalog = catalogWithFeeds({
      "us-pa.json": { sources: [{ name: "SEPTA" }] },
      "de.json": { sources: [{ name: "DELFI" }] },
    });
    expect(listMirrorArchives(catalog, ["us"])).toEqual([{ region: "us-pa", name: "SEPTA" }]);
  });

  it("skips skip:true sources, gbfs specs, and nameless sources", () => {
    const catalog = catalogWithFeeds({
      "de.json": {
        sources: [
          { name: "Good" },
          { name: "Gone", skip: true },
          { name: "Bikes", spec: "gbfs" },
          { spec: "gtfs" },
        ],
      },
    });
    expect(listMirrorArchives(catalog, ["de"])).toEqual([{ region: "de", name: "Good" }]);
  });

  it("returns every region when no countries are given", () => {
    const catalog = catalogWithFeeds({
      "de.json": { sources: [{ name: "DELFI" }] },
      "fr.json": { sources: [{ name: "SNCF" }] },
    });
    expect(
      listMirrorArchives(catalog)
        .map((a) => a.region)
        .sort(),
    ).toEqual(["de", "fr"]);
  });
});

describe("mirrorArchives", () => {
  function destDir(): string {
    tmp = mkdtempSync(join(tmpdir(), "openmapx-mirror-dest-"));
    return tmp;
  }

  const archives: MirrorArchive[] = [{ region: "de", name: "DELFI" }];
  const logger = { info() {}, warn() {}, error() {} };

  it("downloads each archive directly by URL (gtfs hit)", async () => {
    const dest = destDir();
    const urls: string[] = [];
    const result = await mirrorArchives({
      archives,
      baseUrl: "https://api.transitous.org/gtfs/",
      destDir: dest,
      download: async (url, d) => {
        urls.push(url);
        writeFileSync(d, "data");
      },
      logger,
    });
    expect(urls).toEqual(["https://api.transitous.org/gtfs/de_DELFI.gtfs.zip"]);
    expect(result).toEqual({ fetched: 1, missing: [] });
  });

  it("falls back from gtfs to netex on 404", async () => {
    const dest = destDir();
    const urls: string[] = [];
    const result = await mirrorArchives({
      archives,
      baseUrl: "https://x/gtfs",
      destDir: dest,
      download: async (url, d) => {
        urls.push(url);
        if (url.endsWith(".gtfs.zip")) throw new Error("404");
        writeFileSync(d, "data");
      },
      logger,
    });
    expect(urls).toEqual(["https://x/gtfs/de_DELFI.gtfs.zip", "https://x/gtfs/de_DELFI.netex.zip"]);
    expect(result.fetched).toBe(1);
  });

  it("reports archives missing when no spec downloads", async () => {
    const dest = destDir();
    const result = await mirrorArchives({
      archives,
      baseUrl: "https://x/gtfs/",
      destDir: dest,
      download: async () => {
        throw new Error("404");
      },
      logger,
    });
    expect(result.fetched).toBe(0);
    expect(result.missing).toEqual(archives);
  });
});

describe("rewriteRtUrls", () => {
  it("repoints rt.triptix.tech onto our feed-proxy and counts replacements", () => {
    const config = [
      "  rt:",
      `    - url: ${TRANSITOUS_FEED_PROXY_URL}/feed/de-bvg-0`,
      `    - url: ${TRANSITOUS_FEED_PROXY_URL}/feed/de-bvg-1`,
    ].join("\n");
    const { text, replaced } = rewriteRtUrls(config, "http://motis-feed-proxy");
    expect(replaced).toBe(2);
    expect(text).toContain("http://motis-feed-proxy/feed/de-bvg-0");
    expect(text).not.toContain(TRANSITOUS_FEED_PROXY_URL);
  });

  it("strips a trailing slash on the target and is a no-op when absent", () => {
    const { text, replaced } = rewriteRtUrls("osm: planet.osm.pbf\n", "http://motis-feed-proxy/");
    expect(replaced).toBe(0);
    expect(text).toBe("osm: planet.osm.pbf\n");
  });

  it("only repoints feeds our proxy serves when a feedIds set is given", () => {
    const config = [
      `    - url: ${TRANSITOUS_FEED_PROXY_URL}/feed/de-bvg-0`,
      `    - url: ${TRANSITOUS_FEED_PROXY_URL}/feed/de-vbb-0`,
    ].join("\n");
    const { text, replaced } = rewriteRtUrls(
      config,
      "http://motis-feed-proxy",
      new Set(["de-bvg-0"]),
    );
    expect(replaced).toBe(1);
    expect(text).toContain("http://motis-feed-proxy/feed/de-bvg-0");
    // Not in our proxy set → left on the origin proxy rather than broken.
    expect(text).toContain(`${TRANSITOUS_FEED_PROXY_URL}/feed/de-vbb-0`);
  });
});
