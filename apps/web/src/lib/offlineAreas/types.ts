export type OfflineAreaStatus = "pending" | "downloading" | "ready" | "error" | "paused";

export interface OfflineAreaBbox {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface OfflineArea {
  id: string;
  name: string;
  bbox: OfflineAreaBbox;
  minZoom: number;
  maxZoom: number;
  status: OfflineAreaStatus;
  createdAt: number;
  updatedAt: number;
  /** Total tiles expected once tile-list is generated. */
  tileCount: number;
  /** Tiles successfully cached so far. */
  tilesDone: number;
  /** Approximate cache size in bytes. */
  sizeBytes: number;
  /** Last error message, if status === "error". */
  errorMessage?: string;
  /** Style identifier used at download time (e.g. "openmapx", "maptiler:bright-v2"). */
  styleKey: string;
}

export interface DownloadProgress {
  area: OfflineArea;
  /** 0..1 fraction of tiles cached. */
  progress: number;
  /** Tiles successfully cached this run. */
  done: number;
  total: number;
  /** Approximate bytes cached. */
  bytes: number;
  status: OfflineAreaStatus;
  errorMessage?: string;
}
