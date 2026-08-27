import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { services } from "@openmapx/core/server";
import { afterEach, describe, expect, it } from "vitest";
import { createTrustedConfigurationAuthorityLoader } from "./trusted-configuration-authority";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function builtIn(id = "alpha"): services.LoadedService {
  return {
    manifest: {
      id,
      name: id,
      version: "1.0.0",
      quality: "built-in",
      container: { image: `example/${id}`, tag: "1" },
    },
    directory: `/trusted/${id}`,
    isBuiltIn: true,
    enabled: true,
  };
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "openmapx-live-authority-"));
  roots.push(root);
  chmodSync(root, 0o755);
  mkdirSync(join(root, "services", ".community"), { recursive: true, mode: 0o755 });
  mkdirSync(join(root, "custom_integrations"), { mode: 0o755 });
  return root;
}

function installService(root: string): string {
  const directory = join(root, "services", ".community", "0123456789abcdef", "services", "live");
  mkdirSync(directory, { recursive: true, mode: 0o755 });
  writeFileSync(
    join(directory, "service.json"),
    JSON.stringify({
      id: "community-live",
      name: "Community Live",
      version: "1.0.0",
      quality: "community",
      container: {
        image: "registry.example.test/community-live",
        tag: "1.0.0",
        digest: `sha256:${"a".repeat(64)}`,
      },
      configSchema: { type: "object", properties: { region: { enum: ["eu"] } } },
    }),
    { mode: 0o644 },
  );
  return directory;
}

function installIntegration(root: string, allowed = "eu"): string {
  const directory = join(root, "custom_integrations", "integration-live");
  mkdirSync(directory, { recursive: true, mode: 0o755 });
  writeFileSync(
    join(directory, "manifest.json"),
    JSON.stringify({
      id: "integration-live",
      configSchema: { type: "object", properties: { region: { enum: [allowed] } } },
    }),
    { mode: 0o644 },
  );
  return directory;
}

describe("refreshed trusted configuration authority", () => {
  it("atomically observes a live service/integration install, schema update, and removal", async () => {
    const root = fixture();
    const load = createTrustedConfigurationAuthorityLoader({
      rootDir: root,
      builtInServices: [builtIn()],
    });
    const initial = await load();
    expect(initial.services.map((service) => service.manifest.id)).toEqual(["alpha"]);
    expect(initial.integrationSchemas).toEqual(new Map());

    const serviceDirectory = installService(root);
    const integrationDirectory = installIntegration(root);
    const installed = await load();
    expect(installed.services.map((service) => service.manifest.id).sort()).toEqual([
      "alpha",
      "community-live",
    ]);
    expect(installed.integrationSchemas.get("integration-live")).toMatchObject({
      properties: { region: { enum: ["eu"] } },
    });
    expect(installed.revisionId).not.toBe(initial.revisionId);

    installIntegration(root, "us");
    const updated = await load();
    expect(updated.integrationSchemas.get("integration-live")).toMatchObject({
      properties: { region: { enum: ["us"] } },
    });
    expect(updated.revisionId).not.toBe(installed.revisionId);

    rmSync(serviceDirectory, { recursive: true });
    rmSync(integrationDirectory, { recursive: true });
    const removed = await load();
    expect(removed.services.map((service) => service.manifest.id)).toEqual(["alpha"]);
    expect(removed.integrationSchemas).toEqual(new Map());
    expect(removed.revisionId).not.toBe(updated.revisionId);
  });

  it("rejects symbolic or writable custom authority instead of following it", async () => {
    const root = fixture();
    const serviceDirectory = installService(root);
    const load = createTrustedConfigurationAuthorityLoader({
      rootDir: root,
      builtInServices: [builtIn()],
    });
    const manifest = join(serviceDirectory, "service.json");
    const target = join(root, "target-service.json");
    writeFileSync(target, "{}", { mode: 0o644 });
    rmSync(manifest);
    symlinkSync(target, manifest);
    await expect(load()).rejects.toThrow("Trusted configuration authority rejected");

    rmSync(serviceDirectory, { recursive: true });
    const integrationDirectory = installIntegration(root);
    chmodSync(integrationDirectory, 0o777);
    await expect(load()).rejects.toThrow("Trusted configuration authority rejected");
  });

  it("rejects a community repository parent replaced by a symlink after validation", async () => {
    const root = fixture();
    const serviceDirectory = installService(root);
    const repository = join(root, "services", ".community", "0123456789abcdef");
    const outside = mkdtempSync(join(tmpdir(), "openmapx-swapped-service-"));
    roots.push(outside);
    const replacement = join(outside, "services", "live");
    mkdirSync(replacement, { recursive: true, mode: 0o755 });
    writeFileSync(
      join(replacement, "service.json"),
      JSON.stringify({
        id: "escaped-service",
        name: "Escaped",
        version: "1.0.0",
        quality: "community",
        container: {
          image: "registry.example.test/escaped",
          digest: `sha256:${"b".repeat(64)}`,
        },
      }),
      { mode: 0o644 },
    );
    let swapped = false;
    const load = createTrustedConfigurationAuthorityLoader({
      rootDir: root,
      builtInServices: [builtIn()],
      hooks: {
        beforeManifestOpen: (kind) => {
          if (kind !== "service" || swapped) return;
          swapped = true;
          renameSync(repository, `${repository}.original`);
          symlinkSync(outside, repository);
        },
      },
    });

    await expect(load()).rejects.toThrow("Trusted configuration authority rejected");
    expect(serviceDirectory).toContain("services/live");
  });

  it("rejects an integration parent replaced by a symlink after validation", async () => {
    const root = fixture();
    installIntegration(root);
    const integrations = join(root, "custom_integrations");
    const outside = mkdtempSync(join(tmpdir(), "openmapx-swapped-integration-"));
    roots.push(outside);
    const replacement = join(outside, "integration-live");
    mkdirSync(replacement, { recursive: true, mode: 0o755 });
    writeFileSync(
      join(replacement, "manifest.json"),
      JSON.stringify({
        id: "integration-live",
        configSchema: { properties: { escaped: { type: "string" } } },
      }),
      { mode: 0o644 },
    );
    let swapped = false;
    const load = createTrustedConfigurationAuthorityLoader({
      rootDir: root,
      builtInServices: [builtIn()],
      hooks: {
        beforeManifestOpen: (kind) => {
          if (kind !== "integration" || swapped) return;
          swapped = true;
          renameSync(integrations, `${integrations}.original`);
          symlinkSync(outside, integrations);
        },
      },
    });

    await expect(load()).rejects.toThrow("Trusted configuration authority rejected");
  });
});
