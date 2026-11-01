import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readOsmPbfHeader, tryReadOsmPbfHeader } from "../../src/utils/osm-pbf-header.js";

// Written by libosmium (pyosmium) from the traffic-engine fixture, with the
// replication header Geofabrik sets on its extracts.
const FIXTURES = join(import.meta.dirname, "../../src/__tests__/fixtures");
const ZLIB = join(FIXTURES, "osm-pbf-header/replication-zlib.osm.pbf");
const RAW = join(FIXTURES, "osm-pbf-header/replication-raw.osm.pbf");
const NO_REPLICATION = join(FIXTURES, "traffic-engine/roads.osm.pbf");

const dirs: string[] = [];
function scratch(name: string, bytes: Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), "openmapx-pbf-header-"));
  dirs.push(dir);
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("readOsmPbfHeader", () => {
  it("reads the replication timestamp and diff feed from a compressed header block", () => {
    expect(readOsmPbfHeader(ZLIB)).toEqual({
      timestamp: "2026-10-31T20:21:42.000Z",
      replicationUrl: "https://download.geofabrik.de/europe/monaco-updates",
    });
  });

  it("reads an uncompressed header block too", () => {
    expect(readOsmPbfHeader(RAW)).toEqual(readOsmPbfHeader(ZLIB));
  });

  it("reports nothing for a PBF whose header names no replication state", () => {
    expect(readOsmPbfHeader(NO_REPLICATION)).toEqual({});
  });

  it("rejects a file that does not start with an OSM header block", () => {
    expect(() =>
      readOsmPbfHeader(scratch("text.osm.pbf", Buffer.from("not a pbf at all"))),
    ).toThrow(/not an OSM PBF/);
  });

  it("rejects a file cut off inside the header block", () => {
    const truncated = scratch("cut.osm.pbf", readFileSync(ZLIB).subarray(0, 40));
    expect(() => readOsmPbfHeader(truncated)).toThrow();
  });

  it("drops a diff feed that is not https", () => {
    const bytes = readFileSync(RAW);
    const at = bytes.indexOf("https://");
    const patched = Buffer.from(bytes);
    patched.write("http:/", at, "latin1");
    expect(readOsmPbfHeader(scratch("http.osm.pbf", patched))).toEqual({
      timestamp: "2026-10-31T20:21:42.000Z",
    });
  });
});

describe("tryReadOsmPbfHeader", () => {
  it("reports nothing for a missing or unreadable file instead of throwing", () => {
    expect(tryReadOsmPbfHeader("/nonexistent/region.osm.pbf")).toEqual({});
    expect(tryReadOsmPbfHeader(scratch("empty.osm.pbf", Buffer.alloc(0)))).toEqual({});
  });
});
