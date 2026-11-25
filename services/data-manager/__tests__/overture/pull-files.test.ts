import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { pullOverture } from "../../src/jobs/overture/pull.js";
import { readOverturePullContract } from "../../src/jobs/overture/stac.js";

const execution = vi.hoisted(() => ({
  afterCopy: undefined as undefined | ((path: string) => void),
  failValidation: false,
  outsideRegion: 0,
  sqlStatements: [] as string[],
  stagedWktFiles: {} as Record<string, string>,
}));
// Keep filesystem writes and publication real; replace only the external DuckDB
// process, reproducing COPY's write to the destination supplied by production SQL.
vi.mock("../../src/jobs/overture/duckdb.js", async (original) => {
  const actual = await original<typeof import("../../src/jobs/overture/duckdb.js")>();
  return {
    ...actual,
    runDuckDb: async (args: string[]) => {
      const sql = args.at(-1) ?? "";
      execution.sqlStatements.push(sql);
      for (const match of sql.matchAll(/read_text\('((?:[^']|'')+)'\)/g)) {
        const wktPath = match[1]?.replaceAll("''", "'");
        if (wktPath && !(wktPath in execution.stagedWktFiles)) {
          execution.stagedWktFiles[wktPath] = readFileSync(wktPath, "utf8");
        }
      }
      const copyPath = sql.match(
        /\) TO '((?:[^']|'')+)' \(FORMAT parquet, COMPRESSION zstd\);/,
      )?.[1];
      if (copyPath) {
        const path = copyPath.replaceAll("''", "'");
        writeFileSync(path, "validated parquet fixture");
        execution.afterCopy?.(path);
      }
      if (sql.includes("AS row_count")) {
        if (execution.failValidation) throw new Error("Snapshot validation failed");
        return {
          stdout: JSON.stringify([
            {
              row_count: 2,
              invalid_ids: 0,
              duplicate_ids: 0,
              null_geometries: 0,
              non_point_geometries: 0,
              wrong_crs_geometries: 0,
              invalid_points: 0,
              wrong_type_rows: 0,
              ...(sql.includes("AS outside_region")
                ? { outside_region: execution.outsideRegion }
                : {}),
            },
          ]),
        };
      }
      return { stdout: sql.includes("SELECT DISTINCT dataset") ? '[{"dataset":"meta"}]' : "" };
    },
  };
});

const release = "2026-07-22.0";
const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  execution.afterCopy = undefined;
  execution.failValidation = false;
  execution.outsideRegion = 0;
  execution.sqlStatements.length = 0;
  for (const key of Object.keys(execution.stagedWktFiles)) delete execution.stagedWktFiles[key];
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

function fixture(region = "planet", fetchPolyImpl?: (url: string) => Promise<string>) {
  const dataDir = mkdtempSync(join(tmpdir(), "openmapx-overture-pull-"));
  directories.push(dataDir);
  vi.stubEnv("OVERTURE_DISK_RESERVE_BYTES", "1");
  vi.stubEnv("OVERTURE_FIRST_PULL_ESTIMATE_BYTES", "1");
  const outDir = join(dataDir, "overture", release);
  mkdirSync(outDir, { recursive: true });
  const rootUrl = "https://stac.overturemaps.org/catalog.json";
  const documents: Record<string, unknown> = {
    [rootUrl]: {
      latest: release,
      links: [{ rel: "child", href: `./${release}/catalog.json` }],
    },
    [`https://stac.overturemaps.org/${release}/catalog.json`]: {
      id: release,
      links: [{ rel: "child", href: "./places/catalog.json", title: "places" }],
    },
    [`https://stac.overturemaps.org/${release}/places/catalog.json`]: {
      id: "places",
      links: [{ rel: "child", href: "./place/collection.json", title: "place" }],
    },
    [`https://stac.overturemaps.org/${release}/places/place/collection.json`]: {
      type: "Collection",
      id: "place",
      links: [{ rel: "item", href: "./00000/00000.json" }],
    },
    [`https://stac.overturemaps.org/${release}/places/place/00000/00000.json`]: {
      type: "Feature",
      stac_version: "1.1.0",
      id: "00000",
      collection: "place",
      bbox: [-180, -90, 180, 90],
      properties: { num_rows: 2 },
      assets: {
        aws: {
          href:
            `https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/release/${release}/` +
            "theme=places/type=place/part-00000-immutable.parquet",
          type: "application/vnd.apache.parquet",
        },
      },
    },
  };
  const fetchImpl: typeof fetch = async (input) => {
    const document = documents[String(input)];
    return document === undefined
      ? new Response("not found", { status: 404 })
      : new Response(JSON.stringify(document));
  };
  return { dataDir, outDir, fetchImpl, fetchPolyImpl, region, release };
}

it("publishes the validated planet snapshot unclipped without following a pre-created staging symlink", async () => {
  const options = fixture();
  vi.spyOn(Date, "now").mockReturnValue(1_000);
  const protectedFile = join(options.dataDir, "protected.txt");
  writeFileSync(protectedFile, "keep this file");
  symlinkSync(protectedFile, join(options.outDir, `planet.${process.pid}.1000.partial.parquet`));
  await expect(pullOverture(options)).resolves.toBe(join(options.outDir, "planet.parquet"));
  expect(readFileSync(protectedFile, "utf8")).toBe("keep this file");
  expect(readOverturePullContract(options.dataDir, release, "planet")).toMatchObject({
    contractVersion: 1,
    rowCount: 2,
    contributors: ["meta"],
    parquetFile: "planet.parquet",
    regionEnvelopes: [{ west: -180, south: -90, east: 180, north: 90 }],
    regionClip: { kind: "none" },
    sourcesCatalogue: expect.arrayContaining([expect.objectContaining({ sourceId: "foursquare" })]),
  });
  for (const sql of execution.sqlStatements) {
    expect(sql).not.toContain("INSTALL ");
  }
  const copySql = execution.sqlStatements[0] ?? "";
  expect(copySql).toContain("LOAD httpfs;");
  expect(copySql).toContain("LOAD spatial;");
  expect(copySql).toContain("(FORMAT parquet, COMPRESSION zstd);");
  expect(copySql).not.toContain("SET VARIABLE region_poly");
  expect(copySql).not.toContain("ST_Intersects");
  const statsSql = execution.sqlStatements.find((sql) => sql.includes("AS row_count"));
  expect(statsSql).toContain("ST_CRS(geometry) IS DISTINCT FROM 'OGC:CRS84'");
  expect(statsSql).toContain("AS wrong_crs_geometries");
  expect(statsSql).toContain("AS invalid_points");
  expect(statsSql).not.toContain("outside_region");
});

it("clips regional pulls via staged WKT, SET VARIABLE region_poly, per-ring ST_MakeValid, and exclusions", async () => {
  const southAfricaPoly = [
    "south-africa",
    "1",
    "16.5 -34.8",
    "32.9 -34.8",
    "32.9 -22.1",
    "16.5 -22.1",
    "END",
    "!2",
    "27.0 -30.7",
    "29.5 -30.7",
    "29.5 -28.6",
    "27.0 -28.6",
    "END",
    "END",
  ].join("\n");
  const options = fixture("africa/south-africa", async (url) => {
    expect(url).toBe("https://download.geofabrik.de/africa/south-africa/south-africa.poly");
    return southAfricaPoly;
  });

  await expect(pullOverture(options)).resolves.toBe(
    join(options.outDir, "africa-south-africa.parquet"),
  );

  const copySql = execution.sqlStatements[0] ?? "";
  expect(copySql).toContain("SET VARIABLE region_poly =");
  expect(copySql).toContain("read_text(");
  expect(copySql).toContain("region-outer.wkt");
  expect(copySql).toContain("region-exclusions.wkt");
  expect(copySql).toContain("ST_Union_Agg(ST_MakeValid(g))");
  expect(copySql).toContain("ST_Difference(u.g, x.g)");
  expect(copySql).toContain("ST_SetCRS(");
  expect(copySql).toContain("SET VARIABLE _region_poly_valid =");
  expect(copySql).toContain("ST_Area(getvariable('region_poly')) > 0");
  expect(copySql.indexOf("bbox.xmin <=")).toBeGreaterThan(-1);
  expect(copySql.indexOf("bbox.xmin <=")).toBeLessThan(
    copySql.indexOf("ST_Intersects(geometry, getvariable('region_poly'))"),
  );
  expect(copySql).not.toContain("MULTIPOLYGON(");

  const wktValues = Object.values(execution.stagedWktFiles);
  expect(wktValues).toHaveLength(2);
  expect(wktValues.some((wkt) => wkt.startsWith("MULTIPOLYGON(((16.5 -34.8,"))).toBe(true);
  expect(wktValues.some((wkt) => wkt.startsWith("MULTIPOLYGON(((27 -30.7,"))).toBe(true);

  const statsSql = execution.sqlStatements.find((sql) => sql.includes("AS row_count")) ?? "";
  expect(statsSql).toContain("SET VARIABLE region_poly =");
  expect(statsSql).toContain("AS outside_region");

  expect(readOverturePullContract(options.dataDir, release, "africa/south-africa")).toMatchObject({
    contractVersion: 1,
    regionEnvelopes: [{ west: 16.5, south: -34.8, east: 32.9, north: -22.1 }],
    regionClip: {
      kind: "geofabrik-poly",
      url: "https://download.geofabrik.de/africa/south-africa/south-africa.poly",
      outerRings: 1,
      exclusionRings: 1,
      vertices: 8,
    },
  });
});

it("uses UNION ALL for antimeridian two-envelope pulls and fails closed when rows fall outside the polygon", async () => {
  const fijiPoly = [
    "fiji",
    "1",
    "177.1 -19.0",
    "180.0 -19.0",
    "180.0 -16.0",
    "177.1 -16.0",
    "END",
    "2",
    "-180.0 -19.5",
    "-178.4 -19.5",
    "-178.4 -16.2",
    "-180.0 -16.2",
    "END",
    "END",
  ].join("\n");
  const options = fixture("australia-oceania/fiji", async () => fijiPoly);
  await expect(pullOverture(options)).resolves.toBe(
    join(options.outDir, "australia-oceania-fiji.parquet"),
  );
  const copySql = execution.sqlStatements[0] ?? "";
  expect(copySql).toContain("UNION ALL");
  expect(copySql).toContain("bbox.xmin <= -178.4");
  expect(copySql).toContain("bbox.xmax >= 177.1");
  expect(copySql).not.toContain("region-exclusions.wkt");

  const smallPolyLen = copySql.length;
  execution.sqlStatements.length = 0;
  const manyVertices = [
    "berlin",
    "1",
    ...Array.from({ length: 200 }, (_, i) => {
      const angle = (i / 200) * Math.PI * 2;
      return `${(13.4 + Math.cos(angle) * 0.2).toFixed(6)} ${(52.5 + Math.sin(angle) * 0.2).toFixed(6)}`;
    }),
    "END",
    "END",
  ].join("\n");
  const largeOptions = fixture("europe/germany/berlin", async () => manyVertices);
  execution.outsideRegion = 3;
  await expect(pullOverture(largeOptions)).rejects.toThrow(/outside_region: 3 row\(s\)/);
  // Polygon WKT stays in a staged file rather than growing DuckDB argv.
  const largeCopySql = execution.sqlStatements[0] ?? "";
  expect(largeCopySql).not.toContain("MULTIPOLYGON(");
  expect(largeCopySql.length).toBeLessThan(smallPolyLen + 200);
});

it("keeps incomplete snapshots in a private staging directory and removes it after validation failure", async () => {
  const options = fixture();
  writeFileSync(join(options.outDir, "planet.parquet"), "previous snapshot");
  writeFileSync(join(options.outDir, "planet.contract.json"), "previous contract");
  let stagingDir = "";
  execution.afterCopy = (path) => {
    stagingDir = dirname(path);
    expect(stagingDir).not.toBe(options.outDir);
    expect(statSync(stagingDir).mode & 0o777).toBe(0o700);
  };
  execution.failValidation = true;
  await expect(pullOverture(options)).rejects.toThrow("Snapshot validation failed");
  expect(readFileSync(join(options.outDir, "planet.parquet"), "utf8")).toBe("previous snapshot");
  expect(readFileSync(join(options.outDir, "planet.contract.json"), "utf8")).toBe(
    "previous contract",
  );
  expect(readdirSync(options.outDir)).toEqual(["planet.contract.json", "planet.parquet"]);
  expect(() => statSync(stagingDir)).toThrow();
});

it("removes the allocated staging directory when progress reporting throws before COPY", async () => {
  const options = fixture();
  await expect(
    pullOverture({
      ...options,
      onProgress: (message) => {
        if (message.startsWith("Pulling Overture")) throw new Error("Progress reporting failed");
      },
    }),
  ).rejects.toThrow("Progress reporting failed");
  expect(readdirSync(options.outDir)).toEqual([]);
});
