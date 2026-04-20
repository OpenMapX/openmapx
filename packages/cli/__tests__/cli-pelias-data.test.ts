import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildPeliasData,
  type CommandRunner,
  DEFAULT_PELIAS_OPENSTREETMAP_IMAGE,
  DEFAULT_PELIAS_SCHEMA_IMAGE,
  DEFAULT_PELIAS_WHOSONFIRST_IMAGE,
  PELIAS_BUILD_COMPOSE_FILENAME,
  PELIAS_BUILD_PROJECT_NAME,
  PELIAS_DATA_DIR,
  PELIAS_OPENSTREETMAP_FILENAME,
  PELIAS_PLACEHOLDER_FILENAME,
} from "../src/lib/pelias-data";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "openmapx-pelias-data-"));
  writeFileSync(join(tmp, "pnpm-workspace.yaml"), "packages: []\n");
  mkdirSync(join(tmp, "services", "pelias", "config"), { recursive: true });
  mkdirSync(join(tmp, "infra", "docker", "data", "osm"), { recursive: true });
  writeFileSync(join(tmp, "services", "pelias", "config", "pelias.json"), "{}\n");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("buildPeliasData", () => {
  it("stages Pelias inputs and runs schema, download, import, and placeholder preparation", async () => {
    const pbf = join(tmp, "infra", "docker", "data", "osm", "europe-germany.osm.pbf");
    writeFileSync(pbf, "PBF");

    const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
    const peliasDir = join(tmp, "infra", "docker", "data", PELIAS_DATA_DIR);
    const whosonfirstDir = join(peliasDir, "whosonfirst");
    const placeholderDir = join(peliasDir, "placeholder");
    const runner: CommandRunner = async (command, args, opts) => {
      calls.push({ command, args, cwd: opts.cwd });
      if (command !== "docker") return;
      const joined = args.join(" ");
      if (joined.includes("run --rm pelias-whosonfirst-download")) {
        writeFileSync(join(whosonfirstDir, "admin.sqlite3"), "WOF");
      }
      if (joined.includes("run --rm pelias-placeholder-build")) {
        writeFileSync(join(placeholderDir, PELIAS_PLACEHOLDER_FILENAME), "SQLITE");
      }
    };

    const result = await buildPeliasData({
      rootDir: tmp,
      region: "europe/germany",
      elasticsearchImage: "elasticsearch:7.17.18",
      placeholderImage: "pelias/placeholder:latest",
      runner,
      elasticsearchReadyDelayMs: 0,
    });

    expect(
      readFileSync(join(peliasDir, "openstreetmap", PELIAS_OPENSTREETMAP_FILENAME), "utf-8"),
    ).toBe("PBF");
    expect(result.sourcePbf).toBe(pbf);
    expect(result.peliasDir).toBe(peliasDir);
    expect(result.openstreetmapPath).toBe(
      join(peliasDir, "openstreetmap", PELIAS_OPENSTREETMAP_FILENAME),
    );
    expect(result.placeholderStorePath).toBe(
      join(peliasDir, "placeholder", PELIAS_PLACEHOLDER_FILENAME),
    );
    expect(result.whosonfirstDir).toBe(whosonfirstDir);
    expect(result.schemaImage).toBe(DEFAULT_PELIAS_SCHEMA_IMAGE);
    expect(result.whosonfirstImage).toBe(DEFAULT_PELIAS_WHOSONFIRST_IMAGE);
    expect(result.openstreetmapImage).toBe(DEFAULT_PELIAS_OPENSTREETMAP_IMAGE);
    expect(existsSync(result.placeholderStorePath)).toBe(true);
    expect(existsSync(join(tmp, "infra", "docker", PELIAS_BUILD_COMPOSE_FILENAME))).toBe(false);

    expect(calls).toEqual([
      {
        command: "docker",
        args: [
          "compose",
          "-p",
          PELIAS_BUILD_PROJECT_NAME,
          "-f",
          join(tmp, "infra", "docker", PELIAS_BUILD_COMPOSE_FILENAME),
          "down",
          "--volumes",
          "--remove-orphans",
        ],
        cwd: join(tmp, "infra", "docker"),
      },
      {
        command: "docker",
        args: [
          "compose",
          "-p",
          PELIAS_BUILD_PROJECT_NAME,
          "-f",
          join(tmp, "infra", "docker", PELIAS_BUILD_COMPOSE_FILENAME),
          "up",
          "-d",
          "elasticsearch",
        ],
        cwd: join(tmp, "infra", "docker"),
      },
      {
        command: "docker",
        args: [
          "compose",
          "-p",
          PELIAS_BUILD_PROJECT_NAME,
          "-f",
          join(tmp, "infra", "docker", PELIAS_BUILD_COMPOSE_FILENAME),
          "exec",
          "-T",
          "elasticsearch",
          "curl",
          "-fs",
          "http://localhost:9200/_cluster/health",
        ],
        cwd: join(tmp, "infra", "docker"),
      },
      {
        command: "docker",
        args: [
          "compose",
          "-p",
          PELIAS_BUILD_PROJECT_NAME,
          "-f",
          join(tmp, "infra", "docker", PELIAS_BUILD_COMPOSE_FILENAME),
          "run",
          "--rm",
          "pelias-schema",
        ],
        cwd: join(tmp, "infra", "docker"),
      },
      {
        command: "docker",
        args: [
          "compose",
          "-p",
          PELIAS_BUILD_PROJECT_NAME,
          "-f",
          join(tmp, "infra", "docker", PELIAS_BUILD_COMPOSE_FILENAME),
          "exec",
          "-T",
          "elasticsearch",
          "curl",
          "-fs",
          "http://localhost:9200/pelias",
        ],
        cwd: join(tmp, "infra", "docker"),
      },
      {
        command: "docker",
        args: [
          "compose",
          "-p",
          PELIAS_BUILD_PROJECT_NAME,
          "-f",
          join(tmp, "infra", "docker", PELIAS_BUILD_COMPOSE_FILENAME),
          "run",
          "--rm",
          "pelias-whosonfirst-download",
        ],
        cwd: join(tmp, "infra", "docker"),
      },
      {
        command: "docker",
        args: [
          "compose",
          "-p",
          PELIAS_BUILD_PROJECT_NAME,
          "-f",
          join(tmp, "infra", "docker", PELIAS_BUILD_COMPOSE_FILENAME),
          "run",
          "--rm",
          "pelias-whosonfirst-import",
        ],
        cwd: join(tmp, "infra", "docker"),
      },
      {
        command: "docker",
        args: [
          "compose",
          "-p",
          PELIAS_BUILD_PROJECT_NAME,
          "-f",
          join(tmp, "infra", "docker", PELIAS_BUILD_COMPOSE_FILENAME),
          "run",
          "--rm",
          "pelias-openstreetmap-import",
        ],
        cwd: join(tmp, "infra", "docker"),
      },
      {
        command: "docker",
        args: [
          "compose",
          "-p",
          PELIAS_BUILD_PROJECT_NAME,
          "-f",
          join(tmp, "infra", "docker", PELIAS_BUILD_COMPOSE_FILENAME),
          "run",
          "--rm",
          "pelias-placeholder-build",
        ],
        cwd: join(tmp, "infra", "docker"),
      },
      {
        command: "docker",
        args: [
          "compose",
          "-p",
          PELIAS_BUILD_PROJECT_NAME,
          "-f",
          join(tmp, "infra", "docker", PELIAS_BUILD_COMPOSE_FILENAME),
          "down",
          "--volumes",
          "--remove-orphans",
        ],
        cwd: join(tmp, "infra", "docker"),
      },
    ]);
  });

  it("requires a region when multiple OSM PBFs exist", async () => {
    writeFileSync(join(tmp, "infra", "docker", "data", "osm", "europe-germany.osm.pbf"), "PBF");
    writeFileSync(join(tmp, "infra", "docker", "data", "osm", "europe-france.osm.pbf"), "PBF");

    await expect(
      buildPeliasData({
        rootDir: tmp,
        elasticsearchImage: "elasticsearch:7.17.18",
        placeholderImage: "pelias/placeholder:latest",
        runner: async () => {},
      }),
    ).rejects.toThrow(/Multiple OSM PBF files found/);
  });
});
