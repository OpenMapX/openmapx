import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveOperationsProfile } from "../../src/jobs/transitous/operations-profile.js";
import { buildJobContext } from "../../src/jobs/transitous/pipeline.js";
import {
  finalizeSovereignSourceManifest,
  writeSovereignSourceManifest,
} from "../../src/jobs/transitous/source-manifest.js";
import { StateStore } from "../../src/state.js";

let tmp: string | undefined;

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

describe("sovereign acquisition manifest", () => {
  it("redacts credential values and hashes the acquired local artifact", () => {
    tmp = mkdtempSync(join(tmpdir(), "openmapx-sovereign-manifest-"));
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
            name: "BVG",
            originUrl: "https://operator.example/gtfs?api_key=secret",
            license: { "spdx-identifier": "CC-BY-4.0" },
          },
        ],
      },
    ];

    const manifestPath = writeSovereignSourceManifest(ctx);
    expect(manifestPath).not.toBeNull();
    writeFileSync(join(ctx.outDir, "de_bvg.gtfs.zip"), "pinned feed bytes");
    finalizeSovereignSourceManifest(ctx);

    const text = readFileSync(manifestPath as string, "utf-8");
    expect(text).not.toContain("secret");
    const manifest = JSON.parse(text) as {
      sources: Array<{ originUrl: string; localArtifact?: { sha256: string; sizeBytes: number } }>;
    };
    expect(manifest.sources[0]?.originUrl).toContain("api_key=%5Bredacted%5D");
    expect(manifest.sources[0]?.localArtifact?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.sources[0]?.localArtifact?.sizeBytes).toBe(17);
  });
});
