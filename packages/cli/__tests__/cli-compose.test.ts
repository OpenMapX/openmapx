import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readErasureJournal } from "@openmapx/core/erasure-journal";
import { services as coreServices } from "@openmapx/core/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderComposeForRepo, rotateRedisPasswordForRepo } from "../src/commands/compose";
import { runsInAgent } from "../src/lib/agent-integrations";
import { legacyTraefikDynamicMounted } from "../src/lib/container-mounts";
import { loadInfraEnv } from "../src/lib/infra-env";
import { rotatePlatformSecretFile } from "../src/lib/platform-secret-files";
import { selectedReleaseServiceFiles } from "../src/lib/release-service-files";

// Docker answers whether a container still mounts the checkout's Traefik
// directory, and what containers mount; here, by default, none does.
vi.mock("../src/lib/container-mounts", () => ({
  legacyTraefikDynamicMounted: vi.fn(async () => false),
  containerBindMounts: vi.fn(async () => []),
}));
// The selected release's files come from its image; by default none is selected.
vi.mock("../src/lib/release-service-files", () => ({
  selectedReleaseServiceFiles: vi.fn(async () => "none"),
}));
// The host CLI by default; a test switches to the operations agent's fixed CLI.
vi.mock("../src/lib/agent-integrations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/agent-integrations")>()),
  runsInAgent: vi.fn(() => false),
}));

/** A file's permission bits, read through a descriptor rather than a second lookup by path. */
function permissions(path: string): number {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return fstatSync(descriptor).mode & 0o777;
  } finally {
    closeSync(descriptor);
  }
}

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

/** The `NAME: <dollar>{NAME:-fallback}` line Compose rendering produces. */
function composeDefault(name: string, fallback: string): string {
  return `${name}: \${${name}:-${fallback}}`;
}

let tmp: string;

/** A file of the applied generation, through the current pointer. */
function currentGenerationFile(...names: string[]): string {
  return join(tmp, "infra", "docker", coreServices.CURRENT_CONFIGURATION, ...names);
}

/** The applied generation's compose file. */
function generatedCompose(): string {
  return currentGenerationFile("docker-compose.generated.yml");
}
let originalPostgresPassword: string | undefined;
let originalBetterAuthSecret: string | undefined;
let originalDataManagerAuthToken: string | undefined;

function writeManifest(slug: string, body: Record<string, unknown>) {
  const dir = join(tmp, "services", slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "service.json"), JSON.stringify(body), "utf-8");
}

const baseManifest = {
  name: "Test",
  version: "1.0.0",
  quality: "built-in",
  container: { image: "t/x", tag: "latest", expose: [80] },
};

beforeEach(() => {
  originalPostgresPassword = process.env.POSTGRES_PASSWORD;
  originalBetterAuthSecret = process.env.BETTER_AUTH_SECRET;
  originalDataManagerAuthToken = process.env.DATA_MANAGER_AUTH_TOKEN;
  process.env.POSTGRES_PASSWORD = "x".repeat(24);
  process.env.BETTER_AUTH_SECRET = "a".repeat(32);
  process.env.DATA_MANAGER_AUTH_TOKEN = "b".repeat(32);
  delete process.env.OPENMAPX_ENABLED_SERVICES;
  tmp = mkdtempSync(join(tmpdir(), "openmapx-cli-render-"));
  writeFileSync(join(tmp, "pnpm-workspace.yaml"), "packages: []\n");
  mkdirSync(join(tmp, "infra", "docker"), { recursive: true });
});

afterEach(() => {
  if (originalPostgresPassword === undefined) delete process.env.POSTGRES_PASSWORD;
  else process.env.POSTGRES_PASSWORD = originalPostgresPassword;
  if (originalBetterAuthSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
  else process.env.BETTER_AUTH_SECRET = originalBetterAuthSecret;
  if (originalDataManagerAuthToken === undefined) delete process.env.DATA_MANAGER_AUTH_TOKEN;
  else process.env.DATA_MANAGER_AUTH_TOKEN = originalDataManagerAuthToken;
  rmSync(tmp, { recursive: true, force: true });
});

describe("renderComposeForRepo", () => {
  it("rejects an unsafe deployment password before creating render output", async () => {
    writeManifest("alpha", { ...baseManifest, id: "alpha" });
    process.env.POSTGRES_PASSWORD = "change-me";

    await expect(
      renderComposeForRepo({ rootDir: tmp, domain: "example.com", services: ["alpha"] }),
    ).rejects.toThrow(/known-placeholder/);
    expect(existsSync(generatedCompose())).toBe(false);
    expect(existsSync(join(tmp, "infra", "docker", "secrets"))).toBe(false);
  });

  it.each(["BETTER_AUTH_SECRET", "DATA_MANAGER_AUTH_TOKEN"] as const)(
    "rejects an unsafe %s before creating render output",
    async (name) => {
      writeManifest("alpha", { ...baseManifest, id: "alpha" });
      process.env[name] = "short";

      await expect(
        renderComposeForRepo({ rootDir: tmp, domain: "example.com", services: ["alpha"] }),
      ).rejects.toThrow(new RegExp(`${name}.*too-short`));
      expect(existsSync(generatedCompose())).toBe(false);
      expect(existsSync(join(tmp, "infra", "docker", "secrets"))).toBe(false);
    },
  );

  it("refuses a deployment .env that is not the operator's own, and loads none of it", async () => {
    writeManifest("alpha", { id: "alpha", ...baseManifest });
    const env = join(tmp, "infra", "docker", ".env");
    writeFileSync(env, "OPENMAPX_TEST_PLANTED=planted\n", { mode: 0o600 });
    chmodSync(env, 0o664);
    delete process.env.OPENMAPX_TEST_PLANTED;
    loadInfraEnv(tmp);
    expect(process.env.OPENMAPX_TEST_PLANTED).toBeUndefined();
    await expect(
      renderComposeForRepo({ rootDir: tmp, domain: "example.com", services: ["alpha"] }),
    ).rejects.toThrow("no group or other write");
    expect(existsSync(generatedCompose())).toBe(false);
    expect(permissions(env)).toBe(0o664);

    chmodSync(env, 0o600);
    loadInfraEnv(tmp);
    expect(process.env.OPENMAPX_TEST_PLANTED).toBe("planted");
    delete process.env.OPENMAPX_TEST_PLANTED;
    await renderComposeForRepo({ rootDir: tmp, domain: "example.com", services: ["alpha"] });
    expect(existsSync(generatedCompose())).toBe(true);
  });

  it("writes the deployment's user from the checkout's owner, and runs only as that user", async () => {
    writeManifest("alpha", { id: "alpha", ...baseManifest });
    const env = join(tmp, "infra", "docker", ".env");
    writeFileSync(env, "DOMAIN=example.com\n", { mode: 0o600 });
    const owner = statSync(tmp);
    await renderComposeForRepo({ rootDir: tmp, domain: "example.com", services: ["alpha"] });
    expect(readFileSync(env, "utf8")).toContain(`\nUID=${owner.uid}\nGID=${owner.gid}\n`);
    expect(permissions(env)).toBe(0o600);

    // .env names another user than this process: nothing is rendered.
    writeFileSync(env, `UID=${owner.uid + 1}\nGID=${owner.gid}\n`, { mode: 0o600 });
    const before = coreServices.currentConfigurationGeneration(join(tmp, "infra", "docker"));
    await expect(
      renderComposeForRepo({ rootDir: tmp, domain: "example.com", services: ["alpha"] }),
    ).rejects.toThrow(/but the deployment's user .* is/);
    expect(coreServices.currentConfigurationGeneration(join(tmp, "infra", "docker"))).toBe(before);
  });

  it("on the host moves the operations agent to its narrow mounts once nothing is missing, and says what is", async () => {
    writeManifest(
      "ops-agent",
      JSON.parse(readFileSync(join(REPO_ROOT, "services/ops-agent/service.json"), "utf8")),
    );
    const infraDir = join(tmp, "infra", "docker");
    // log.warn writes to stderr.
    const warnings = vi.spyOn(console, "error").mockImplementation(() => {});
    const render = () =>
      renderComposeForRepo({ rootDir: tmp, domain: "example.com", services: ["ops-agent"] });
    await render();
    // Without the import, the retired earlier lock and an applied generation.
    expect(coreServices.generationAgentMountLayout(infraDir)).toBe("checkout");
    const said = warnings.mock.calls.flat().join("\n");
    expect(said).toContain("The operations agent keeps the whole checkout mounted.");
    expect(said).toMatch(/- The one-time import of your edits .*overrides-import\.json is missing/);
    expect(said).toMatch(/- Writers still take the earlier releases' configuration lock/);

    writeFileSync(
      join(infraDir, "state/ops-agent/overrides-import.json"),
      `${JSON.stringify({ version: 1, importedAt: "2026-10-26T00:00:00Z", imported: [] })}\n`,
      { mode: 0o600 },
    );
    coreServices.retireLegacyConfigurationWriter(infraDir);
    warnings.mockClear();
    await render();
    expect(coreServices.generationAgentMountLayout(infraDir)).toBe("narrow");
    expect(warnings.mock.calls.flat().join("\n")).not.toContain("keeps the whole checkout");

    // The agent's own render, with the whole checkout mounted, keeps it.
    vi.mocked(runsInAgent).mockReturnValue(true);
    try {
      await render();
      expect(coreServices.generationAgentMountLayout(infraDir)).toBe("checkout");
    } finally {
      vi.mocked(runsInAgent).mockReturnValue(false);
    }
  });

  it("in the operations agent's fixed CLI only reads the deployment's user, and refuses without it", async () => {
    writeManifest("alpha", { id: "alpha", ...baseManifest });
    const infraDir = join(tmp, "infra", "docker");
    const env = join(infraDir, ".env");
    const owner = statSync(tmp);
    // Read through one descriptor rather than a second lookup by path.
    const state = () => {
      const descriptor = openSync(env, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stats = fstatSync(descriptor, { bigint: true });
        return {
          bytes: readFileSync(descriptor, "utf8"),
          ino: stats.ino,
          mtimeNs: stats.mtimeNs,
        };
      } finally {
        closeSync(descriptor);
      }
    };
    // An old mtime, so a write in the same instant would still show.
    const written = (contents: string) => {
      writeFileSync(env, contents, { mode: 0o600 });
      utimesSync(env, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
      return state();
    };
    vi.mocked(runsInAgent).mockReturnValue(true);
    try {
      for (const [contents, missing] of [
        ["DOMAIN=example.com\n", "UID or GID"],
        [`DOMAIN=example.com\nUID=${owner.uid}\n`, "GID"],
      ] as const) {
        const before = written(contents);
        await expect(
          renderComposeForRepo({ rootDir: tmp, domain: "example.com", services: ["alpha"] }),
        ).rejects.toThrow(
          `infra/docker/.env sets no ${missing}, and the operations agent does not write .env: run \`pnpm openmapx compose render\` on the host, as the checkout's owner, which writes UID and GID from that owner.`,
        );
        expect(state()).toEqual(before);
        expect(coreServices.currentConfigurationGeneration(infraDir)).toBeNull();
      }

      const present = written(`DOMAIN=example.com\nUID=${owner.uid}\nGID=${owner.gid}\n`);
      await renderComposeForRepo({ rootDir: tmp, domain: "example.com", services: ["alpha"] });
      expect(coreServices.currentConfigurationGeneration(infraDir)).not.toBeNull();
      expect(state()).toEqual(present);
    } finally {
      vi.mocked(runsInAgent).mockReturnValue(false);
    }
  });

  it("writes docker-compose.generated.yml from explicitly selected manifests", async () => {
    writeManifest("alpha", { ...baseManifest, id: "alpha" });
    writeManifest("beta", { ...baseManifest, id: "beta" });

    const result = await renderComposeForRepo({
      rootDir: tmp,
      domain: "example.com",
      services: ["alpha,beta"],
    });
    expect(result.servicesRendered).toBe(2);
    expect(result.enabledServiceIds).toEqual(["alpha", "beta"]);

    const composePath = generatedCompose();
    const yaml = readFileSync(composePath, "utf-8");
    expect(yaml).toContain("services:");
    expect(yaml).toContain("alpha:");
    expect(yaml).toContain("beta:");
    const queue = lstatSync(join(tmp, "infra", "docker", "state", "ops-agent", "trusted-config"));
    expect(queue.isDirectory()).toBe(true);
    expect(queue.mode & 0o777).toBe(0o700);
    const backups = lstatSync(join(tmp, "infra", "docker", "backups"));
    expect(backups.isDirectory()).toBe(true);
    expect(backups.mode & 0o777).toBe(0o700);
  });

  it("binds the initialized erasure journal to the generated journal key", async () => {
    writeManifest("alpha", { ...baseManifest, id: "alpha" });

    await renderComposeForRepo({ rootDir: tmp, domain: "example.com", services: ["alpha"] });

    const dockerDir = join(tmp, "infra", "docker");
    const key = Buffer.from(
      readFileSync(join(dockerDir, "secrets", "erasure-journal-key"), "utf8"),
      "base64url",
    );
    expect(() =>
      readErasureJournal(join(dockerDir, "data", "erasure", "journal.jsonl"), key),
    ).not.toThrow();
  });

  it("defaults to the small core service selection", async () => {
    writeManifest("app-api", {
      ...baseManifest,
      id: "app-api",
      container: {
        ...baseManifest.container,
        expose: [3001],
        dependsOn: [{ service: "postgis", condition: "service_healthy" }],
      },
      exposure: { proxy: { enabled: true, pathPrefix: "/api" } },
    });
    writeManifest("postgis", { ...baseManifest, id: "postgis" });
    writeManifest("redis", { ...baseManifest, id: "redis" });
    writeManifest("traefik", { ...baseManifest, id: "traefik" });
    // Traefik's static file goes into the generation; render refuses without it.
    mkdirSync(join(tmp, "services", "traefik", "config"), { recursive: true });
    writeFileSync(join(tmp, "services", "traefik", "config", "traefik.yml"), "log: {}\n");
    writeManifest("valhalla", { ...baseManifest, id: "valhalla" });

    const result = await renderComposeForRepo({ rootDir: tmp, domain: "example.com" });

    expect(result.enabledServiceIds).toEqual(["app-api", "postgis", "redis", "traefik"]);
    const yaml = readFileSync(generatedCompose(), "utf-8");
    expect(yaml).toContain("app-api:");
    expect(yaml).toContain("postgis:");
    expect(yaml).toContain("redis:");
    expect(yaml).toContain("traefik:");
    expect(yaml).not.toContain("valhalla:");
    expect(yaml).toContain("OPENMAPX_APPLIED_SERVICES: app-api,postgis,redis,traefik");
  });

  it("renders the real app-api OSM contribution controls with both flags off", async () => {
    // Rendered from the checked-in manifest, not a fixture: this is the guard
    // that a shipped deployment defaults to contributions disabled.
    const manifest = JSON.parse(
      readFileSync(join(REPO_ROOT, "services", "app-api", "service.json"), "utf-8"),
    ) as { container: { environment: Record<string, string> } };
    writeManifest("app-api", manifest as unknown as Record<string, unknown>);

    await renderComposeForRepo({ rootDir: tmp, domain: "example.com", services: ["app-api"] });
    const yaml = readFileSync(generatedCompose(), "utf-8");

    expect(yaml).toContain(composeDefault("OSM_CONTRIBUTIONS_ENABLED", "false"));
    expect(yaml).toContain(composeDefault("OSM_DIRECT_EDITING_ENABLED", "false"));
    expect(yaml).toContain(composeDefault("OSM_API_URL", "https://api.openstreetmap.org"));
    expect(yaml).toContain(composeDefault("OSM_WEB_URL", "https://www.openstreetmap.org"));
    expect(yaml).toContain(composeDefault("OPENMAPX_VERSION", "1.0"));
    for (const limiter of ["READ", "PREVIEW", "PUBLISH", "NOTE"]) {
      expect(yaml).toContain(`RATE_LIMIT_OSM_CONTRIBUTION_${limiter}_MAX:`);
      expect(yaml).toContain(`RATE_LIMIT_OSM_CONTRIBUTION_${limiter}_WINDOW_MS:`);
    }
  });

  it("writes hardlink plan to a sidecar file", async () => {
    writeManifest("data", {
      ...baseManifest,
      id: "data",
      provides: ["osm-data"],
      produces: [{ type: "osm-data", sourceDir: "data/osm" }],
    });
    writeManifest("valhalla", {
      ...baseManifest,
      id: "valhalla",
      consumes: [{ type: "osm-data", mountAt: "/custom_files", required: true }],
    });

    await renderComposeForRepo({ rootDir: tmp, domain: "example.com", services: ["valhalla"] });
    const planPath = currentGenerationFile("docker-compose.generated.hardlinks.json");
    const plan = JSON.parse(readFileSync(planPath, "utf-8"));
    expect(plan).toEqual([
      {
        source: "data/osm",
        target: "data/valhalla/osm-data",
        consumerService: "valhalla",
        dataType: "osm-data",
      },
    ]);
  });

  it("bootstraps stable Redis auth files while keeping the raw password out of Compose", async () => {
    const secretDir = join(tmp, "infra", "docker", "secrets");

    for (const id of ["redis", "app-api"]) {
      const manifest = JSON.parse(
        readFileSync(join(REPO_ROOT, "services", id, "service.json"), "utf8"),
      ) as Record<string, unknown> & { bindMounts?: Array<{ source: string }> };
      manifest.bindMounts = (manifest.bindMounts ?? []).filter((mount) =>
        mount.source.includes("redis-"),
      );
      writeManifest(id, manifest);
    }

    await renderComposeForRepo({
      rootDir: tmp,
      domain: "example.com",
      services: ["redis,app-api"],
    });
    const composePath = generatedCompose();
    const firstYaml = readFileSync(composePath, "utf8");
    const passwordPath = join(secretDir, "redis-password");
    const firstPassword = readFileSync(passwordPath, "utf8");
    const acl = readFileSync(join(secretDir, "redis-acl.conf"), "utf8");

    expect(firstPassword).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(acl).toBe(
      `user default on #${createHash("sha256").update(firstPassword).digest("hex")} ~* &* +@all\n`,
    );
    expect(firstYaml).not.toContain(firstPassword);
    expect(firstYaml).not.toMatch(/redis:\/\/:.+@/);
    expect(firstYaml).toContain("REDIS_PASSWORD_FILE: /run/secrets/redis-password");
    expect(firstYaml).toContain("--aclfile");
    expect(firstYaml).toContain("/etc/valkey/users.acl");
    expect(firstYaml).toContain(
      'REDISCLI_AUTH="$(cat /run/secrets/redis-password)" exec redis-cli ping',
    );
    expect(firstYaml.match(/redis-password:\/run\/secrets\/redis-password:ro/g)).toHaveLength(2);

    await renderComposeForRepo({
      rootDir: tmp,
      domain: "example.com",
      services: ["redis,app-api"],
    });
    expect(readFileSync(passwordPath, "utf8")).toBe(firstPassword);
    expect(readFileSync(composePath, "utf8")).not.toContain(firstPassword);
  });

  it("bootstraps stable distinct ops-agent caller tokens without rendering their bytes", async () => {
    for (const id of ["app-api", "data-manager", "ops-agent", "motis", "postgis", "redis"]) {
      const manifest = JSON.parse(
        readFileSync(join(REPO_ROOT, "services", id, "service.json"), "utf8"),
      ) as Record<string, unknown>;
      writeManifest(id, manifest);
    }

    await renderComposeForRepo({
      rootDir: tmp,
      domain: "example.com",
      services: ["app-api,data-manager,ops-agent"],
    });
    const secretDir = join(tmp, "infra", "docker", "secrets");
    const composePath = generatedCompose();
    const apiToken = readFileSync(join(secretDir, "ops-agent-api-token"), "utf8");
    const dataManagerToken = readFileSync(join(secretDir, "ops-agent-data-manager-token"), "utf8");
    const firstYaml = readFileSync(composePath, "utf8");

    expect(apiToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(dataManagerToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(apiToken).not.toBe(dataManagerToken);
    expect(firstYaml).not.toContain(apiToken);
    expect(firstYaml).not.toContain(dataManagerToken);
    expect(firstYaml).not.toContain("traefik.http.routers.ops-agent");
    expect(firstYaml).not.toContain("ops-agent.example.com");
    expect(firstYaml.split("ops-agent-api-token:/run/secrets/ops-agent-api-token:ro")).toHaveLength(
      3,
    );
    expect(
      firstYaml.split("ops-agent-data-manager-token:/run/secrets/ops-agent-data-manager-token:ro"),
    ).toHaveLength(3);

    await renderComposeForRepo({
      rootDir: tmp,
      domain: "example.com",
      services: ["app-api,data-manager,ops-agent"],
    });
    expect(readFileSync(join(secretDir, "ops-agent-api-token"), "utf8")).toBe(apiToken);
    expect(readFileSync(join(secretDir, "ops-agent-data-manager-token"), "utf8")).toBe(
      dataManagerToken,
    );
  });

  it("bootstraps the offline principal key into app-api only without rendering its bytes", async () => {
    for (const id of ["app-api", "data-manager", "ops-agent", "motis", "postgis", "redis"]) {
      const manifest = JSON.parse(
        readFileSync(join(REPO_ROOT, "services", id, "service.json"), "utf8"),
      ) as Record<string, unknown>;
      writeManifest(id, manifest);
    }

    await renderComposeForRepo({
      rootDir: tmp,
      domain: "example.com",
      services: ["app-api,data-manager"],
    });
    const secretPath = join(tmp, "infra", "docker", "secrets", "offline-package-principal-key");
    const key = readFileSync(secretPath, "utf8");
    const yaml = readFileSync(generatedCompose(), "utf8");

    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(yaml).not.toContain(key);
    expect(
      yaml.match(/offline-package-principal-key:\/run\/secrets\/offline-package-principal-key:ro/g),
    ).toHaveLength(1);
    const dataManagerSection = yaml.split("  data-manager:")[1]?.split("\n  ")[0] ?? "";
    expect(dataManagerSection).not.toContain("OFFLINE_PACKAGE_PRINCIPAL_KEY");
    expect(dataManagerSection).not.toContain("offline-package-principal-key");

    await renderComposeForRepo({
      rootDir: tmp,
      domain: "example.com",
      services: ["app-api,data-manager"],
    });
    expect(readFileSync(secretPath, "utf8")).toBe(key);
  });

  it("creates the agent's stores before mounting its integration store read-only into app-api", async () => {
    for (const id of ["app-api", "data-manager", "ops-agent", "motis", "postgis", "redis"]) {
      const manifest = JSON.parse(
        readFileSync(join(REPO_ROOT, "services", id, "service.json"), "utf8"),
      ) as Record<string, unknown>;
      writeManifest(id, manifest);
    }
    // An earlier release's checkout, with a directory the agent never recorded.
    mkdirSync(join(tmp, "custom_integrations", "hand-placed"), { recursive: true });
    const warnings = vi.spyOn(console, "error").mockImplementation(() => {});

    await renderComposeForRepo({
      rootDir: tmp,
      domain: "example.com",
      services: ["app-api,data-manager"],
    });

    const state = join(tmp, "infra", "docker", "state", "ops-agent");
    for (const store of ["custom-integrations", "community"]) {
      expect(statSync(join(state, store)).mode & 0o777).toBe(0o700);
    }
    expect(readdirSync(join(state, "custom-integrations"))).toEqual([]);
    const yaml = readFileSync(generatedCompose(), "utf8");
    const appApi = yaml.split("  app-api:")[1]?.split("\n  app-")[0] ?? "";
    // Relative to the generation, inside infra/docker/state/ops-agent.
    expect(appApi).toMatch(
      /- \.\.\/\.\.\/custom-integrations:\$\{OPENMAPX_CUSTOM_INTEGRATIONS_DIR:-\/app\/custom_integrations\}:ro/,
    );
    expect(yaml).not.toContain("/custom_integrations:${");
    expect(warnings.mock.calls.flat().join("\n")).toContain(
      "The integration hand-placed in custom_integrations was not copied into the operations agent's state: the agent holds no record of it.",
    );
    // Left in place, as everything in the checkout.
    expect(readdirSync(join(tmp, "custom_integrations"))).toEqual(["hand-placed"]);
  });

  it("mounts only the Transitous API keys directory into data-manager, where it reads them", async () => {
    for (const id of ["app-api", "data-manager", "ops-agent", "motis", "postgis", "redis"]) {
      const manifest = JSON.parse(
        readFileSync(join(REPO_ROOT, "services", id, "service.json"), "utf8"),
      ) as Record<string, unknown>;
      writeManifest(id, manifest);
    }
    // An earlier release's keys in the checkout.
    const legacy = join(tmp, "services", "motis", "tools", "transitous", "api-keys.json");
    mkdirSync(dirname(legacy), { recursive: true });
    writeFileSync(legacy, '{\n  "us-ca/NeedsKey": "secret"\n}\n', { mode: 0o600 });

    await renderComposeForRepo({
      rootDir: tmp,
      domain: "example.com",
      services: ["app-api,data-manager"],
    });

    const keysDirectory = join(tmp, "infra", "docker", "secrets", "transitous-api-keys");
    expect(readdirSync(keysDirectory)).toEqual(["api-keys.json"]);
    expect(readFileSync(join(keysDirectory, "api-keys.json"), "utf8")).toBe(
      readFileSync(legacy, "utf8"),
    );
    const yaml = readFileSync(generatedCompose(), "utf8");
    const dataManagerSection = yaml.split("  data-manager:")[1]?.split("\n  app-")[0] ?? "";
    // The directory, read-only, at the path data-manager reads by default.
    expect(dataManagerSection).toContain(
      "- ../../../../secrets/transitous-api-keys:/config/transitous:ro",
    );
    expect(dataManagerSection).not.toContain("services/motis/tools/transitous");
    expect(yaml.match(/transitous-api-keys/g)).toHaveLength(1);
  });

  it("mounts Traefik's static file from the generation and its dynamic directory from the agent's state", async () => {
    writeManifest(
      "traefik",
      JSON.parse(readFileSync(join(REPO_ROOT, "services", "traefik", "service.json"), "utf8")),
    );
    const config = join(tmp, "services", "traefik", "config");
    mkdirSync(join(config, "dynamic"), { recursive: true });
    writeFileSync(join(config, "traefik.yml"), "log: {}\n");
    writeFileSync(join(config, "dynamic", "middlewares.yml"), "http: {}\n");
    const legacyRoutes = join(config, "dynamic", "generated-routes.yml");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const notices = () =>
      errors.mock.calls
        .flat()
        .map(String)
        .filter((line) => line.includes("Traefik still reads its routes"));

    // A Traefik an earlier release started still reads the checkout's routes.
    vi.mocked(legacyTraefikDynamicMounted).mockResolvedValueOnce(true);
    await renderComposeForRepo({ rootDir: tmp, domain: "example.com", services: ["traefik"] });
    const yaml = readFileSync(generatedCompose(), "utf8");
    expect(yaml).toContain("- ./traefik/traefik.yml:/etc/traefik/traefik.yml:ro");
    expect(yaml).toContain("- ../../traefik/dynamic:/etc/traefik/dynamic:ro");
    expect(yaml).not.toContain("services/traefik/config");
    expect(permissions(currentGenerationFile("traefik", "traefik.yml"))).toBe(0o400);
    const dynamic = join(tmp, "infra", "docker", "state", "ops-agent", "traefik", "dynamic");
    expect(readdirSync(dynamic).sort()).toEqual(["generated-routes.yml", "middlewares.yml"]);
    expect(permissions(dynamic)).toBe(0o700);
    expect(readFileSync(legacyRoutes, "utf8")).toBe(
      readFileSync(join(dynamic, "generated-routes.yml"), "utf8"),
    );
    expect(notices()).toHaveLength(1);

    // Once none does, the checkout's file is left as it was and render is quiet.
    rmSync(legacyRoutes);
    errors.mockClear();
    await renderComposeForRepo({ rootDir: tmp, domain: "example.com", services: ["traefik"] });
    expect(existsSync(legacyRoutes)).toBe(false);
    expect(notices()).toEqual([]);
  });

  /** Martin in a git checkout, and a release of it as its operations-agent image prints it. */
  function martinCheckout() {
    const manifest = {
      ...baseManifest,
      id: "martin",
      bindMounts: [{ source: "config/martin.yaml", target: "/etc/martin/martin.yaml" }],
    };
    writeManifest("martin", manifest);
    const config = join(tmp, "services", "martin", "config");
    mkdirSync(config, { recursive: true });
    const shipped = "listen_addresses: 0.0.0.0:3000\n";
    writeFileSync(join(config, "martin.yaml"), shipped);
    const git = (...args: string[]) =>
      execFileSync(
        "git",
        [
          "-C",
          tmp,
          "-c",
          "user.name=OpenMapX",
          "-c",
          "user.email=ops@example.test",
          "-c",
          "commit.gpgsign=false",
          ...args,
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
    /** Commits the checkout's services; returns the commit. */
    const commit = (message: string) => {
      git("add", "services");
      git("commit", "-q", "-m", message);
      return git("rev-parse", "HEAD");
    };
    git("init", "-q");
    const sha = (text: string) => createHash("sha256").update(text).digest("hex");
    /** Selects the release built from `revision`, whose martin.yaml is `yaml`. */
    const select = (revision: string | null, yaml: string, earlier: string[] = []) =>
      vi.mocked(selectedReleaseServiceFiles).mockResolvedValue({
        files: {
          origin: "release",
          files: new Map([
            [
              "martin/config/martin.yaml",
              {
                serviceId: "martin",
                path: "config/martin.yaml",
                executable: false,
                bytes: Buffer.from(yaml),
                sha256: sha(yaml),
              },
            ],
          ]),
          history: new Map([
            ["martin/config/martin.yaml", new Set([sha(yaml), ...earlier.map(sha)])],
          ]),
          manifests: new Map([["martin", sha(JSON.stringify(manifest))]]),
          missing: [],
        },
        release: "r1",
        image: "ghcr.io/openmapx/ops-agent@sha256:1",
        revision,
      });
    const render = () =>
      renderComposeForRepo({ rootDir: tmp, domain: "example.com", services: ["martin"] });
    const mountedFile = () => {
      const line = readFileSync(generatedCompose(), "utf8")
        .split("\n")
        .find((entry) => entry.includes(":/etc/martin/martin.yaml"));
      return readFileSync(
        join(dirname(generatedCompose()), line?.trim().replace(/^- /, "").split(":")[0] ?? ""),
        "utf8",
      );
    };
    const overrides = join(tmp, "infra", "docker", "overrides");
    const marker = join(tmp, "infra", "docker", "state", "ops-agent", "overrides-import.json");
    return {
      manifest,
      config,
      shipped,
      git,
      commit,
      select,
      render,
      mountedFile,
      overrides,
      marker,
    };
  }

  it("renders a selected release's files, keeps checkout edits as overrides, and refuses while its manifests differ", async () => {
    const f = martinCheckout();
    try {
      // A checkout at the release: the release's file, as the store holds it.
      const first = f.commit("the release");
      f.select(first, f.shipped);
      await f.render();
      expect(f.mountedFile()).toBe(f.shipped);

      // One a later release left behind: refused, and nothing is imported from it.
      const newer = "listen_addresses: 0.0.0.0:3000\nworker_processes: 2\n";
      writeFileSync(join(f.config, "martin.yaml"), newer);
      const later = f.commit("the next release");
      f.git("checkout", "-q", first);
      rmSync(f.marker);
      f.select(later, newer, [f.shipped]);
      await expect(f.render()).rejects.toThrow("services/martin/config/martin.yaml (changed)");
      expect(existsSync(f.overrides)).toBe(false);
      // Refused before the import, which is still to run.
      expect(existsSync(f.marker)).toBe(false);

      // An operator's edit in a checkout behind the release: imported once as
      // an override, then used.
      writeFileSync(join(f.config, "martin.yaml"), "listen_addresses: 0.0.0.0:3001\n");
      // log.info writes to stdout, log.warn to stderr with ⚠.
      const infos = vi.spyOn(console, "log").mockImplementation(() => {});
      const warnings = vi.spyOn(console, "error").mockImplementation(() => {});
      await f.render();
      // What the import did and the override it made: information.
      const said = infos.mock.calls.flat().map(String);
      expect(said).toContainEqual(expect.stringMatching(/^Imported 1 checkout service file/));
      expect(said).toContainEqual(
        "Service file overrides in use, in place of the release's files (infra/docker/overrides/services): martin/config/martin.yaml.",
      );
      expect(warnings.mock.calls.flat().join("\n")).not.toMatch(/Imported|overrides in use/);
      infos.mockRestore();
      warnings.mockRestore();
      expect(
        readFileSync(join(f.overrides, "services", "martin", "config", "martin.yaml"), "utf8"),
      ).toBe("listen_addresses: 0.0.0.0:3001\n");
      expect(f.mountedFile()).toBe("listen_addresses: 0.0.0.0:3001\n");
      expect(existsSync(f.marker)).toBe(true);

      // A checkout whose manifest is not the release's: refused, with what to do.
      writeManifest("martin", { ...f.manifest, version: "2.0.0" });
      const refused = await f.render().catch((error: Error) => error.message);
      expect(refused).toContain(
        `The checkout's built-in services differ from the selected release r1, built from ${later}:\n  services/martin/service.json (changed)`,
      );
      expect(refused).toContain(
        `Either wait until the release of this checkout's commit is published and run \`pnpm openmapx compose release\` again, or check out the selected release's source: git checkout ${later}`,
      );
      expect(refused).toContain("infra/docker/overrides/services/<id>/<path>");
    } finally {
      vi.mocked(selectedReleaseServiceFiles).mockResolvedValue("none");
    }
  });

  it("imports nothing from a checkout one commit ahead of the release with a changed upstream file, and refuses", async () => {
    const f = martinCheckout();
    try {
      const released = f.commit("the release");
      // Upstream's next commit changes martin.yaml; its release isn't published yet.
      writeFileSync(
        join(f.config, "martin.yaml"),
        "listen_addresses: 0.0.0.0:3000\nworker_processes: 8\n",
      );
      f.commit("upstream, ahead of the release");
      f.select(released, f.shipped);

      const refused = await f.render().catch((error: Error) => error.message);
      expect(refused).toContain("  services/martin/config/martin.yaml (changed)");
      expect(refused).toContain(
        `Your edits in the checkout's service files are not imported as overrides meanwhile: the checkout's commit is neither the release's source revision ${released} nor one before it.`,
      );
      expect(existsSync(f.overrides)).toBe(false);
      expect(existsSync(f.marker)).toBe(false);

      // A basic-auth file the waiting import would carry over: refused by name,
      // until it is an override; then the rest of the refusal stands.
      const dynamic = join(tmp, "services", "traefik", "config", "dynamic");
      mkdirSync(dynamic, { recursive: true });
      writeFileSync(join(dynamic, "auth.yml"), "http: {}\n");
      await expect(f.render()).rejects.toThrow(
        "the checkout holds Traefik files the import would carry over, and the release's files in their place could drop a basic-auth gate: services/traefik/config/dynamic/auth.yml.",
      );
      const overridden = join(f.overrides, "services", "traefik", "config", "dynamic");
      mkdirSync(overridden, { recursive: true, mode: 0o755 });
      for (const directory of [f.overrides, join(f.overrides, "services")]) {
        chmodSync(directory, 0o755);
      }
      for (const directory of ["traefik", "traefik/config", "traefik/config/dynamic"]) {
        chmodSync(join(f.overrides, "services", directory), 0o755);
      }
      writeFileSync(join(overridden, "auth.yml"), "http: {}\n", { mode: 0o600 });
      chmodSync(join(overridden, "auth.yml"), 0o600);
      const rest = await f.render().catch((error: Error) => error.message);
      expect(rest).toContain("  services/martin/config/martin.yaml (changed)");
      expect(rest).not.toContain("auth.yml");
      expect(existsSync(f.marker)).toBe(false);
      rmSync(f.overrides, { recursive: true });
      rmSync(join(dynamic, "auth.yml"));

      // Without a revision to compare with, the import waits too.
      f.select(null, f.shipped);
      await expect(f.render()).rejects.toThrow(
        "not imported as overrides meanwhile: the selected release's operations-agent image names no source revision",
      );
      expect(existsSync(f.overrides)).toBe(false);
      expect(existsSync(f.marker)).toBe(false);
    } finally {
      vi.mocked(selectedReleaseServiceFiles).mockResolvedValue("none");
    }
  });

  it("rejects pre-existing identical ops-agent role tokens", async () => {
    writeManifest("alpha", { ...baseManifest, id: "alpha" });
    const secretDir = join(tmp, "infra", "docker", "secrets");
    mkdirSync(secretDir, { recursive: true, mode: 0o700 });
    const token = Buffer.alloc(32, 21).toString("base64url");
    writeFileSync(join(secretDir, "ops-agent-api-token"), token, { mode: 0o444 });
    writeFileSync(join(secretDir, "ops-agent-data-manager-token"), token, { mode: 0o444 });

    await expect(
      renderComposeForRepo({ rootDir: tmp, domain: "example.com", services: ["alpha"] }),
    ).rejects.toThrow("must be distinct");
  });
});

describe("rotateRedisPasswordForRepo", () => {
  async function bootstrapAuthFiles() {
    writeManifest("alpha", { ...baseManifest, id: "alpha" });
    await renderComposeForRepo({ rootDir: tmp, domain: "example.com", services: ["alpha"] });
    const secretDir = join(tmp, "infra", "docker", "secrets");
    return {
      secretDir,
      passwordPath: join(secretDir, "redis-password"),
      aclPath: join(secretDir, "redis-acl.conf"),
    };
  }

  function expectAclMatchesPassword(passwordPath: string, aclPath: string) {
    const password = readFileSync(passwordPath, "utf8");
    expect(readFileSync(aclPath, "utf8")).toBe(
      `user default on #${createHash("sha256").update(password).digest("hex")} ~* &* +@all\n`,
    );
  }

  it("requires the stopped-client confirmation, rotates without returning the secret, and rerenders stably", async () => {
    writeManifest("alpha", { ...baseManifest, id: "alpha" });
    await renderComposeForRepo({ rootDir: tmp, domain: "example.com", services: ["alpha"] });
    const secretDir = join(tmp, "infra", "docker", "secrets");
    const passwordPath = join(secretDir, "redis-password");
    const aclPath = join(secretDir, "redis-acl.conf");
    const original = readFileSync(passwordPath, "utf8");

    expect(() =>
      rotateRedisPasswordForRepo({
        rootDir: tmp,
        confirmClientsStopped: false,
      }),
    ).toThrow(/clients must be stopped/);
    expect(readFileSync(passwordPath, "utf8")).toBe(original);

    const rotatedValue = Buffer.alloc(32, 18).toString("base64url");
    const result = rotateRedisPasswordForRepo({
      rootDir: tmp,
      confirmClientsStopped: true,
      randomBytes: () => Buffer.alloc(32, 18),
    });

    expect(result).toEqual({ passwordPath, aclPath });
    expect(JSON.stringify(result)).not.toContain(rotatedValue);
    expect(readFileSync(passwordPath, "utf8")).toBe(rotatedValue);
    expect(readFileSync(aclPath, "utf8")).toBe(
      `user default on #${createHash("sha256").update(rotatedValue).digest("hex")} ~* &* +@all\n`,
    );

    await renderComposeForRepo({ rootDir: tmp, domain: "example.com", services: ["alpha"] });
    expect(readFileSync(passwordPath, "utf8")).toBe(rotatedValue);
  });

  it("prepares the derived ACL before committing the password", async () => {
    const { passwordPath, aclPath } = await bootstrapAuthFiles();
    const originalPassword = readFileSync(passwordPath, "utf8");
    const oldAcl = readFileSync(aclPath, "utf8");

    expect(() =>
      rotateRedisPasswordForRepo({
        rootDir: tmp,
        confirmClientsStopped: true,
        randomBytes: () => Buffer.alloc(32, 21),
        aclTemporaryFileOps: {
          fsync: () => {
            throw new Error("injected-acl-fsync-failure");
          },
        },
      }),
    ).toThrow(/ACL candidate preparation failed/);
    expect(readFileSync(passwordPath, "utf8")).toBe(originalPassword);
    expect(readFileSync(aclPath, "utf8")).toBe(oldAcl);
  });

  it.each(["symlink", "hardlink", "directory"] as const)(
    "rejects a malformed %s ACL target before changing the password",
    async (kind) => {
      const { secretDir, passwordPath, aclPath } = await bootstrapAuthFiles();
      const originalPassword = readFileSync(passwordPath, "utf8");
      if (kind === "symlink") {
        const outside = join(tmp, "outside-acl");
        writeFileSync(outside, "not-authoritative");
        rmSync(aclPath);
        symlinkSync(outside, aclPath);
      } else if (kind === "hardlink") {
        linkSync(aclPath, join(secretDir, "acl-alias"));
      } else {
        rmSync(aclPath);
        mkdirSync(aclPath);
      }

      expect(() =>
        rotateRedisPasswordForRepo({
          rootDir: tmp,
          confirmClientsStopped: true,
          randomBytes: () => Buffer.alloc(32, 22),
        }),
      ).toThrow(/ACL target preflight failed/);
      expect(readFileSync(passwordPath, "utf8")).toBe(originalPassword);
    },
  );

  it("applies the ACL owner-policy seam before changing the password", async () => {
    const { passwordPath } = await bootstrapAuthFiles();
    const originalPassword = readFileSync(passwordPath, "utf8");
    const options = {
      rootDir: tmp,
      confirmClientsStopped: true,
      randomBytes: () => Buffer.alloc(32, 23),
      aclTargetMetadataValidator: () => {
        throw new Error("injected ACL owner mismatch");
      },
    } as Parameters<typeof rotateRedisPasswordForRepo>[0];

    expect(() => rotateRedisPasswordForRepo(options)).toThrow(/ACL target preflight failed.*owner/);
    expect(readFileSync(passwordPath, "utf8")).toBe(originalPassword);
  });

  it("reports a post-password ACL integrity race and recovers by rendering while clients stay stopped", async () => {
    const { secretDir, passwordPath, aclPath } = await bootstrapAuthFiles();
    const rotatedPassword = Buffer.alloc(32, 27).toString("base64url");
    const options = {
      rootDir: tmp,
      confirmClientsStopped: true,
      randomBytes: () => Buffer.alloc(32, 27),
      rotationHooks: {
        afterPasswordCommitted: () => {
          const replacement = join(secretDir, "concurrent-acl");
          writeFileSync(replacement, "concurrent-valid-target\n", { mode: 0o444 });
          renameSync(replacement, aclPath);
        },
      },
    } as Parameters<typeof rotateRedisPasswordForRepo>[0];

    expect(() => rotateRedisPasswordForRepo(options)).toThrow(
      /password commit succeeded but the ACL commit failed.*target integrity/,
    );
    expect(readFileSync(passwordPath, "utf8")).toBe(rotatedPassword);

    await renderComposeForRepo({ rootDir: tmp, domain: "example.com", services: ["alpha"] });
    expectAclMatchesPassword(passwordPath, aclPath);
  });

  it("classifies a post-rename password verification race as crossed-boundary and recovers by rendering", async () => {
    const { secretDir, passwordPath, aclPath } = await bootstrapAuthFiles();
    const concurrentPassword = Buffer.alloc(32, 29).toString("base64url");
    const options = {
      rootDir: tmp,
      confirmClientsStopped: true,
      randomBytes: () => Buffer.alloc(32, 28),
      passwordReplacementHooks: {
        afterRename: () => {
          const replacement = join(secretDir, "concurrent-password");
          writeFileSync(replacement, concurrentPassword, { mode: 0o444 });
          renameSync(replacement, passwordPath);
        },
      },
    } as Parameters<typeof rotateRedisPasswordForRepo>[0];

    let rotationError: Error | undefined;
    try {
      rotateRedisPasswordForRepo(options);
    } catch (error) {
      rotationError = error as Error;
    }
    expect(rotationError?.message).toMatch(
      /password commit crossed the rename boundary.*keep Redis clients stopped.*compose render/,
    );
    expect(rotationError?.message).not.toMatch(/without changing the password/);
    expect(readFileSync(passwordPath, "utf8")).toBe(concurrentPassword);

    await renderComposeForRepo({ rootDir: tmp, domain: "example.com", services: ["alpha"] });
    expectAclMatchesPassword(passwordPath, aclPath);
  });

  it("reconciles a render that observed the password before a concurrent rotation", async () => {
    const { passwordPath, aclPath } = await bootstrapAuthFiles();
    const concurrentPassword = Buffer.alloc(32, 24).toString("base64url");
    let interleaved = false;
    const options = {
      rootDir: tmp,
      domain: "example.com",
      services: ["alpha"],
      redisAuthHooks: {
        afterPasswordObserved: () => {
          if (interleaved) return;
          interleaved = true;
          rotateRedisPasswordForRepo({
            rootDir: tmp,
            confirmClientsStopped: true,
            randomBytes: () => Buffer.alloc(32, 24),
          });
        },
      },
    } as Parameters<typeof renderComposeForRepo>[0];

    await renderComposeForRepo(options);
    expect(readFileSync(passwordPath, "utf8")).toBe(concurrentPassword);
    expectAclMatchesPassword(passwordPath, aclPath);
  });

  it("reconciles overlapping rotations to the authoritative password", async () => {
    const { passwordPath, aclPath } = await bootstrapAuthFiles();
    const lastPassword = Buffer.alloc(32, 26).toString("base64url");
    let interleaved = false;
    const options = {
      rootDir: tmp,
      confirmClientsStopped: true,
      randomBytes: () => Buffer.alloc(32, 25),
      redisAuthHooks: {
        afterPasswordObserved: () => {
          if (interleaved) return;
          interleaved = true;
          rotateRedisPasswordForRepo({
            rootDir: tmp,
            confirmClientsStopped: true,
            randomBytes: () => Buffer.alloc(32, 26),
          });
        },
      },
    } as Parameters<typeof rotateRedisPasswordForRepo>[0];

    rotateRedisPasswordForRepo(options);
    expect(readFileSync(passwordPath, "utf8")).toBe(lastPassword);
    expectAclMatchesPassword(passwordPath, aclPath);
  });

  it("fails explicitly when bounded reconciliation cannot catch continuous churn", async () => {
    const { passwordPath } = await bootstrapAuthFiles();
    const options = {
      rootDir: tmp,
      domain: "example.com",
      services: ["alpha"],
      redisAuthHooks: {
        afterPasswordObserved: (attempt: number) => {
          rotatePlatformSecretFile(passwordPath, {
            randomBytes: () => Buffer.alloc(32, 40 + attempt),
          });
        },
      },
    } as Parameters<typeof renderComposeForRepo>[0];

    await expect(renderComposeForRepo(options)).rejects.toThrow(/continuous password churn/);
  });
});

describe("renderComposeForRepo and what the admin panel applied", () => {
  const ingest = {
    ...baseManifest,
    id: "ingest",
    configSchema: {
      type: "object",
      properties: {
        MODE: { type: "string", default: "standard" },
        NH_API_KEY: { type: "string", "x-openmapx-secret": true },
      },
    },
  };

  /** An admin apply that saved config and a vault secret for ingest without enabling it. */
  async function adminApply(transitCredentialsRevision?: string) {
    writeManifest("alpha", { ...baseManifest, id: "alpha" });
    writeManifest("ingest", ingest);
    const registry = new coreServices.ServiceRegistry({ rootDir: tmp });
    await registry.load();
    await coreServices.commitConfigurationGeneration({
      infraDir: join(tmp, "infra", "docker"),
      services: registry.list(),
      input: {
        domain: "example.com",
        ...(transitCredentialsRevision ? { transitCredentialsRevision } : {}),
        selectedRoots: ["alpha"],
        serviceConfigs: [{ serviceId: "ingest", values: { MODE: "saved" } }],
        integrationConfigs: [],
        serviceSecrets: [{ serviceId: "ingest", values: { NH_API_KEY: "secret-value" } }],
      },
    });
  }

  afterEach(() => {
    delete process.env.SERVICE_INGEST_MODE;
  });

  it("preserves the opaque transit credential version during the actual CLI render", async () => {
    const revision = "c".repeat(64);
    await adminApply(revision);
    await renderComposeForRepo({ rootDir: tmp, domain: "example.com", services: ["alpha"] });
    expect(coreServices.readAppliedTransitCredentialsRevision(join(tmp, "infra/docker"))).toBe(
      revision,
    );
  });

  it("keeps saved config and vault secrets, also for a service it enables later", async () => {
    await adminApply();

    await renderComposeForRepo({
      rootDir: tmp,
      domain: "example.com",
      services: ["alpha,ingest"],
    });
    const yaml = readFileSync(generatedCompose(), "utf-8");
    expect(yaml).toContain("MODE: saved");
    expect(yaml).toContain("NH_API_KEY_FILE: /run/secrets/NH_API_KEY");
    expect(
      readFileSync(currentGenerationFile(".generated-secrets", "ingest", "NH_API_KEY"), "utf-8"),
    ).toBe("secret-value");
  });

  it("replaces a saved value with a reference when the host env sets it", async () => {
    await adminApply();
    process.env.SERVICE_INGEST_MODE = "from-env";

    await renderComposeForRepo({ rootDir: tmp, domain: "example.com", services: ["ingest"] });
    const yaml = readFileSync(generatedCompose(), "utf-8");
    expect(yaml).toContain(`MODE: \${SERVICE_INGEST_MODE:-}`);
    expect(yaml).not.toContain("from-env");
  });
});

it("keeps adopted platform slots across CLI renders and an invocation domain override", async () => {
  writeManifest("alpha", {
    ...baseManifest,
    id: "alpha",
    container: {
      ...baseManifest.container,
      environment: {
        PUBLIC_ORIGIN: "https://${DOMAIN:-localhost}",
        OPENMAPX_REGION: "${OPENMAPX_REGION:-}",
        CONTACT: "${ACME_EMAIL:-admin@example.com}",
      },
    },
  });
  await renderComposeForRepo({ rootDir: tmp, services: ["alpha"] });
  const registry = new coreServices.ServiceRegistry({ rootDir: tmp });
  await registry.load();
  const platform = {
    version: 1 as const,
    domain: { source: "database" as const, value: "adopted.example.test" },
    acmeEmail: { source: "database" as const, value: "operator@example.test" },
    defaultRegion: { source: "database" as const, value: "europe/germany" },
  };
  await coreServices.commitConfigurationGeneration({
    infraDir: join(tmp, "infra/docker"),
    services: registry.list(),
    input: {
      domain: "adopted.example.test",
      platform,
      selectedRoots: ["alpha"],
      serviceConfigs: [],
      serviceSecrets: [],
      integrationConfigs: [],
    },
  });
  const previousRoot = process.env.OPENMAPX_ROOT_DIR;
  const previousRegion = process.env.OPENMAPX_REGION;
  try {
    process.env.OPENMAPX_ROOT_DIR = tmp;
    process.env.OPENMAPX_REGION = "europe/france";
    const { resolveOsmRegion } = await import("../src/lib/env-defaults");
    expect(resolveOsmRegion(undefined)).toEqual({ value: "europe/germany" });
    expect(resolveOsmRegion("europe/austria")).toEqual({ value: "europe/austria" });
  } finally {
    if (previousRoot === undefined) delete process.env.OPENMAPX_ROOT_DIR;
    else process.env.OPENMAPX_ROOT_DIR = previousRoot;
    if (previousRegion === undefined) delete process.env.OPENMAPX_REGION;
    else process.env.OPENMAPX_REGION = previousRegion;
  }
  await renderComposeForRepo({ rootDir: tmp, services: ["alpha"] });
  expect(readFileSync(generatedCompose(), "utf8")).toContain(
    "PUBLIC_ORIGIN: https://adopted.example.test",
  );
  expect(readFileSync(generatedCompose(), "utf8")).toContain("OPENMAPX_REGION: europe/germany");
  expect(coreServices.readAppliedPlatformConfiguration(join(tmp, "infra/docker"))).toEqual(
    platform,
  );
  await renderComposeForRepo({ rootDir: tmp, services: ["alpha"], domain: "once.example.test" });
  expect(readFileSync(generatedCompose(), "utf8")).toContain(
    "PUBLIC_ORIGIN: https://once.example.test",
  );
  expect(coreServices.readAppliedPlatformConfiguration(join(tmp, "infra/docker"))).toEqual(
    platform,
  );
  await renderComposeForRepo({ rootDir: tmp, services: ["alpha"] });
  expect(readFileSync(generatedCompose(), "utf8")).toContain(
    "PUBLIC_ORIGIN: https://adopted.example.test",
  );
});

it("allows an explicit domain override when the unrelated host domain is malformed", async () => {
  const previous = process.env.DOMAIN;
  process.env.DOMAIN = "https://old-invalid.example.test";
  try {
    writeManifest("demo", { ...baseManifest, id: "demo" });
    const result = await renderComposeForRepo({
      rootDir: tmp,
      domain: "maps.example.test",
      services: ["demo"],
    });
    expect(result.enabledServiceIds).toContain("demo");
  } finally {
    if (previous === undefined) delete process.env.DOMAIN;
    else process.env.DOMAIN = previous;
  }
});
