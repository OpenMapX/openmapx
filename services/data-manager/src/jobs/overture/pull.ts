import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";

export const OVERTURE_RELEASE = "2026-06-17.0";

const REGION_BBOXES: Record<string, { west: number; south: number; east: number; north: number }> =
  {
    "europe/berlin": { west: 13.0, south: 52.3, east: 13.8, north: 52.7 },
  };

export function regionSlug(region: string): string {
  return region.replace(/\//g, "-");
}

export function resolveRegionBbox(region: string): {
  west: number;
  south: number;
  east: number;
  north: number;
} {
  const bbox = REGION_BBOXES[region];
  if (!bbox) throw new Error(`No bbox defined for region "${region}". Define it in REGION_BBOXES.`);
  return bbox;
}

export interface PullOvertureOptions {
  region: string;
  dataDir: string;
  release?: string;
  onProgress?: (msg: string) => void;
}

export async function pullOverture(opts: PullOvertureOptions): Promise<string> {
  const release = opts.release ?? OVERTURE_RELEASE;
  const bbox = resolveRegionBbox(opts.region);
  const slug = regionSlug(opts.region);
  const outDir = join(opts.dataDir, "overture", release);
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${slug}.parquet`);

  const duckSql = [
    "INSTALL httpfs; LOAD httpfs;",
    "INSTALL spatial; LOAD spatial;",
    "SET s3_region='us-west-2';",
    `COPY (`,
    `  SELECT *`,
    `  FROM read_parquet('s3://overturemaps-us-west-2/release/${release}/theme=places/type=place/*')`,
    `  WHERE bbox.xmin <= ${bbox.east}`,
    `    AND bbox.xmax >= ${bbox.west}`,
    `    AND bbox.ymin <= ${bbox.north}`,
    `    AND bbox.ymax >= ${bbox.south}`,
    `) TO '${outPath}' (FORMAT parquet);`,
  ].join("\n");

  opts.onProgress?.(`Pulling Overture ${release} for ${opts.region} → ${outPath}`);
  await execa("duckdb", ["-c", duckSql], { stdio: "inherit" });
  opts.onProgress?.(`Done: ${outPath}`);
  return outPath;
}
