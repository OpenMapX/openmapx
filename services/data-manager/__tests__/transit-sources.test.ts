import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listTransitSources,
  prepareAddTransitSource,
  prepareEnableTransitSource,
  prepareRemoveTransitSource,
} from "../src/transit-sources.js";

let tmp: string | undefined;

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

function fixture() {
  tmp = mkdtempSync(join(tmpdir(), "openmapx-transit-sources-"));
  const catalogDir = join(tmp, ".transitous-catalog");
  const overlayPath = join(tmp, "overrides", "feeds-overlay.json");
  mkdirSync(join(catalogDir, "feeds"), { recursive: true });
  writeFileSync(
    join(catalogDir, "feeds", "de.json"),
    JSON.stringify({
      sources: [
        {
          name: "active-feed",
          spec: "gtfs",
          type: "http",
          url: "https://catalog.example/active.zip",
          license: { "spdx-identifier": "CC0-1.0" },
        },
        {
          name: "disabled-feed",
          spec: "gtfs",
          type: "http",
          url: "https://catalog.example/disabled.zip",
          skip: true,
        },
      ],
    }),
  );
  mkdirSync(join(tmp, "motis", "live"), { recursive: true });
  writeFileSync(
    join(tmp, "motis", "live", "transit-source-manifest.json"),
    JSON.stringify({
      version: 1,
      generatedAt: "2026-07-30T00:00:00.000Z",
      sources: [
        {
          sourceId: "catalog:de:active-feed",
          region: "de",
          name: "active-feed",
          format: "gtfs",
          origin: "catalog",
          originUrl: "https://catalog.example/active.zip",
          license: { "spdx-identifier": "CC0-1.0" },
          transformations: ["transitous-cleaning"],
          artifact: {
            relativePath: "de_active-feed.gtfs.zip",
            sha256: "a".repeat(64),
            sizeBytes: 42,
            modifiedAt: "2026-07-29T12:00:00.000Z",
          },
        },
      ],
    }),
  );
  writeFileSync(
    join(tmp, "motis", "live", "motis-candidate-manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      epoch: "epoch-live",
      artifacts: { sourceManifest: { path: "transit-source-manifest.json" } },
    }),
  );
  return { dataDir: tmp, catalogDir, overlayPath };
}

function operatorSource() {
  return {
    spec: "gtfs" as const,
    type: "http" as const,
    region: "de",
    name: "operator-feed",
    url: "https://operator.example/feed.zip",
    origin: "operator" as const,
    license: { spdxIdentifier: "CC-BY-4.0", attribution: "Operator" },
  };
}

describe("transit source lifecycle", () => {
  it("derives desired and active independently with filtering and pagination", () => {
    const fx = fixture();
    prepareAddTransitSource({ ...fx, source: operatorSource() }).persist();
    const result = listTransitSources({
      ...fx,
      feedStates: [
        {
          region: "de",
          name: "operator-feed",
          status: "failed",
          validationStatus: "error",
          validationMessage: "invalid archive",
        },
      ],
      query: { origin: "operator", lifecycle: "failed", search: "operator", limit: 1 },
    });
    expect(result).toMatchObject({ total: 1, limit: 1, offset: 0 });
    expect(result.sources[0]).toMatchObject({
      id: "operator:de:operator-feed",
      requested: true,
      active: false,
      lifecycle: "failed",
      validationMessage: "invalid archive",
    });

    const all = listTransitSources({ ...fx });
    expect(all.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "catalog:de:active-feed",
          requested: true,
          active: true,
          activeEpoch: "epoch-live",
          lifecycle: "active",
        }),
        expect.objectContaining({
          id: "catalog:de:disabled-feed",
          requested: false,
          active: false,
          lifecycle: "disabled",
        }),
      ]),
    );
  });

  it("persists catalog disable/re-enable and operator removal as v3 state", () => {
    const fx = fixture();
    prepareAddTransitSource({ ...fx, source: operatorSource() }).persist();
    prepareRemoveTransitSource({
      ...fx,
      sourceId: "catalog:de:active-feed",
    }).persist();
    expect(listTransitSources({ ...fx }).sources).toContainEqual(
      expect.objectContaining({
        id: "catalog:de:active-feed",
        requested: false,
        active: true,
        lifecycle: "removal-pending",
      }),
    );
    prepareEnableTransitSource({
      ...fx,
      sourceId: "catalog:de:active-feed",
    }).persist();
    prepareRemoveTransitSource({
      ...fx,
      sourceId: "operator:de:operator-feed",
    }).persist();
    const overlay = JSON.parse(readFileSync(fx.overlayPath, "utf-8")) as {
      version: number;
      sources: unknown[];
      patches: Array<{ sourceId: string; skip: boolean }>;
    };
    expect(overlay).toMatchObject({
      version: 3,
      sources: [],
      patches: [{ sourceId: "catalog:de:active-feed", skip: false }],
    });
  });
});
