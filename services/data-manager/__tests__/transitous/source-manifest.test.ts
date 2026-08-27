import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveOperationsProfile } from "../../src/jobs/transitous/operations-profile.js";
import { buildJobContext } from "../../src/jobs/transitous/pipeline.js";
import {
  finalizeTransitSourceManifest,
  readTransitSourceManifest,
  writeTransitSourceManifest,
} from "../../src/jobs/transitous/source-manifest.js";
import { StateStore } from "../../src/state.js";

let tmp: string | undefined;

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

describe("transit acquisition manifest", () => {
  it("is produced for every profile, omits operator relay URLs, and hashes each artifact", () => {
    tmp = mkdtempSync(join(tmpdir(), "openmapx-transit-manifest-"));
    mkdirSync(join(tmp, "gtfs"), { recursive: true });
    const ctx = buildJobContext({
      dataDir: tmp,
      countries: ["de"],
      source: "build",
      operationsPolicy: resolveOperationsProfile({
        profile: "regional-sovereign",
        countries: ["de"],
        source: "build",
        osmInput: "germany.osm.pbf",
      }),
      store: new StateStore(tmp),
      now: () => "2026-07-15T12:00:00.000Z",
    });
    ctx.state.selectedFeedFiles = [
      {
        id: "de",
        country: "de",
        path: "feeds/de.json",
        url: "catalog",
        activeScheduleSources: [
          {
            id: "de_bvg",
            sourceId: "operator:de:BVG",
            region: "de",
            name: "BVG",
            format: "gtfs",
            origin: "operator",
            originUrl: "https://operator.example/gtfs?api_key=secret",
            license: { "spdx-identifier": "CC-BY-4.0" },
          },
        ],
      },
    ];

    const manifestPath = writeTransitSourceManifest(ctx);
    writeFileSync(join(ctx.outDir, "de_bvg.gtfs.zip"), "pinned feed bytes");
    finalizeTransitSourceManifest(ctx);

    const text = readFileSync(manifestPath as string, "utf-8");
    expect(text).not.toContain("secret");
    const manifest = JSON.parse(text) as {
      sources: Array<{
        originUrl?: string;
        artifact: { relativePath: string; sha256: string; sizeBytes: number };
      }>;
    };
    expect(manifest.sources[0]?.originUrl).toBeUndefined();
    expect(manifest.sources[0]?.artifact.relativePath).toBe("de_bvg.gtfs.zip");
    expect(manifest.sources[0]?.artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.sources[0]?.artifact.sizeBytes).toBe(17);
    expect(readTransitSourceManifest(manifestPath).profileEvidence?.profile).toBe(
      "regional-sovereign",
    );
  });

  it("fails completeness when any desired source artifact is absent", () => {
    tmp = mkdtempSync(join(tmpdir(), "openmapx-transit-manifest-"));
    mkdirSync(join(tmp, "gtfs"), { recursive: true });
    const ctx = buildJobContext({ dataDir: tmp, store: new StateStore(tmp) });
    ctx.state.selectedFeedFiles = [
      {
        id: "de",
        country: "de",
        path: "feeds/de.json",
        url: "catalog",
        activeScheduleSources: [
          {
            id: "de_vbb",
            sourceId: "catalog:de:vbb",
            region: "de",
            name: "vbb",
            format: "gtfs",
            origin: "catalog",
          },
        ],
      },
    ];
    writeTransitSourceManifest(ctx);
    expect(() => finalizeTransitSourceManifest(ctx)).toThrow(/has no acquired artifact/);
  });
});
