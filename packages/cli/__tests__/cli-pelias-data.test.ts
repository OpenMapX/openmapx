import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type BuildPeliasDataOptions,
  buildPeliasData,
  type CommandRunner,
  PELIAS_BUILD_COMPOSE_FILENAME,
  PELIAS_BUILD_PROJECT_NAME,
  PELIAS_DATA_DIR,
  PELIAS_ELASTICSEARCH_DIR,
  PELIAS_OPENSTREETMAP_FILENAME,
  PELIAS_PLACEHOLDER_FILENAME,
} from "../src/lib/pelias-data";

let tmp: string;

const images = {
  elasticsearchImage: "elasticsearch:7.17.28",
  placeholderImage: "pelias/placeholder:latest",
  schemaImage: "pelias/schema:latest@sha256:1",
  whosonfirstImage: "pelias/whosonfirst:latest@sha256:2",
  openstreetmapImage: "pelias/openstreetmap:latest@sha256:3",
} satisfies Partial<BuildPeliasDataOptions>;

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

function composeCall(composeFile: string, ...args: string[]) {
  return {
    command: "docker",
    args: ["compose", "-p", PELIAS_BUILD_PROJECT_NAME, "-f", composeFile, ...args],
    cwd: join(tmp, "infra", "docker"),
  };
}

/** Fakes the containers by writing what each step would produce. */
function fakePeliasRunner(
  buildDir: string,
  calls: Array<{ command: string; args: string[]; cwd?: string }>,
  hooks: { onUp?: () => void; failAt?: string } = {},
): CommandRunner {
  return async (command, args, opts) => {
    calls.push({ command, args, cwd: opts.cwd });
    const joined = args.join(" ");
    if (hooks.failAt && joined.includes(hooks.failAt)) throw new Error(`${hooks.failAt} failed`);
    if (joined.includes("up -d elasticsearch")) {
      hooks.onUp?.();
      writeFileSync(join(buildDir, PELIAS_ELASTICSEARCH_DIR, "index"), "ES");
    }
    if (joined.includes("run --rm pelias-whosonfirst-download")) {
      writeFileSync(join(buildDir, "whosonfirst", "admin.sqlite3"), "WOF");
    }
    if (joined.includes("run --rm pelias-placeholder-build")) {
      writeFileSync(join(buildDir, "placeholder", PELIAS_PLACEHOLDER_FILENAME), "SQLITE");
    }
  };
}

describe("buildPeliasData", () => {
  it("builds the whole tree, Elasticsearch index included, in a staged dir and swaps it in", async () => {
    const pbf = join(tmp, "infra", "docker", "data", "osm", "europe-germany.osm.pbf");
    writeFileSync(pbf, "PBF");
    const peliasDir = join(tmp, "infra", "docker", "data", PELIAS_DATA_DIR);
    const buildDir = `${peliasDir}.next`;
    mkdirSync(join(peliasDir, "placeholder"), { recursive: true });
    writeFileSync(join(peliasDir, "placeholder", "stale"), "OLD");
    const composeFile = join(tmp, "infra", "docker", PELIAS_BUILD_COMPOSE_FILENAME);

    let compose: {
      services: Record<string, { image: string; volumes?: string[]; user?: string }>;
      volumes?: unknown;
    } = { services: {} };
    const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
    const result = await buildPeliasData({
      rootDir: tmp,
      region: "europe/germany",
      ...images,
      runner: fakePeliasRunner(buildDir, calls, {
        onUp: () => {
          compose = JSON.parse(readFileSync(composeFile, "utf-8"));
        },
      }),
      elasticsearchReadyDelayMs: 0,
    });

    expect(compose.volumes).toBeUndefined();
    expect(compose.services.elasticsearch?.volumes).toEqual([
      `${join(buildDir, PELIAS_ELASTICSEARCH_DIR)}:/usr/share/elasticsearch/data`,
    ]);
    if (typeof process.getuid === "function") {
      expect(compose.services.elasticsearch?.user).toBe(`${process.getuid()}:0`);
    }
    expect(compose.services["pelias-whosonfirst-import"]?.volumes).toContain(`${buildDir}:/data`);
    expect(compose.services["pelias-schema"]?.image).toBe(images.schemaImage);
    expect(compose.services["pelias-whosonfirst-download"]?.image).toBe(images.whosonfirstImage);
    expect(compose.services["pelias-openstreetmap-import"]?.image).toBe(images.openstreetmapImage);

    expect(existsSync(buildDir)).toBe(false);
    expect(existsSync(join(peliasDir, "placeholder", "stale"))).toBe(false);
    expect(readFileSync(join(peliasDir, PELIAS_ELASTICSEARCH_DIR, "index"), "utf-8")).toBe("ES");
    expect(
      readFileSync(join(peliasDir, "openstreetmap", PELIAS_OPENSTREETMAP_FILENAME), "utf-8"),
    ).toBe("PBF");
    expect(result).toMatchObject({
      sourcePbf: pbf,
      peliasDir,
      placeholderStorePath: join(peliasDir, "placeholder", PELIAS_PLACEHOLDER_FILENAME),
      whosonfirstDir: join(peliasDir, "whosonfirst"),
    });
    expect(existsSync(result.placeholderStorePath)).toBe(true);
    expect(existsSync(composeFile)).toBe(false);

    expect(calls).toEqual([
      composeCall(composeFile, "down", "--remove-orphans"),
      composeCall(composeFile, "up", "-d", "elasticsearch"),
      composeCall(
        composeFile,
        "exec",
        "-T",
        "elasticsearch",
        "curl",
        "-fs",
        "http://localhost:9200/_cluster/health",
      ),
      composeCall(composeFile, "run", "--rm", "pelias-schema"),
      composeCall(
        composeFile,
        "exec",
        "-T",
        "elasticsearch",
        "curl",
        "-fs",
        "http://localhost:9200/pelias",
      ),
      composeCall(composeFile, "run", "--rm", "pelias-whosonfirst-download"),
      composeCall(composeFile, "run", "--rm", "pelias-whosonfirst-import"),
      composeCall(composeFile, "run", "--rm", "pelias-openstreetmap-import"),
      composeCall(composeFile, "run", "--rm", "pelias-placeholder-build"),
      composeCall(composeFile, "down", "--remove-orphans"),
    ]);
  });

  it("leaves the previous tree untouched when an import step fails", async () => {
    writeFileSync(join(tmp, "infra", "docker", "data", "osm", "europe-germany.osm.pbf"), "PBF");
    const peliasDir = join(tmp, "infra", "docker", "data", PELIAS_DATA_DIR);
    mkdirSync(join(peliasDir, "placeholder"), { recursive: true });
    writeFileSync(join(peliasDir, "placeholder", PELIAS_PLACEHOLDER_FILENAME), "OLD");
    const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];

    await expect(
      buildPeliasData({
        rootDir: tmp,
        region: "europe/germany",
        ...images,
        runner: fakePeliasRunner(`${peliasDir}.next`, calls, {
          failAt: "pelias-openstreetmap-import",
        }),
        elasticsearchReadyDelayMs: 0,
      }),
    ).rejects.toThrow(/pelias-openstreetmap-import failed/);

    expect(readFileSync(join(peliasDir, "placeholder", PELIAS_PLACEHOLDER_FILENAME), "utf-8")).toBe(
      "OLD",
    );
    expect(existsSync(`${peliasDir}.next`)).toBe(false);
    expect(calls.at(-1)?.args.slice(-2)).toEqual(["down", "--remove-orphans"]);
  });

  it("requires a region when multiple OSM PBFs exist", async () => {
    writeFileSync(join(tmp, "infra", "docker", "data", "osm", "europe-germany.osm.pbf"), "PBF");
    writeFileSync(join(tmp, "infra", "docker", "data", "osm", "europe-france.osm.pbf"), "PBF");

    await expect(
      buildPeliasData({ rootDir: tmp, ...images, runner: async () => {} }),
    ).rejects.toThrow(/Multiple OSM PBF files found/);
  });
});
