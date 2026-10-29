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
}));
// Keep filesystem writes and publication real; replace only the external DuckDB
// process, reproducing COPY's write to the destination supplied by production SQL.
vi.mock("../../src/jobs/overture/duckdb.js", () => ({
  runDuckDb: async (args: string[]) => {
    const sql = args.at(-1) ?? "";
    const copyPath = sql.match(/\) TO '((?:[^']|'')+)' \(FORMAT parquet\);/)?.[1];
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
            wrong_type_rows: 0,
          },
        ]),
      };
    }
    return { stdout: sql.includes("SELECT DISTINCT dataset") ? '[{"dataset":"meta"}]' : "" };
  },
}));

const release = "2026-07-22.0";
const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  execution.afterCopy = undefined;
  execution.failValidation = false;
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

function fixture() {
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
  return { dataDir, outDir, fetchImpl, region: "planet", release };
}

it("publishes the validated snapshot without following a pre-created predictable staging symlink", async () => {
  const options = fixture();
  vi.spyOn(Date, "now").mockReturnValue(1_000);
  const protectedFile = join(options.dataDir, "protected.txt");
  writeFileSync(protectedFile, "keep this file");
  symlinkSync(protectedFile, join(options.outDir, `planet.${process.pid}.1000.partial.parquet`));
  await expect(pullOverture(options)).resolves.toBe(join(options.outDir, "planet.parquet"));
  expect(readFileSync(protectedFile, "utf8")).toBe("keep this file");
  expect(readOverturePullContract(options.dataDir, release, "planet")).toMatchObject({
    rowCount: 2,
    contributors: ["meta"],
    parquetFile: "planet.parquet",
    sourcesCatalogue: expect.arrayContaining([expect.objectContaining({ sourceId: "foursquare" })]),
  });
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
