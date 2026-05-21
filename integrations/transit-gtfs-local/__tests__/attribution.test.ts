import { describe, expect, it } from "vitest";
import type { GtfsDeps } from "../gtfs-local.js";
import { getFeedAttributions, setDeps } from "../gtfs-local.js";

type FeedRow = ReturnType<GtfsDeps["manager"]["getFeeds"]>[number];

function makeManager(feeds: FeedRow[], initialized = true): GtfsDeps["manager"] {
  return {
    initialized,
    getActiveFeedsForBbox: () => [],
    getSchemaForStopId: () => null,
    getOriginalStopId: () => null,
    getSlugFromStopId: () => null,
    getFeeds: () => feeds,
  };
}

function makeDeps(manager: GtfsDeps["manager"]): GtfsDeps {
  return { manager, queries: {} as unknown as GtfsDeps["queries"] };
}

describe("getFeedAttributions", () => {
  it("emits one entry per active feed keyed by `gtfs-<slug>`", () => {
    setDeps(
      makeDeps(
        makeManager([
          {
            slug: "de_vbb",
            schemaName: "gtfs_de_vbb",
            status: "active",
            name: "VBB Berlin",
            url: "https://vbb.de/gtfs.zip",
            license: "CC-BY-4.0",
            licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
          },
          {
            slug: "ch_sbb",
            schemaName: "gtfs_ch_sbb",
            status: "active",
            name: "SBB",
            url: "https://opentransportdata.swiss/timetable.zip",
          },
        ]),
      ),
    );

    const map = getFeedAttributions();
    expect(map["gtfs-de_vbb"]).toEqual({
      label: "VBB Berlin",
      url: "https://vbb.de/gtfs.zip",
      license: "CC-BY-4.0",
      licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
    });
    expect(map["gtfs-ch_sbb"]).toEqual({
      label: "SBB",
      url: "https://opentransportdata.swiss/timetable.zip",
      license: undefined,
      licenseUrl: undefined,
    });
  });

  it("skips feeds that aren't active", () => {
    setDeps(
      makeDeps(
        makeManager([
          { slug: "live", schemaName: "gtfs_live", status: "active", name: "Live" },
          { slug: "broken", schemaName: "gtfs_broken", status: "failed", name: "Broken" },
          { slug: "pending", schemaName: "gtfs_pending", status: "pending", name: "Pending" },
        ]),
      ),
    );

    const map = getFeedAttributions();
    expect(Object.keys(map)).toEqual(["gtfs-live"]);
  });

  it("falls back to slug when the feed has no `name`", () => {
    setDeps(
      makeDeps(makeManager([{ slug: "raw_slug", schemaName: "gtfs_raw_slug", status: "active" }])),
    );

    const map = getFeedAttributions();
    expect(map["gtfs-raw_slug"]).toMatchObject({ label: "raw_slug", url: "" });
  });

  it("returns an empty map when the manager hasn't initialized", () => {
    setDeps(makeDeps(makeManager([], false)));
    expect(getFeedAttributions()).toEqual({});
  });
});
