import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CANDIDATE_MANIFEST_FILENAME,
  CANDIDATE_PROXY_DIRNAME,
  createCandidateManifest,
  parseMotisConfigExpectations,
  sha256File,
  verifyCandidateManifest,
} from "../../src/jobs/transitous/candidate.js";
import { resolveOperationsProfile } from "../../src/jobs/transitous/operations-profile.js";
import { TRANSIT_SOURCE_MANIFEST_FILENAME } from "../../src/jobs/transitous/source-manifest.js";

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
      { mode: 0o600 },
    );
    writeFileSync(join(tmp, "license.json"), "[]\n", { mode: 0o600 });
    writeFileSync(join(tmp, "demo.gtfs.zip"), "GTFS", { mode: 0o600 });
    writeFileSync(join(tmp, TRANSIT_SOURCE_MANIFEST_FILENAME), '{"version":1,"sources":[]}\n', {
      mode: 0o600,
    });
    const proxy = join(tmp, CANDIDATE_PROXY_DIRNAME);
    mkdirSync(join(proxy, "conf"), { mode: 0o700, recursive: true });
    writeFileSync(join(proxy, "conf", "default.conf"), "server { listen 80; }\n", { mode: 0o600 });
    writeFileSync(join(proxy, "feed-proxy-vars.json"), "{}\n", { mode: 0o600 });
    return tmp;
  }

  it("writes and verifies an immutable artifact tuple", async () => {
    const dir = fixture();
    const manifest = createCandidateManifest(dir, "epoch-1", "2026-07-15T00:00:00.000Z");
    expect(manifest.epoch).toBe("epoch-1");
    expect(fs.statSync(join(dir, CANDIDATE_MANIFEST_FILENAME)).mode & 0o777).toBe(0o600);
    expect(manifest.artifacts.datasets).toHaveLength(1);
    expect(await verifyCandidateManifest(dir)).toEqual(manifest);
  });

  it("binds the resolved operations policy into the promoted candidate", async () => {
    const dir = fixture();
    const policy = resolveOperationsProfile({ countries: ["de"], source: "mirror" });
    const manifest = createCandidateManifest(dir, "epoch-1", "2026-07-15T00:00:00.000Z", policy);
    expect(manifest.operationsPolicy).toEqual(policy);
    expect((await verifyCandidateManifest(dir)).operationsPolicy?.profile).toBe(
      "regional-assisted",
    );
  });

  it("detects mutation after the manifest is written", async () => {
    const dir = fixture();
    createCandidateManifest(dir, "epoch-1", "2026-07-15T00:00:00.000Z");
    writeFileSync(join(dir, "license.json"), '[{"changed":true}]\n', { mode: 0o600 });
    await expect(verifyCandidateManifest(dir)).rejects.toThrow(/hash mismatch: license\.json/);
  });
});

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});
it("hashes datasets without loading a whole file into one buffer", () => {
  tmp = mkdtempSync(join(tmpdir(), "omx-candidate-stream-"));
  const file = join(tmp, "large.gtfs.zip"),
    bytes = Buffer.alloc(8 * 1024 * 1024, 7);
  writeFileSync(file, bytes, { mode: 0o600 });
  vi.mocked(fs.readFileSync).mockClear();
  expect(sha256File(file).sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  expect(fs.readFileSync).not.toHaveBeenCalledWith(file);
});
