import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Kept in sync with packages/core/src/services/types.ts `DatasetType`. When
// the data-manager is allowed to depend on @openmapx/core directly (post-Dockerfile
// refactor), we can import from there and delete this local copy.
export type DatasetType =
  | "osm-pbf"
  | "osm-pbf-bz2"
  | "osrm-graph"
  | "otp-graph"
  | "motis-data"
  | "motis-staging-data"
  | "motis-feed-proxy-config"
  | "gtfs"
  | "tile-mbtiles"
  | "tile-fonts"
  | "pelias-placeholder-data"
  | "pelias-whosonfirst-data";

const DATASET_TYPES = new Set<DatasetType>([
  "osm-pbf",
  "osm-pbf-bz2",
  "osrm-graph",
  "otp-graph",
  "motis-data",
  "motis-staging-data",
  "motis-feed-proxy-config",
  "gtfs",
  "tile-mbtiles",
  "tile-fonts",
  "pelias-placeholder-data",
  "pelias-whosonfirst-data",
]);

export interface DatasetMetadata {
  type: DatasetType;
  id: string;
  region?: string;
  url?: string;
  sizeBytes: number;
  downloadedAt: string;
  sha256?: string;
  md5?: string;
  path: string;
}

export interface State {
  datasets: DatasetMetadata[];
}

export type StateLoadStatus = "missing" | "ok" | "corrupt";

export interface StateLoadDiagnostics {
  status: StateLoadStatus;
  error: string | null;
}

export class StateStore {
  private path: string;
  private state: State = { datasets: [] };
  private loadDiagnostics: StateLoadDiagnostics = { status: "missing", error: null };

  constructor(dataDir: string) {
    this.path = join(dataDir, ".data-manager-state.json");
    this.loadFromDisk();
  }

  reload(): { datasets: number } {
    this.loadFromDisk();
    return { datasets: this.state.datasets.length };
  }

  getLoadDiagnostics(): StateLoadDiagnostics {
    return { ...this.loadDiagnostics };
  }

  private loadFromDisk(): void {
    this.state = { datasets: [] };
    if (!existsSync(this.path)) {
      this.loadDiagnostics = { status: "missing", error: null };
      return;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf-8")) as unknown;
      if (
        !parsed ||
        typeof parsed !== "object" ||
        !Array.isArray((parsed as { datasets?: unknown }).datasets)
      ) {
        throw new Error("state file must contain a datasets array");
      }
      const datasets = (parsed as { datasets: unknown[] }).datasets;
      for (const [index, dataset] of datasets.entries()) {
        if (!isDatasetMetadata(dataset)) {
          throw new Error(`state file contains invalid dataset metadata at index ${index}`);
        }
      }
      this.state = { datasets: datasets as DatasetMetadata[] };
      this.loadDiagnostics = { status: "ok", error: null };
    } catch (err) {
      // Start empty on corrupt state, but retain a diagnostic so evidence
      // consumers can distinguish "no datasets have ever been downloaded"
      // from "the inventory could not be read".
      this.loadDiagnostics = {
        status: "corrupt",
        error: err instanceof Error ? err.message.slice(0, 500) : "invalid state file",
      };
    }
  }

  getAll(): DatasetMetadata[] {
    return [...this.state.datasets];
  }

  upsert(d: DatasetMetadata): void {
    const idx = this.state.datasets.findIndex((x) => x.type === d.type && x.id === d.id);
    if (idx >= 0) this.state.datasets[idx] = d;
    else this.state.datasets.push(d);
    this.persist();
  }

  replaceType(type: DatasetMetadata["type"], datasets: DatasetMetadata[]): void {
    this.state.datasets = [
      ...this.state.datasets.filter((dataset) => dataset.type !== type),
      ...datasets,
    ];
    this.persist();
  }

  remove(type: DatasetMetadata["type"], id: string): boolean {
    const before = this.state.datasets.length;
    this.state.datasets = this.state.datasets.filter((d) => !(d.type === type && d.id === id));
    if (this.state.datasets.length !== before) {
      this.persist();
      return true;
    }
    return false;
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.state, null, 2), "utf-8");
    this.loadDiagnostics = { status: "ok", error: null };
  }
}

function isDatasetMetadata(value: unknown): value is DatasetMetadata {
  if (!value || typeof value !== "object") return false;
  const dataset = value as Partial<DatasetMetadata>;
  return (
    typeof dataset.type === "string" &&
    DATASET_TYPES.has(dataset.type as DatasetType) &&
    typeof dataset.id === "string" &&
    dataset.id.length > 0 &&
    typeof dataset.sizeBytes === "number" &&
    Number.isFinite(dataset.sizeBytes) &&
    dataset.sizeBytes >= 0 &&
    typeof dataset.downloadedAt === "string" &&
    dataset.downloadedAt.length > 0 &&
    typeof dataset.path === "string" &&
    dataset.path.length > 0 &&
    (dataset.region === undefined || typeof dataset.region === "string") &&
    (dataset.url === undefined || typeof dataset.url === "string") &&
    (dataset.sha256 === undefined || typeof dataset.sha256 === "string") &&
    (dataset.md5 === undefined || typeof dataset.md5 === "string")
  );
}
