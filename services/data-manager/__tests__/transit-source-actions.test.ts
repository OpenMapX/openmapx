import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readFeedOverlay, writeFeedOverlayAtomic } from "../src/jobs/transitous-feeds-overlay.js";
import {
  listTransitSources,
  prepareEnableTransitSource,
  prepareRemoveTransitSource,
} from "../src/transit-sources.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "openmapx-source-actions-"));
  roots.push(dataDir);
  const catalogDir = join(dataDir, "catalog"),
    overlayPath = join(dataDir, "overlay.json");
  mkdirSync(join(catalogDir, "feeds"), { recursive: true });
  writeFileSync(
    join(catalogDir, "feeds/de.json"),
    JSON.stringify({
      sources: [
        {
          name: "catalog",
          spec: "gtfs",
          type: "http",
          url: "https://catalog.example.test/feed.zip",
        },
      ],
    }),
  );
  const source = {
      spec: "gtfs" as const,
      type: "http" as const,
      origin: "operator" as const,
      region: "de",
      name: "local",
      url: "https://operator.example.test/feed.zip",
      license: {
        spdxIdentifier: "CC-BY-4.0",
        attribution: "Synthetic operator",
        publisher: "Operator",
      },
    },
    sourceId = "operator:de:local";
  writeFeedOverlayAtomic(overlayPath, {
    version: 3,
    sources: [source],
    patches: [{ sourceId, skip: true }],
    quarantine: [],
  });
  return { dataDir, catalogDir, overlayPath, source, sourceId };
}
it("re-enables a retained disabled operator source without losing its URL, attribution or licence", () => {
  const fx = fixture();
  expect(listTransitSources(fx).sources.find((row) => row.id === fx.sourceId)?.requested).toBe(
    false,
  );
  prepareEnableTransitSource({ ...fx, countries: ["de"] }).persist();
  expect(readFeedOverlay(fx.overlayPath)?.sources).toEqual([fx.source]);
  expect(listTransitSources(fx).sources.find((row) => row.id === fx.sourceId)?.requested).toBe(
    true,
  );
});
it("removes an operator source together with its patches and quarantine, leaving unrelated records", () => {
  const fx = fixture(),
    overlay = readFeedOverlay(fx.overlayPath)!;
  writeFeedOverlayAtomic(fx.overlayPath, {
    ...overlay,
    patches: [...overlay.patches, { sourceId: "catalog:de:catalog", skip: false }],
    quarantine: [
      {
        sourceId: fx.sourceId,
        reason: "fixture",
        firstSeen: "2026-10-01",
        lastChecked: "2026-10-01",
      },
    ],
  });
  prepareRemoveTransitSource(fx).persist();
  expect(readFeedOverlay(fx.overlayPath)).toEqual({
    version: 3,
    sources: [],
    patches: [{ sourceId: "catalog:de:catalog", skip: false }],
    quarantine: [],
  });
});
it("refuses catalog removal without changing desired state", () => {
  const fx = fixture(),
    before = readFileSync(fx.overlayPath);
  expect(() => prepareRemoveTransitSource({ ...fx, sourceId: "catalog:de:catalog" })).toThrow();
  expect(readFileSync(fx.overlayPath)).toEqual(before);
});

it("does not overwrite an unrelated source edit made after preparation", () => {
  const fx = fixture(),
    prepared = prepareEnableTransitSource(fx),
    overlay = readFeedOverlay(fx.overlayPath)!;
  writeFeedOverlayAtomic(fx.overlayPath, {
    ...overlay,
    patches: [...overlay.patches, { sourceId: "catalog:de:catalog", skip: true }],
  });
  const changed = readFileSync(fx.overlayPath);
  expect(() => prepared.persist()).toThrow();
  expect(readFileSync(fx.overlayPath)).toEqual(changed);
});

it("retains a closed desired-source mutation in the durable sync identity", async () => {
  const { normalizeDataExecutionInput } = await import("@openmapx/core/data-manager-contracts");
  const mutation = {
    action: "disable",
    sourceId: "operator:de:local",
    expectedSourceRevision: "a".repeat(64),
  };
  expect(
    normalizeDataExecutionInput({
      kind: "transit-sync",
      countries: ["de"],
      sourceMutation: mutation,
    }),
  ).toMatchObject({ sourceMutation: mutation });
});

it("keeps exact source provenance across disable and enable materialization", async () => {
  const fx = fixture(),
    { prepareSetTransitSourceEnabled } = await import("../src/transit-sources.js"),
    { applyFeedOverlay } = await import("../src/jobs/transitous-feeds-overlay.js");
  for (const enabled of [true, false, true]) {
    prepareSetTransitSourceEnabled({ ...fx, enabled }).persist();
    const feeds = [{ region: "de", sources: [] as Record<string, unknown>[] }];
    applyFeedOverlay(feeds, readFeedOverlay(fx.overlayPath)!);
    const source = feeds[0]!.sources[0]!;
    expect(source).toMatchObject({
      url: fx.source.url,
      skip: !enabled,
      license: {
        "spdx-identifier": "CC-BY-4.0",
        "attribution-text": "Synthetic operator",
        publisher: "Operator",
      },
    });
    expect(listTransitSources(fx).sources.find((row) => row.id === fx.sourceId)).toMatchObject({
      desiredState: enabled ? "enabled" : "disabled",
      actions: { enable: !enabled, disable: enabled, remove: true },
    });
  }
});
it("allows a retained out-of-scope source to be disabled or removed, but not enabled", async () => {
  const fx = fixture(),
    { prepareSetTransitSourceEnabled } = await import("../src/transit-sources.js");
  prepareSetTransitSourceEnabled({ ...fx, countries: ["ch"], enabled: false }).persist();
  expect(
    listTransitSources({ ...fx, countries: ["ch"] }).sources.find((row) => row.id === fx.sourceId),
  ).toMatchObject({ actions: { enable: false, disable: false, remove: true } });
  expect(() => prepareEnableTransitSource({ ...fx, countries: ["ch"] })).toThrow(/outside/);
  prepareRemoveTransitSource({ ...fx, countries: ["ch"] }).persist();
  expect(() => prepareEnableTransitSource(fx)).toThrow(/not found/);
});

it("keeps a quarantined colliding operator visible and removable without materializing it", () => {
  const fx = fixture(),
    source = { ...fx.source, name: "catalog", url: "https://catalog.example.test/feed.zip" },
    sourceId = "operator:de:catalog";
  writeFeedOverlayAtomic(fx.overlayPath, {
    version: 3,
    sources: [source],
    patches: [],
    quarantine: [
      { sourceId, reason: "catalog collision", firstSeen: "2026-10-01", lastChecked: "2026-10-01" },
    ],
  });
  expect(listTransitSources(fx).sources.find((row) => row.id === sourceId)).toMatchObject({
    requested: false,
    desiredState: "disabled",
    actions: { enable: false, remove: true },
  });
  prepareRemoveTransitSource({ ...fx, sourceId }).persist();
  expect(readFeedOverlay(fx.overlayPath)?.sources).toEqual([]);
});

it("bounds the UTF-8 source intent before creating a durable execution", async () => {
  const { normalizeDataExecutionInput } = await import("@openmapx/core/data-manager-contracts"),
    mutation = {
      action: "add",
      expectedSourceRevision: "a".repeat(64),
      source: {
        region: "de",
        name: "bounded",
        url: "https://operator.example.test/feed.zip",
        license: { spdxIdentifier: "CC0-1.0", attribution: "ü".repeat(8192) },
      },
    };
  expect(JSON.stringify(mutation).length).toBeLessThan(16384);
  expect(() =>
    normalizeDataExecutionInput({
      kind: "transit-sync",
      countries: ["de"],
      sourceMutation: mutation,
    }),
  ).toThrow(/metadata is too large/);
});
