import { describe, expect, it } from "vitest";
import {
  buildMirrorCommands,
  parseLicenseManifest,
  rewriteRtUrls,
  TRANSITOUS_FEED_PROXY_URL,
} from "../src/mirror.js";

describe("buildMirrorCommands", () => {
  it("fetches config + license directly and mirrors all archives globally", () => {
    const cmds = buildMirrorCommands("https://api.transitous.org/gtfs/", "/out");
    expect(cmds.map((c) => c.description)).toEqual([
      "config.yml",
      "license.json",
      "gtfs archives + scripts",
    ]);
    expect(cmds[0]?.args).toContain("https://api.transitous.org/gtfs/config.yml");
    const accept = cmds[2]?.args[cmds[2].args.indexOf("-A") + 1];
    expect(accept).toBe("*.gtfs.zip,*.netex.zip,*.lua");
  });

  it("adds a trailing slash to the base url", () => {
    const cmds = buildMirrorCommands("https://api.transitous.org/gtfs", "/out");
    expect(cmds[0]?.args).toContain("https://api.transitous.org/gtfs/config.yml");
  });

  it("scopes the archive accept-list to the requested countries", () => {
    const cmds = buildMirrorCommands("https://x/gtfs/", "/out", ["de", "ch"]);
    const accept = cmds[2]?.args[cmds[2].args.indexOf("-A") + 1] ?? "";
    expect(accept).toContain("de_*.gtfs.zip");
    expect(accept).toContain("de-*.gtfs.zip");
    expect(accept).toContain("ch_*.gtfs.zip");
    expect(accept).toContain("*.lua");
    // No unscoped global archive wildcard as a standalone token.
    expect(accept.split(",")).not.toContain("*.gtfs.zip");
  });
});

describe("parseLicenseManifest", () => {
  it("parses snake_case entries from the array", () => {
    const json = JSON.stringify([
      {
        country_code: "de",
        region_code: "de-by",
        human_name: "MVV",
        filename: "de-by_MVV.gtfs.zip",
        last_updated: "2026-06-01",
        spdx_license_identifier: "CC-BY-4.0",
      },
    ]);
    const entries = parseLicenseManifest(json);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      countryCode: "de",
      regionCode: "de-by",
      humanName: "MVV",
      filename: "de-by_MVV.gtfs.zip",
      lastUpdated: "2026-06-01",
    });
  });

  it("returns [] for non-arrays / malformed json", () => {
    expect(parseLicenseManifest("not json")).toEqual([]);
    expect(parseLicenseManifest('{"not":"an array"}')).toEqual([]);
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
});
