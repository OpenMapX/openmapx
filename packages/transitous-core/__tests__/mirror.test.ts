import { describe, expect, it } from "vitest";
import { buildMirrorCommands, rewriteRtUrls, TRANSITOUS_FEED_PROXY_URL } from "../src/mirror.js";

describe("buildMirrorCommands", () => {
  it("recursively mirrors all archives globally (no config/license/scripts)", () => {
    const cmds = buildMirrorCommands("https://api.transitous.org/gtfs/", "/out");
    expect(cmds).toHaveLength(1);
    expect(cmds[0]?.args).toContain("https://api.transitous.org/gtfs/");
    const accept = cmds[0]?.args[cmds[0].args.indexOf("-A") + 1];
    expect(accept).toBe("*.gtfs.zip,*.netex.zip");
  });

  it("adds a trailing slash to the base url", () => {
    const cmds = buildMirrorCommands("https://api.transitous.org/gtfs", "/out");
    expect(cmds[0]?.args).toContain("https://api.transitous.org/gtfs/");
  });

  it("scopes the archive accept-list to the requested countries", () => {
    const cmds = buildMirrorCommands("https://x/gtfs/", "/out", ["de", "ch"]);
    const accept = cmds[0]?.args[cmds[0].args.indexOf("-A") + 1] ?? "";
    expect(accept).toContain("de_*.gtfs.zip");
    expect(accept).toContain("de-*.gtfs.zip");
    expect(accept).toContain("ch_*.gtfs.zip");
    // No unscoped global archive wildcard as a standalone token.
    expect(accept.split(",")).not.toContain("*.gtfs.zip");
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
