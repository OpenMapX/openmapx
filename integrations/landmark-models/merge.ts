import { createHash } from "node:crypto";
import type {
  Attribution,
  LandmarkAsset,
  LandmarkCatalogueSnapshot,
  LandmarkReviewTier,
} from "@openmapx/integration-framework";
import { cellsForBounds as cellsForBox } from "./cells";
import { type CellResponse, type CoverageResponse, modelPath, type WireAsset } from "./wire";

/**
 * Bump when normalization, ranking or the wire format changes, so cached cells
 * from an older OpenMapX version never match a new revision.
 */
export const MERGE_FORMAT_VERSION = 1;

export interface ProviderSnapshot {
  providerId: string;
  snapshot: LandmarkCatalogueSnapshot | null;
}

export interface MergedAsset {
  providerId: string;
  asset: LandmarkAsset;
}

export interface MergedIndex {
  revision: string;
  complete: boolean;
  cells: ReadonlyMap<string, readonly MergedAsset[]>;
  providers: CoverageResponse["providers"];
}

const TIER_RANK: Record<LandmarkReviewTier, number> = { approved: 0, unreviewed: 1, draft: 2 };

/** Operator-configured `<provider-id>:<asset-id>` entries, one per line or comma. */
export function parseHiddenAssets(value: unknown): ReadonlySet<string> {
  if (typeof value !== "string") return new Set();
  return new Set(
    value
      .split(/[\n,]/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.includes(":")),
  );
}

/** No landmark spans more cells than this; larger extents are rejected as bad data. */
const MAX_CELLS_PER_ASSET = 16;

/**
 * The z12 cells (`x/y`) an asset's west/south/east/north box touches, or none
 * when the box is not finite, inverted or larger than any landmark.
 */
export function cellsForBounds(bounds: readonly [number, number, number, number]): string[] {
  return cellsForBox(bounds, MAX_CELLS_PER_ASSET);
}

function isAllowed(asset: LandmarkAsset, disallowed: ReadonlySet<string>): boolean {
  if (disallowed.has(asset.sourceId)) return false;
  return asset.contributors.every((receipt) => !disallowed.has(receipt.sourceId));
}

function revisionOf(
  input: readonly ProviderSnapshot[],
  hidden: ReadonlySet<string>,
  disallowed: ReadonlySet<string>,
  formatVersion: number,
): string {
  const key = JSON.stringify([
    formatVersion,
    input.map((p) => `${p.providerId}@${p.snapshot?.release ?? "-"}`).sort(),
    [...hidden].sort(),
    [...disallowed].sort(),
  ]);
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

/**
 * Merge every provider's catalogue. Overlap exists only between providers:
 * a provider may model one structure in several parts that share references.
 * Assets are accepted best rank first, and an asset is dropped when an
 * accepted asset of another provider replaces one of the same OSM elements.
 */
export function mergeProviders(
  input: readonly ProviderSnapshot[],
  hidden: ReadonlySet<string>,
  disallowed: ReadonlySet<string>,
  formatVersion = MERGE_FORMAT_VERSION,
): MergedIndex {
  const candidates: MergedAsset[] = [];
  for (const { providerId, snapshot } of input) {
    for (const asset of snapshot?.assets ?? []) {
      if (hidden.has(`${providerId}:${asset.providerAssetId}`)) continue;
      if (!isAllowed(asset, disallowed)) continue;
      candidates.push({ providerId, asset });
    }
  }
  candidates.sort(
    (a, b) =>
      TIER_RANK[a.asset.reviewTier] - TIER_RANK[b.asset.reviewTier] ||
      a.providerId.localeCompare(b.providerId) ||
      a.asset.providerAssetId.localeCompare(b.asset.providerAssetId),
  );

  const refOwner = new Map<string, string>();
  const cells = new Map<string, MergedAsset[]>();
  for (const candidate of candidates) {
    const { providerId, asset } = candidate;
    const taken = asset.replaces.some((ref) => {
      const owner = refOwner.get(ref);
      return owner !== undefined && owner !== providerId;
    });
    if (taken) continue;
    const assetCells = cellsForBounds(asset.bounds);
    if (assetCells.length === 0) continue;
    for (const ref of asset.replaces) if (!refOwner.has(ref)) refOwner.set(ref, providerId);
    for (const cell of assetCells) {
      const list = cells.get(cell);
      if (list) list.push(candidate);
      else cells.set(cell, [candidate]);
    }
  }

  return {
    revision: revisionOf(input, hidden, disallowed, formatVersion),
    complete: input.every((p) => p.snapshot !== null),
    cells,
    providers: input.map(({ providerId, snapshot }) => ({
      id: providerId,
      release: snapshot?.release ?? null,
      count: snapshot?.assets.length ?? 0,
      fetchedAt: snapshot?.fetchedAt ?? null,
    })),
  };
}

function toWire(
  { providerId, asset }: MergedAsset,
  receiptIndex: (receipt: Attribution) => number,
): WireAsset {
  return {
    id: `${providerId}:${asset.providerAssetId}`,
    name: asset.name,
    anchor: [asset.anchor[0], asset.anchor[1]],
    bounds: [asset.bounds[0], asset.bounds[1], asset.bounds[2], asset.bounds[3]],
    ...(asset.heightM === undefined ? {} : { heightM: asset.heightM }),
    elevationM: asset.elevationM,
    minZoom: asset.minZoom,
    ...(asset.lods.detail && asset.detailZoom !== undefined
      ? { detailZoom: asset.detailZoom }
      : {}),
    models: {
      low: modelPath(providerId, asset.lods.low.sha256),
      ...(asset.lods.detail ? { detail: modelPath(providerId, asset.lods.detail.sha256) } : {}),
    },
    replaces: [...asset.replaces],
    ...(asset.footprint ? { footprint: asset.footprint } : {}),
    grounding: asset.grounding,
    derivedFootprintAllowed: asset.derivedFootprintAllowed,
    ...(asset.wikidata ? { wikidata: asset.wikidata } : {}),
    receipts: asset.contributors.map(receiptIndex),
  };
}

/** One cell's merged assets, with identical receipts sent once. */
export function toCellResponse(index: MergedIndex, cell: string): CellResponse {
  const receipts: Attribution[] = [];
  const byKey = new Map<string, number>();
  const receiptIndex = (receipt: Attribution) => {
    const key = JSON.stringify(receipt);
    let at = byKey.get(key);
    if (at === undefined) {
      at = receipts.push(receipt) - 1;
      byKey.set(key, at);
    }
    return at;
  };
  const assets = (index.cells.get(cell) ?? []).map((merged) => toWire(merged, receiptIndex));
  return { revision: index.revision, receipts, assets };
}
