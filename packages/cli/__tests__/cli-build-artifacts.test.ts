import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BUNDLE_MANIFEST_PATH,
  type BuildRecord,
  exportBuildBundle,
  importBuildBundle,
  readBuildRecord,
  writeBuildRecord,
} from "../src/lib/build-artifacts";

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;
const OSRM_IMAGE = `ghcr.io/project-osrm/osrm-backend:latest@${DIGEST_A}`;
const MOTIS_IMAGE = `ghcr.io/motis-project/motis:latest@${DIGEST_A}`;

function motisRecord(): BuildRecord {
  return { ...osrmRecord(), service: "motis", runtimeImages: { motis: MOTIS_IMAGE } };
}
const BUNDLE_MANIFEST_DIR = BUNDLE_MANIFEST_PATH.split("/")[0] ?? "";

let tmp: string;
let buildHost: string;
let serveHost: string;

function writeServiceManifest(root: string, id: string, image: string, digest: string): void {
  mkdirSync(join(root, "services", id), { recursive: true });
  writeFileSync(
    join(root, "services", id, "service.json"),
    JSON.stringify({
      id,
      name: id,
      version: "1.0.0",
      quality: "built-in",
      container: { image, tag: "latest", digest, expose: [5000] },
    }),
  );
}

function makeHost(name: string, osrmDigest = DIGEST_A): string {
  const root = join(tmp, name);
  mkdirSync(join(root, "infra", "docker", "data"), { recursive: true });
  writeFileSync(join(root, "pnpm-workspace.yaml"), "packages: []\n");
  writeServiceManifest(root, "osrm", "ghcr.io/project-osrm/osrm-backend", osrmDigest);
  writeServiceManifest(root, "motis", "ghcr.io/motis-project/motis", DIGEST_A);
  return root;
}

function dataDir(root: string): string {
  return join(root, "infra", "docker", "data");
}

function osrmRecord(): BuildRecord {
  return {
    schemaVersion: 1,
    service: "osrm",
    region: "europe/germany",
    sourcePbf: { name: "europe-germany.osm.pbf", sizeBytes: 3 },
    builtAt: "2026-10-03T00:00:00.000Z",
    runtimeImages: { osrm: OSRM_IMAGE },
    toolImages: {},
  };
}

function seedOsrmBuild(root: string): void {
  const graph = join(dataDir(root), "osrm-graph");
  mkdirSync(join(graph, "region.osrm.cells.d"), { recursive: true });
  writeFileSync(join(graph, "region.osrm"), "GRAPH");
  writeFileSync(join(graph, "region.osrm.cells.d", "part"), "CELLS");
  writeFileSync(join(graph, "segment-speeds.csv"), "");
  writeFileSync(join(graph, "region.osm.pbf"), "PBF");
  writeBuildRecord(osrmRecord(), root);
}

const noneRunning = async () => [];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "openmapx-build-artifacts-"));
  buildHost = makeHost("build");
  serveHost = makeHost("serve");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("build bundles", () => {
  it("round-trips a build to another host, dropping staged inputs and recording provenance", async () => {
    seedOsrmBuild(buildHost);
    const bundle = join(tmp, "osrm.tar");
    const exported = await exportBuildBundle({ serviceId: "osrm", bundle, rootDir: buildHost });

    expect(exported.files.map((file) => file.path)).toEqual([
      "osrm-graph/region.osrm",
      "osrm-graph/region.osrm.cells.d/part",
      "osrm-graph/segment-speeds.csv",
    ]);

    const liveGraph = join(dataDir(serveHost), "osrm-graph");
    mkdirSync(liveGraph, { recursive: true });
    writeFileSync(join(liveGraph, "region.osrm"), "OLD");

    const imported = await importBuildBundle({
      bundle,
      rootDir: serveHost,
      runningServices: noneRunning,
    });

    expect(imported.service).toBe("osrm");
    expect(readFileSync(join(liveGraph, "region.osrm"), "utf-8")).toBe("GRAPH");
    expect(readFileSync(join(liveGraph, "region.osrm.cells.d", "part"), "utf-8")).toBe("CELLS");
    expect(existsSync(join(liveGraph, "region.osm.pbf"))).toBe(false);
    expect(existsSync(join(dataDir(serveHost), ".openmapx-import"))).toBe(false);
    expect(readBuildRecord("osrm", serveHost)).toEqual(osrmRecord());
  });

  it("refuses a bundle built for a different runtime image", async () => {
    seedOsrmBuild(buildHost);
    const otherServe = makeHost("serve-other", DIGEST_B);
    const bundle = join(tmp, "osrm.tar");
    await exportBuildBundle({ serviceId: "osrm", bundle, rootDir: buildHost });

    await expect(
      importBuildBundle({ bundle, rootDir: otherServe, runningServices: noneRunning }),
    ).rejects.toThrow(/different runtime images.*osrm/);
    expect(existsSync(join(dataDir(otherServe), "osrm-graph"))).toBe(false);
  });

  it("refuses to swap while a consumer is running", async () => {
    seedOsrmBuild(buildHost);
    const bundle = join(tmp, "osrm.tar");
    await exportBuildBundle({ serviceId: "osrm", bundle, rootDir: buildHost });

    await expect(
      importBuildBundle({
        bundle,
        rootDir: serveHost,
        runningServices: async (ids) => ids.filter((id) => id === "osrm"),
      }),
    ).rejects.toThrow(/osrm is running/);
  });

  it("rejects a bundle whose contents no longer match its manifest", async () => {
    seedOsrmBuild(buildHost);
    const bundle = join(tmp, "osrm.tar");
    await exportBuildBundle({ serviceId: "osrm", bundle, rootDir: buildHost });

    const unpacked = join(tmp, "unpacked");
    mkdirSync(unpacked);
    execFileSync("tar", ["-xf", bundle, "-C", unpacked]);
    writeFileSync(join(unpacked, "osrm-graph", "region.osrm"), "TAMPERED");
    const tampered = join(tmp, "tampered.tar");
    execFileSync("tar", ["-cf", tampered, "-C", unpacked, BUNDLE_MANIFEST_DIR, "osrm-graph"]);

    await expect(
      importBuildBundle({ bundle: tampered, rootDir: serveHost, runningServices: noneRunning }),
    ).rejects.toThrow(/failed verification: osrm-graph\/region.osrm/);
  });

  it("rejects extra entries the manifest does not list", async () => {
    seedOsrmBuild(buildHost);
    const bundle = join(tmp, "osrm.tar");
    await exportBuildBundle({ serviceId: "osrm", bundle, rootDir: buildHost });

    const unpacked = join(tmp, "unpacked");
    mkdirSync(unpacked);
    execFileSync("tar", ["-xf", bundle, "-C", unpacked]);
    writeFileSync(join(unpacked, "osrm-graph", "extra"), "X");
    const padded = join(tmp, "padded.tar");
    execFileSync("tar", ["-cf", padded, "-C", unpacked, BUNDLE_MANIFEST_DIR, "osrm-graph"]);

    await expect(
      importBuildBundle({ bundle: padded, rootDir: serveHost, runningServices: noneRunning }),
    ).rejects.toThrow(/does not list: osrm-graph\/extra/);
  });

  it("rejects a bundle whose artifact root is a symlink", async () => {
    const outside = join(tmp, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "region.osrm"), "X");
    const crafted = join(tmp, "crafted");
    mkdirSync(join(crafted, BUNDLE_MANIFEST_DIR), { recursive: true });
    writeFileSync(
      join(crafted, BUNDLE_MANIFEST_PATH),
      JSON.stringify({
        ...osrmRecord(),
        dirs: ["osrm-graph"],
        directories: ["osrm-graph"],
        files: [
          {
            path: "osrm-graph/region.osrm",
            sizeBytes: 1,
            sha256: "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881",
          },
        ],
      }),
    );
    symlinkSync(outside, join(crafted, "osrm-graph"));
    const bundle = join(tmp, "crafted.tar");
    execFileSync("tar", ["-cf", bundle, "-C", crafted, BUNDLE_MANIFEST_DIR, "osrm-graph"]);

    await expect(
      importBuildBundle({ bundle, rootDir: serveHost, runningServices: noneRunning }),
    ).rejects.toThrow(/Refusing symlink in build artifact: osrm-graph/);
    expect(existsSync(join(dataDir(serveHost), "osrm-graph"))).toBe(false);
  });

  it("resolves a relative bundle path against the invoking directory", async () => {
    seedOsrmBuild(buildHost);
    const previous = process.env.INIT_CWD;
    process.env.INIT_CWD = tmp;
    try {
      await exportBuildBundle({ serviceId: "osrm", bundle: "relative.tar", rootDir: buildHost });
      expect(existsSync(join(tmp, "relative.tar"))).toBe(true);
      await importBuildBundle({
        bundle: "relative.tar",
        rootDir: serveHost,
        runningServices: noneRunning,
      });
      expect(existsSync(join(dataDir(serveHost), "osrm-graph", "region.osrm"))).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.INIT_CWD;
      else process.env.INIT_CWD = previous;
    }
  });

  it("refuses to export MOTIS import output that no --import build vouches for", async () => {
    const data = dataDir(buildHost);
    mkdirSync(join(data, "motis", "live", "data"), { recursive: true });
    mkdirSync(join(data, "motis-feed-proxy"), { recursive: true });
    writeBuildRecord({ ...osrmRecord(), service: "motis", runtimeImages: {} }, buildHost);

    await expect(
      exportBuildBundle({ serviceId: "motis", bundle: join(tmp, "m.tar"), rootDir: buildHost }),
    ).rejects.toThrow(/without --import/);
  });

  it("requires a build record before exporting", async () => {
    mkdirSync(join(dataDir(buildHost), "osrm-graph"), { recursive: true });
    await expect(
      exportBuildBundle({ serviceId: "osrm", bundle: join(tmp, "x.tar"), rootDir: buildHost }),
    ).rejects.toThrow(/No build record for "osrm"/);
  });

  it("refuses symlinks inside an artifact", async () => {
    seedOsrmBuild(buildHost);
    symlinkSync("/etc/passwd", join(dataDir(buildHost), "osrm-graph", "link"));
    await expect(
      exportBuildBundle({ serviceId: "osrm", bundle: join(tmp, "x.tar"), rootDir: buildHost }),
    ).rejects.toThrow(/Refusing symlink in build artifact: osrm-graph\/link/);
  });

  it("exports an aliased MOTIS live dir as the directory it points at", async () => {
    const data = dataDir(buildHost);
    mkdirSync(join(data, "motis", "slots", "A", "data"), { recursive: true });
    writeFileSync(join(data, "motis", "slots", "A", "config.yml"), "osm: x.osm.pbf\n");
    writeFileSync(join(data, "motis", "slots", "A", "data", "tt.bin"), "TT");
    symlinkSync(join(data, "motis", "slots", "A"), join(data, "motis", "live"));
    mkdirSync(join(data, "motis-feed-proxy", "conf"), { recursive: true });
    writeFileSync(join(data, "motis-feed-proxy", "conf", "default.conf"), "server {}\n");
    writeBuildRecord(motisRecord(), buildHost);

    const bundle = join(tmp, "motis.tar");
    await exportBuildBundle({ serviceId: "motis", bundle, rootDir: buildHost });
    await importBuildBundle({ bundle, rootDir: serveHost, runningServices: noneRunning });

    const live = join(dataDir(serveHost), "motis", "live");
    expect(readFileSync(join(live, "data", "tt.bin"), "utf-8")).toBe("TT");
    expect(readFileSync(join(live, "config.yml"), "utf-8")).toBe("osm: x.osm.pbf\n");
    expect(existsSync(join(dataDir(serveHost), "motis-feed-proxy", "conf", "default.conf"))).toBe(
      true,
    );
  });

  it("imports MOTIS into the active slot when the serving host uses the slot layout", async () => {
    const source = dataDir(buildHost);
    mkdirSync(join(source, "motis", "live", "data"), { recursive: true });
    writeFileSync(join(source, "motis", "live", "data", "tt.bin"), "NEW");
    mkdirSync(join(source, "motis-feed-proxy"), { recursive: true });
    writeBuildRecord(motisRecord(), buildHost);
    const bundle = join(tmp, "motis.tar");
    await exportBuildBundle({ serviceId: "motis", bundle, rootDir: buildHost });

    const target = dataDir(serveHost);
    const slotA = join(target, "motis", "slots", "A");
    mkdirSync(join(slotA, "data"), { recursive: true });
    writeFileSync(join(slotA, "data", "tt.bin"), "OLD");
    symlinkSync(slotA, join(target, "motis", "live"));

    await importBuildBundle({ bundle, rootDir: serveHost, runningServices: noneRunning });

    expect(lstatSync(join(target, "motis", "live")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(slotA, "data", "tt.bin"), "utf-8")).toBe("NEW");
  });
});
