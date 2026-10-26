import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  linkSync,
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
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { agentStatePaths } from "../agent-state";
import {
  type ConfigurationInput,
  commitConfigurationGeneration,
} from "../configuration-generation";
import { CURRENT_CONFIGURATION } from "../deployment";
import { findServiceManifestDirs } from "../manifest-discovery";
import {
  parseServiceFileHistory,
  type ReleaseServiceFiles,
  readCheckoutServiceFiles,
} from "../release-service-files";
import { serviceFilesImported } from "../service-file-import";
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
    // Nothing a working checkout adds: dependencies, earlier routes, an operator's auth.yml.
    filter: (source) =>
      !source.split(/[/\\]/).includes("node_modules") &&
      !["generated-routes.yml", "auth.yml"].includes(basename(source)),
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
  // The release: these same files, before any edit, built at the checkout's
  // commit or later, so it knows every version the checkout's history lists.
  const shipped = readCheckoutServiceFiles(services, process.geteuid?.() ?? 0);
  const listed = parseServiceFileHistory(
    readFileSync(join(root, "services", "service-file-history.json"), "utf8"),
  );
  const release = (
    changes: Record<string, string> = {},
    history: Record<string, string[]> = {},
  ): ReleaseServiceFiles => {
    const files = new Map(shipped.files);
    for (const [key, text] of Object.entries(changes)) {
      const file = files.get(key);
      if (!file) throw new Error(`no ${key}`);
      files.set(key, { ...file, bytes: Buffer.from(text), sha256: sha256(text) });
    }
    return {
      origin: "release",
      files,
      history: new Map(
        [...files].map(([key, file]) => [
          key,
          new Set([file.sha256, ...(listed.get(key) ?? []), ...(history[key] ?? [])]),
        ]),
      ),
      manifests: new Map(),
      missing: [],
    };
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
  const block = compose.slice(compose.indexOf(`\n  ${service}:\n`));
  const line = block.split("\n").find((entry) => entry.includes(`:${target}`));
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
      legacyTraefikDynamicMounted: false,
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
    expect(committed.serviceFileReport).toEqual([
      "Service file overrides in use, in place of the release's files (infra/docker/overrides/services): martin/config/martin.yaml, traefik/config/dynamic/auth.yml (no release file; Traefik's dynamic directory), traefik/config/traefik.yml, valhalla/config/valhalla.json.",
    ]);
    expect(JSON.stringify(committed)).not.toContain("secret-hash");
    // Removing an override brings the release's file back.
    rmSync(join(f.infraDir, "overrides", "services", "traefik", "config", "dynamic", "auth.yml"));
    await commitConfigurationGeneration({
      infraDir: f.infraDir,
      services: f.services,
      input: input(SELECTED),
      releaseServiceFiles: f.release(),
      legacyTraefikDynamicMounted: false,
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
        legacyTraefikDynamicMounted: false,
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
      legacyTraefikDynamicMounted: false,
    });
    expect(committed.serviceFileReport).toEqual([
      "infra/docker/overrides/services/martin/config/extra.yaml is ignored: the release has no services/martin/config/extra.yaml for it to replace.",
      'infra/docker/overrides/services/no-such-service is ignored: there is no built-in service "no-such-service" with files to replace.',
      "infra/docker/overrides/services/traefik/config/dynamic/generated-routes.yml is ignored: render writes Traefik's routes itself.",
      "infra/docker/overrides/services/well-known/config/html/security.txt is ignored: the release has no services/well-known/config/html/security.txt for it to replace.",
    ]);
    const html = mounted(f.infraDir, "well-known", "/usr/share/nginx/html/.well-known");
    expect(readdirSync(html).sort()).toEqual(["apple-app-site-association", "assetlinks.json"]);
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
        legacyTraefikDynamicMounted: false,
      });
    const flag = expect.stringContaining(
      "The release's services/martin/config/martin.yaml changed since infra/docker/overrides/services/martin/config/martin.yaml was made",
    );
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

describe("the one-time import of checkout edits", () => {
  const commit = (f: ReturnType<typeof checkout>, release: ReleaseServiceFiles) =>
    commitConfigurationGeneration({
      infraDir: f.infraDir,
      services: f.services,
      input: input(SELECTED),
      releaseServiceFiles: release,
      legacyTraefikDynamicMounted: false,
    });

  it("makes overrides of edits, Traefik's auth.yml and basic-auth reference included, once", async () => {
    const f = checkout();
    const traefik = join(f.root, "services", "traefik", "config");
    const gated = readFileSync(join(traefik, "traefik.yml"), "utf8").replace(
      "middlewares:",
      "middlewares:\n          - basic-auth@file",
    );
    writeFileSync(join(traefik, "traefik.yml"), gated);
    writeFileSync(join(traefik, "dynamic", "auth.yml"), AUTH);
    writeFileSync(join(traefik, "dynamic", "generated-routes.yml"), "stale: routes\n");
    writeFileSync(join(f.root, "services", "martin", "config", "martin.yaml"), "edited: true\n");
    chmodSync(join(f.root, "services", "martin", "config", "martin.yaml"), 0o600);
    // valhalla-scripted's own rewrite: a file a container writes.
    writeFileSync(
      join(f.root, "services", "valhalla", "config", "valhalla.json"),
      '{"concurrency": "12"}\n',
    );

    const committed = await commit(f, f.release());
    const overrides = join(f.infraDir, "overrides", "services");
    expect(committed.serviceFileReport[0]).toBe(
      "Imported 3 checkout service files that differ from every version a release shipped as overrides, used from now on in place of the release's: infra/docker/overrides/services/martin/config/martin.yaml, infra/docker/overrides/services/traefik/config/dynamic/auth.yml, infra/docker/overrides/services/traefik/config/traefik.yml. Edit them there; the checkout's copies are no longer read.",
    );
    expect(readFileSync(join(overrides, "traefik", "config", "traefik.yml"), "utf8")).toBe(gated);
    expect(readFileSync(join(overrides, "traefik", "config", "dynamic", "auth.yml"), "utf8")).toBe(
      AUTH,
    );
    expect(
      existsSync(join(overrides, "traefik", "config", "dynamic", "generated-routes.yml")),
    ).toBe(false);
    expect(existsSync(join(overrides, "valhalla"))).toBe(false);
    // Never more open than the checkout's file; Traefik's owner-only.
    const mode = (path: string) => statSync(path).mode & 0o777;
    expect(mode(join(overrides, "martin", "config", "martin.yaml"))).toBe(0o600);
    expect(mode(join(overrides, "traefik", "config", "dynamic", "auth.yml"))).toBe(0o600);
    expect(mode(join(overrides, "traefik", "config", "traefik.yml"))).toBe(0o600);
    // The basic-auth gate survives the switch to the release's files.
    expect(
      readFileSync(join(f.infraDir, CURRENT_CONFIGURATION, TRAEFIK_STATIC_GENERATION_FILE), "utf8"),
    ).toContain("basic-auth@file");
    expect(readFileSync(join(agentStatePaths(f.infraDir).traefikDynamic, "auth.yml"), "utf8")).toBe(
      AUTH,
    );
    // The checkout is untouched, for a rollback to the release before.
    expect(readFileSync(join(traefik, "traefik.yml"), "utf8")).toBe(gated);
    expect(JSON.stringify(committed)).not.toContain("secret-hash");

    // Once: a later checkout edit is reported, not imported.
    writeFileSync(
      join(f.root, "services", "postgis", "scripts", "sync-password.sh"),
      "#!/bin/sh\n",
    );
    const later = await commit(f, f.release());
    expect(existsSync(join(overrides, "postgis"))).toBe(false);
    expect(later.serviceFileReport).toContainEqual(
      "services/postgis/scripts/sync-password.sh differs from every version a release shipped, and render does not use it: services read the release's files, or your overrides. To keep this change, put the whole file in infra/docker/overrides/services/postgis/scripts/sync-password.sh.",
    );
    expect(later.serviceFileReport.join("\n")).not.toContain("Imported");
  });

  it("imports nothing from a checkout an earlier release left, with only Valhalla's own rewrite (openmapx.com)", async () => {
    const f = checkout();
    // openmapx.com's checkout predates the service file history, which says
    // it is behind the release.
    rmSync(join(f.root, "services", "service-file-history.json"));
    // The checkout is one release behind: martin.yaml and pelias.json hold
    // that release's bytes, which the release's history knows.
    const martin = readFileSync(
      join(f.root, "services", "martin", "config", "martin.yaml"),
      "utf8",
    );
    const pelias = readFileSync(
      join(f.root, "services", "pelias", "config", "pelias.json"),
      "utf8",
    );
    const release = f.release(
      {
        "martin/config/martin.yaml": `${martin}# newer\n`,
        "pelias/config/pelias.json": `${pelias.trim()}\n\n`,
      },
      {
        "martin/config/martin.yaml": [sha256(martin)],
        "pelias/config/pelias.json": [sha256(pelias)],
      },
    );
    writeFileSync(
      join(f.root, "services", "valhalla", "config", "valhalla.json"),
      '{"mjolnir": {"concurrency": "12"}}\n',
    );
    const committed = await commit(f, release);
    expect(existsSync(join(f.infraDir, "overrides"))).toBe(false);
    expect(committed.serviceFileReport).toEqual([]);
    expect(serviceFilesImported(f.infraDir)).toBe(true);
    expect(readFileSync(mounted(f.infraDir, "martin", "/etc/martin/martin.yaml"), "utf8")).toBe(
      `${martin}# newer\n`,
    );
  });

  /**
   * A checkout one commit ahead of the release: upstream changed martin.yaml,
   * and its regenerated history lists the new bytes.
   */
  function ahead(f: ReturnType<typeof checkout>) {
    const newer = "listen_addresses: 0.0.0.0:3000\nworker_processes: 8\n";
    const martin = join(f.root, "services", "martin", "config", "martin.yaml");
    const shipped = readFileSync(martin, "utf8");
    writeFileSync(martin, newer);
    const historyPath = join(f.root, "services", "service-file-history.json");
    const history = JSON.parse(readFileSync(historyPath, "utf8")) as {
      files: Record<string, string[]>;
    };
    history.files["martin/config/martin.yaml"]?.push(sha256(newer));
    writeFileSync(historyPath, JSON.stringify(history));
    return { newer, shipped, historyPath, history };
  }

  it("waits, importing and recording nothing, while the checkout is ahead of the release", async () => {
    const f = checkout();
    const { newer, shipped, historyPath, history } = ahead(f);
    // The operator changed OTP's build configuration.
    const otp = join(f.root, "services", "otp", "config", "build-config.json");
    writeFileSync(otp, '{"osm": []}\n');

    const waiting = await commit(f, f.release());
    expect(existsSync(join(f.infraDir, "overrides"))).toBe(false);
    expect(serviceFilesImported(f.infraDir)).toBe(false);
    expect(waiting.serviceFileReport[0]).toBe(
      "The one-time import of your edits in the checkout's service files waits: the checkout's services/service-file-history.json lists versions of services/martin/config/martin.yaml that the release doesn't, so the checkout may be ahead of it. A checkout file ahead of the release could be a newer upstream version rather than your edit, so nothing is imported or recorded until the checkout is at or behind the release's source revision; render tries again each time. Meanwhile render uses the release's files, not these checkout files, which match no version it shipped: services/martin/config/martin.yaml, services/otp/config/build-config.json. To keep an edit among them now, put the whole file in infra/docker/overrides/services/<id>/<path>.",
    );
    expect(readFileSync(mounted(f.infraDir, "martin", "/etc/martin/martin.yaml"), "utf8")).toBe(
      shipped,
    );
    // Again on the next render, still without a record.
    expect((await commit(f, f.release())).serviceFileReport[0]).toContain("waits");
    expect(serviceFilesImported(f.infraDir)).toBe(false);

    // A history it can't read says nothing about where the checkout stands.
    writeFileSync(historyPath, "{}");
    expect((await commit(f, f.release())).serviceFileReport[0]).toContain(
      "waits: the checkout's services/service-file-history.json, which says whether it is ahead of the release, is not a service file history.",
    );
    writeFileSync(historyPath, JSON.stringify(history));

    // The release of that commit: upstream's martin.yaml is its own, and only
    // the operator's file is imported.
    const caughtUp = await commit(f, f.release({ "martin/config/martin.yaml": newer }));
    expect(caughtUp.serviceFileReport[0]).toBe(
      "Imported 1 checkout service file that differs from every version a release shipped as overrides, used from now on in place of the release's: infra/docker/overrides/services/otp/config/build-config.json. Edit them there; the checkout's copies are no longer read.",
    );
    expect(existsSync(join(f.infraDir, "overrides", "services", "martin"))).toBe(false);
    expect(serviceFilesImported(f.infraDir)).toBe(true);
  });

  it("refuses, while the import waits, a basic-auth gate it would carry over, until it is in overrides", async () => {
    const f = checkout();
    ahead(f);
    const traefik = join(f.root, "services", "traefik", "config");
    const gated = readFileSync(join(traefik, "traefik.yml"), "utf8").replace(
      "middlewares:",
      "middlewares:\n          - basic-auth@file",
    );
    writeFileSync(join(traefik, "traefik.yml"), gated);
    writeFileSync(join(traefik, "dynamic", "auth.yml"), AUTH);

    const refused = await commit(f, f.release()).catch((error: Error) => error.message);
    expect(refused).toBe(
      "Render refuses while the one-time import of your service file edits waits (the checkout's services/service-file-history.json lists versions of services/martin/config/martin.yaml that the release doesn't, so the checkout may be ahead of it): the checkout holds Traefik files the import would carry over, and the release's files in their place could drop a basic-auth gate: services/traefik/config/dynamic/auth.yml, services/traefik/config/traefik.yml. Put each, as a whole file at the same path, in infra/docker/overrides/services/traefik/, created under umask 022 (an auth.yml holding password hashes with mode 0600), or delete it if you don't need it. An override ends the wait for that file, and render goes on.",
    );
    expect(refused).not.toContain("secret-hash");
    expect(existsSync(join(f.infraDir, "overrides"))).toBe(false);
    expect(serviceFilesImported(f.infraDir)).toBe(false);
    expect(existsSync(join(f.infraDir, CURRENT_CONFIGURATION))).toBe(false);

    // The same files, placed in overrides: render goes on and serves the gate.
    f.override("traefik/config/dynamic/auth.yml", AUTH, 0o600);
    f.override("traefik/config/traefik.yml", gated);
    const committed = await commit(f, f.release());
    expect(
      readFileSync(join(f.infraDir, CURRENT_CONFIGURATION, TRAEFIK_STATIC_GENERATION_FILE), "utf8"),
    ).toContain("basic-auth@file");
    expect(readFileSync(join(agentStatePaths(f.infraDir).traefikDynamic, "auth.yml"), "utf8")).toBe(
      AUTH,
    );
    // The rest still waits, reported: upstream's martin.yaml keeps the release's bytes.
    expect(committed.serviceFileReport[0]).toContain(
      "Meanwhile render uses the release's files, not these checkout files, which match no version it shipped: services/martin/config/martin.yaml.",
    );
    expect(serviceFilesImported(f.infraDir)).toBe(false);
  });

  it("runs only for the release's files, and fails rather than lose an edit it may not read", async () => {
    const f = checkout();
    const martin = join(f.root, "services", "martin", "config", "martin.yaml");
    // Running from the checkout, under OPENMAPX_RELEASE=local: its edits are
    // the files, and nothing is imported.
    writeFileSync(martin, "edited: true\n");
    await commit(f, readCheckoutServiceFiles(f.services, process.geteuid?.() ?? 0));
    expect(serviceFilesImported(f.infraDir)).toBe(false);
    expect(existsSync(join(f.infraDir, "overrides"))).toBe(false);

    writeFileSync(join(f.root, "elsewhere.yaml"), "edited: true\n");
    rmSync(martin);
    symlinkSync(join(f.root, "elsewhere.yaml"), martin);
    await expect(commit(f, f.release())).rejects.toThrow(
      "services/martin/config/martin.yaml can't be read for the one-time import of your service file edits: it is a symbolic link.",
    );
    expect(serviceFilesImported(f.infraDir)).toBe(false);
  });
});
