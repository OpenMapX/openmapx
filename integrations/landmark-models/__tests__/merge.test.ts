import type { LandmarkAsset, OsmElementRef } from "@openmapx/integration-framework";
import { describe, expect, it } from "vitest";
import {
  cellsForBounds,
  MERGE_FORMAT_VERSION,
  mergeProviders,
  type ProviderSnapshot,
  parseHiddenAssets,
  toCellResponse,
} from "../merge";

const BARRELMAN = "landmark-models-barrelman";
const OPEN = "landmark-models-open-landmarks";
const SHA = (n: number) => n.toString(16).padStart(64, "0");

let next = 1;
function asset(overrides: Partial<LandmarkAsset> = {}): LandmarkAsset {
  const n = next++;
  return {
    providerAssetId: `a${n}`,
    revision: `r${n}`,
    name: `Asset ${n}`,
    anchor: [2.2945, 48.8584],
    bounds: [2.294, 48.858, 2.295, 48.859],
    elevationM: 0,
    minZoom: 15,
    lods: { low: { sha256: SHA(n), bytes: 100, gzipBytes: 50 } },
    replaces: [],
    grounding: "anchor",
    derivedFootprintAllowed: false,
    reviewTier: "unreviewed",
    sourceId: "src",
    contributors: [{ sourceId: "src", name: "Source" }],
    ...overrides,
  };
}

function snap(providerId: string, assets: LandmarkAsset[], release = "r1"): ProviderSnapshot {
  return { providerId, snapshot: { release, fetchedAt: "2026-11-20T00:00:00Z", assets } };
}

const none = new Set<string>();
const ids = (index: ReturnType<typeof mergeProviders>) =>
  [
    ...new Set(
      [...index.cells.values()].flat().map((m) => `${m.providerId}:${m.asset.providerAssetId}`),
    ),
  ].sort();

describe("mergeProviders", () => {
  it("keeps same-provider assets that share a ref", () => {
    const ref = "way/1" as OsmElementRef;
    const a = asset({ replaces: [ref] });
    const b = asset({ replaces: [ref] });
    const index = mergeProviders([snap(BARRELMAN, [a, b])], none, none);
    expect(ids(index)).toEqual(
      [`${BARRELMAN}:${a.providerAssetId}`, `${BARRELMAN}:${b.providerAssetId}`].sort(),
    );
  });

  it("drops the lower-ranked asset of two providers sharing a ref", () => {
    const ref = "way/2" as OsmElementRef;
    const approved = asset({ replaces: [ref], reviewTier: "approved" });
    const unreviewed = asset({ replaces: [ref], reviewTier: "unreviewed" });
    expect(
      ids(mergeProviders([snap(BARRELMAN, [unreviewed]), snap(OPEN, [approved])], none, none)),
    ).toEqual([`${OPEN}:${approved.providerAssetId}`]);

    const draft = asset({ replaces: [ref], reviewTier: "draft" });
    expect(
      ids(mergeProviders([snap(BARRELMAN, [unreviewed]), snap(OPEN, [draft])], none, none)),
    ).toEqual([`${BARRELMAN}:${unreviewed.providerAssetId}`]);
  });

  it("breaks rank ties by provider id then asset id", () => {
    const ref = "relation/3" as OsmElementRef;
    const fromOpen = asset({ replaces: [ref], reviewTier: "draft" });
    const fromBarrelman = asset({ replaces: [ref], reviewTier: "draft" });
    expect(
      ids(mergeProviders([snap(OPEN, [fromOpen]), snap(BARRELMAN, [fromBarrelman])], none, none)),
    ).toEqual([`${BARRELMAN}:${fromBarrelman.providerAssetId}`]);
  });

  it("never drops assets without refs", () => {
    const index = mergeProviders([snap(BARRELMAN, [asset()]), snap(OPEN, [asset()])], none, none);
    expect(ids(index)).toHaveLength(2);
  });

  it("removes hidden assets", () => {
    const hidden = parseHiddenAssets("a:x\nb:y, c:z");
    expect([...hidden].sort()).toEqual(["a:x", "b:y", "c:z"]);
    const shown = asset();
    const gone = asset();
    const index = mergeProviders(
      [snap(BARRELMAN, [shown, gone])],
      new Set([`${BARRELMAN}:${gone.providerAssetId}`]),
      none,
    );
    expect(ids(index)).toEqual([`${BARRELMAN}:${shown.providerAssetId}`]);
    expect(parseHiddenAssets(undefined).size).toBe(0);
    expect(parseHiddenAssets(42).size).toBe(0);
  });

  it("excludes assets whose sources are disallowed", () => {
    const kept = asset({ sourceId: "ok", contributors: [{ sourceId: "ok", name: "Ok" }] });
    const blocked = asset({ sourceId: "blocked" });
    const viaReceipt = asset({
      sourceId: "ok",
      contributors: [
        { sourceId: "ok", name: "Ok" },
        { sourceId: "openstreetmap", name: "OpenStreetMap" },
      ],
    });
    const index = mergeProviders(
      [snap(BARRELMAN, [kept, blocked, viaReceipt])],
      none,
      new Set(["blocked", "openstreetmap"]),
    );
    expect(ids(index)).toEqual([`${BARRELMAN}:${kept.providerAssetId}`]);
  });

  it("buckets an asset into every z12 cell its bounds touch", () => {
    // z12 tile x boundary at lng 0: x = 2048.
    const across = asset({ bounds: [-0.001, 51.5, 0.001, 51.501] });
    const index = mergeProviders([snap(BARRELMAN, [across])], none, none);
    expect([...index.cells.keys()].sort()).toEqual(cellsForBounds(across.bounds).sort());
    expect(index.cells.size).toBe(2);
  });

  it("revision is stable for the same input and changes with a release or the merge format version", () => {
    const a = asset();
    const one = mergeProviders([snap(BARRELMAN, [a], "r1")], none, none).revision;
    expect(mergeProviders([snap(BARRELMAN, [a], "r1")], none, none).revision).toBe(one);
    expect(mergeProviders([snap(BARRELMAN, [a], "r2")], none, none).revision).not.toBe(one);
    expect(
      mergeProviders([snap(BARRELMAN, [a], "r1")], none, none, MERGE_FORMAT_VERSION + 1).revision,
    ).not.toBe(one);
    expect(one).toMatch(/^[0-9a-f]{16}$/);
  });

  it("skips assets whose bounds would span more than 16 cells", () => {
    const huge = asset({ bounds: [-180, -85, 180, 85] });
    const inverted = asset({ bounds: [3, 49, 2, 48] });
    const index = mergeProviders([snap(BARRELMAN, [huge, inverted, asset()])], none, none);
    expect(ids(index)).toHaveLength(1);
    expect(index.cells.size).toBe(1);
  });

  it("an asset without cells does not suppress another provider's asset", () => {
    const ref = "way/99" as OsmElementRef;
    const broken = asset({ replaces: [ref], reviewTier: "approved", bounds: [3, 49, 2, 48] });
    const valid = asset({ replaces: [ref], reviewTier: "unreviewed" });
    const index = mergeProviders([snap(OPEN, [broken]), snap(BARRELMAN, [valid])], none, none);
    expect(ids(index)).toEqual([`${BARRELMAN}:${valid.providerAssetId}`]);
  });

  it("complete is false while a provider has no snapshot", () => {
    const index = mergeProviders(
      [snap(BARRELMAN, [asset()]), { providerId: OPEN, snapshot: null }],
      none,
      none,
    );
    expect(index.complete).toBe(false);
    expect(index.providers).toContainEqual({ id: OPEN, release: null, count: 0, fetchedAt: null });
  });
});

describe("cells", () => {
  it("cellsForBounds uses Web Mercator z12 tiles", () => {
    // The Eiffel Tower lies in z12 tile 2074/1409.
    expect(cellsForBounds([2.2945, 48.8584, 2.2945, 48.8584])).toEqual(["2074/1409"]);
  });

  it("toCellResponse indexes identical receipts once", () => {
    const receipt = { sourceId: "src", name: "Source" };
    const a = asset({ contributors: [receipt] });
    const b = asset({ contributors: [{ ...receipt }] });
    const index = mergeProviders([snap(BARRELMAN, [a, b])], none, none);
    const cell = [...index.cells.keys()][0] as string;
    const response = toCellResponse(index, cell);
    expect(response.receipts).toEqual([receipt]);
    expect(response.assets.map((x) => x.receipts)).toEqual([[0], [0]]);
    expect(response.revision).toBe(index.revision);
  });

  it("toCellResponse writes model paths for low and detail", () => {
    const a = asset({
      lods: {
        low: { sha256: SHA(901), bytes: 1, gzipBytes: 1 },
        detail: { sha256: SHA(902), bytes: 1, gzipBytes: 1 },
      },
      detailZoom: 17,
    });
    const index = mergeProviders([snap(BARRELMAN, [a])], none, none);
    const wire = toCellResponse(index, [...index.cells.keys()][0] as string).assets[0];
    expect(wire?.id).toBe(`${BARRELMAN}:${a.providerAssetId}`);
    expect(wire?.models).toEqual({
      low: `/api/integrations/landmark-models/models/${BARRELMAN}/${SHA(901)}.glb`,
      detail: `/api/integrations/landmark-models/models/${BARRELMAN}/${SHA(902)}.glb`,
    });
    expect(wire?.detailZoom).toBe(17);
  });

  it("an unoccupied cell returns an empty asset list", () => {
    const index = mergeProviders([snap(BARRELMAN, [asset()])], none, none);
    expect(toCellResponse(index, "0/0")).toEqual({
      revision: index.revision,
      receipts: [],
      assets: [],
    });
  });
});
