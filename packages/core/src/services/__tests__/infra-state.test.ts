import {
  chmodSync,
  existsSync,
  linkSync,
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
  currentConfigurationGeneration,
} from "../configuration-generation";
import { acquireConfigurationOwnership } from "../configuration-ownership";
import {
  CURRENT_CONFIGURATION,
  deploymentEnvironmentFileProblem,
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

describe("the agent's configuration state", () => {
  it("keeps generation retention in the agent's state while infra/docker is read-only", async () => {
    const { infraDir } = checkout();
    const first = await commitConfigurationGeneration({ infraDir, services, input: input() });
    const containerId = "a".repeat(64);
    chmodSync(infraDir, 0o555);
    try {
      await commitConfigurationGeneration({
        infraDir,
        services,
        input: input({ domain: "next.example.test" }),
        ownedServiceGenerations: [{ containerId, revisionIds: [first.revisionId] }],
        observedServiceContainerIds: [containerId],
      });
      const retained = JSON.parse(
        readFileSync(
          join(infraDir, "state/ops-agent/configuration/.owned-service-generations.json"),
          "utf8",
        ),
      );
      expect(retained.containers).toEqual({ [containerId]: [first.revisionId] });
      expect(existsSync(join(infraDir, ".owned-service-generations.json"))).toBe(false);
    } finally {
      chmodSync(infraDir, 0o775);
    }
  });

  it("refuses malformed retention evidence", async () => {
    const { infraDir } = checkout();
    const first = await commitConfigurationGeneration({ infraDir, services, input: input() });
    writeFileSync(
      join(infraDir, "state/ops-agent/configuration/.owned-service-generations.json"),
      "{}\n",
      { mode: 0o600 },
    );
    await expect(
      commitConfigurationGeneration({ infraDir, services, input: input() }),
    ).rejects.toThrow();
    expect(currentConfigurationGeneration(infraDir)).toBe(first.revisionId);
  });

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
    expect(compose).toContain("name: openmapx");
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
    // Another account of the group plants a selection of its own.
    writeFileSync(join(infraDir, "service-selection.json"), JSON.stringify({ selected: ["beta"] }));
    expect(currentConfigurationGeneration(infraDir)).toBe(revisionId);
    expect(readDesiredSelection(infraDir, {}).roots).not.toContain("beta");
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

describe("the writer lock", () => {
  it("is taken in the agent's state directory and released", async () => {
    const { infraDir } = checkout();
    const release = await acquireConfigurationOwnership(infraDir);
    expect(existsSync(join(infraDir, "state", "ops-agent", "configuration", ".writer"))).toBe(true);
    release();
    expect(existsSync(join(infraDir, "state", "ops-agent", "configuration", ".writer"))).toBe(
      false,
    );
  });
});

describe("the release overlay stack commands use", () => {
  it("is used only as this user's own file", () => {
    const { infraDir } = checkout();
    const overlay = join(infraDir, "state", "ops-agent", "releases", "docker-compose.release.yml");
    const paths = {
      infraDir,
      composePath: join(infraDir, CURRENT_CONFIGURATION, "docker-compose.generated.yml"),
      composeReleasePath: overlay,
    };
    expect(stackComposeArgs(paths)).not.toContain(overlay);
    mkdirSync(join(infraDir, "state", "ops-agent", "releases"), { recursive: true, mode: 0o700 });
    writeFileSync(overlay, "services: {}\n", { mode: 0o600 });
    expect(stackComposeArgs(paths)).toContain(overlay);
    chmodSync(overlay, 0o664);
    expect(() => stackComposeArgs(paths)).toThrow("no group or other write");
    chmodSync(overlay, 0o600);
    linkSync(overlay, join(infraDir, "overlay-alias.yml"));
    expect(() => stackComposeArgs(paths)).toThrow("one link");
    rmSync(join(infraDir, "overlay-alias.yml"));
    renameSync(overlay, join(infraDir, "overlay.yml"));
    symlinkSync(join(infraDir, "overlay.yml"), overlay);
    expect(() => stackComposeArgs(paths)).toThrow("regular file");
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
