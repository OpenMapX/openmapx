import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { BuiltInManifestSource } from "../built-in-service-source";
import {
  embeddedBuiltInIntegrationManifests,
  embeddedBuiltInServiceManifests,
} from "../embedded-built-in-services";
import { embeddedBuiltInIntegrationManifests as bundledIntegrationManifests } from "../embedded-built-in-services.bundle";
import { loadTrustedIntegrationSchemas } from "../trusted-integration-schemas";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function writeManifest(path: string, id: string, schema: Record<string, unknown>, mode = 0o644) {
  writeFileSync(join(path, "manifest.json"), JSON.stringify({ id, configSchema: schema }), {
    mode,
  });
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "openmapx-integration-schemas-"));
  roots.push(root);
  chmodSync(root, 0o755);
  mkdirSync(join(root, "integrations", "routing-demo"), { recursive: true, mode: 0o755 });
  writeManifest(join(root, "integrations", "routing-demo"), "routing-demo", {
    properties: { region: { type: "string" } },
  });
  mkdirSync(join(root, "integrations", "_template"), { recursive: true });
  writeManifest(join(root, "integrations", "_template"), "__ID__", {});
  mkdirSync(join(root, "custom_integrations", "overlay-demo"), { recursive: true, mode: 0o755 });
  chmodSync(join(root, "custom_integrations"), 0o755);
  writeManifest(join(root, "custom_integrations", "overlay-demo"), "overlay-demo", {
    properties: { layers: { type: "array" } },
  });
  return root;
}

/** A release's embedded integration manifests, laid out like the bundle's copies. */
function releaseSource(manifests: Record<string, Record<string, unknown>>): BuiltInManifestSource {
  const release = mkdtempSync(join(tmpdir(), "openmapx-release-integrations-"));
  roots.push(release);
  for (const [id, schema] of Object.entries(manifests)) {
    mkdirSync(join(release, id));
    writeManifest(join(release, id), id, schema);
  }
  return {
    ids: Object.keys(manifests).sort(),
    manifestPath: (id) => join(release, id, "manifest.json"),
    embedded: true,
  };
}

describe("trusted integration schemas", () => {
  it("embeds every built-in integration manifest in the ops-agent bundle", () => {
    expect(embeddedBuiltInIntegrationManifests()).toBeNull();
    expect(embeddedBuiltInServiceManifests()).toBeNull();
    const bundled = bundledIntegrationManifests();
    const directories = readdirSync(join(REPOSITORY_ROOT, "integrations"), {
      withFileTypes: true,
    })
      .filter((entry) => entry.isDirectory() && /^[a-z0-9]/.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    expect(bundled?.ids).toEqual(directories);
    for (const id of bundled?.ids ?? []) {
      expect(bundled?.manifestPath(id)).toBe(
        join(REPOSITORY_ROOT, "integrations", id, "manifest.json"),
      );
    }
    const schemas = loadTrustedIntegrationSchemas(REPOSITORY_ROOT, {
      ...(bundled ? { builtIns: bundled } : {}),
    });
    expect([...schemas.keys()]).toEqual(expect.arrayContaining(directories));
  });

  it("loads built-in and installed schemas", () => {
    const root = fixture();
    expect(loadTrustedIntegrationSchemas(root)).toEqual(
      new Map([
        ["overlay-demo", { properties: { layers: { type: "array" } } }],
        ["routing-demo", { properties: { region: { type: "string" } } }],
      ]),
    );
  });

  it("accepts built-in integrations a umask of 002 left group-writable", () => {
    const root = fixture();
    chmodSync(root, 0o775);
    chmodSync(join(root, "integrations"), 0o775);
    chmodSync(join(root, "integrations", "routing-demo"), 0o775);
    chmodSync(join(root, "integrations", "routing-demo", "manifest.json"), 0o664);
    expect(loadTrustedIntegrationSchemas(root).has("routing-demo")).toBe(true);
  });

  it("takes built-in schemas from the release, not from a tampered checkout", () => {
    const root = fixture();
    writeManifest(join(root, "integrations", "routing-demo"), "routing-demo", {
      properties: { region: { type: "string" }, tampered: { type: "string" } },
    });
    const schemas = loadTrustedIntegrationSchemas(root, {
      builtIns: releaseSource({ "routing-demo": { properties: { region: { type: "string" } } } }),
    });
    expect(schemas.get("routing-demo")).toEqual({ properties: { region: { type: "string" } } });
  });

  it("keeps the owner and mode checks on installed integrations", () => {
    for (const target of ["directory", "integration", "manifest"] as const) {
      const root = fixture();
      const path =
        target === "directory"
          ? join(root, "custom_integrations")
          : target === "integration"
            ? join(root, "custom_integrations", "overlay-demo")
            : join(root, "custom_integrations", "overlay-demo", "manifest.json");
      chmodSync(path, target === "manifest" ? 0o664 : 0o775);
      expect(() => loadTrustedIntegrationSchemas(root), target).toThrow(
        "Trusted integration registry rejected",
      );
    }
    const root = fixture();
    expect(() => loadTrustedIntegrationSchemas(root, { uid: 4_242_424 })).toThrow(
      "Trusted integration registry rejected",
    );
  });

  it("loads no installed schemas when custom_integrations does not exist", () => {
    const root = fixture();
    rmSync(join(root, "custom_integrations"), { recursive: true });
    expect([...loadTrustedIntegrationSchemas(root).keys()]).toEqual(["routing-demo"]);
  });

  it("rejects duplicate identities and symbolic manifest files", () => {
    const root = fixture();
    const duplicate = join(root, "custom_integrations", "routing-demo");
    mkdirSync(duplicate, { mode: 0o755 });
    writeManifest(duplicate, "routing-demo", {});
    expect(() => loadTrustedIntegrationSchemas(root)).toThrow(
      "Trusted integration registry rejected",
    );

    rmSync(duplicate, { recursive: true });
    const manifest = join(root, "custom_integrations", "overlay-demo", "manifest.json");
    const real = join(root, "real-manifest.json");
    writeFileSync(real, JSON.stringify({ id: "overlay-demo" }), { mode: 0o644 });
    rmSync(manifest);
    symlinkSync(real, manifest);
    expect(() => loadTrustedIntegrationSchemas(root)).toThrow(
      "Trusted integration registry rejected",
    );
  });

  it("rejects an unsupported schema before it enters refreshed authority", () => {
    const root = fixture();
    writeManifest(join(root, "custom_integrations", "overlay-demo"), "overlay-demo", {
      properties: { layers: { type: "array", contains: { type: "string" } } },
    });
    expect(() => loadTrustedIntegrationSchemas(root)).toThrow(
      "Trusted integration registry rejected",
    );
  });
});
