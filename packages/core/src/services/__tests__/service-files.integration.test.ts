import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ConfigurationInput,
  commitConfigurationGeneration,
} from "../configuration-generation";
import { CURRENT_CONFIGURATION, GENERATED_COMPOSE_FILE } from "../deployment";
import { findServiceManifestDirs } from "../manifest-discovery";
import { type ReleaseServiceFiles, readCheckoutServiceFiles } from "../release-service-files";
import type { LoadedService, ServiceManifest } from "../types";

// Real containers reading the release's files as a generation mounts them
// from the store. CI pulls the pinned images first; PostGIS's is the database
// job's own service image.
const runTests = process.env.OPENMAPX_RUN_SERVICE_FILE_TESTS === "1";
const REPOSITORY = fileURLToPath(new URL("../../../../../", import.meta.url));

const services: LoadedService[] = findServiceManifestDirs(join(REPOSITORY, "services")).map(
  (directory) => ({
    manifest: JSON.parse(readFileSync(join(directory, "service.json"), "utf8")) as ServiceManifest,
    directory,
    isBuiltIn: true,
    enabled: false,
  }),
);
const pinned = (id: string) => {
  const { container } = services.find((service) => service.manifest.id === id)
    ?.manifest as ServiceManifest;
  return `${container.image}:${container.tag}@${container.digest}`;
};

let infraDir: string;
const containers: string[] = [];
const volumes: string[] = [];
const roots: string[] = [];

function docker(...args: string[]): string {
  return execFileSync("docker", args, {
    encoding: "utf-8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

function input(selectedRoots: string[]): ConfigurationInput {
  return {
    domain: "maps.example.test",
    selectedRoots,
    serviceConfigs: [],
    integrationConfigs: [],
    serviceSecrets: [],
  };
}

/** The repository's files as a release of them, with `changes` in place of some. */
function release(changes: Record<string, string> = {}): ReleaseServiceFiles {
  const checkout = readCheckoutServiceFiles(services, process.geteuid?.() ?? 0);
  const files = new Map(checkout.files);
  for (const [key, text] of Object.entries(changes)) {
    const file = files.get(key);
    if (!file) throw new Error(`no ${key}`);
    files.set(key, { ...file, bytes: Buffer.from(text), sha256: sha256(text) });
  }
  return { ...checkout, origin: "release", files, missing: [] };
}

async function render(selected: string[], changes: Record<string, string> = {}) {
  return commitConfigurationGeneration({
    infraDir,
    services,
    input: input(selected),
    releaseServiceFiles: release(changes),
    legacyTraefikDynamicMounted: false,
  });
}

/**
 * `docker run` volume flags for a service's rendered bind mounts, resolved as
 * Compose resolves them (against `current`, as named); a fresh named volume
 * for each of its named ones. Only the mounts of targets `keep` accepts.
 */
function renderedVolumes(service: string, keep = (_target: string) => true): string[] {
  const generation = join(infraDir, CURRENT_CONFIGURATION);
  const compose = load(readFileSync(join(generation, GENERATED_COMPOSE_FILE), "utf8")) as {
    services: Record<string, { volumes?: string[] }>;
  };
  return (compose.services[service]?.volumes ?? []).flatMap((entry) => {
    const [source = "", target = "", mode] = entry.split(":");
    if (!keep(target)) return [];
    if (source.startsWith(".") || isAbsolute(source)) {
      return ["--volume", `${resolve(generation, source)}:${target}${mode ? `:${mode}` : ""}`];
    }
    const volume = docker(
      "volume",
      "create",
      `openmapx-service-files-${randomBytes(4).toString("hex")}`,
    );
    volumes.push(volume);
    return ["--volume", `${volume}:${target}`];
  });
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

afterEach(() => {
  for (const id of containers.splice(0)) docker("rm", "--force", id);
  for (const volume of volumes.splice(0)) docker("volume", "rm", "--force", volume);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function stack() {
  const root = mkdtempSync(join(tmpdir(), "openmapx-service-files-"));
  roots.push(root);
  infraDir = join(root, "infra", "docker");
  mkdirSync(infraDir, { recursive: true });
}

describe.runIf(runTests)("containers reading the release's files from the store", () => {
  it("lets nginx's workers and PostGIS's user, neither root nor the deployment's, read them under the agent's 0700 state", async () => {
    stack();
    await render(["well-known", "postgis"]);
    expect(lstatSync(join(infraDir, "state", "ops-agent")).mode & 0o777).toBe(0o700);

    const nginx = docker(
      "run",
      "--detach",
      "--pull",
      "never",
      "--network",
      "none",
      ...renderedVolumes("well-known"),
      pinned("well-known"),
    );
    containers.push(nginx);
    const expected = readFileSync(
      join(REPOSITORY, "services/well-known/config/html/assetlinks.json"),
      "utf8",
    );
    let served = "";
    for (let attempt = 0; attempt < 50 && served !== expected; attempt += 1) {
      await sleep(200);
      try {
        served = docker(
          "exec",
          nginx,
          "wget",
          "-qO-",
          "http://127.0.0.1/.well-known/assetlinks.json",
        );
      } catch {
        served = "";
      }
    }
    expect(`${served}\n`.trim()).toBe(expected.trim());
    // nginx's workers, which read the files, run as its own user.
    const workers = docker("exec", nginx, "ps", "-o", "user,args");
    expect(workers).toMatch(/nginx\s+nginx: worker process/);

    // PostGIS's server runs as 999; its entrypoint wrapper comes from the store.
    const entrypoint = "/usr/local/bin/openmapx-postgis-entrypoint.sh";
    const read = docker(
      "run",
      "--rm",
      "--pull",
      "never",
      "--network",
      "none",
      "--user",
      "999:999",
      "--entrypoint",
      "sh",
      ...renderedVolumes("postgis", (target) => target === entrypoint),
      pinned("postgis"),
      "-c",
      `id -u; test -x ${entrypoint} && sha256sum ${entrypoint}`,
    );
    const [uid, digest] = read.split("\n");
    expect(uid).toBe("999");
    expect(digest?.split(" ")[0]).toBe(
      sha256(readFileSync(join(REPOSITORY, "services/postgis/scripts/sync-password.sh"))),
    );
  }, 120_000);

  it("lets Valhalla rewrite its writable copy, which render keeps until the release's file changes", async () => {
    stack();
    await render(["valhalla"]);
    const copy = join(infraDir, "data", "valhalla", "config", "valhalla.json");
    const seed = readFileSync(copy, "utf8");
    const inode = statSync(copy).ino;

    // Valhalla's own start: configure_valhalla.sh merges its defaults into
    // the file. Tiles in place and no serving, so it stops after that.
    const customFiles = docker(
      "volume",
      "create",
      `openmapx-valhalla-${randomBytes(4).toString("hex")}`,
    );
    volumes.push(customFiles);
    docker(
      "run",
      "--rm",
      "--pull",
      "never",
      "--network",
      "none",
      "--volume",
      `${customFiles}:/c`,
      "--entrypoint",
      "sh",
      pinned("valhalla"),
      "-c",
      "mkdir -p /c/valhalla_tiles && touch /c/valhalla_tiles/0",
    );
    const flags = renderedVolumes("valhalla", (target) => target === "/custom_files/valhalla.json");
    expect(flags).toEqual(["--volume", `${copy}:/custom_files/valhalla.json`]);
    try {
      docker(
        "run",
        "--rm",
        "--pull",
        "never",
        "--network",
        "none",
        ...[
          "serve_tiles=False",
          "build_tar=False",
          "use_tiles_ignore_pbf=True",
          "build_elevation=False",
          "build_admins=False",
          "build_time_zones=False",
          "server_threads=12",
        ].flatMap((env) => ["-e", env]),
        "--volume",
        `${customFiles}:/custom_files`,
        ...flags,
        pinned("valhalla"),
        "build_tiles",
      );
    } catch {
      // Its tile build fails on the empty tiles; the configuration is written before.
    }
    const rewritten = readFileSync(copy, "utf8");
    expect(rewritten).not.toBe(seed);
    expect(JSON.parse(rewritten).mjolnir.concurrency).toBe("12");
    // Merged into the release's file in place, not replaced.
    expect(JSON.parse(rewritten).httpd.service.drain_seconds).toBe(
      JSON.parse(seed).httpd.service.drain_seconds,
    );
    expect(statSync(copy).ino).toBe(inode);

    await render(["valhalla"]);
    expect(readFileSync(copy, "utf8")).toBe(rewritten);

    await render(["valhalla"], {
      "valhalla/config/valhalla.json": '{"mjolnir": {"concurrency": 2}}\n',
    });
    expect(readFileSync(copy, "utf8")).toBe('{"mjolnir": {"concurrency": 2}}\n');
  }, 300_000);
});
