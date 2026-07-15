/**
 * A single `sources[]` entry in a Transitous `feeds/<region>.json` file. Only
 * the fields we read/write are typed; upstream's full schema lives in
 * `src/metadata.py`.
 */
export interface TransitousFeedSource {
  name?: string;
  skip?: boolean;
  "skip-reason"?: string;
  spec?: string;
  type?: string;
  url?: string;
  "api-key"?: string;
  "url-override"?: string;
  "transitland-atlas-id"?: string;
  "mdb-id"?: string | number;
  license?: Record<string, unknown>;
}

export interface TransitousFeedFile {
  sources?: TransitousFeedSource[];
}
