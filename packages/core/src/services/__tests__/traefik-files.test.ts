import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentStatePaths } from "../agent-state";
import {
  type ConfigurationInput,
  commitConfigurationGeneration,
} from "../configuration-generation";
import { CURRENT_CONFIGURATION } from "../deployment";
import { TRAEFIK_STATIC_GENERATION_FILE } from "../traefik-files";
import type { LoadedService } from "../types";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const STATIC = "entryPoints:\n  web:\n    address: :80\n";
const MIDDLEWARES = "http:\n  middlewares:\n    hsts:\n      headers:\n        stsSeconds: 1\n";
const AUTH =
  "http:\n  middlewares:\n    basic-auth:\n      basicAuth:\n        users: ['op:$2y$05$secret-hash']\n";

/** A checkout with Traefik's files as the release ships them. */
function checkout() {
  const root = mkdtempSync(join(tmpdir(), "openmapx-traefik-files-"));
  roots.push(root);
  const infraDir = join(root, "infra", "docker");
  mkdirSync(infraDir, { recursive: true });
  const traefik = join(root, "services", "traefik");
  const dynamic = join(traefik, "config", "dynamic");
  mkdirSync(dynamic, { recursive: true });
  writeFileSync(join(traefik, "config", "traefik.yml"), STATIC);
  writeFileSync(join(dynamic, "middlewares.yml"), MIDDLEWARES);
  writeFileSync(join(dynamic, "auth.yml.example"), "# copy to auth.yml\n");
  const services: LoadedService[] = [
    {
      manifest: {
        id: "traefik",
        name: "Traefik",
        version: "1.0.0",
        quality: "built-in",
        container: { image: "traefik", tag: "v3", expose: [80] },
      },
      directory: traefik,
      isBuiltIn: true,
      enabled: false,
    },
    {
      manifest: {
        id: "web",
        name: "Web",
        version: "1.0.0",
        quality: "built-in",
        container: { image: "example/web", tag: "1", expose: [3000] },
        exposure: { proxy: { enabled: true, pathPrefix: "/" } },
      },
      directory: join(root, "services", "web"),
      isBuiltIn: true,
      enabled: false,
    },
  ];
  const dynamicTarget = agentStatePaths(infraDir).traefikDynamic;
  return { root, infraDir, dynamic, services, dynamicTarget };
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

const mode = (path: string) => lstatSync(path).mode & 0o777;

describe("Traefik's files outside the checkout", () => {
  it("writes the dynamic files beside the generation and traefik.yml into it, owner-only", async () => {
    const f = checkout();
    writeFileSync(join(f.dynamic, "auth.yml"), AUTH);

    const committed = await commitConfigurationGeneration({
      infraDir: f.infraDir,
      services: f.services,
      input: input(["traefik", "web"]),
      legacyTraefikDynamicMounted: false,
    });

    expect(committed.stackFileProblems).toEqual([]);
    expect(readdirSync(f.dynamicTarget).sort()).toEqual([
      "auth.yml",
      "generated-routes.yml",
      "middlewares.yml",
    ]);
    expect(mode(f.dynamicTarget)).toBe(0o700);
    for (const name of readdirSync(f.dynamicTarget)) {
      expect(mode(join(f.dynamicTarget, name))).toBe(0o600);
    }
    expect(readFileSync(join(f.dynamicTarget, "auth.yml"), "utf8")).toBe(AUTH);
    expect(readFileSync(join(f.dynamicTarget, "generated-routes.yml"), "utf8")).toContain("web");
    const generated = join(f.infraDir, CURRENT_CONFIGURATION, TRAEFIK_STATIC_GENERATION_FILE);
    expect(readFileSync(generated, "utf8")).toBe(STATIC);
    expect(mode(generated)).toBe(0o400);
    // Nothing more is written into the checkout once no container mounts it.
    expect(existsSync(join(f.dynamic, "generated-routes.yml"))).toBe(false);
  });

  it("keeps writing the checkout's routes while a container mounts them, or when that is not known", async () => {
    const f = checkout();
    await commitConfigurationGeneration({
      infraDir: f.infraDir,
      services: f.services,
      input: input(["traefik", "web"]),
      legacyTraefikDynamicMounted: true,
    });
    const legacy = join(f.dynamic, "generated-routes.yml");
    expect(readFileSync(legacy, "utf8")).toBe(
      readFileSync(join(f.dynamicTarget, "generated-routes.yml"), "utf8"),
    );

    rmSync(legacy);
    await commitConfigurationGeneration({
      infraDir: f.infraDir,
      services: f.services,
      input: input(["traefik"]),
    });
    expect(existsSync(legacy)).toBe(true);

    // Left as it was, for a rollback, once none does.
    const before = readFileSync(legacy, "utf8");
    await commitConfigurationGeneration({
      infraDir: f.infraDir,
      services: f.services,
      input: input(["traefik", "web"]),
      legacyTraefikDynamicMounted: false,
    });
    expect(readFileSync(legacy, "utf8")).toBe(before);
  });

  it("never copies the checkout's stale routes, and drops a dynamic file removed there", async () => {
    const f = checkout();
    writeFileSync(join(f.dynamic, "generated-routes.yml"), "stale: routes\n");
    writeFileSync(join(f.dynamic, "auth.yml"), AUTH);
    const commit = () =>
      commitConfigurationGeneration({
        infraDir: f.infraDir,
        services: f.services,
        input: input(["traefik", "web"]),
        legacyTraefikDynamicMounted: false,
      });
    await commit();
    expect(readFileSync(join(f.dynamicTarget, "generated-routes.yml"), "utf8")).not.toContain(
      "stale",
    );
    expect(readFileSync(join(f.dynamic, "generated-routes.yml"), "utf8")).toBe("stale: routes\n");

    // An unchanged file is not replaced, so Traefik has nothing to reload.
    const inode = lstatSync(join(f.dynamicTarget, "middlewares.yml")).ino;
    rmSync(join(f.dynamic, "auth.yml"));
    await commit();
    expect(readdirSync(f.dynamicTarget).sort()).toEqual([
      "generated-routes.yml",
      "middlewares.yml",
    ]);
    expect(lstatSync(join(f.dynamicTarget, "middlewares.yml")).ino).toBe(inode);
  });

  it("skips a dynamic file it may not read and names it, never its contents", async () => {
    const f = checkout();
    writeFileSync(join(f.root, "elsewhere.yml"), AUTH);
    symlinkSync(join(f.root, "elsewhere.yml"), join(f.dynamic, "linked.yml"));
    writeFileSync(join(f.dynamic, "auth.yml"), AUTH);
    linkSync(join(f.dynamic, "auth.yml"), join(f.root, "second-name.yml"));
    mkdirSync(join(f.dynamic, "folder.yml"));

    const committed = await commitConfigurationGeneration({
      infraDir: f.infraDir,
      services: f.services,
      input: input(["traefik", "web"]),
      legacyTraefikDynamicMounted: false,
    });

    const kept = "Traefik keeps the copy of an earlier render, if there is one.";
    expect(committed.stackFileProblems).toEqual([
      `services/traefik/config/dynamic/auth.yml was not copied to Traefik's dynamic directory, infra/docker/state/ops-agent/traefik/dynamic: it has 2 links. ${kept}`,
      `services/traefik/config/dynamic/folder.yml was not copied to Traefik's dynamic directory, infra/docker/state/ops-agent/traefik/dynamic: it is not a regular file. ${kept}`,
      `services/traefik/config/dynamic/linked.yml was not copied to Traefik's dynamic directory, infra/docker/state/ops-agent/traefik/dynamic: it is a symbolic link. ${kept}`,
    ]);
    expect(committed.stackFileProblems.join("\n")).not.toContain("secret-hash");
    expect(readdirSync(f.dynamicTarget).sort()).toEqual([
      "generated-routes.yml",
      "middlewares.yml",
    ]);
  });

  it("keeps a copy whose source it may no longer read, and every copy when the directory is not its own", async () => {
    const f = checkout();
    writeFileSync(join(f.dynamic, "auth.yml"), AUTH);
    const commit = () =>
      commitConfigurationGeneration({
        infraDir: f.infraDir,
        services: f.services,
        input: input(["traefik", "web"]),
        legacyTraefikDynamicMounted: false,
      });
    await commit();

    // auth.yml is still there, but now a second name for the same file.
    linkSync(join(f.dynamic, "auth.yml"), join(f.root, "second-name.yml"));
    expect((await commit()).stackFileProblems).toEqual([
      expect.stringContaining("services/traefik/config/dynamic/auth.yml was not copied"),
    ]);
    expect(readFileSync(join(f.dynamicTarget, "auth.yml"), "utf8")).toBe(AUTH);

    // The directory itself replaced by a link: nothing in it is read or dropped.
    const elsewhere = join(f.root, "elsewhere");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "planted.yml"), "http: {}\n");
    rmSync(f.dynamic, { recursive: true });
    symlinkSync(elsewhere, f.dynamic);
    expect((await commit()).stackFileProblems).toEqual([
      expect.stringContaining(
        "services/traefik/config/dynamic was not copied to Traefik's dynamic directory, infra/docker/state/ops-agent/traefik/dynamic: it is a symbolic link.",
      ),
    ]);
    expect(readdirSync(f.dynamicTarget).sort()).toEqual([
      "auth.yml",
      "generated-routes.yml",
      "middlewares.yml",
    ]);

    // Missing altogether, the same.
    rmSync(f.dynamic);
    expect((await commit()).stackFileProblems).toEqual([
      expect.stringContaining("services/traefik/config/dynamic was not copied"),
    ]);
    expect(readdirSync(f.dynamicTarget)).toContain("middlewares.yml");
  });

  it("removes a temporary a stopped render left behind", async () => {
    const f = checkout();
    const commit = () =>
      commitConfigurationGeneration({
        infraDir: f.infraDir,
        services: f.services,
        input: input(["traefik", "web"]),
        legacyTraefikDynamicMounted: false,
      });
    await commit();
    writeFileSync(join(f.dynamicTarget, ".auth.yml.0123456789ab.tmp"), AUTH);
    await commit();
    expect(readdirSync(f.dynamicTarget).sort()).toEqual([
      "generated-routes.yml",
      "middlewares.yml",
    ]);
  });

  it("reports routes it could not write for an earlier Traefik and finishes the render", async () => {
    const f = checkout();
    chmodSync(f.dynamic, 0o500);
    try {
      const committed = await commitConfigurationGeneration({
        infraDir: f.infraDir,
        services: f.services,
        input: input(["traefik", "web"]),
        legacyTraefikDynamicMounted: true,
      });
      expect(committed.stackFileProblems).toEqual([
        expect.stringContaining(
          "The routes could not be written to services/traefik/config/dynamic, where a Traefik started by an earlier release still reads them: EACCES.",
        ),
      ]);
      expect(readdirSync(f.dynamic).sort()).toEqual(["auth.yml.example", "middlewares.yml"]);
      expect(existsSync(join(f.dynamicTarget, "generated-routes.yml"))).toBe(true);
    } finally {
      chmodSync(f.dynamic, 0o700);
    }

    // A checkout without the directory is mounted by no one; it isn't created.
    rmSync(f.dynamic, { recursive: true });
    const committed = await commitConfigurationGeneration({
      infraDir: f.infraDir,
      services: f.services,
      input: input(["traefik", "web"]),
    });
    expect(existsSync(f.dynamic)).toBe(false);
    expect(committed.stackFileProblems).toEqual([
      expect.stringContaining("services/traefik/config/dynamic was not copied"),
    ]);
  });

  it("refuses a traefik.yml it may not read, rather than mount a missing one", async () => {
    const f = checkout();
    const path = join(f.root, "services", "traefik", "config", "traefik.yml");
    rmSync(path);
    writeFileSync(join(f.root, "other.yml"), STATIC);
    symlinkSync(join(f.root, "other.yml"), path);

    await expect(
      commitConfigurationGeneration({
        infraDir: f.infraDir,
        services: f.services,
        input: input(["traefik"]),
        legacyTraefikDynamicMounted: false,
      }),
    ).rejects.toThrow("services/traefik/config/traefik.yml can't be used: it is a symbolic link");
  });
});
