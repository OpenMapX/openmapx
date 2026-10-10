import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ConfigurationInput,
  commitConfigurationGeneration,
  readAppliedConfiguration,
  readAppliedServiceIds,
  renderConfiguration,
} from "../configuration-generation";
import {
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
  it("names a generation by its content and makes it the applied one", async () => {
    const { root, infraDir } = checkout();
    const first = await commitConfigurationGeneration({ infraDir, services, input: input() });
    const again = await commitConfigurationGeneration({ infraDir, services, input: input() });

    expect(first.revisionId).toMatch(/^cfg1_[A-Za-z0-9_-]{43}$/);
    expect(again.revisionId).toBe(first.revisionId);
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
