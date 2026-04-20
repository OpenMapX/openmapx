import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  downloadGtfs,
  type FeedDescriptor,
  filterFeedsByCountry,
  slugify,
} from "../src/jobs/download-gtfs.js";
import { StateStore } from "../src/state.js";

let tmp: string | undefined;

afterEach(() => {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  }
});

describe("download-gtfs helpers", () => {
  it("slugifies feed identifier from URL", () => {
    expect(slugify("https://transitous.org/feeds/de-bvg.zip")).toBe("de-bvg");
    expect(slugify("https://example.com/some/path/feed.zip")).toBe("feed");
  });

  it("filters feeds by country code", () => {
    const feeds = [
      { id: "de-bvg", country: "de", url: "x" },
      { id: "us-mbta", country: "us", url: "y" },
      { id: "ch-sbb", country: "ch", url: "z" },
    ];
    expect(filterFeedsByCountry(feeds, ["de", "ch"]).map((f) => f.id)).toEqual([
      "de-bvg",
      "ch-sbb",
    ]);
  });

  it("returns all feeds when filter is empty", () => {
    const feeds = [
      { id: "a", country: "x", url: "1" },
      { id: "b", country: "y", url: "2" },
    ];
    expect(filterFeedsByCountry(feeds, [])).toEqual(feeds);
  });

  it("tracks partial GTFS download success without failing the full batch", async () => {
    tmp = mkdtempSync(join(tmpdir(), "openmapx-download-gtfs-"));
    const feeds: FeedDescriptor[] = [
      { id: "de_bvg", country: "de", url: "https://example.com/de_bvg.zip" },
      { id: "de_vbb", country: "de", url: "https://example.com/de_vbb.zip" },
      { id: "us_mbta", country: "us", url: "https://example.com/us_mbta.zip" },
    ];

    const result = await downloadGtfs({
      feeds,
      countries: ["de"],
      dataDir: tmp,
      store: new StateStore(tmp),
      now: () => "2026-04-20T10:00:00.000Z",
      downloader: async (url, targetPath) => {
        if (url.includes("de_vbb")) throw new Error("HTTP 503");
        mkdirSync(dirname(targetPath), { recursive: true });
        writeFileSync(targetPath, "GTFS");
      },
    });

    expect(result.requestedCount).toBe(3);
    expect(result.selectedCount).toBe(2);
    expect(result.skippedCount).toBe(1);
    expect(result.downloaded).toHaveLength(1);
    expect(result.downloaded[0]?.id).toBe("de_bvg");
    expect(result.partialSuccess).toBe(true);
    expect(result.failures).toEqual([
      {
        id: "de_vbb",
        country: "de",
        url: "https://example.com/de_vbb.zip",
        message: "HTTP 503",
      },
    ]);

    const state = JSON.parse(readFileSync(join(tmp, ".data-manager-state.json"), "utf-8")) as {
      datasets: Array<{ id: string }>;
    };
    expect(state.datasets.map((dataset) => dataset.id)).toEqual(["de_bvg"]);
    expect(readFileSync(join(tmp, "gtfs", "de_bvg.gtfs.zip"), "utf-8")).toBe("GTFS");
  });
});
