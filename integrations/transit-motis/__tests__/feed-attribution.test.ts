import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TransitStop } from "@openmapx/mobility-core/transit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __testing, extractFeedTags } from "../local.js";

const LICENSE_FIXTURE = [
  {
    country_code: "DE",
    spdx_license_identifier: "CC0-1.0",
    license_url: "https://creativecommons.org/publicdomain/zero/1.0/",
    source: "https://example.com/delfi.zip",
    filename: "de_DELFI.gtfs.zip",
    human_name: "DELFI Germany",
    publisher: { name: "DELFI e.V.", url: "https://delfi.de/" },
  },
  {
    country_code: "CH",
    spdx_license_identifier: "OPEN-DATA-CH",
    license_url: "https://opentransportdata.swiss/license",
    source: "https://opentransportdata.swiss/gtfs.zip",
    filename: "ch_SBB.gtfs.zip",
    human_name: "SBB Switzerland",
    publisher: { name: "SBB", url: "https://www.sbb.ch/" },
  },
];

let tmpDir: string;
let licenseFile: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "feed-attribution-"));
  licenseFile = join(tmpDir, "license.json");
  writeFileSync(licenseFile, JSON.stringify(LICENSE_FIXTURE), "utf-8");
  __testing.setLicenseFile(licenseFile);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("transit-motis feed attribution", () => {
  it("attaches the matching Attribution row for a single feed-tagged stop", () => {
    const stop: TransitStop = {
      id: "ms:de_DELFI_de:08111:6118:0:3",
      name: "Stuttgart Hbf",
      lat: 48.7838,
      lng: 9.1815,
      modes: ["train"],
      provider: "ms",
    };
    const wrapped = __testing.wrapLocal(stop);
    expect(wrapped.attributions).toHaveLength(1);
    expect(wrapped.attributions[0].sourceId).toBe("de_DELFI");
    expect(wrapped.attributions[0].name).toBe("DELFI Germany");
    expect(wrapped.attributions[0].publisher?.name).toBe("DELFI e.V.");
    expect(wrapped.freshness.hasRealtimeData).toBe(false);
  });

  it("deduplicates and lists every feed tag spanning an array", () => {
    const arr: TransitStop[] = [
      {
        id: "ms:de_DELFI_de:08111:6118:0:3",
        name: "Stuttgart Hbf",
        lat: 48.78,
        lng: 9.18,
        modes: ["train"],
        provider: "ms",
      },
      {
        id: "ms:de_DELFI_de:08000105:0:1",
        name: "Frankfurt(Main)Hbf",
        lat: 50.107,
        lng: 8.663,
        modes: ["train"],
        provider: "ms",
      },
      {
        id: "ms:ch_SBB_8503000",
        name: "Zürich HB",
        lat: 47.378,
        lng: 8.54,
        modes: ["train"],
        provider: "ms",
      },
    ];
    const wrapped = __testing.wrapLocalRT(arr);
    const sourceIds = wrapped.attributions.map((a) => a.sourceId).sort();
    expect(sourceIds).toEqual(["ch_SBB", "de_DELFI"]);
    expect(wrapped.freshness.hasRealtimeData).toBe(true);
  });

  it("falls back to ATTRIBUTION_LOCAL when the feed tag is not in license.json", () => {
    const stop: TransitStop = {
      id: "ms:unknown_feed_X_some-stop",
      name: "Mystery Stop",
      lat: 0,
      lng: 0,
      modes: [],
      provider: "ms",
    };
    const wrapped = __testing.wrapLocal(stop);
    expect(wrapped.attributions).toEqual(__testing.ATTRIBUTION_LOCAL);
    expect(wrapped.attributions[0].sourceId).toBe("transitous");
  });

  it("extractFeedTags walks nested trip-plan shapes (legs with from/to stop ids)", () => {
    const tripPlan = {
      from: { name: "A", lat: 0, lng: 0 },
      to: { name: "B", lat: 0, lng: 0 },
      itineraries: [
        {
          legs: [
            {
              from: { stopId: "ms:de_DELFI_8000105" },
              to: { stopId: "ms:ch_SBB_8503000" },
            },
          ],
        },
      ],
    };
    const tags = extractFeedTags(tripPlan).sort();
    expect(tags).toEqual(["ch_SBB", "de_DELFI"]);
  });

  it("returns an empty tag list for shapes without recognisable ids", () => {
    expect(extractFeedTags(null)).toEqual([]);
    expect(extractFeedTags({})).toEqual([]);
    expect(extractFeedTags([{ foo: "bar" }])).toEqual([]);
  });
});
