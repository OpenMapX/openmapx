import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { services as coreServices } from "@openmapx/core/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderComposeForRepo, rotateRedisPasswordForRepo } from "../src/commands/compose";
import { rotatePlatformSecretFile } from "../src/lib/platform-secret-files";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

/** The `NAME: <dollar>{NAME:-fallback}` line Compose rendering produces. */
function composeDefault(name: string, fallback: string): string {
  return `${name}: ` + "$" + `{${name}:-${fallback}}`;
}

const { readServiceSecretKeysFromCompose } = coreServices;

let tmp: string;
let originalPostgresPassword: string | undefined;

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
  process.env.POSTGRES_PASSWORD = "x".repeat(24);
  delete process.env.OPENMAPX_ENABLED_SERVICES;
  tmp = mkdtempSync(join(tmpdir(), "openmapx-cli-render-"));
  writeFileSync(join(tmp, "pnpm-workspace.yaml"), "packages: []\n");
  mkdirSync(join(tmp, "infra", "docker"), { recursive: true });
});

afterEach(() => {
  if (originalPostgresPassword === undefined) delete process.env.POSTGRES_PASSWORD;
  else process.env.POSTGRES_PASSWORD = originalPostgresPassword;
  rmSync(tmp, { recursive: true, force: true });
});

describe("renderComposeForRepo", () => {
  it("rejects an unsafe deployment password before creating render output", async () => {
    writeManifest("alpha", { ...baseManifest, id: "alpha" });
    process.env.POSTGRES_PASSWORD = "change-me";

    await expect(
      renderComposeForRepo({ rootDir: tmp, domain: "example.com", services: ["alpha"] }),
    ).rejects.toThrow(/known-placeholder/);
    expect(existsSync(join(tmp, "infra", "docker", "docker-compose.generated.yml"))).toBe(false);
    expect(existsSync(join(tmp, "infra", "docker", "secrets"))).toBe(false);
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

    const composePath = join(tmp, "infra", "docker", "docker-compose.generated.yml");
    const yaml = readFileSync(composePath, "utf-8");
    expect(yaml).toContain("services:");
    expect(yaml).toContain("alpha:");
    expect(yaml).toContain("beta:");
    const queue = lstatSync(join(tmp, "infra", "docker", "data", "ops-agent", "trusted-config"));
    expect(queue.isDirectory()).toBe(true);
    expect(queue.mode & 0o777).toBe(0o700);
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
    writeManifest("valhalla", { ...baseManifest, id: "valhalla" });

    const result = await renderComposeForRepo({ rootDir: tmp, domain: "example.com" });

    expect(result.enabledServiceIds).toEqual(["app-api", "postgis", "redis", "traefik"]);
    const yaml = readFileSync(
      join(tmp, "infra", "docker", "docker-compose.generated.yml"),
      "utf-8",
    );
    expect(yaml).toContain("app-api:");
    expect(yaml).toContain("postgis:");
    expect(yaml).toContain("redis:");
    expect(yaml).toContain("traefik:");
    expect(yaml).not.toContain("valhalla:");
    expect(yaml).toContain("OPENMAPX_ENABLED_SERVICES: app-api,postgis,redis,traefik");
  });

  it("renders the real app-api OSM contribution controls with both flags off", async () => {
    // Rendered from the checked-in manifest, not a fixture: this is the guard
    // that a shipped deployment defaults to contributions disabled.
    const manifest = JSON.parse(
      readFileSync(join(REPO_ROOT, "services", "app-api", "service.json"), "utf-8"),
    ) as { container: { environment: Record<string, string> } };
    writeManifest("app-api", manifest as unknown as Record<string, unknown>);

    await renderComposeForRepo({ rootDir: tmp, domain: "example.com", services: ["app-api"] });
    const yaml = readFileSync(
      join(tmp, "infra", "docker", "docker-compose.generated.yml"),
      "utf-8",
    );

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
    const planPath = join(tmp, "infra", "docker", "docker-compose.generated.hardlinks.json");
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

    for (const id of ["redis", "app-api", "data-manager"]) {
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
      services: ["redis,app-api,data-manager"],
    });
    const composePath = join(tmp, "infra", "docker", "docker-compose.generated.yml");
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
    expect(firstYaml.match(/redis-password:\/run\/secrets\/redis-password:ro/g)).toHaveLength(3);

    await renderComposeForRepo({
      rootDir: tmp,
      domain: "example.com",
      services: ["redis,app-api,data-manager"],
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
    const composePath = join(tmp, "infra", "docker", "docker-compose.generated.yml");
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
    const yaml = readFileSync(join(tmp, "infra", "docker", "docker-compose.generated.yml"), "utf8");

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

describe("renderComposeForRepo vault-secret preservation", () => {
  const composePathIn = () => join(tmp, "infra", "docker", "docker-compose.generated.yml");
  const secretsDirIn = () => join(tmp, "infra", "docker", ".generated-secrets");

  function writePriorComposeWithIngestSecret() {
    // Shape the app-api (vault-backed) render produces for a credentialed
    // extension service: top-level file secret + per-service mount + _FILE env.
    writeFileSync(
      composePathIn(),
      [
        "services:",
        "  ingest:",
        "    image: t/x:latest",
        "    environment:",
        "      NH_API_KEY_FILE: /run/secrets/NH_API_KEY",
        "    secrets:",
        "      - source: ingest__NH_API_KEY",
        "        target: NH_API_KEY",
        "secrets:",
        "  ingest__NH_API_KEY:",
        "    file: ./.generated-secrets/ingest/NH_API_KEY",
        "",
      ].join("\n"),
    );
  }

  it("a narrowed render keeps the excluded service's secret record; the next full render re-attaches it", async () => {
    writeManifest("alpha", { ...baseManifest, id: "alpha" });
    writeManifest("ingest", { ...baseManifest, id: "ingest" });
    writePriorComposeWithIngestSecret();

    // Narrowed render (`--services alpha`): ingest is not part of this pass.
    await renderComposeForRepo({ rootDir: tmp, domain: "example.com", services: ["alpha"] });
    const afterNarrowed = readServiceSecretKeysFromCompose(composePathIn());
    expect(afterNarrowed.get("ingest")).toEqual(["NH_API_KEY"]);

    // Full render: the preserved record re-attaches the mounts to the service.
    await renderComposeForRepo({
      rootDir: tmp,
      domain: "example.com",
      services: ["alpha,ingest"],
    });
    const yaml = readFileSync(composePathIn(), "utf-8");
    expect(yaml).toContain("NH_API_KEY_FILE: /run/secrets/NH_API_KEY");
    expect(yaml).toContain("source: ingest__NH_API_KEY");
    expect(yaml).toContain("./.generated-secrets/ingest/NH_API_KEY");
  });

  it("recovers key names from a readable .generated-secrets dir when the compose is missing", async () => {
    writeManifest("ingest", { ...baseManifest, id: "ingest" });
    mkdirSync(join(secretsDirIn(), "ingest"), { recursive: true });
    writeFileSync(join(secretsDirIn(), "ingest", "NH_API_KEY"), "secret-value");

    await renderComposeForRepo({ rootDir: tmp, domain: "example.com", services: ["ingest"] });
    const yaml = readFileSync(composePathIn(), "utf-8");
    expect(yaml).toContain("NH_API_KEY_FILE: /run/secrets/NH_API_KEY");
    expect(yaml).toContain("./.generated-secrets/ingest/NH_API_KEY");
  });

  it("refuses to render when .generated-secrets exists but no secret keys are recoverable", async () => {
    writeManifest("alpha", { ...baseManifest, id: "alpha" });
    // Vault dir present (as far as a non-root CLI can tell) but empty-looking:
    // compose absent + nothing listable → rendering would strip the mounts.
    mkdirSync(secretsDirIn(), { recursive: true });

    await expect(
      renderComposeForRepo({ rootDir: tmp, domain: "example.com", services: ["alpha"] }),
    ).rejects.toThrow(/un-credential/);
    // The guard must refuse BEFORE overwriting the compose.
    expect(() => readFileSync(composePathIn(), "utf-8")).toThrow();
  });

  it("--drop-secrets explicitly renders without the vault mounts", async () => {
    writeManifest("alpha", { ...baseManifest, id: "alpha" });
    mkdirSync(secretsDirIn(), { recursive: true });

    const result = await renderComposeForRepo({
      rootDir: tmp,
      domain: "example.com",
      services: ["alpha"],
      dropSecrets: true,
    });
    expect(result.servicesRendered).toBe(1);
    const yaml = readFileSync(composePathIn(), "utf-8");
    expect(yaml).not.toContain("secrets:");
  });
});
