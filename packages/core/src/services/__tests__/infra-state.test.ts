import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ConfigurationInput,
  commitConfigurationGeneration,
  configurationMigrationPending,
  currentConfigurationGeneration,
  migrateLegacyServiceSelection,
  readAppliedConfiguration,
  withConfigurationGenerationWriter,
} from "../configuration-generation";
import {
  acquireConfigurationOwnership,
  legacyConfigurationWriterActive,
  retireLegacyConfigurationWriter,
} from "../configuration-ownership";
import {
  CONFIGURATION_GENERATIONS,
  CURRENT_CONFIGURATION,
  deploymentEnvironmentFileProblem,
  LEGACY_CONFIGURATION_GENERATIONS,
  LEGACY_CURRENT_CONFIGURATION,
  readDesiredSelection,
  readServiceSelectionFile,
  serviceSelectionPath,
  stackComposeArgs,
} from "../deployment";
import type { LoadedService } from "../types";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function service(id: string): LoadedService {
  return {
    manifest: {
      id,
      name: id,
      version: "1.0.0",
      quality: "built-in",
      container: { image: `example/${id}`, tag: "1" },
      configSchema: { type: "object", properties: { PUBLIC_SETTING: { type: "string" } } },
    },
    directory: `/trusted/services/${id}`,
    isBuiltIn: true,
    enabled: false,
  };
}
const services = [service("alpha"), service("beta")];
const input = (overrides: Partial<ConfigurationInput> = {}): ConfigurationInput => ({
  domain: "maps.example.test",
  selectedRoots: ["alpha"],
  serviceConfigs: [],
  integrationConfigs: [],
  serviceSecrets: [],
  ...overrides,
});

/** A checkout under umask 002: `infra/docker` writable by its group. */
function checkout() {
  const root = mkdtempSync(join(tmpdir(), "openmapx-infra-state-"));
  roots.push(root);
  const infraDir = join(root, "infra", "docker");
  mkdirSync(infraDir, { recursive: true });
  chmodSync(infraDir, 0o775);
  return { root, infraDir };
}

/**
 * What an earlier release left: its applied generation in `infra/docker`
 * itself, with `beta` selected and a saved setting. Built from a real commit
 * whose generations are then moved where that release kept them.
 */
async function legacyDeployment(infraDir: string) {
  const { revisionId } = await commitConfigurationGeneration({
    infraDir,
    services,
    input: input({
      selectedRoots: ["beta"],
      serviceConfigs: [{ serviceId: "beta", values: { PUBLIC_SETTING: "saved" } }],
    }),
  });
  renameSync(
    join(infraDir, CONFIGURATION_GENERATIONS),
    join(infraDir, LEGACY_CONFIGURATION_GENERATIONS),
  );
  rmSync(join(infraDir, CURRENT_CONFIGURATION));
  symlinkSync(
    join(LEGACY_CONFIGURATION_GENERATIONS, revisionId),
    join(infraDir, LEGACY_CURRENT_CONFIGURATION),
  );
  return revisionId;
}

describe("the agent's configuration state", () => {
  it("lives in the agent's state directory, and a group-writable infra/docker is left as it is", async () => {
    const { infraDir } = checkout();
    const { revisionId } = await commitConfigurationGeneration({
      infraDir,
      services,
      input: input(),
    });
    expect(readlinkSync(join(infraDir, CURRENT_CONFIGURATION))).toBe(`generations/${revisionId}`);
    expect(currentConfigurationGeneration(infraDir)).toBe(revisionId);
    expect(statSync(infraDir).mode & 0o777).toBe(0o775);
    expect(statSync(join(infraDir, "state", "ops-agent", "configuration")).mode & 0o777).toBe(
      0o700,
    );
    const compose = readFileSync(
      join(infraDir, CURRENT_CONFIGURATION, "docker-compose.generated.yml"),
      "utf8",
    );
    expect(compose).toContain("name: docker");
  });

  it("refuses state directories anyone else can reach instead of repairing them", async () => {
    const { infraDir } = checkout();
    mkdirSync(join(infraDir, "state", "ops-agent"), { recursive: true, mode: 0o700 });
    chmodSync(join(infraDir, "state", "ops-agent"), 0o770);
    await expect(acquireConfigurationOwnership(infraDir)).rejects.toThrow(
      "Unsafe configuration ownership directory",
    );
    expect(statSync(join(infraDir, "state", "ops-agent")).mode & 0o777).toBe(0o770);
  });

  it("ignores what is planted in a group-writable infra/docker", async () => {
    const { infraDir } = checkout();
    const { revisionId } = await commitConfigurationGeneration({
      infraDir,
      services,
      input: input(),
    });
    // Another account of the group: a selection, and a pointer to a generation of its own.
    writeFileSync(join(infraDir, "service-selection.json"), JSON.stringify({ selected: ["beta"] }));
    mkdirSync(join(infraDir, LEGACY_CONFIGURATION_GENERATIONS, `cfg1_${"p".repeat(43)}`), {
      recursive: true,
      mode: 0o700,
    });
    symlinkSync(
      join(LEGACY_CONFIGURATION_GENERATIONS, `cfg1_${"p".repeat(43)}`),
      join(infraDir, LEGACY_CURRENT_CONFIGURATION),
    );
    expect(currentConfigurationGeneration(infraDir)).toBe(revisionId);
    expect(configurationMigrationPending(infraDir)).toBe(false);
    expect(readDesiredSelection(infraDir, {}).roots).not.toContain("beta");
    expect(migrateLegacyServiceSelection(infraDir)).toBe(false);
    // A pointer in the state directory that is not this user's is refused.
    vi.spyOn(process, "geteuid").mockReturnValue((process.geteuid?.() ?? 0) + 1);
    expect(() => currentConfigurationGeneration(infraDir)).toThrow();
  });

  it("reads the selection only as this user wrote it", () => {
    const { infraDir } = checkout();
    mkdirSync(join(infraDir, "state", "ops-agent"), { recursive: true, mode: 0o700 });
    writeFileSync(serviceSelectionPath(infraDir), JSON.stringify({ selected: ["alpha"] }), {
      mode: 0o600,
    });
    expect(readServiceSelectionFile(infraDir)).toEqual(["alpha"]);
    chmodSync(serviceSelectionPath(infraDir), 0o660);
    expect(() => readServiceSelectionFile(infraDir)).toThrow("no group or other write");
    chmodSync(serviceSelectionPath(infraDir), 0o600);
    linkSync(serviceSelectionPath(infraDir), join(infraDir, "state", "ops-agent", "alias"));
    expect(() => readServiceSelectionFile(infraDir)).toThrow("one link");
  });
});

describe("moving an earlier release's configuration", () => {
  it("carries its applied settings and selection over once, then never reads it again", async () => {
    const { infraDir } = checkout();
    const legacy = await legacyDeployment(infraDir);
    // The earlier release's group-writable selection file is never what carries over.
    writeFileSync(
      join(infraDir, "service-selection.json"),
      JSON.stringify({ selected: ["alpha"] }),
    );
    expect(currentConfigurationGeneration(infraDir)).toBeNull();
    expect(configurationMigrationPending(infraDir)).toBe(true);
    expect(readAppliedConfiguration(infraDir).serviceConfigs).toEqual([
      { serviceId: "beta", values: { PUBLIC_SETTING: "saved" } },
    ]);

    await withConfigurationGenerationWriter(infraDir, async (writer) => {
      expect(migrateLegacyServiceSelection(infraDir)).toBe(true);
      const desired = readDesiredSelection(infraDir, {});
      expect(desired).toEqual({ source: "file", roots: ["beta"] });
      await writer.commit({
        services,
        input: input({ selectedRoots: desired.roots, ...readAppliedConfiguration(infraDir) }),
      });
    });
    expect(statSync(serviceSelectionPath(infraDir)).mode & 0o777).toBe(0o600);
    expect(configurationMigrationPending(infraDir)).toBe(false);
    expect(currentConfigurationGeneration(infraDir)).not.toBe(legacy);

    // The earlier files stay, untouched, and are read no more.
    expect(readlinkSync(join(infraDir, LEGACY_CURRENT_CONFIGURATION))).toContain(legacy);
    rmSync(join(infraDir, LEGACY_CONFIGURATION_GENERATIONS), { recursive: true });
    expect(readAppliedConfiguration(infraDir).serviceConfigs).toEqual([
      { serviceId: "beta", values: { PUBLIC_SETTING: "saved" } },
    ]);
    expect(migrateLegacyServiceSelection(infraDir)).toBe(false);
  });

  it("refuses to render past an earlier pointer that is not this user's", async () => {
    const { infraDir } = checkout();
    await legacyDeployment(infraDir);
    vi.spyOn(process, "geteuid").mockReturnValue((process.geteuid?.() ?? 0) + 1);
    expect(() => configurationMigrationPending(infraDir)).toThrow("cannot be verified");
    expect(() => readAppliedConfiguration(infraDir)).toThrow("cannot be verified");
  });

  it("takes the earlier releases' lock too until this release's agent retires it", async () => {
    const { infraDir } = checkout();
    const release = await acquireConfigurationOwnership(infraDir);
    expect(existsSync(join(infraDir, ".trusted-config-writer"))).toBe(true);
    expect(existsSync(join(infraDir, "state", "ops-agent", "configuration", ".writer"))).toBe(true);
    // An agent of an earlier release, which knows only the old lock, waits.
    expect(lstatSync(join(infraDir, ".trusted-config-writer")).isDirectory()).toBe(true);
    release();
    expect(existsSync(join(infraDir, ".trusted-config-writer"))).toBe(false);

    expect(legacyConfigurationWriterActive(infraDir)).toBe(true);
    retireLegacyConfigurationWriter(infraDir);
    expect(legacyConfigurationWriterActive(infraDir)).toBe(false);
    const after = await acquireConfigurationOwnership(infraDir);
    expect(existsSync(join(infraDir, ".trusted-config-writer"))).toBe(false);
    after();
  });
});

describe("the deployment's .env", () => {
  it("is used only as the operator's own file", () => {
    const { infraDir } = checkout();
    const paths = {
      infraDir,
      composePath: join(infraDir, CURRENT_CONFIGURATION, "docker-compose.generated.yml"),
      composeReleasePath: join(infraDir, "state", "ops-agent", "releases", "release.yml"),
    };
    const env = join(infraDir, ".env");
    expect(stackComposeArgs(paths)).not.toContain("--env-file");
    writeFileSync(env, "DOMAIN=maps.example.test\n", { mode: 0o600 });
    expect(stackComposeArgs(paths)).toContain(env);
    for (const [label, prepare] of [
      ["group-writable", () => chmodSync(env, 0o664)],
      ["hard-linked", () => linkSync(env, join(infraDir, ".env.alias"))],
      [
        "a symbolic link",
        () => {
          renameSync(env, join(infraDir, "real.env"));
          symlinkSync("real.env", env);
        },
      ],
    ] as const) {
      prepare();
      expect(deploymentEnvironmentFileProblem(env), label).not.toBeNull();
      expect(() => stackComposeArgs(paths), label).toThrow("no group or other write");
      rmSync(env, { force: true });
      rmSync(join(infraDir, ".env.alias"), { force: true });
      rmSync(join(infraDir, "real.env"), { force: true });
      writeFileSync(env, "DOMAIN=maps.example.test\n", { mode: 0o600 });
    }
    vi.spyOn(process, "geteuid").mockReturnValue((process.geteuid?.() ?? 0) + 1);
    expect(deploymentEnvironmentFileProblem(env)).toContain("is owned by uid");
    // Nothing repairs it.
    expect(statSync(env).mode & 0o777).toBe(0o600);
  });
});
