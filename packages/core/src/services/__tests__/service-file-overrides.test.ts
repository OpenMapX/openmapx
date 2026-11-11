import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
import { afterEach, describe, expect, it } from "vitest";
import { agentStatePaths } from "../agent-state";
import {
  type ConfigurationInput,
  commitConfigurationGeneration,
} from "../configuration-generation";
import { CURRENT_CONFIGURATION } from "../deployment";
import { findServiceManifestDirs } from "../manifest-discovery";
import { type ReleaseServiceFiles, readCheckoutServiceFiles } from "../release-service-files";
import { TRAEFIK_STATIC_GENERATION_FILE } from "../traefik-files";
import type { LoadedService, ServiceManifest } from "../types";

const REPOSITORY = fileURLToPath(new URL("../../../../../", import.meta.url));
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const HASH = "'op:$2y$05$secret-hash'";
const AUTH = `http:\n  middlewares:\n    basic-auth:\n      basicAuth:\n        users: [${HASH}]\n`;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * A checkout: the repository's services copied into a temporary root, as
 * `git clone` would leave them. Its files are the release's own.
 */
function checkout() {
  const root = mkdtempSync(join(tmpdir(), "openmapx-overrides-"));
  roots.push(root);
  cpSync(join(REPOSITORY, "services"), join(root, "services"), {
    recursive: true,
    // Nothing a working checkout adds: dependencies, an operator's auth.yml.
    filter: (source) =>
      !source.split(/[/\\]/).includes("node_modules") && basename(source) !== "auth.yml",
  });
  const infraDir = join(root, "infra", "docker");
  mkdirSync(infraDir, { recursive: true });
  const services: LoadedService[] = findServiceManifestDirs(join(root, "services")).map(
    (directory) => ({
      manifest: JSON.parse(
        readFileSync(join(directory, "service.json"), "utf8"),
      ) as ServiceManifest,
      directory,
      isBuiltIn: true,
      enabled: false,
    }),
  );
  // The release: these same files, before any edit.
  const shipped = readCheckoutServiceFiles(services, process.geteuid?.() ?? 0);
  const release = (changes: Record<string, string> = {}): ReleaseServiceFiles => {
    const files = new Map(shipped.files);
    for (const [key, text] of Object.entries(changes)) {
      const file = files.get(key);
      if (!file) throw new Error(`no ${key}`);
      files.set(key, { ...file, bytes: Buffer.from(text), sha256: sha256(text) });
    }
    return { origin: "release", files, manifests: new Map(), missing: [] };
  };
  const override = (key: string, text: string, mode = 0o644) => {
    const path = join(infraDir, "overrides", "services", key);
    mkdirSync(join(path, ".."), { recursive: true, mode: 0o755 });
    writeFileSync(path, text, { mode });
    chmodSync(path, mode);
    return path;
  };
  return { root, infraDir, services, release, override };
}

function input(selectedRoots: string[]): ConfigurationInput {
  return {
    domain: "maps.example.test",
    selectedRoots,
    serviceConfigs: [],
    integrationConfigs: [],
    serviceSecrets: [],
  };
}

const SELECTED = ["traefik", "martin", "postgis", "valhalla"];

function mounted(infraDir: string, service: string, target: string): string {
  const compose = readFileSync(
    join(infraDir, CURRENT_CONFIGURATION, "docker-compose.generated.yml"),
    "utf8",
  );
  const model = load(compose) as { services: Record<string, { volumes?: string[] }> };
  const line = model.services[service]?.volumes?.find((entry) => entry.split(":")[1] === target);
  if (!line) throw new Error(`${service} does not mount ${target}`);
  return join(
    infraDir,
    CURRENT_CONFIGURATION,
    line.trim().replace(/^- /, "").split(":")[0] as string,
  );
}

describe("service file overrides", () => {
  it("use an override in place of the release's file, and name it, never its contents", async () => {
    const f = checkout();
    f.override("martin/config/martin.yaml", "listen_addresses: 0.0.0.0:3001\n");
    f.override("traefik/config/dynamic/auth.yml", AUTH, 0o600);
    f.override("traefik/config/traefik.yml", "entryPoints: {}\n");
    f.override("valhalla/config/valhalla.json", '{"mjolnir": {"concurrency": 3}}\n');
    const committed = await commitConfigurationGeneration({
      infraDir: f.infraDir,
      services: f.services,
      input: input(SELECTED),
      releaseServiceFiles: f.release(),
    });

    expect(readFileSync(mounted(f.infraDir, "martin", "/etc/martin/martin.yaml"), "utf8")).toBe(
      "listen_addresses: 0.0.0.0:3001\n",
    );
    const dynamic = agentStatePaths(f.infraDir).traefikDynamic;
    expect(readFileSync(join(dynamic, "auth.yml"), "utf8")).toBe(AUTH);
    expect(
      readFileSync(join(f.infraDir, CURRENT_CONFIGURATION, TRAEFIK_STATIC_GENERATION_FILE), "utf8"),
    ).toBe("entryPoints: {}\n");
    expect(
      readFileSync(join(f.infraDir, "data", "valhalla", "config", "valhalla.json"), "utf8"),
    ).toBe('{"mjolnir": {"concurrency": 3}}\n');
    // How things should be: information, not a warning.
    expect(committed.serviceFileReport).toEqual([
      {
        level: "info",
        message: expect.stringContaining("Service file overrides in use"),
      },
    ]);
    expect(JSON.stringify(committed)).not.toContain("secret-hash");
    // Removing an override brings the release's file back.
    rmSync(join(f.infraDir, "overrides", "services", "traefik", "config", "dynamic", "auth.yml"));
    await commitConfigurationGeneration({
      infraDir: f.infraDir,
      services: f.services,
      input: input(SELECTED),
      releaseServiceFiles: f.release(),
    });
    expect(existsSync(join(dynamic, "auth.yml"))).toBe(false);
  });

  it("fails the render for an override of a shipped file it may not use, and names it, never its contents", async () => {
    const f = checkout();
    const commit = () =>
      commitConfigurationGeneration({
        infraDir: f.infraDir,
        services: f.services,
        input: input(SELECTED),
        releaseServiceFiles: f.release(),
      });
    const auth = f.override("traefik/config/dynamic/middlewares.yml", AUTH, 0o600);

    chmodSync(auth, 0o620);
    const writable = await commit().catch((error: Error) => error);
    expect(String(writable)).toContain(
      "infra/docker/overrides/services/traefik/config/dynamic/middlewares.yml can't be used: group or others may write it",
    );
    expect(String(writable)).not.toContain("secret-hash");
    chmodSync(auth, 0o600);

    linkSync(auth, join(f.root, "second-name"));
    await expect(commit()).rejects.toThrow("middlewares.yml can't be used: it has 2 links");
    rmSync(join(f.root, "second-name"));

    rmSync(auth);
    writeFileSync(join(f.root, "elsewhere.yml"), AUTH);
    symlinkSync(join(f.root, "elsewhere.yml"), auth);
    await expect(commit()).rejects.toThrow("middlewares.yml can't be used: it is a symbolic link");
    rmSync(auth);

    // A link for a directory that holds shipped paths.
    const config = join(f.infraDir, "overrides", "services", "martin", "config");
    mkdirSync(join(f.root, "linked-config"));
    // 0755 whatever the umask: under 002 a plain mkdir is group-writable,
    // which render refuses before it reaches the link.
    mkdirSync(join(config, ".."), { recursive: true, mode: 0o755 });
    symlinkSync(join(f.root, "linked-config"), config);
    await expect(commit()).rejects.toThrow(
      "infra/docker/overrides/services/martin/config can't be used: it is a symbolic link",
    );
    rmSync(config);

    // A directory where the release ships a file, as `mkdir -p` of its path leaves.
    mkdirSync(join(config, "martin.yaml"), { recursive: true, mode: 0o755 });
    chmodSync(config, 0o755);
    writeFileSync(join(config, "martin.yaml", "martin.yaml"), "listen_addresses: 0.0.0.0:3001\n");
    await expect(commit()).rejects.toThrow(
      "infra/docker/overrides/services/martin/config/martin.yaml can't be used: it is a directory",
    );
    rmSync(join(f.infraDir, "overrides", "services", "martin"), { recursive: true });
    chmodSync(join(f.infraDir, "overrides", "services"), 0o775);
    await expect(commit()).rejects.toThrow(
      "infra/docker/overrides/services can't be used: group or others may write it",
    );
    chmodSync(join(f.infraDir, "overrides", "services"), 0o755);
    await expect(commit()).resolves.toBeDefined();
  });

  it("reports and ignores an override of a path the release doesn't ship", async () => {
    const f = checkout();
    f.override("martin/config/extra.yaml", "x: 1\n");
    f.override("traefik/config/dynamic/generated-routes.yml", "http: {}\n");
    f.override("no-such-service/config.json", "{}\n");
    f.override("well-known/config/html/security.txt", "Contact: mailto:ops@example.test\n");
    const committed = await commitConfigurationGeneration({
      infraDir: f.infraDir,
      services: f.services,
      input: input([...SELECTED, "well-known"]),
      releaseServiceFiles: f.release(),
    });
    expect(committed.serviceFileReport).toEqual(
      [
        "infra/docker/overrides/services/martin/config/extra.yaml is ignored: the release has no services/martin/config/extra.yaml for it to replace.",
        'infra/docker/overrides/services/no-such-service is ignored: there is no built-in service "no-such-service" with files to replace.',
        "infra/docker/overrides/services/traefik/config/dynamic/generated-routes.yml is ignored: render writes Traefik's routes itself.",
        "infra/docker/overrides/services/well-known/config/html/security.txt is ignored: the release has no services/well-known/config/html/security.txt for it to replace.",
      ].map((message) => ({ level: "warn", message })),
    );
    const script = mounted(f.infraDir, "well-known", "/opt/openmapx/well-known/app-links.sh");
    expect(readFileSync(script, "utf8")).toBe(
      readFileSync(join(REPOSITORY, "services/well-known/config/app-links.sh"), "utf8"),
    );
  });

  it("flags an override whose release file changed since, until the override is edited", async () => {
    const f = checkout();
    const path = f.override("martin/config/martin.yaml", "listen_addresses: 0.0.0.0:3001\n");
    const commit = (changes: Record<string, string> = {}) =>
      commitConfigurationGeneration({
        infraDir: f.infraDir,
        services: f.services,
        input: input(SELECTED),
        releaseServiceFiles: f.release(changes),
      });
    const flag = {
      level: "warn",
      message: expect.stringContaining(
        "The release's services/martin/config/martin.yaml changed since infra/docker/overrides/services/martin/config/martin.yaml was made",
      ),
    };
    expect((await commit()).serviceFileReport).not.toContainEqual(flag);
    const newer = {
      "martin/config/martin.yaml": "listen_addresses: 0.0.0.0:3000\nworker_processes: 4\n",
    };
    expect((await commit(newer)).serviceFileReport).toContainEqual(flag);
    expect((await commit(newer)).serviceFileReport).toContainEqual(flag);
    // Editing the override acknowledges the release's change.
    writeFileSync(path, "listen_addresses: 0.0.0.0:3001\nworker_processes: 4\n");
    expect((await commit(newer)).serviceFileReport).not.toContainEqual(flag);
  });
});
