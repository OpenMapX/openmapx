import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildOsrmGraph,
  type CommandRunner,
  DEFAULT_OSRM_PROFILE,
  OSRM_GRAPH_BASENAME,
  OSRM_GRAPH_DIR,
  OSRM_INPUT_FILENAME,
  resolveOsmPbfForOsrm,
} from "../src/lib/osrm-graph";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "openmapx-osrm-graph-"));
  writeFileSync(join(tmp, "pnpm-workspace.yaml"), "packages: []\n");
  mkdirSync(join(tmp, "services"), { recursive: true });
  mkdirSync(join(tmp, "infra", "docker", "data", "osm"), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("resolveOsmPbfForOsrm", () => {
  it("resolves the expected region file", () => {
    const dataDir = join(tmp, "infra", "docker", "data");
    const pbf = join(dataDir, "osm", "europe-germany.osm.pbf");
    writeFileSync(pbf, "PBF");

    expect(resolveOsmPbfForOsrm(dataDir, "europe/germany")).toBe(pbf);
  });

  it("requires a region when multiple PBF files are present", () => {
    const dataDir = join(tmp, "infra", "docker", "data");
    writeFileSync(join(dataDir, "osm", "europe-germany.osm.pbf"), "PBF");
    writeFileSync(join(dataDir, "osm", "planet.osm.pbf"), "PBF");

    expect(() => resolveOsmPbfForOsrm(dataDir)).toThrow(/Multiple OSM PBF files/);
  });
});

describe("buildOsrmGraph", () => {
  it("rejects planet-scale inputs", async () => {
    const pbf = join(tmp, "infra", "docker", "data", "osm", "planet.osm.pbf");
    writeFileSync(pbf, "PBF");

    await expect(
      buildOsrmGraph({
        rootDir: tmp,
        region: "planet",
        image: "ghcr.io/project-osrm/osrm-backend:latest",
      }),
    ).rejects.toThrow("OSRM cannot build planet-scale graphs");
  });

  it("runs OSRM extract, partition, and customize in the OSRM Docker image", async () => {
    const pbf = join(tmp, "infra", "docker", "data", "osm", "europe-germany.osm.pbf");
    writeFileSync(pbf, "PBF");

    const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
    const graphDir = join(tmp, "infra", "docker", "data", OSRM_GRAPH_DIR);
    const runner: CommandRunner = async (command, args, opts) => {
      calls.push({ command, args, cwd: opts.cwd });
      if (args.includes("osrm-customize")) {
        writeFileSync(join(graphDir, OSRM_GRAPH_BASENAME), "GRAPH");
      }
    };

    const result = await buildOsrmGraph({
      rootDir: tmp,
      region: "europe/germany",
      image: "ghcr.io/project-osrm/osrm-backend:latest",
      runner,
    });

    expect(readFileSync(join(graphDir, OSRM_INPUT_FILENAME), "utf-8")).toBe("PBF");
    expect(result.graphPath).toBe(join(graphDir, OSRM_GRAPH_BASENAME));
    expect(calls.map((call) => call.args.find((arg) => arg.startsWith("osrm-")))).toEqual([
      "osrm-extract",
      "osrm-partition",
      "osrm-customize",
    ]);
    expect(calls[0]?.args).toEqual(
      expect.arrayContaining([
        "run",
        "--rm",
        "-v",
        `${graphDir}:/data`,
        "ghcr.io/project-osrm/osrm-backend:latest",
        "osrm-extract",
        "-p",
        DEFAULT_OSRM_PROFILE,
        `/data/${OSRM_INPUT_FILENAME}`,
      ]),
    );
    expect(existsSync(result.graphPath)).toBe(true);
  });
});
