import type { MultiPolygon, Polygon } from "geojson";
import type { Attribution } from "./mobility-data-source-provider.js";

/**
 * Pluggable "landmark-models" capability: catalogues of georeferenced 3D
 * landmark models. The first-party `landmark-models` orchestrator merges every
 * registered provider, serves the merged catalogue by map cell and proxies the
 * model files, so browsers never contact a provider's host.
 */

/** How far a model has been reviewed; lower tiers win when providers overlap. */
export type LandmarkReviewTier = "approved" | "unreviewed" | "draft";

/** An OpenStreetMap element reference such as `way/123`. */
export type OsmElementRef = `${"node" | "way" | "relation"}/${number}`;

export interface LandmarkModelFile {
  /** sha256 of the raw GLB, lower-case hex; the model's public identifier. */
  readonly sha256: string;
  /** Raw GLB size in bytes. */
  readonly bytes: number;
  /** Size of the gzip file the provider fetches. */
  readonly gzipBytes: number;
  readonly triangles?: number;
}

export interface LandmarkAsset {
  /** Upstream id, unique within the provider. */
  readonly providerAssetId: string;
  /** Upstream content revision. */
  readonly revision: string;
  readonly name: string;
  /** WGS84 longitude and latitude of the model origin. */
  readonly anchor: readonly [number, number];
  /** West, south, east, north. */
  readonly bounds: readonly [number, number, number, number];
  readonly heightM?: number;
  /** Lift in metres applied after grounding; 0 unless the provider supplies one. */
  readonly elevationM: number;
  /** Minimum display zoom, within [13, 18]. */
  readonly minZoom: number;
  /** Zoom from which the detail model is drawn; only with `lods.detail`. */
  readonly detailZoom?: number;
  readonly lods: { readonly low: LandmarkModelFile; readonly detail?: LandmarkModelFile };
  /** OpenStreetMap elements the model stands in for, primary first, at most 256. */
  readonly replaces: readonly OsmElementRef[];
  /** Ground outline of the structure the model replaces, when the provider has one. */
  readonly footprint?: Polygon | MultiPolygon;
  /** How the browser finds the model's ground height on 3D terrain. */
  readonly grounding: "anchor" | "footprint-minimum";
  /** Whether a footprint derived from the model's own geometry may hide extrusions. */
  readonly derivedFootprintAllowed: boolean;
  readonly wikidata?: string;
  readonly reviewTier: LandmarkReviewTier;
  /** The manifest data source that supplied the model. */
  readonly sourceId: string;
  /** Receipts captured when the catalogue was loaded. */
  readonly contributors: readonly Attribution[];
}

export interface LandmarkCatalogueSnapshot {
  /** Upstream release id. */
  readonly release: string;
  /** ISO time of the last successful catalogue check. */
  readonly fetchedAt: string;
  readonly assets: readonly LandmarkAsset[];
}

export type LandmarkModelFetchResult =
  | { readonly status: "ok"; readonly gzip: Uint8Array }
  /** `unlisted`: the provider lists no such model; `gone`: listed, but upstream answered 404. */
  | { readonly status: "unlisted" | "gone" };

export interface LandmarkModelProvider {
  /** The registering integration's id. */
  readonly id: string;
  /** Manifest data sources this provider's records and receipts use. */
  readonly sourceIds: readonly string[];
  /** Current in-memory catalogue, or null before the first successful load. */
  snapshot(): LandmarkCatalogueSnapshot | null;
  /**
   * Gzip bytes of a listed model, verified against the upstream gzip sha256.
   * Throws on other upstream or verification failures.
   */
  fetchModelGzip(sha256: string, signal: AbortSignal): Promise<LandmarkModelFetchResult>;
}

export function assertLandmarkModelProviderContract(
  provider: LandmarkModelProvider,
  integrationId: string,
  allowedSourceIds: ReadonlySet<string>,
): void {
  if (provider.id !== integrationId)
    throw new TypeError(
      `landmark-models provider id "${provider.id}" must equal its integration id "${integrationId}"`,
    );
  if (
    provider.sourceIds.length === 0 ||
    new Set(provider.sourceIds).size !== provider.sourceIds.length
  )
    throw new TypeError(`landmark-models provider ${provider.id} must declare unique sourceIds`);
  for (const sourceId of provider.sourceIds) {
    if (!allowedSourceIds.has(sourceId))
      throw new TypeError(
        `landmark-models provider ${provider.id} uses undeclared source "${sourceId}"`,
      );
  }
}
