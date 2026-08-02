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
  "openmapx-source-id"?: string;
  "openmapx-origin"?: "operator";
}

export interface TransitousFeedFile {
  sources?: TransitousFeedSource[];
}

/**
 * The shape a feed source `name` must have before it can be interpolated into
 * an archive filename (`<region>_<name>.<spec>.zip`) and its download URL.
 */
export function isSafeFeedSourceName(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(value);
}
