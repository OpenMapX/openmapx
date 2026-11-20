import type { Attribution } from "@openmapx/integration-framework";
import type { MultiPolygon, Polygon } from "geojson";

/** The z12 Web Mercator cells landmark catalogues are served by. */
export const CELL_ZOOM = 12;

const MODEL_ROUTE = "/api/integrations/landmark-models/models";

/** One merged landmark as the browser receives it. */
export interface WireAsset {
  /** `<provider-id>:<asset-id>`. */
  id: string;
  name: string;
  anchor: [number, number];
  bounds: [number, number, number, number];
  heightM?: number;
  elevationM: number;
  minZoom: number;
  detailZoom?: number;
  /** API-relative model paths. */
  models: { low: string; detail?: string };
  replaces: string[];
  footprint?: Polygon | MultiPolygon;
  grounding: "anchor" | "footprint-minimum";
  derivedFootprintAllowed: boolean;
  wikidata?: string;
  /** Indexes into the response's `receipts`. */
  receipts: number[];
}

export interface CoverageResponse {
  revision: string;
  /** False while an enabled provider has not loaded its catalogue yet. */
  complete: boolean;
  cellZoom: typeof CELL_ZOOM;
  /** Occupied cells as `x/y`. */
  occupied: string[];
  providers: { id: string; release: string | null; count: number; fetchedAt: string | null }[];
  licence: { name: "ODbL-1.0"; url: string; notice: string };
}

export interface CellResponse {
  revision: string;
  receipts: Attribution[];
  assets: WireAsset[];
}

export function modelPath(providerId: string, sha256: string): string {
  return `${MODEL_ROUTE}/${providerId}/${sha256}.glb`;
}
