import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listMirrorArchives,
  type MirrorArchive,
  mirrorArchives,
  rewriteHostedFeedProxy,
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

  it("keeps the pinned catalog's real schedule source names", () => {
    const catalog = catalogWithFeeds({
      "de.json": {
        sources: [
          { name: "DELFI" },
          { name: "VBB" },
          { name: "VBN" },
          { name: "AVV-Aachen" },
          { name: "amarillo-bw" },
          { name: "pollo" },
          { name: "esel.ac" },
        ],
      },
      "at.json": {
        sources: [
          { name: "PTA-Styria-Flex-2026" },
          { name: "Linz-AG-2026" },
          { name: "Railway-Current-Reference-Data-2026" },
          { name: "WienMobil-Rad" },
        ],
      },
    });
    expect(listMirrorArchives(catalog)).toEqual(
      expect.arrayContaining([
        { region: "de", name: "DELFI" },
        { region: "de", name: "VBB" },
        { region: "de", name: "VBN" },
        { region: "de", name: "AVV-Aachen" },
        { region: "de", name: "amarillo-bw" },
        { region: "de", name: "pollo" },
        { region: "de", name: "esel.ac" },
        { region: "at", name: "PTA-Styria-Flex-2026" },
        { region: "at", name: "Linz-AG-2026" },
        { region: "at", name: "Railway-Current-Reference-Data-2026" },
        { region: "at", name: "WienMobil-Rad" },
      ]),
    );
  });

  it("skips unsafe source names while keeping safe siblings", () => {
    const catalog = catalogWithFeeds({
      "de.json": {
        sources: [
          { name: "Good" },
          { name: "../../../evil" },
          { name: "a/b" },
          { name: ".hidden" },
          { name: ".." },
          { name: "Has Space" },
        ],
      },
    });
    expect(listMirrorArchives(catalog)).toEqual([{ region: "de", name: "Good" }]);
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
    const destinations: string[] = [];
    const result = await mirrorArchives({
      archives,
      baseUrl: "https://api.transitous.org/gtfs/",
      destDir: dest,
      download: async (url, d) => {
        urls.push(url);
        destinations.push(d);
        writeFileSync(d, "data");
      },
      logger,
    });
    expect(urls).toEqual(["https://api.transitous.org/gtfs/de_DELFI.gtfs.zip"]);
    expect(destinations).toEqual([join(dest, "de_DELFI.gtfs.zip")]);
    expect(result).toEqual({ fetched: 1, missing: [] });
  });

  it("refuses traversal-shaped archive names before downloading", async () => {
    const dest = destDir();
    const warnings: string[] = [];
    const downloads: string[] = [];
    const archive = { region: "de", name: "../../../evil" };
    const result = await mirrorArchives({
      archives: [archive],
      baseUrl: "https://api.transitous.org/gtfs/",
      destDir: dest,
      download: async (url) => {
        downloads.push(url);
      },
      logger: { info() {}, warn: (message) => warnings.push(message), error() {} },
    });

    expect(downloads).toEqual([]);
    expect(result).toEqual({ fetched: 0, missing: [archive] });
    expect(warnings.some((warning) => warning.includes("refusing archive name outside"))).toBe(
      true,
    );
  });

  it("downloads concurrently, bounded by `concurrency`", async () => {
    const dest = destDir();
    const many: MirrorArchive[] = Array.from({ length: 7 }, (_, i) => ({
      region: "de",
      name: `f${i}`,
    }));
    let inFlight = 0;
    let maxInFlight = 0;
    const result = await mirrorArchives({
      archives: many,
      baseUrl: "https://x/gtfs/",
      destDir: dest,
      concurrency: 3,
      download: async (_url, d) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        await Promise.resolve();
        writeFileSync(d, "x");
        inFlight -= 1;
      },
      logger,
    });
    expect(result.fetched).toBe(7);
    expect(maxInFlight).toBeGreaterThan(1); // genuinely concurrent, not serial
    expect(maxInFlight).toBeLessThanOrEqual(3); // never exceeds the cap
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

describe("rewriteHostedFeedProxy", () => {
  it.each([
    ["unquoted", "https://rt.triptix.tech", "http://motis-feed-proxy"],
    ["double quoted", '"https://rt.triptix.tech"', '"http://motis-feed-proxy"'],
    ["single quoted", "'https://rt.triptix.tech'", "'http://motis-feed-proxy'"],
  ])("rewrites the top-level gbfs proxy when %s", (_label, source, expected) => {
    const config = `gbfs:\n  proxy: ${source} # keep\n  feeds: {}\nother:\n  proxy: https://rt.triptix.tech\n`;
    const result = rewriteHostedFeedProxy(config, "http://motis-feed-proxy");
    expect(result.counts).toEqual({ realtimeUrls: 0, gbfsProxy: 1 });
    expect(result.text).toContain(`  proxy: ${expected} # keep`);
    expect(result.text).toContain("other:\n  proxy: https://rt.triptix.tech");
  });

  it("preserves nested proxies, CRLF and feed-id scoping", () => {
    const config = [
      "gbfs:",
      "  proxy: https://rt.triptix.tech",
      "  nested:",
      "    proxy: https://rt.triptix.tech",
      "  feeds:",
      "    one:",
      "      url: https://rt.triptix.tech/feed/one",
      "    two:",
      "      url: https://rt.triptix.tech/feed/two",
      "",
    ].join("\r\n");
    const result = rewriteHostedFeedProxy(config, "http://motis-feed-proxy/", new Set(["one"]));
    expect(result.counts).toEqual({ realtimeUrls: 1, gbfsProxy: 1 });
    expect(result.text).toContain("\r\n");
    expect(result.text).toContain("    proxy: https://rt.triptix.tech");
    expect(result.text).toContain("http://motis-feed-proxy/feed/one");
    expect(result.text).toContain("https://rt.triptix.tech/feed/two");
  });

  it("is idempotent and leaves absent or operator proxies untouched", () => {
    const config = "gbfs:\n  proxy: https://operator.example\n  feeds: {}\n";
    const first = rewriteHostedFeedProxy(config, "http://motis-feed-proxy");
    const second = rewriteHostedFeedProxy(first.text, "http://motis-feed-proxy");
    expect(first.counts).toEqual({ realtimeUrls: 0, gbfsProxy: 0 });
    expect(second.counts).toEqual({ realtimeUrls: 0, gbfsProxy: 0 });
    expect(second.text).toBe(config);
    expect(rewriteHostedFeedProxy("osm: region.pbf\n", "http://proxy").text).toBe(
      "osm: region.pbf\n",
    );
  });
});
