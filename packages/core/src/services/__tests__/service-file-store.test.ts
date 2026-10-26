import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
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
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  appliedServiceFile,
  type ConfigurationInput,
  commitConfigurationGeneration,
  currentConfigurationGeneration,
} from "../configuration-generation";
import { CONFIGURATION_GENERATIONS, CURRENT_CONFIGURATION } from "../deployment";
import { embeddedBuiltInServiceManifests } from "../embedded-built-in-services.bundle";
import { embeddedBuiltInServiceFiles } from "../embedded-service-files.bundle";
import { findServiceManifestDirs } from "../manifest-discovery";
import { readBuiltInServices } from "../release-authority-inventory";
import {
  type ReleaseServiceFiles,
  readCheckoutServiceFiles,
  serviceFileReferences,
} from "../release-service-files";
import { readGenerationServiceFiles, serviceFileStore } from "../service-file-store";
import type { LoadedService, ServiceManifest } from "../types";
import { safeGenerationTree as previousGenerationCheck } from "./fixtures/previous-generation-check";

const REPOSITORY = fileURLToPath(new URL("../../../../../", import.meta.url));
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** The repository's built-in services, as the release ships them. */
function releaseServices(): LoadedService[] {
  return findServiceManifestDirs(join(REPOSITORY, "services")).map((directory) => ({
    manifest: JSON.parse(readFileSync(join(directory, "service.json"), "utf8")) as ServiceManifest,
    directory,
    isBuiltIn: true,
    enabled: false,
  }));
}

function stack() {
  const root = mkdtempSync(join(tmpdir(), "openmapx-service-files-"));
  roots.push(root);
  const infraDir = join(root, "infra", "docker");
  mkdirSync(infraDir, { recursive: true });
  return { root, infraDir };
}

const SELECTED = ["postgis", "martin", "well-known", "pelias-pip", "valhalla"];

function input(selectedRoots: string[] = SELECTED): ConfigurationInput {
  return {
    domain: "maps.example.test",
    selectedRoots,
    serviceConfigs: [],
    integrationConfigs: [],
    serviceSecrets: [],
  };
}

/** The repository's files as a release of them, with `changes` in place of some. */
function release(
  services: readonly LoadedService[],
  changes: Record<string, string> = {},
): ReleaseServiceFiles {
  const checkout = readCheckoutServiceFiles(services, process.geteuid?.() ?? 0);
  const files = new Map(checkout.files);
  for (const [key, text] of Object.entries(changes)) {
    const file = files.get(key);
    if (!file) throw new Error(`no ${key}`);
    const bytes = Buffer.from(text);
    files.set(key, { ...file, bytes, sha256: sha256(bytes) });
  }
  return { ...checkout, origin: "release", files, missing: [] };
}

function composeOf(infraDir: string): string {
  return readFileSync(
    join(infraDir, CURRENT_CONFIGURATION, "docker-compose.generated.yml"),
    "utf8",
  );
}

/** The host path of the volume line mounting `target` in `service`. */
function mountOf(infraDir: string, service: string, target: string): string {
  const compose = composeOf(infraDir);
  const block = compose.slice(compose.indexOf(`\n  ${service}:\n`));
  const line = block.split("\n").find((entry) => entry.includes(`:${target}`));
  if (!line) throw new Error(`${service} does not mount ${target}`);
  const source = line.trim().replace(/^- /, "").split(":")[0] as string;
  return join(infraDir, CURRENT_CONFIGURATION, source);
}

const mode = (path: string) => lstatSync(path).mode & 0o777;

describe("the release's service files in the store", () => {
  it("mounts them from content-addressed trees beside the generations, readable by any container user", async () => {
    const { infraDir } = stack();
    const services = releaseServices();
    await commitConfigurationGeneration({
      infraDir,
      services,
      input: input(),
      releaseServiceFiles: release(services),
      legacyTraefikDynamicMounted: false,
    });

    const script = mountOf(infraDir, "postgis", "/usr/local/bin/openmapx-postgis-entrypoint.sh");
    expect(relative(serviceFileStore(infraDir), script)).toMatch(
      /^postgis\/[a-f0-9]{64}\/scripts\/sync-password\.sh$/,
    );
    expect(readFileSync(script)).toEqual(
      readFileSync(join(REPOSITORY, "services/postgis/scripts/sync-password.sh")),
    );
    // PostGIS runs it as 999, nginx's workers read as another user again.
    expect(mode(script)).toBe(0o555);
    const html = mountOf(infraDir, "well-known", "/usr/share/nginx/html/.well-known");
    expect(mode(html)).toBe(0o755);
    expect(mode(join(html, "assetlinks.json"))).toBe(0o444);
    // pelias-pip reads pelias's own file, through @service:.
    expect(
      relative(serviceFileStore(infraDir), mountOf(infraDir, "pelias-pip", "/code/pelias.json")),
    ).toMatch(/^pelias\/[a-f0-9]{64}\/config\/pelias\.json$/);
    // The store and the state above it stay the agent's own.
    expect(mode(serviceFileStore(infraDir))).toBe(0o700);
    expect(mode(join(infraDir, "state", "ops-agent"))).toBe(0o700);

    const generation = join(
      infraDir,
      CONFIGURATION_GENERATIONS,
      currentConfigurationGeneration(infraDir) as string,
    );
    expect(readGenerationServiceFiles(generation)?.get("postgis")).toMatch(/^[a-f0-9]{64}$/);
  });

  it("writes generations the previous release's unchanged check accepts", async () => {
    const { infraDir } = stack();
    const services = releaseServices();
    await commitConfigurationGeneration({
      infraDir,
      services,
      input: input([...SELECTED, "traefik"]),
      releaseServiceFiles: release(services),
      legacyTraefikDynamicMounted: false,
    });
    const generations = join(infraDir, CONFIGURATION_GENERATIONS);
    for (const name of readdirSync(generations)) {
      expect(() => previousGenerationCheck(join(generations, name))).not.toThrow();
    }
  });

  it("reuses an unchanged tree, and gives a changed file a new one, so only its service is recreated", async () => {
    const { infraDir } = stack();
    const services = releaseServices();
    const commit = (changes: Record<string, string> = {}) =>
      commitConfigurationGeneration({
        infraDir,
        services,
        input: input(),
        releaseServiceFiles: release(services, changes),
        legacyTraefikDynamicMounted: false,
      });
    await commit();
    const martin = mountOf(infraDir, "martin", "/etc/martin/martin.yaml");
    const postgis = mountOf(infraDir, "postgis", "/usr/local/bin/openmapx-postgis-entrypoint.sh");
    const inode = statSync(postgis).ino;

    await commit();
    expect(mountOf(infraDir, "martin", "/etc/martin/martin.yaml")).toBe(martin);
    expect(statSync(postgis).ino).toBe(inode);

    await commit({ "martin/config/martin.yaml": "listen_addresses: 0.0.0.0:3000\n" });
    const changed = mountOf(infraDir, "martin", "/etc/martin/martin.yaml");
    expect(changed).not.toBe(martin);
    expect(readFileSync(changed, "utf8")).toBe("listen_addresses: 0.0.0.0:3000\n");
    expect(mountOf(infraDir, "postgis", "/usr/local/bin/openmapx-postgis-entrypoint.sh")).toBe(
      postgis,
    );
    // The earlier tree stays while a retained generation records it.
    expect(existsSync(martin)).toBe(true);
  });

  it("removes a tree nothing records or mounts, and keeps one a container mounts or when Docker can't tell", async () => {
    const { infraDir } = stack();
    const services = releaseServices();
    const commit = (containerBindSources?: string[]) =>
      commitConfigurationGeneration({
        infraDir,
        services,
        input: input(),
        releaseServiceFiles: release(services),
        legacyTraefikDynamicMounted: false,
        containerBindSources,
      });
    await commit([]);
    // Trees a pruned generation recorded.
    const orphan = join(serviceFileStore(infraDir), "martin", "a".repeat(64));
    const mounted = join(serviceFileStore(infraDir), "postgis", "b".repeat(64));
    const temporary = join(
      serviceFileStore(infraDir),
      "martin",
      `.${"c".repeat(64)}.0123456789ab.tmp`,
    );
    for (const path of [orphan, mounted, temporary]) {
      mkdirSync(join(path, "config"), { recursive: true });
      writeFileSync(join(path, "config", "martin.yaml"), "old\n");
      chmodSync(join(path, "config", "martin.yaml"), 0o444);
    }

    await commit(undefined);
    expect([existsSync(orphan), existsSync(mounted), existsSync(temporary)]).toEqual([
      true,
      true,
      false,
    ]);
    await commit([join(mounted, "scripts", "sync-password.sh")]);
    expect([existsSync(orphan), existsSync(mounted)]).toEqual([false, true]);
    // What the generation mounts is never removed.
    expect(existsSync(mountOf(infraDir, "martin", "/etc/martin/martin.yaml"))).toBe(true);
  });

  it("refuses a tree that no longer holds what it was written with", async () => {
    const { infraDir } = stack();
    const services = releaseServices();
    const commit = () =>
      commitConfigurationGeneration({
        infraDir,
        services,
        input: input(),
        releaseServiceFiles: release(services),
        legacyTraefikDynamicMounted: false,
      });
    await commit();
    const file = mountOf(infraDir, "martin", "/etc/martin/martin.yaml");
    chmodSync(file, 0o644);
    writeFileSync(file, "changed: true\n");
    await expect(commit()).rejects.toThrow(/no longer holds the files it was written with/);
  });

  it("seeds Valhalla's writable copy, keeps its rewrite, and seeds it again when the release's file changes", async () => {
    const { infraDir } = stack();
    const services = releaseServices();
    const commit = (changes: Record<string, string> = {}) =>
      commitConfigurationGeneration({
        infraDir,
        services,
        input: input(),
        releaseServiceFiles: release(services, changes),
        legacyTraefikDynamicMounted: false,
      });
    await commit();
    const copy = join(infraDir, "data", "valhalla", "config", "valhalla.json");
    expect(mountOf(infraDir, "valhalla", "/custom_files/valhalla.json")).toBe(copy);
    expect(readFileSync(copy)).toEqual(
      readFileSync(join(REPOSITORY, "services/valhalla/config/valhalla.json")),
    );
    expect(mode(copy)).toBe(0o644);

    // Valhalla's own rewrite, as configure_valhalla.sh does on every start.
    writeFileSync(copy, '{"rewritten": true}\n');
    await commit();
    expect(readFileSync(copy, "utf8")).toBe('{"rewritten": true}\n');

    await commit({ "valhalla/config/valhalla.json": '{"mjolnir": {"concurrency": 4}}\n' });
    expect(readFileSync(copy, "utf8")).toBe('{"mjolnir": {"concurrency": 4}}\n');

    // A copy that exists but can't be seeded again is reported; Valhalla
    // keeps it.
    const config = join(infraDir, "data", "valhalla", "config");
    if (process.geteuid?.() !== 0) {
      chmodSync(config, 0o555);
      try {
        const kept = await commit({ "valhalla/config/valhalla.json": '{"kept": true}\n' });
        expect(kept.stackFileProblems).toEqual([
          expect.stringContaining("could not be written: EACCES. valhalla keeps its current copy."),
        ]);
        expect(readFileSync(copy, "utf8")).toBe('{"mjolnir": {"concurrency": 4}}\n');

        // One that isn't there and can't be seeded fails the render: Docker
        // would mount a root-owned directory in its place.
        chmodSync(config, 0o755);
        rmSync(copy);
        chmodSync(config, 0o555);
        await expect(commit()).rejects.toThrow(
          /data\/valhalla\/config\/valhalla\.json, the writable copy of services\/valhalla\/config\/valhalla\.json, could not be written: EACCES\. valhalla has no copy to start with/,
        );
        expect(currentConfigurationGeneration(infraDir)).toBe(kept.revisionId);
      } finally {
        chmodSync(config, 0o755);
      }
    }
    const before = currentConfigurationGeneration(infraDir);

    // A directory Docker made of a missing copy fails the render, and is not
    // followed.
    rmSync(copy, { force: true });
    mkdirSync(copy);
    await expect(commit({ "valhalla/config/valhalla.json": "{}\n" })).rejects.toThrow(
      "the writable copy of services/valhalla/config/valhalla.json, is not a regular file",
    );
    expect(currentConfigurationGeneration(infraDir)).toBe(before);

    // A container that writes the data directory plants a link for its
    // directory: render does not write through it, and there is no copy.
    const elsewhere = join(infraDir, "elsewhere");
    mkdirSync(elsewhere);
    rmSync(join(infraDir, "data", "valhalla"), { recursive: true });
    symlinkSync(elsewhere, join(infraDir, "data", "valhalla"));
    await expect(
      commit({ "valhalla/config/valhalla.json": '{"planted": false}\n' }),
    ).rejects.toThrow("data/valhalla is not a directory");
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(currentConfigurationGeneration(infraDir)).toBe(before);
  });

  it("gives builds the applied generation's copy, and tells them to render first", async () => {
    const { infraDir } = stack();
    const services = releaseServices();
    expect(() => appliedServiceFile(infraDir, "otp", "config/build-config.json")).toThrow(
      "Render the stack first",
    );
    await commitConfigurationGeneration({
      infraDir,
      services,
      input: input(),
      releaseServiceFiles: release(services, { "otp/config/build-config.json": '{"osm": []}\n' }),
      legacyTraefikDynamicMounted: false,
    });
    const path = appliedServiceFile(infraDir, "otp", "config/build-config.json");
    expect(relative(serviceFileStore(infraDir), path)).toMatch(/^otp\/[a-f0-9]{64}\//);
    expect(readFileSync(path, "utf8")).toBe('{"osm": []}\n');
  });
});

describe("the runtime bundle's service files", () => {
  const bundled = embeddedBuiltInServiceFiles();
  const files = bundled?.files ?? [];
  const history = JSON.parse(readFileSync(fileURLToPath(bundled?.history as URL), "utf8")) as {
    files: Record<string, string[]>;
  };
  const source = embeddedBuiltInServiceManifests();
  if (!source) throw new Error("The bundle variant names its manifests");

  it("embeds every file a built-in names, with its executable bit", () => {
    const manifests = source.ids.map(
      (id) => JSON.parse(readFileSync(source.manifestPath(id), "utf8")) as ServiceManifest,
    );
    const listed = new Set(files.map((file) => `${file.serviceId}/${file.path}`));
    for (const reference of serviceFileReferences(manifests)) {
      const key = `${reference.serviceId}/${reference.path}`;
      expect(
        listed.has(key) || [...listed].some((path) => path.startsWith(`${key}/`)),
        `${key} is embedded`,
      ).toBe(true);
    }
    for (const file of files) {
      const path = fileURLToPath(file.url);
      expect(relative(join(REPOSITORY, "services"), path)).toBe(`${file.serviceId}/${file.path}`);
      expect((statSync(path).mode & 0o111) !== 0, path).toBe(file.executable);
    }
  });

  it("knows every file's current bytes as a version the release shipped", () => {
    for (const file of files) {
      expect(history.files[`${file.serviceId}/${file.path}`]).toContain(
        sha256(readFileSync(fileURLToPath(file.url))),
      );
    }
  });

  it("covers each file's bytes, executable bit and path in the release authority digest", () => {
    const services = releaseServices();
    const base = release(services);
    const digest = (serviceFiles: ReleaseServiceFiles) =>
      readBuiltInServices(REPOSITORY, { source, serviceFiles }).digest;
    const key = "postgis/scripts/sync-password.sh";
    const file = base.files.get(key);
    if (!file) throw new Error(`no ${key}`);
    const variant = (change: Partial<typeof file>) => {
      const files = new Map(base.files);
      const changed = { ...file, ...change };
      files.delete(key);
      files.set(`${changed.serviceId}/${changed.path}`, changed);
      return { ...base, files };
    };
    const original = digest(base);
    expect(digest(base)).toBe(original);
    expect(digest(variant({ sha256: sha256(Buffer.from("x")) }))).not.toBe(original);
    expect(digest(variant({ executable: false }))).not.toBe(original);
    expect(digest(variant({ path: "scripts/renamed.sh" }))).not.toBe(original);
  });
});
