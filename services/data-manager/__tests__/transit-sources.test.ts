import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCandidateManifest } from "../src/jobs/transitous/candidate.js";
import { resolveTransitOverlayPath } from "../src/jobs/transitous/internal.js";
import { safeOriginUrl } from "../src/jobs/transitous/source-manifest.js";
import {
  listTransitSources,
  prepareAddTransitSource,
  prepareEnableTransitSource,
  prepareRemoveTransitSource,
  prepareSetTransitSourceEnabled,
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
  mkdirSync(join(catalogDir, "feeds"), { mode: 0o700, recursive: true });
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
    { mode: 0o600 },
  );
  mkdirSync(join(tmp, "motis", "live"), { mode: 0o700, recursive: true });
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
            sha256: createHash("sha256").update("synthetic timetable").digest("hex"),
            sizeBytes: Buffer.byteLength("synthetic timetable"),
            modifiedAt: "2026-07-29T12:00:00.000Z",
          },
        },
      ],
    }),
    { mode: 0o600 },
  );
  const live = join(tmp, "motis", "live");
  mkdirSync(join(live, ".openmapx-feed-proxy", "conf"), { mode: 0o700, recursive: true });
  writeFileSync(
    join(live, "config.yml"),
    JSON.stringify({
      timetable: { datasets: { "de-active-feed": { path: "de_active-feed.gtfs.zip" } } },
    }),
    { mode: 0o600 },
  );
  writeFileSync(join(live, "license.json"), "[]", { mode: 0o600 });
  writeFileSync(join(live, "de_active-feed.gtfs.zip"), "synthetic timetable", { mode: 0o600 });
  writeFileSync(
    join(live, ".openmapx-feed-proxy", "conf", "default.conf"),
    "# no realtime feeds\n",
    { mode: 0o600 },
  );
  writeFileSync(join(live, ".openmapx-feed-proxy", "feed-proxy-vars.json"), "{}", { mode: 0o600 });
  createCandidateManifest(live, "epoch-live", "2026-07-30T00:00:00.000Z");
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
    prepareSetTransitSourceEnabled({
      ...fx,
      enabled: false,
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

  it("falls back to the default overlay path when the env var renders empty", () => {
    const previous = process.env.TRANSITOUS_FEEDS_OVERLAY_PATH;
    process.env.TRANSITOUS_FEEDS_OVERLAY_PATH = "";
    try {
      expect(resolveTransitOverlayPath("/data")).toBe("/data/overrides/feeds-overlay.json");
      expect(resolveTransitOverlayPath("/data", "")).toBe("/data/overrides/feeds-overlay.json");
      expect(resolveTransitOverlayPath("/data", "/explicit.json")).toBe("/explicit.json");
    } finally {
      if (previous === undefined) delete process.env.TRANSITOUS_FEEDS_OVERLAY_PATH;
      else process.env.TRANSITOUS_FEEDS_OVERLAY_PATH = previous;
    }
  });

  it("keeps a source active when the manifest URL is credential-sanitized", () => {
    const fx = fixture();
    const rawUrl = "https://catalog.example/active.zip?apiKey=secret";
    writeFileSync(
      join(fx.catalogDir, "feeds", "de.json"),
      JSON.stringify({
        sources: [
          {
            name: "active-feed",
            spec: "gtfs",
            type: "http",
            url: rawUrl,
            license: { "spdx-identifier": "CC0-1.0" },
          },
        ],
      }),
      { mode: 0o600 },
    );
    const manifestPath = join(
      fx.dataDir as string,
      "motis",
      "live",
      "transit-source-manifest.json",
    );
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
      sources: Array<{ originUrl?: string }>;
    };
    manifest.sources[0].originUrl = safeOriginUrl(rawUrl);
    writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
    expect(listTransitSources({ ...fx }).sources).toContainEqual(
      expect.objectContaining({ id: "catalog:de:active-feed", lifecycle: "active" }),
    );
  });

  it("scopes catalog rows and mutations to the configured countries", () => {
    const fx = fixture();
    writeFileSync(
      join(fx.catalogDir, "feeds", "fr.json"),
      JSON.stringify({
        sources: [
          { name: "fr-feed", spec: "gtfs", type: "http", url: "https://catalog.example/fr.zip" },
        ],
      }),
      { mode: 0o600 },
    );
    const scoped = listTransitSources({ ...fx, countries: ["de"] });
    expect(scoped.sources.some((source) => source.region === "fr")).toBe(false);
    expect(listTransitSources({ ...fx }).sources.some((source) => source.region === "fr")).toBe(
      true,
    );
    expect(() =>
      prepareAddTransitSource({
        ...fx,
        countries: ["de"],
        source: { ...operatorSource(), region: "fr", url: "https://operator.example/fr.zip" },
      }),
    ).toThrow(/country scope/);
    expect(() =>
      prepareEnableTransitSource({ ...fx, countries: ["de"], sourceId: "catalog:fr:fr-feed" }),
    ).toThrow(/outside the configured country scope/);
  });
});
