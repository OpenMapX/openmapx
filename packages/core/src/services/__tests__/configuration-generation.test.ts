import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { composePathHost, installedCompose } from "../__fixtures__/compose-path-host";
import {
  type ConfigurationInput,
  commitConfigurationGeneration,
  initializeConfigurationGenerations,
  readAppliedConfiguration,
  readAppliedServiceIds,
  renderConfiguration,
  withConfigurationGenerationWriter,
} from "../configuration-generation";
import {
  configurationGenerationBasePath,
  readDesiredSelection,
  readServiceSelectionFile,
  stackComposeArgs,
  writeServiceSelectionFile,
} from "../deployment";
import type { LoadedService } from "../types";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function checkout() {
  const root = mkdtempSync(join(tmpdir(), "openmapx-generation-"));
  roots.push(root);
  const infraDir = join(root, "infra", "docker");
  mkdirSync(infraDir, { recursive: true });
  return { root, infraDir };
}

function service(id: string): LoadedService {
  return {
    manifest: {
      id,
      name: id,
      version: "1.0.0",
      quality: "built-in",
      container: { image: `example/${id}`, tag: "1" },
      configSchema: {
        type: "object",
        properties: {
          PUBLIC_SETTING: { type: "string" },
          PRIVATE_SETTING: { type: "string", "x-openmapx-secret": true },
        },
      },
    },
    directory: `/trusted/services/${id}`,
    isBuiltIn: true,
    enabled: false,
  };
}

const services = [service("alpha"), service("beta")];

function input(overrides: Partial<ConfigurationInput> = {}): ConfigurationInput {
  return {
    domain: "maps.example.test",
    selectedRoots: ["alpha"],
    serviceConfigs: [],
    integrationConfigs: [],
    serviceSecrets: [],
    ...overrides,
  };
}

describe("configuration generations", () => {
  it("carries opaque managed credential revision through unrelated CLI renders", async () => {
    const { infraDir } = checkout();
    const revision = "b".repeat(64);
    await commitConfigurationGeneration({
      infraDir,
      services,
      input: input({ transitCredentialsRevision: revision } as Partial<ConfigurationInput>),
    });
    expect(readAppliedConfiguration(infraDir)).toHaveProperty(
      "transitCredentialsRevision",
      revision,
    );
    await commitConfigurationGeneration({
      infraDir,
      services,
      input: input(readAppliedConfiguration(infraDir)),
    });
    expect(readAppliedConfiguration(infraDir)).toHaveProperty(
      "transitCredentialsRevision",
      revision,
    );
  });

  it("gives each application a fresh identity even when content repeats", async () => {
    const { root, infraDir } = checkout();
    const first = await commitConfigurationGeneration({ infraDir, services, input: input() });
    const again = await commitConfigurationGeneration({ infraDir, services, input: input() });

    expect(first.revisionId).toMatch(/^cfg1_[A-Za-z0-9_-]{43}$/);
    expect(again.revisionId).not.toBe(first.revisionId);
    expect(first.enabledServiceIds).toEqual(["alpha"]);
    expect(readAppliedServiceIds(infraDir, services)).toEqual(new Set(["alpha"]));
    const compose = readFileSync(
      join(infraDir, ".trusted-config-current", "docker-compose.generated.yml"),
      "utf8",
    );
    expect(compose).toContain("alpha:");
    // The project is the file's, not its generation directory's.
    expect(compose.startsWith("name: docker\n")).toBe(true);
    expect(existsSync(join(root, "services/traefik/config/dynamic/generated-routes.yml"))).toBe(
      true,
    );
    expect(existsSync(join(root, "custom_integrations"))).toBe(true);
  });

  it("retains commit evidence even if the owner callback fails while its write is settling", async () => {
    const { infraDir } = checkout();
    const error = await withConfigurationGenerationWriter(infraDir, async (writer) => {
      void writer.commit({
        services,
        input: input(),
        afterCommit: async () => {
          throw new Error("post-pointer fault");
        },
      });
      throw new Error("callback fault");
    }).catch((error) => error);
    expect(error.result).toMatchObject({ outcome: "committed", followUp: "failed" });
    expect(readAppliedServiceIds(infraDir, services)).toEqual(new Set(["alpha"]));
  });
  it("does not activate when cancellation arrives after staging rename", async () => {
    const { infraDir } = checkout();
    const controller = new AbortController();
    const error = await commitConfigurationGeneration({
      infraDir,
      services,
      input: input(),
      signal: controller.signal,
      afterGenerationRename: async () => {
        controller.abort();
      },
    }).catch((error) => error);
    expect(error.result).toMatchObject({ outcome: "not_committed" });
  });

  it("keeps what was saved for services that are not enabled, for a later render", async () => {
    const { infraDir } = checkout();
    const saved = {
      serviceConfigs: [{ serviceId: "beta", values: { PUBLIC_SETTING: "kept" } }],
      integrationConfigs: [{ integrationId: "routing", values: { enabled: true } }],
      serviceSecrets: [{ serviceId: "beta", values: { PRIVATE_SETTING: "s3cret" } }],
    };
    await commitConfigurationGeneration({ infraDir, services, input: input(saved) });

    expect(readAppliedConfiguration(infraDir)).toEqual(saved);
    const compose = readFileSync(
      join(infraDir, ".trusted-config-current", "docker-compose.generated.yml"),
      "utf8",
    );
    expect(compose).not.toContain("beta:");

    await commitConfigurationGeneration({
      infraDir,
      services,
      input: input({ ...saved, selectedRoots: ["alpha", "beta"] }),
    });
    const enabled = readFileSync(
      join(infraDir, ".trusted-config-current", "docker-compose.generated.yml"),
      "utf8",
    );
    expect(enabled).toContain("PUBLIC_SETTING: kept");
    expect(enabled).toContain("PRIVATE_SETTING_FILE");
  });

  it("layers schema defaults under saved values and env references over both", () => {
    const { infraDir } = checkout();
    const tuned = service("alpha");
    tuned.manifest.configSchema = {
      type: "object",
      properties: {
        THREADS: { type: "string", default: "2" },
        CACHE: { type: "string", default: "small" },
        MODE: { type: "string", default: "fast" },
      },
    };
    const { rendered } = renderConfiguration({
      infraDir,
      services: [tuned],
      input: input({
        serviceConfigs: [{ serviceId: "alpha", values: { CACHE: "large" }, envKeys: ["MODE"] }],
      }),
    });
    expect(rendered.composeYaml).toContain("THREADS: '2'");
    expect(rendered.composeYaml).toContain("CACHE: large");
    expect(rendered.composeYaml).toContain(`MODE: \${SERVICE_ALPHA_MODE:-}`);
  });

  it("refuses configuration of a service it does not know", async () => {
    const { infraDir } = checkout();
    await expect(
      commitConfigurationGeneration({
        infraDir,
        services,
        input: input({ serviceConfigs: [{ serviceId: "gamma", values: {} }] }),
      }),
    ).rejects.toThrow(/unknown service: gamma/);
    expect(readAppliedServiceIds(infraDir, services)).toBeNull();
  });

  it("reads nothing applied before the first render", () => {
    const { infraDir } = checkout();
    expect(readAppliedServiceIds(infraDir, services)).toBeNull();
    expect(readAppliedConfiguration(infraDir)).toEqual({
      serviceConfigs: [],
      integrationConfigs: [],
      serviceSecrets: [],
    });
  });
});

describe("desired selection", () => {
  it("takes the operator's env, then the file, then the defaults", () => {
    const { infraDir } = checkout();
    expect(readDesiredSelection(infraDir, {})).toMatchObject({ source: "default" });
    writeServiceSelectionFile(infraDir, ["valhalla", "photon", "valhalla"]);
    expect(readServiceSelectionFile(infraDir)).toEqual(["valhalla", "photon"]);
    expect(readDesiredSelection(infraDir, {})).toEqual({
      source: "file",
      roots: ["valhalla", "photon"],
    });
    expect(readDesiredSelection(infraDir, { OPENMAPX_ENABLED_SERVICES: "osrm" })).toEqual({
      source: "env",
      roots: ["osrm"],
    });
  });

  // biome-ignore lint/suspicious/noTemplateCurlyInString: The test name documents literal Compose default-value syntax.
  it("treats an override that names no service as unset, as `${VAR:-}` passes an unset one", () => {
    const { infraDir } = checkout();
    writeServiceSelectionFile(infraDir, ["valhalla"]);
    for (const value of ["", " ", ","]) {
      expect(readDesiredSelection(infraDir, { OPENMAPX_ENABLED_SERVICES: value })).toEqual({
        source: "file",
        roots: ["valhalla"],
      });
    }
  });

  it("rejects a malformed selection file", () => {
    const { infraDir } = checkout();
    writeFileSync(join(infraDir, "service-selection.json"), '{"selected":"valhalla"}');
    expect(() => readDesiredSelection(infraDir, {})).toThrow(/expected "selected" array/);
  });
});

describe("stack compose arguments", () => {
  it("adds fixed bases to existing generations without modifying their bytes and rejects forged bases", async () => {
    const host = await composePathHost();
    roots.push(host.root);
    const composeHash = host.hash(host.firstCompose),
      secretHash = host.hash(host.secretFile(host.firstCompose));
    const base = configurationGenerationBasePath(host.infraDir, host.first.revisionId);
    rmSync(base);
    expect(() => host.currentArgs()).toThrow();
    await initializeConfigurationGenerations(host.infraDir);
    expect(realpathSync(base)).toBe(realpathSync(join(host.infraDir, ".trusted-config-current")));
    expect(host.currentArgs()).toContain(base);
    expect(host.hash(host.firstCompose)).toBe(composeHash);
    expect(host.hash(host.secretFile(host.firstCompose))).toBe(secretHash);
    rmSync(base);
    symlinkSync(".trusted-config-current", base);
    expect(() => host.currentArgs()).toThrow("Unsafe generation Compose base");
    await expect(initializeConfigurationGenerations(host.infraDir)).rejects.toThrow(
      "Unsafe generation Compose base",
    );
    expect(host.hash(host.firstCompose)).toBe(composeHash);
    expect(host.hash(host.secretFile(host.firstCompose))).toBe(secretHash);
  });

  it.runIf(installedCompose)(
    "resolves real rendered current and retained paths without redirecting generation secrets",
    async () => {
      const host = await composePathHost();
      roots.push(host.root);
      const originalBytes = host.hash(host.firstCompose),
        originalSecret = host.hash(host.secretFile(host.firstCompose));
      const oldArgs = host.currentArgs();
      for (const noEnv of [false, true]) {
        const result = host.config(oldArgs, noEnv);
        expect(result.status, "real Compose must validate production-rendered env_file paths").toBe(
          0,
        );
        if (!result.model) throw Error("Real Compose fixture acquisition failed");
        expect(Object.values(host.pathChecks(result.model, host.firstCompose)).every(Boolean)).toBe(
          true,
        );
      }
      await host.commit("second");
      const nextCompose = realpathSync(host.stack.composePath);
      expect(host.sameFile(host.secretFile(host.firstCompose), host.secretFile(nextCompose))).toBe(
        false,
      );
      for (const [args, file] of [
        [oldArgs, host.firstCompose],
        [host.retainedArgs(), host.firstCompose],
        [host.currentArgs(), nextCompose],
      ] as const) {
        const result = host.config(args);
        expect(result.status).toBe(0);
        if (!result.model) throw Error("Real Compose fixture acquisition failed");
        expect(Object.values(host.pathChecks(result.model, file)).every(Boolean)).toBe(true);
      }
      expect(host.hash(host.firstCompose)).toBe(originalBytes);
      expect(host.hash(host.secretFile(host.firstCompose))).toBe(originalSecret);
    },
  );

  it("addresses the stack as one project with the deployment environment", () => {
    const paths = {
      infraDir: "/stack",
      composePath: "/stack/.trusted-config-current/docker-compose.generated.yml",
      composeReleasePath: "/stack/docker-compose.release.yml",
    };
    expect(stackComposeArgs(paths, () => true)).toEqual([
      "compose",
      "--env-file",
      "/stack/.env",
      "-f",
      "/stack/.trusted-config-current/docker-compose.generated.yml",
      "-f",
      "/stack/docker-compose.release.yml",
    ]);
    expect(stackComposeArgs(paths, () => false)).toEqual([
      "compose",
      "-f",
      "/stack/.trusted-config-current/docker-compose.generated.yml",
    ]);
  });
});

it("retains closed platform ownership through a generation without exporting secrets", async () => {
  const { infraDir } = checkout();
  const platform = {
    version: 1 as const,
    domain: { source: "database" as const, value: "adopted.example.test" },
    defaultRegion: { source: "database" as const, value: "europe/germany" },
  };
  await commitConfigurationGeneration({
    infraDir,
    services,
    input: input({ domain: "adopted.example.test", platform }),
  });
  expect(readAppliedConfiguration(infraDir).platform).toEqual(platform);
  const config = JSON.parse(
    readFileSync(join(infraDir, ".trusted-config-current/resolved-config.generated.json"), "utf8"),
  );
  expect(config.platform).toEqual(platform);
  expect(config).not.toHaveProperty("serviceSecrets");
});

it("keeps host-owned Compose interpolation equivalent to legacy generations", () => {
  const { infraDir } = checkout();
  const manifest = service("alpha");
  manifest.manifest.container.environment = {
    ORIGIN: "https://${DOMAIN:-localhost}",
    ACME: "${ACME_EMAIL:-admin@example.com}",
  };
  const before = renderConfiguration({ infraDir, services: [manifest], input: input() });
  const after = renderConfiguration({
    infraDir,
    services: [manifest],
    input: input({
      platform: { version: 1, domain: { source: "host" }, acmeEmail: { source: "host" } },
    }),
  });
  expect(after.rendered.composeYaml).toBe(before.rendered.composeYaml);
});

it("applied selector and retention follow the current generation and explicit return to host", async () => {
  const { infraDir } = checkout();
  const { readAppliedPlatformValues, readAppliedReleaseSelection } = await import(
    "../configuration-generation"
  );
  const env = { OPENMAPX_RELEASE: "main", BACKUP_RETENTION_DAYS: "30" };
  await commitConfigurationGeneration({
    infraDir,
    services,
    input: input({
      platform: {
        version: 1,
        releaseSelector: { source: "database", value: "preview" },
        backupRetentionDays: { source: "database", value: 60 },
      },
    }),
  });
  expect(readAppliedReleaseSelection(infraDir, env)).toMatchObject({ kind: "preview" });
  expect(readAppliedPlatformValues(infraDir, env).backupRetentionDays).toBe(60);
  await commitConfigurationGeneration({
    infraDir,
    services,
    input: input({
      platform: {
        version: 1,
        releaseSelector: { source: "host" },
        backupRetentionDays: { source: "host" },
      },
    }),
  });
  expect(readAppliedReleaseSelection(infraDir, env)).toMatchObject({ kind: "main" });
  expect(
    readAppliedPlatformValues(infraDir, { ...env, BACKUP_RETENTION_DAYS: "45" })
      .backupRetentionDays,
  ).toBe(45);
});
