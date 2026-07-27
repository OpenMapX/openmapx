import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { services as coreServices } from "@openmapx/core/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderComposeForRepo } from "../src/commands/compose";

const { readServiceSecretKeysFromCompose } = coreServices;

let tmp: string;

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
  delete process.env.OPENMAPX_ENABLED_SERVICES;
  tmp = mkdtempSync(join(tmpdir(), "openmapx-cli-render-"));
  writeFileSync(join(tmp, "pnpm-workspace.yaml"), "packages: []\n");
  mkdirSync(join(tmp, "infra", "docker"), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("renderComposeForRepo", () => {
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
