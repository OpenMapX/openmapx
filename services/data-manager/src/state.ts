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
  | "tile-styles"
  | "pelias-placeholder-data"
  | "pelias-whosonfirst-data";

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

export class StateStore {
  private path: string;
  private state: State = { datasets: [] };

  constructor(dataDir: string) {
    this.path = join(dataDir, ".data-manager-state.json");
    this.loadFromDisk();
  }

  reload(): { datasets: number } {
    this.loadFromDisk();
    return { datasets: this.state.datasets.length };
  }

  private loadFromDisk(): void {
    this.state = { datasets: [] };
    if (existsSync(this.path)) {
      try {
        this.state = JSON.parse(readFileSync(this.path, "utf-8")) as State;
      } catch {
        // start fresh on corrupt state
      }
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
  }
}
