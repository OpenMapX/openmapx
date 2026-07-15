import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CANDIDATE_PROXY_DIRNAME,
  createCandidateManifest,
  parseMotisConfigExpectations,
  verifyCandidateManifest,
} from "../../src/jobs/transitous/candidate.js";

let tmp: string | undefined;

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

describe("parseMotisConfigExpectations", () => {
  it("decodes timetable, realtime, GBFS and optional feature expectations", () => {
    expect(
      parseMotisConfigExpectations(`timetable:
  datasets:
    one:
      path: one.gtfs.zip
      rt:
        - url: https://example.test/rt
    two:
      path: two.netex.zip
gbfs:
  proxy: http://motis-feed-proxy
  feeds:
    bikes:
      url: https://example.test/gbfs
tiles:
  profile: full.lua
elevation_data: elevation.tif
osr_footpath: true
`),
    ).toEqual({
      timetableDatasets: 2,
      realtimeFeeds: 1,
      gbfsFeeds: 1,
      expectsGbfs: true,
      tilesEnabled: true,
      elevationEnabled: true,
      routedTransfersEnabled: true,
      gbfsProxyUrl: "http://motis-feed-proxy",
      feedProxyUrls: [],
    });
  });

  it("rejects malformed or non-object YAML", () => {
    expect(() => parseMotisConfigExpectations("- item\n")).toThrow(/YAML object/);
    expect(() => parseMotisConfigExpectations("gbfs: [\n")).toThrow();
  });
});

describe("candidate manifest", () => {
  function fixture(): string {
    tmp = mkdtempSync(join(tmpdir(), "openmapx-candidate-"));
    writeFileSync(
      join(tmp, "config.yml"),
      "timetable:\n  datasets:\n    demo:\n      path: demo.gtfs.zip\n",
    );
    writeFileSync(join(tmp, "license.json"), "[]\n");
    writeFileSync(join(tmp, "demo.gtfs.zip"), "GTFS");
    const proxy = join(tmp, CANDIDATE_PROXY_DIRNAME);
    mkdirSync(join(proxy, "conf"), { recursive: true });
    writeFileSync(join(proxy, "conf", "default.conf"), "server { listen 80; }\n");
    writeFileSync(join(proxy, "feed-proxy-vars.json"), "{}\n");
    return tmp;
  }

  it("writes and verifies an immutable artifact tuple", () => {
    const dir = fixture();
    const manifest = createCandidateManifest(dir, "epoch-1", "2026-07-15T00:00:00.000Z");
    expect(manifest.epoch).toBe("epoch-1");
    expect(manifest.artifacts.datasets).toHaveLength(1);
    expect(verifyCandidateManifest(dir)).toEqual(manifest);
  });

  it("detects mutation after the manifest is written", () => {
    const dir = fixture();
    createCandidateManifest(dir, "epoch-1", "2026-07-15T00:00:00.000Z");
    writeFileSync(join(dir, "license.json"), '[{"changed":true}]\n');
    expect(() => verifyCandidateManifest(dir)).toThrow(/hash mismatch: license\.json/);
  });
});
