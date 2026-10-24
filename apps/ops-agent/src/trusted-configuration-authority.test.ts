import {
  chmodSync,
  linkSync,
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
import { services } from "@openmapx/core/server";
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

const REPOSITORY = "0123456789abcdef";

function serviceManifest(id = "community-live"): string {
  return JSON.stringify({
    id,
    name: "Community Live",
    version: "1.0.0",
    quality: "community",
    container: {
      image: `registry.example.test/${id}`,
      tag: "1.0.0",
      digest: `sha256:${"a".repeat(64)}`,
    },
    configSchema: { type: "object", properties: { region: { enum: ["eu"] } } },
  });
}

/** What the agent's record holds once it has published `paths`. */
function writeRecord(root: string, paths: string[]): void {
  const repository = join(root, "services", ".community", REPOSITORY);
  writeFileSync(
    join(root, "services", ".community", services.communityRecordFileName(REPOSITORY)),
    JSON.stringify({
      version: services.COMMUNITY_RECORD_VERSION,
      repository: REPOSITORY,
      url: "https://example.test/live.git",
      commit: "c".repeat(40),
      extensionId: "live-extension",
      manifests: paths.map((path) => ({
        path,
        sha256: services.manifestSha256(readFileSync(join(repository, path, "service.json"))),
      })),
      pending: null,
    }),
    { mode: 0o644 },
  );
}

/** A repository installed and recorded the way the agent publishes one. */
function installService(root: string): string {
  const directory = join(root, "services", ".community", REPOSITORY, "services", "live");
  mkdirSync(directory, { recursive: true, mode: 0o755 });
  writeFileSync(join(directory, "service.json"), serviceManifest(), { mode: 0o644 });
  writeRecord(root, ["services/live"]);
  return directory;
}

/** An integration installed and recorded the way the agent installs one. */
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
  const records = services.integrationRecordsDirectory(join(root, "infra", "docker"));
  mkdirSync(records, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(records, "integration-live.json"),
    JSON.stringify({
      version: services.INTEGRATION_RECORD_VERSION,
      integrationId: "integration-live",
      extensionId: "live-extension",
      status: "ok",
      reason: null,
      source: { kind: "upload", sha256: "e".repeat(64) },
      files: [
        {
          path: "manifest.json",
          sha256: services.sha256Hex(readFileSync(join(directory, "manifest.json"))),
        },
      ],
      pending: null,
    }),
    { mode: 0o600 },
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

    installService(root);
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

    rmSync(join(root, "services", ".community", REPOSITORY), { recursive: true });
    rmSync(join(root, "services", ".community", services.communityRecordFileName(REPOSITORY)));
    rmSync(integrationDirectory, { recursive: true });
    rmSync(
      join(
        services.integrationRecordsDirectory(join(root, "infra", "docker")),
        "integration-live.json",
      ),
    );
    const removed = await load();
    expect(removed.services.map((service) => service.manifest.id)).toEqual(["alpha"]);
    expect(removed.integrationSchemas).toEqual(new Map());
    expect(removed.revisionId).not.toBe(updated.revisionId);
  });

  it("rejects symbolic service authority, and trusts integrations by bytes, not modes", async () => {
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

    rmSync(join(root, "services", ".community", REPOSITORY), { recursive: true });
    rmSync(join(root, "services", ".community", services.communityRecordFileName(REPOSITORY)));
    const integrationDirectory = installIntegration(root);
    chmodSync(integrationDirectory, 0o777);
    chmodSync(join(integrationDirectory, "manifest.json"), 0o666);
    expect((await load()).integrationSchemas.has("integration-live")).toBe(true);

    writeFileSync(
      join(integrationDirectory, "manifest.json"),
      JSON.stringify({ id: "integration-live", configSchema: { properties: {} } }),
    );
    const changed = await load();
    expect(changed.integrationSchemas.has("integration-live")).toBe(false);
    expect(changed.integrationProblems?.map((entry) => entry.integrationId)).toEqual([
      "integration-live",
    ]);
  });

  it("rejects a recorded repository replaced by a symlink to identical bytes", async () => {
    const root = fixture();
    installService(root);
    const repository = join(root, "services", ".community", REPOSITORY);
    const outside = mkdtempSync(join(tmpdir(), "openmapx-swapped-service-"));
    roots.push(outside);
    mkdirSync(join(outside, "services", "live"), { recursive: true });
    writeFileSync(join(outside, "services", "live", "service.json"), serviceManifest());
    renameSync(repository, `${repository}.original`);
    symlinkSync(outside, repository);
    const load = createTrustedConfigurationAuthorityLoader({
      rootDir: root,
      builtInServices: [builtIn()],
    });
    await expect(load()).rejects.toThrow("Trusted configuration authority rejected");
  });

  it("loads community services by their recorded digests, not by file permissions", async () => {
    const root = fixture();
    const serviceDirectory = installService(root);
    const load = createTrustedConfigurationAuthorityLoader({
      rootDir: root,
      builtInServices: [builtIn()],
    });
    // A umask of 002 makes the checkout group-writable; the digests still hold.
    for (const path of [
      root,
      join(root, "services"),
      join(root, "services", ".community"),
      join(root, "services", ".community", REPOSITORY),
      serviceDirectory,
    ]) {
      chmodSync(path, 0o775);
    }
    chmodSync(join(serviceDirectory, "service.json"), 0o664);
    expect((await load()).services.map((service) => service.manifest.id).sort()).toEqual([
      "alpha",
      "community-live",
    ]);

    // A manifest the record does not list, and a repository without a record,
    // are never loaded.
    mkdirSync(join(serviceDirectory, "..", "extra"));
    writeFileSync(join(serviceDirectory, "..", "extra", "service.json"), serviceManifest("extra"));
    mkdirSync(join(root, "services", ".community", "fedcba9876543210"));
    writeFileSync(
      join(root, "services", ".community", "fedcba9876543210", "service.json"),
      serviceManifest("unrecorded"),
    );
    expect((await load()).services.map((service) => service.manifest.id).sort()).toEqual([
      "alpha",
      "community-live",
    ]);

    // Changed bytes fail closed, as an invalid manifest always has.
    writeFileSync(
      join(serviceDirectory, "service.json"),
      serviceManifest().replace("registry.example.test", "attacker.example.test"),
    );
    await expect(load()).rejects.toThrow("Trusted configuration authority rejected");
  });

  it("reads repository records strictly", async () => {
    const recordPath = (root: string) =>
      join(root, "services", ".community", services.communityRecordFileName(REPOSITORY));
    const load = (root: string) =>
      createTrustedConfigurationAuthorityLoader({ rootDir: root, builtInServices: [builtIn()] })();
    for (const failure of ["writable", "symlink", "version-1", "hardlink"] as const) {
      const root = fixture();
      installService(root);
      const path = recordPath(root);
      if (failure === "writable") {
        chmodSync(path, 0o664);
      } else if (failure === "symlink") {
        renameSync(path, `${path}.real`);
        symlinkSync(`${path}.real`, path);
      } else if (failure === "version-1") {
        const record = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
        const { manifests: _manifests, ...legacy } = record;
        writeFileSync(path, JSON.stringify({ ...legacy, version: 1 }));
      } else {
        linkSync(path, `${path}.link`);
      }
      await expect(load(root), failure).rejects.toThrow("Trusted configuration authority rejected");
    }
  });

  it("leaves out an integration whose directory is swapped for other bytes during the read", async () => {
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

    const authority = await load();
    expect(swapped).toBe(true);
    expect(authority.integrationSchemas.has("integration-live")).toBe(false);
    expect(authority.integrationProblems?.[0]?.problem).toContain("no longer matches");
  });
});
