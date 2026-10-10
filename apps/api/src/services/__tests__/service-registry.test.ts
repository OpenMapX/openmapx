import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { services } from "@openmapx/core/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getServiceRegistry, initServiceRegistry } from "../service-registry";

let tmp: string;
let originalCwd: string;

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
  delete process.env.OPENMAPX_APPLIED_SERVICES;
  originalCwd = process.cwd();
  tmp = mkdtempSync(join(tmpdir(), "openmapx-api-service-registry-"));
  mkdirSync(join(tmp, "apps", "api"), { recursive: true });
  mkdirSync(join(tmp, "infra", "docker"), { recursive: true });
  writeFileSync(join(tmp, "pnpm-workspace.yaml"), "packages: []\n");
  process.chdir(join(tmp, "apps", "api"));
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tmp, { recursive: true, force: true });
});

describe("initServiceRegistry", () => {
  it("honors the persisted service-selection file when env selection is absent", async () => {
    writeManifest("app-api", {
      ...baseManifest,
      id: "app-api",
      container: {
        ...baseManifest.container,
        dependsOn: [{ service: "postgis", condition: "service_healthy" }],
      },
    });
    writeManifest("postgis", { ...baseManifest, id: "postgis" });
    writeManifest("valhalla", { ...baseManifest, id: "valhalla" });
    writeManifest("traefik", { ...baseManifest, id: "traefik" });
    writeManifest("well-known", { ...baseManifest, id: "well-known" });
    writeManifest("app-web", { ...baseManifest, id: "app-web" });
    writeManifest("redis", { ...baseManifest, id: "redis" });
    writeManifest("data-manager", { ...baseManifest, id: "data-manager" });

    writeFileSync(
      join(tmp, "infra", "docker", "service-selection.json"),
      JSON.stringify({ selected: ["app-api", "valhalla"] }, null, 2),
      "utf-8",
    );

    await initServiceRegistry();

    const enabled = getServiceRegistry()
      .enabled()
      .map((service) => service.manifest.id)
      .sort();
    expect(enabled).toEqual(["app-api", "postgis", "valhalla"]);
  });

  it("prefers OPENMAPX_ENABLED_SERVICES over the persisted selection file", async () => {
    writeManifest("app-api", { ...baseManifest, id: "app-api" });
    writeManifest("postgis", { ...baseManifest, id: "postgis" });
    writeManifest("valhalla", { ...baseManifest, id: "valhalla" });

    writeFileSync(
      join(tmp, "infra", "docker", "service-selection.json"),
      JSON.stringify({ selected: ["valhalla"] }, null, 2),
      "utf-8",
    );
    process.env.OPENMAPX_ENABLED_SERVICES = "app-api,postgis";

    await initServiceRegistry();

    const enabled = getServiceRegistry()
      .enabled()
      .map((service) => service.manifest.id)
      .sort();
    expect(enabled).toEqual(["app-api", "postgis"]);
  });

  it("follows the applied generation rather than the selection it has not applied yet", async () => {
    writeManifest("app-api", { ...baseManifest, id: "app-api" });
    writeManifest("valhalla", { ...baseManifest, id: "valhalla" });
    const loaded = new services.ServiceRegistry({ rootDir: tmp });
    await loaded.load();
    await services.commitConfigurationGeneration({
      infraDir: join(tmp, "infra", "docker"),
      services: loaded.list(),
      input: {
        domain: "localhost",
        selectedRoots: ["valhalla"],
        serviceConfigs: [],
        integrationConfigs: [],
        serviceSecrets: [],
      },
    });
    writeFileSync(
      join(tmp, "infra", "docker", "service-selection.json"),
      JSON.stringify({ selected: ["app-api"] }),
    );

    await initServiceRegistry();

    expect(
      getServiceRegistry()
        .enabled()
        .map((service) => service.manifest.id),
    ).toEqual(["valhalla"]);
  });

  it("takes the applied services its render baked into app-api", async () => {
    writeManifest("app-api", { ...baseManifest, id: "app-api" });
    writeManifest("postgis", { ...baseManifest, id: "postgis" });
    writeManifest("valhalla", { ...baseManifest, id: "valhalla" });
    process.env.OPENMAPX_APPLIED_SERVICES = "app-api,postgis";

    await initServiceRegistry();

    expect(
      getServiceRegistry()
        .enabled()
        .map((service) => service.manifest.id)
        .sort(),
    ).toEqual(["app-api", "postgis"]);
  });

  it("fails closed on a malformed or dangling trusted selection pointer", async () => {
    writeManifest("app-api", { ...baseManifest, id: "app-api" });
    symlinkSync(
      join(".trusted-config-generations", `cfg1_${"z".repeat(43)}`),
      join(tmp, "infra", "docker", ".trusted-config-current"),
    );
    await expect(initServiceRegistry()).rejects.toThrow();
  });
});
