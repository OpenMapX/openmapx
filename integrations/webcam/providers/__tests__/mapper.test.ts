import { isI18nToken } from "@openmapx/integration-framework/strings";
import { describe, expect, it } from "vitest";
import { mapTflToDetail, mapTflToResult } from "../gb-eng-tfl.js";
import { mapOsmToDetail, mapOsmToResult } from "../osm.js";
import type { RawWebcam } from "../types.js";
import { mapCaltransToDetail, mapCaltransToResult } from "../us-ca-caltrans.js";
import { mapNpsToDetail } from "../us-nps.js";
import { mapUsStateSourceToDetail, mapUsStateSourceToResult } from "../us-state-sources.js";
import { mapWindyToDetail } from "../windy.js";

function makeRaw(overrides: Partial<RawWebcam> = {}): RawWebcam {
  return {
    id: "test:1",
    name: "Test Webcam",
    coordinates: [11.5, 48.5],
    source: "test",
    variant: "landscape",
    thumbnailUrl: "https://example.com/thumb.jpg",
    streamUrl: "https://example.com/stream.m3u8",
    playerEmbedUrl: "https://example.com/player",
    direction: "North",
    categories: ["weather", "city"],
    viewCount: 1234,
    lastUpdated: "2026-05-06T11:00:00.000Z",
    location: { city: "Munich", region: "Bavaria", country: "DE" },
    detailUrl: "https://example.com/cam",
    ...overrides,
  };
}

function assertSectionsAreTokens(sections: { title: unknown; rows?: unknown[][] }[]) {
  for (const section of sections) {
    expect(
      isI18nToken(section.title),
      `section.title should be I18nToken, got: ${JSON.stringify(section.title)}`,
    ).toBe(true);
    if (section.rows) {
      for (const row of section.rows) {
        const label = row[0];
        expect(
          isI18nToken(label),
          `row label should be I18nToken, got: ${JSON.stringify(label)}`,
        ).toBe(true);
      }
    }
  }
}

describe("webcam mappers emit I18nToken for section titles and row labels", () => {
  it("us-ca-caltrans", () => {
    const raw = makeRaw({ source: "us-ca-caltrans" });
    assertSectionsAreTokens(mapCaltransToDetail(raw).sections);
    expect(isI18nToken(mapCaltransToResult(raw).summary)).toBe(true);
  });

  it("us-nps", () => {
    const raw = makeRaw({ source: "us-nps" });
    assertSectionsAreTokens(mapNpsToDetail(raw).sections);
  });

  it("osm", async () => {
    // mapOsmToDetail performs a HEAD probe; pass an unreachable URL so the
    // offline branch (which emits the most tokens) is exercised.
    const raw = makeRaw({
      source: "osm",
      thumbnailUrl: "https://invalid.test.localhost.example/never-resolves",
    });
    assertSectionsAreTokens((await mapOsmToDetail(raw)).sections);
    expect(isI18nToken(mapOsmToResult(raw).summary)).toBe(true);
  });

  it("gb-eng-tfl", () => {
    const raw = makeRaw({ source: "gb-eng-tfl" });
    assertSectionsAreTokens(mapTflToDetail(raw).sections);
    expect(isI18nToken(mapTflToResult(raw).summary)).toBe(true);
  });

  it("windy", () => {
    const raw = makeRaw({ source: "windy" });
    assertSectionsAreTokens(mapWindyToDetail(raw).sections);
  });

  it("US state source", () => {
    const raw = makeRaw({ source: "us-ny-511" });
    assertSectionsAreTokens(mapUsStateSourceToDetail(raw).sections);
    // The summary may be a passthrough string from raw.direction.
    const summary = mapUsStateSourceToResult(raw).summary;
    expect(typeof summary === "string" || isI18nToken(summary)).toBe(true);
  });
});
