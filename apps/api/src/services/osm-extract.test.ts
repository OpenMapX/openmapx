import type { DatasetMetadata } from "@openmapx/core/data-manager-contracts";
import { describe, expect, it } from "vitest";
import { osmExtractFor } from "./osm-extract";

const osm = {
  found: true,
  filename: "europe-germany-berlin.osm.pbf",
  sizeBytes: 1000,
  modifiedAt: "2026-11-01T03:00:00.000Z",
  region: "europe-germany-berlin",
};

function dataset(over: Partial<DatasetMetadata> = {}): DatasetMetadata {
  return {
    type: "osm-pbf",
    id: "europe/germany/berlin",
    path: "/data/osm/europe-germany-berlin.osm.pbf",
    sizeBytes: 1000,
    downloadedAt: "2026-11-01T03:00:00.000Z",
    osmTimestamp: "2026-10-31T20:21:42Z",
    osmReplicationUrl: "https://download.geofabrik.de/europe/germany/berlin-updates",
    ...over,
  };
}

describe("osmExtractFor", () => {
  it("reports the extract time recorded for the file the inventory found", () => {
    expect(osmExtractFor(osm, [dataset()])).toEqual({
      timestamp: "2026-10-31T20:21:42.000Z",
      replicationUrl: "https://download.geofabrik.de/europe/germany/berlin-updates",
    });
  });

  it("does not show a record of another or an earlier file as this one's", () => {
    expect(
      osmExtractFor(osm, [dataset({ path: "/data/osm/europe-germany.osm.pbf" })]),
    ).toBeUndefined();
    expect(osmExtractFor(osm, [dataset({ sizeBytes: 999 })])).toBeUndefined();
    expect(osmExtractFor(osm, [dataset({ type: "osm-pbf-bz2" })])).toBeUndefined();
  });

  it("reports nothing without a recorded time, a file or a usable record", () => {
    expect(osmExtractFor(osm, [dataset({ osmTimestamp: undefined })])).toBeUndefined();
    expect(osmExtractFor(osm, [dataset({ osmTimestamp: "yesterday-ish" })])).toBeUndefined();
    expect(osmExtractFor({ found: false }, [dataset()])).toBeUndefined();
    expect(osmExtractFor(osm, [])).toBeUndefined();
  });

  it("drops a feed that is not https rather than failing the response", () => {
    expect(
      osmExtractFor(osm, [dataset({ osmReplicationUrl: "http://example.org/updates" })]),
    ).toEqual({ timestamp: "2026-10-31T20:21:42.000Z" });
  });
});
