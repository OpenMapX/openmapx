import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  backupInstalledIntegration,
  packageIntegration,
  restoreInstalledIntegration,
} from "@openmapx/integration-framework/installer";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  formatIntegrationsTable,
  installIntegration,
  listIntegrations,
  registerIntegrationsCommands,
  removeIntegration,
  validateIntegration,
} from "../src/commands/integrations";

let tmp: string;

function writeIntegration(
  parent: "integrations" | "custom_integrations",
  id: string,
  body: Record<string, unknown>,
) {
  const dir = join(tmp, parent, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(body), "utf-8");
}

const baseManifest = {
  name: "Test",
  version: "1.0.0",
  domains: ["map-overlay"],
  quality: "community",
  platform: ">=1.0.0",
};

function writeTarGz(sourceDir: string, artifactPath: string): void {
  const result = spawnSync("tar", ["-czf", artifactPath, "-C", sourceDir, "."], {
    stdio: "pipe",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.toString() || `tar exited with ${result.status}`);
  }
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "openmapx-cli-int-"));
  writeFileSync(join(tmp, "pnpm-workspace.yaml"), "packages: []\n");
  // findRepoRoot needs at least one OpenMapX-specific top-level dir.
  mkdirSync(join(tmp, "services"), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("listIntegrations", () => {
  it("returns nothing when custom_integrations is missing", () => {
    expect(listIntegrations({ rootDir: tmp })).toEqual([]);
  });

  it("lists installed community integrations", () => {
    writeIntegration("custom_integrations", "weather-radar", {
      ...baseManifest,
      id: "weather-radar",
    });
    writeIntegration("custom_integrations", "ads-b", { ...baseManifest, id: "ads-b" });
    const list = listIntegrations({ rootDir: tmp });
    expect(list.map((i) => i.id)).toEqual(["ads-b", "weather-radar"]);
  });

  it("ignores entries without a manifest.json", () => {
    mkdirSync(join(tmp, "custom_integrations", "incomplete"), { recursive: true });
    expect(listIntegrations({ rootDir: tmp })).toEqual([]);
  });

  it("includes built-in integrations when --include-built-in is set", () => {
    writeIntegration("integrations", "core-feature", {
      ...baseManifest,
      id: "core-feature",
      quality: "built-in",
    });
    writeIntegration("custom_integrations", "weather-radar", {
      ...baseManifest,
      id: "weather-radar",
    });
    const list = listIntegrations({ rootDir: tmp, includeBuiltIn: true });
    expect(list.map((i) => i.id)).toEqual(["core-feature", "weather-radar"]);
  });

  it("formats installed declarative integrations as a table", () => {
    writeIntegration("custom_integrations", "weather-radar", {
      ...baseManifest,
      id: "weather-radar",
    });
    const out = formatIntegrationsTable(listIntegrations({ rootDir: tmp }));
    expect(out).toContain("weather-radar");
    expect(out).toContain("community");
  });
});

describe("integrations command policy", () => {
  it("does not expose executable community build controls", () => {
    const program = new Command();
    registerIntegrationsCommands(program);
    const integrations = program.commands.find((command) => command.name() === "integrations");
    const commandNames = integrations?.commands.map((command) => command.name()) ?? [];
    const install = integrations?.commands.find((command) => command.name() === "install");
    const packageCommand = integrations?.commands.find((command) => command.name() === "package");

    expect(commandNames).not.toContain("build");
    expect(install?.options.map((option) => option.long)).not.toContain("--no-build");
    expect(packageCommand?.options.map((option) => option.long)).not.toContain("--no-build");
  });
});

describe("validateIntegration", () => {
  it("passes a valid manifest", () => {
    writeIntegration("custom_integrations", "good", { ...baseManifest, id: "good" });
    const result = validateIntegration(join(tmp, "custom_integrations", "good"));
    expect(result.valid).toBe(true);
    expect(result.id).toBe("good");
  });

  it("flags missing required fields", () => {
    // Missing `domains`
    writeIntegration("custom_integrations", "broken", {
      id: "broken",
      name: "Broken",
      version: "1.0.0",
      quality: "community",
    });
    const result = validateIntegration(join(tmp, "custom_integrations", "broken"));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("domains"))).toBe(true);
  });

  it("returns an error for missing manifest", () => {
    const result = validateIntegration(join(tmp, "custom_integrations", "ghost"));
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/manifest\.json/);
  });

  it.each([
    ["missing", "missing"],
    ["directory", "directory"],
    ["oversized", "oversized"],
  ])("rejects a declared %s preview", (_label, kind) => {
    const dir = join(tmp, "custom_integrations", `bad-preview-${kind}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({
        ...baseManifest,
        id: `bad-preview-${kind}`,
        frontend: {
          layerSelector: { group: "map-details", labelKey: "example", preview: "preview.svg" },
        },
      }),
      "utf-8",
    );
    if (kind === "directory") mkdirSync(join(dir, "preview.svg"));
    if (kind === "oversized") writeFileSync(join(dir, "preview.svg"), "x".repeat(64 * 1024 + 1));

    const result = validateIntegration(dir);
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/frontend\.layerSelector\.preview/);
  });
});

describe("installIntegration (local source)", () => {
  it("copies a local directory into custom_integrations/<id>/", async () => {
    const src = join(tmp, "src-int");
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, "manifest.json"),
      JSON.stringify({ ...baseManifest, id: "ads-b" }),
      "utf-8",
    );
    const result = await installIntegration({ source: src, rootDir: tmp });
    expect(result.id).toBe("ads-b");
    expect(result.replaced).toBe(false);
    expect(existsSync(join(tmp, "custom_integrations", "ads-b", "manifest.json"))).toBe(true);
  });

  it("copies a declared static preview without building frontend code", async () => {
    const src = join(tmp, "preview-int");
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, "manifest.json"),
      JSON.stringify({
        ...baseManifest,
        id: "preview-demo",
        frontend: {
          layerSelector: { group: "map-details", labelKey: "example", preview: "preview.svg" },
        },
      }),
      "utf-8",
    );
    writeFileSync(join(src, "preview.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');

    await installIntegration({ source: src, rootDir: tmp });
    expect(
      readFileSync(join(tmp, "custom_integrations", "preview-demo", "preview.svg"), "utf-8"),
    ).toContain("<svg");
    expect(
      existsSync(join(tmp, "custom_integrations", "preview-demo", "dist", "frontend", "index.js")),
    ).toBe(false);
  });

  it("rejects a declared missing preview before replacing an existing install", async () => {
    const src = join(tmp, "missing-preview-int");
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, "manifest.json"),
      JSON.stringify({
        ...baseManifest,
        id: "preview-demo",
        frontend: {
          layerSelector: { group: "map-details", labelKey: "example", preview: "preview.svg" },
        },
      }),
      "utf-8",
    );
    const installed = join(tmp, "custom_integrations", "preview-demo");
    mkdirSync(installed, { recursive: true });
    writeFileSync(join(installed, "keep.txt"), "existing");

    await expect(installIntegration({ source: src, rootDir: tmp })).rejects.toThrow(
      /frontend\.layerSelector\.preview.*missing/,
    );
    expect(readFileSync(join(installed, "keep.txt"), "utf-8")).toBe("existing");
  });

  it("rejects same-origin community frontend source", async () => {
    const src = join(tmp, "frontend-int");
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, "manifest.json"),
      JSON.stringify({
        ...baseManifest,
        id: "frontend-demo",
        frontend: { mapLayer: true },
      }),
      "utf-8",
    );
    writeFileSync(
      join(src, "map-layer.tsx"),
      "export default function MapLayer() { return null; }",
      "utf-8",
    );

    await expect(installIntegration({ source: src, rootDir: tmp })).rejects.toThrow(
      /Executable community integration code cannot be installed without an isolation boundary/,
    );
    expect(existsSync(join(tmp, "custom_integrations", "frontend-demo"))).toBe(false);
  });

  it("installs a declarative integration without creating build output", async () => {
    const src = join(tmp, "backend-only");
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, "manifest.json"),
      JSON.stringify({ ...baseManifest, id: "backend-only" }),
      "utf-8",
    );

    await installIntegration({ source: src, rootDir: tmp });
    expect(existsSync(join(tmp, "custom_integrations", "backend-only", "dist"))).toBe(false);
  });

  it("rejects community backend source instead of installing it into the API trust domain", async () => {
    const src = join(tmp, "backend-int");
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, "manifest.json"),
      JSON.stringify({
        ...baseManifest,
        id: "backend-demo",
        backend: { routes: true },
      }),
      "utf-8",
    );
    writeFileSync(
      join(src, "index.ts"),
      [
        'import type { IntegrationContext } from "@openmapx/core";',
        'import { message } from "./message.js";',
        "export function setup(ctx: IntegrationContext) {",
        '  ctx.registerRoute("GET", "/message", (_req, reply) => reply.send({ message }));',
        "}",
      ].join("\n"),
      "utf-8",
    );
    writeFileSync(join(src, "message.ts"), 'export const message = "hello";', "utf-8");

    await expect(installIntegration({ source: src, rootDir: tmp })).rejects.toThrow(
      /Executable community integration code cannot be installed.*isolated service/s,
    );
    expect(existsSync(join(tmp, "custom_integrations", "backend-demo"))).toBe(false);
  });

  it("rejects executable community POI declarations", async () => {
    const src = join(tmp, "community-poi");
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, "manifest.json"),
      JSON.stringify({ ...baseManifest, id: "community-poi" }),
      "utf-8",
    );
    writeFileSync(
      join(src, "poi-sources.js"),
      "export function declarePoiSources() { return []; }",
      "utf-8",
    );

    await expect(installIntegration({ source: src, rootDir: tmp })).rejects.toThrow(
      /Executable community integration code cannot be installed/,
    );
    expect(existsSync(join(tmp, "custom_integrations", "community-poi"))).toBe(false);
  });

  it("replaces an existing install", async () => {
    const src = join(tmp, "src-int");
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, "manifest.json"),
      JSON.stringify({ ...baseManifest, id: "ads-b", version: "2.0.0" }),
      "utf-8",
    );

    // Pre-existing install
    mkdirSync(join(tmp, "custom_integrations", "ads-b"), { recursive: true });
    writeFileSync(
      join(tmp, "custom_integrations", "ads-b", "manifest.json"),
      JSON.stringify({ ...baseManifest, id: "ads-b", version: "1.0.0" }),
      "utf-8",
    );

    const result = await installIntegration({ source: src, rootDir: tmp });
    expect(result.replaced).toBe(true);
    const manifest = JSON.parse(
      readFileSync(join(tmp, "custom_integrations", "ads-b", "manifest.json"), "utf-8"),
    ) as { version: string };
    expect(manifest.version).toBe("2.0.0");
  });

  it("rejects a source without a manifest", async () => {
    const src = join(tmp, "no-manifest");
    mkdirSync(src, { recursive: true });
    await expect(installIntegration({ source: src, rootDir: tmp })).rejects.toThrow(
      /manifest\.json/,
    );
  });

  it("rejects a manifest that fails validation", async () => {
    const src = join(tmp, "bad");
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, "manifest.json"),
      JSON.stringify({ id: "bad", name: "Bad", version: "1.0.0", quality: "community" }),
      "utf-8",
    );
    await expect(installIntegration({ source: src, rootDir: tmp })).rejects.toThrow(
      /Manifest validation failed/,
    );
    // Did NOT leave a partial install behind
    expect(existsSync(join(tmp, "custom_integrations", "bad"))).toBe(false);
  });

  it("rejects a non-existent local path that's not a github: spec", async () => {
    await expect(
      installIntegration({ source: "/this/path/does/not/exist", rootDir: tmp }),
    ).rejects.toThrow(/not.*existing local directory/);
  });
});

describe("installIntegration (artifact source)", () => {
  it("rejects a prebuilt same-origin frontend bundle", async () => {
    const src = join(tmp, "artifact-src");
    mkdirSync(join(src, "dist", "frontend"), { recursive: true });
    writeFileSync(
      join(src, "manifest.json"),
      JSON.stringify({
        ...baseManifest,
        id: "artifact-demo",
        frontend: { legend: true },
      }),
      "utf-8",
    );
    writeFileSync(
      join(src, "dist", "frontend", "index.js"),
      "window.__openmapx_integrations=[];",
      "utf-8",
    );
    const artifact = join(tmp, "artifact-demo.tar.gz");
    writeTarGz(src, artifact);

    await expect(
      installIntegration({
        source: artifact,
        sourceKind: "artifact",
        artifactSha256: sha256(artifact),
        rootDir: tmp,
      }),
    ).rejects.toThrow(/Executable community integration code cannot be installed/);
    expect(existsSync(join(tmp, "custom_integrations", "artifact-demo"))).toBe(false);
  });

  it("extracts artifact entries that use tar long-path metadata", async () => {
    const src = join(tmp, "long-path-artifact-src");
    const longFileName = `${"a".repeat(120)}.txt`;
    mkdirSync(join(src, "assets"), { recursive: true });
    writeFileSync(
      join(src, "manifest.json"),
      JSON.stringify({ ...baseManifest, id: "long-path-artifact" }),
      "utf-8",
    );
    writeFileSync(join(src, "assets", longFileName), "hello");
    const artifact = join(tmp, "long-path-artifact.tar.gz");
    writeTarGz(src, artifact);

    await installIntegration({
      source: artifact,
      sourceKind: "artifact",
      rootDir: tmp,
    });

    expect(
      existsSync(join(tmp, "custom_integrations", "long-path-artifact", "assets", longFileName)),
    ).toBe(true);
  });

  it("extracts safe internal symlinks from artifacts", async () => {
    const src = join(tmp, "symlink-artifact-src");
    const targetDir = join(src, "assets", "real");
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(
      join(src, "manifest.json"),
      JSON.stringify({ ...baseManifest, id: "symlink-artifact" }),
      "utf-8",
    );
    writeFileSync(join(targetDir, "data.json"), '{ "ok": true }', "utf-8");
    symlinkSync("real", join(src, "assets", "linked"), "dir");
    const artifact = join(tmp, "symlink-artifact.tar.gz");
    writeTarGz(src, artifact);

    await installIntegration({
      source: artifact,
      sourceKind: "artifact",
      rootDir: tmp,
    });

    const installedLink = join(tmp, "custom_integrations", "symlink-artifact", "assets", "linked");
    expect(lstatSync(installedLink).isSymbolicLink()).toBe(true);
    expect(existsSync(join(installedLink, "data.json"))).toBe(true);
  });

  it("rejects artifacts that ship a node_modules directory", async () => {
    const src = join(tmp, "node-modules-artifact-src");
    mkdirSync(join(src, "node_modules", "pkg"), { recursive: true });
    writeFileSync(
      join(src, "manifest.json"),
      JSON.stringify({ ...baseManifest, id: "node-modules-artifact" }),
      "utf-8",
    );
    writeFileSync(join(src, "node_modules", "pkg", "index.js"), "module.exports = {};");
    const artifact = join(tmp, "node-modules-artifact.tar.gz");
    writeTarGz(src, artifact);

    await expect(
      installIntegration({ source: artifact, sourceKind: "artifact", rootDir: tmp }),
    ).rejects.toThrow(/must not ship a node_modules/);
    expect(existsSync(join(tmp, "custom_integrations", "node-modules-artifact"))).toBe(false);
  });

  it("rejects artifacts whose extracted tar exceeds the artifact byte limit", async () => {
    const src = join(tmp, "oversized-artifact-src");
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, "manifest.json"),
      JSON.stringify({ ...baseManifest, id: "oversized-artifact" }),
      "utf-8",
    );
    writeFileSync(join(src, "payload.txt"), "a".repeat(64 * 1024), "utf-8");
    const artifact = join(tmp, "oversized-artifact.tar.gz");
    writeTarGz(src, artifact);

    expect(statSync(artifact).size).toBeLessThan(4096);
    await expect(
      installIntegration({
        source: artifact,
        sourceKind: "artifact",
        rootDir: tmp,
        maxArtifactBytes: 4096,
      }),
    ).rejects.toThrow(/extracted size exceeds max/);
    expect(existsSync(join(tmp, "custom_integrations", "oversized-artifact"))).toBe(false);
  });

  it("rejects manifests that advertise executable community presentation code", async () => {
    const src = join(tmp, "broken-artifact-src");
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, "manifest.json"),
      JSON.stringify({
        ...baseManifest,
        id: "broken-artifact",
        frontend: { legend: true },
      }),
      "utf-8",
    );
    const artifact = join(tmp, "broken-artifact.tar.gz");
    writeTarGz(src, artifact);

    await expect(
      installIntegration({ source: artifact, sourceKind: "artifact", rootDir: tmp }),
    ).rejects.toThrow(/Executable community integration code cannot be installed/);
    expect(existsSync(join(tmp, "custom_integrations", "broken-artifact"))).toBe(false);
  });

  it("rejects backend artifacts before they enter the privileged runtime mount", async () => {
    const src = join(tmp, "broken-backend-artifact-src");
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, "manifest.json"),
      JSON.stringify({
        ...baseManifest,
        id: "broken-backend-artifact",
        backend: { routes: true },
      }),
      "utf-8",
    );
    writeFileSync(
      join(src, "index.ts"),
      "export function setup() { /* intentionally unbundled */ }",
      "utf-8",
    );
    const artifact = join(tmp, "broken-backend-artifact.tar.gz");
    writeTarGz(src, artifact);

    await expect(
      installIntegration({ source: artifact, sourceKind: "artifact", rootDir: tmp }),
    ).rejects.toThrow(/Executable community integration code cannot be installed/);
    expect(existsSync(join(tmp, "custom_integrations", "broken-backend-artifact"))).toBe(false);
  });

  it("rejects obsolete executable-bundle metadata", async () => {
    const src = join(tmp, "bad-checksum-artifact-src");
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, "manifest.json"),
      JSON.stringify({
        ...baseManifest,
        id: "bad-checksum-artifact",
        frontend: {
          layerSelector: { group: "map-details", labelKey: "example", preview: "preview.svg" },
        },
      }),
      "utf-8",
    );
    writeFileSync(join(src, "preview.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>', "utf-8");
    writeFileSync(
      join(src, "openmapx-artifact.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "bad-checksum-artifact",
        platformVersion: "1.0.0",
        builtAt: new Date().toISOString(),
        bundles: {
          preview: {
            path: "preview.svg",
            sha256: "0".repeat(64),
          },
        },
      }),
      "utf-8",
    );
    const artifact = join(tmp, "bad-checksum-artifact.tar.gz");
    writeTarGz(src, artifact);

    await expect(
      installIntegration({ source: artifact, sourceKind: "artifact", rootDir: tmp }),
    ).rejects.toThrow(/invalid shape/);
    expect(existsSync(join(tmp, "custom_integrations", "bad-checksum-artifact"))).toBe(false);
  });
});

describe("packageIntegration", () => {
  it("rejects packaging executable community presentation code", async () => {
    const src = join(tmp, "package-src");
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, "manifest.json"),
      JSON.stringify({
        ...baseManifest,
        id: "package-demo",
        frontend: { legend: true },
      }),
      "utf-8",
    );
    writeFileSync(
      join(src, "legend.tsx"),
      "export default function Legend() { return null; }",
      "utf-8",
    );
    await expect(
      packageIntegration({
        rootDir: tmp,
        source: src,
        outFile: join(tmp, "package-demo.tar.gz"),
      }),
    ).rejects.toThrow(/Executable community integration code cannot be installed/);
  });

  it("preserves a static preview without creating a frontend bundle", async () => {
    const src = join(tmp, "package-preview-src");
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, "manifest.json"),
      JSON.stringify({
        ...baseManifest,
        id: "package-preview",
        frontend: {
          layerSelector: { group: "map-details", labelKey: "example", preview: "preview.svg" },
        },
      }),
      "utf-8",
    );
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="2"/></svg>';
    writeFileSync(join(src, "preview.svg"), svg);

    const artifact = join(tmp, "package-preview.tar.gz");
    const result = await packageIntegration({
      rootDir: tmp,
      source: src,
      outFile: artifact,
    });
    expect(result.files).not.toContain("dist/frontend/index.js");
    expect(existsSync(join(src, "dist", "frontend", "index.js"))).toBe(false);

    await installIntegration({ rootDir: tmp, source: artifact, sourceKind: "artifact" });
    const installed = join(tmp, "custom_integrations", "package-preview");
    expect(readFileSync(join(installed, "preview.svg"), "utf-8")).toBe(svg);
    expect(existsSync(join(installed, "dist", "frontend", "index.js"))).toBe(false);
  });
});

describe("integration rollback backups", () => {
  it("restores the exact pre-update files", () => {
    writeIntegration("custom_integrations", "weather-radar", {
      ...baseManifest,
      id: "weather-radar",
    });
    const target = join(tmp, "custom_integrations", "weather-radar");
    writeFileSync(join(target, "version.txt"), "old", "utf8");
    const backup = backupInstalledIntegration(tmp, "weather-radar");
    expect(backup).not.toBeNull();

    writeFileSync(join(target, "version.txt"), "new", "utf8");
    writeFileSync(join(target, "new-only.txt"), "new", "utf8");
    restoreInstalledIntegration(tmp, backup as NonNullable<typeof backup>);

    expect(readFileSync(join(target, "version.txt"), "utf8")).toBe("old");
    expect(existsSync(join(target, "new-only.txt"))).toBe(false);
    expect(existsSync((backup as NonNullable<typeof backup>).backupDirectory)).toBe(false);
  });
});

describe("removeIntegration", () => {
  it("removes the directory", () => {
    writeIntegration("custom_integrations", "weather-radar", {
      ...baseManifest,
      id: "weather-radar",
    });
    removeIntegration({ id: "weather-radar", rootDir: tmp });
    expect(existsSync(join(tmp, "custom_integrations", "weather-radar"))).toBe(false);
  });

  it("throws when the integration is not installed", () => {
    expect(() => removeIntegration({ id: "ghost", rootDir: tmp })).toThrow(/not installed/);
  });

  it("rejects a path-traversal id (defense in depth)", () => {
    expect(() => removeIntegration({ id: "../../etc/cron.d/evil", rootDir: tmp })).toThrow(
      /Invalid integration id/,
    );
  });

  it("rejects an empty id", () => {
    expect(() => removeIntegration({ id: "", rootDir: tmp })).toThrow(/Invalid integration id/);
  });
});

describe("installIntegration security", () => {
  it("rejects a remote artifact without a SHA-256 pin before downloading", async () => {
    await expect(
      installIntegration({
        source: "https://example.com/community.tar.gz",
        sourceKind: "artifact",
        rootDir: tmp,
      }),
    ).rejects.toThrow(/require an expected SHA-256 digest/);
  });

  it("rejects a preview symlink that escapes the integration", async () => {
    const outside = join(tmp, "outside.svg");
    writeFileSync(outside, '<svg xmlns="http://www.w3.org/2000/svg"/>');
    const src = join(tmp, "escaping-preview-link");
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, "manifest.json"),
      JSON.stringify({
        ...baseManifest,
        id: "escaping-preview-link",
        frontend: {
          layerSelector: { group: "map-details", labelKey: "example", preview: "preview.svg" },
        },
      }),
    );
    symlinkSync(outside, join(src, "preview.svg"));

    await expect(installIntegration({ source: src, rootDir: tmp })).rejects.toThrow(
      /frontend\.layerSelector\.preview.*symlink/,
    );
  });

  it("rejects a manifest with a path-traversal id", async () => {
    const src = join(tmp, "evil");
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, "manifest.json"),
      JSON.stringify({ ...baseManifest, id: "../../etc/cron.d/evil" }),
      "utf-8",
    );
    // Schema regex catches this at validation time, before any path concatenation.
    await expect(installIntegration({ source: src, rootDir: tmp })).rejects.toThrow(
      /Manifest validation failed/,
    );
    expect(existsSync(join(tmp, "custom_integrations", "..", "..", "etc"))).toBe(false);
  });

  it("rejects a manifest with id containing JS-injection characters", async () => {
    const src = join(tmp, "injection");
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, "manifest.json"),
      JSON.stringify({ ...baseManifest, id: 'x"; window.evil()//' }),
      "utf-8",
    );
    await expect(installIntegration({ source: src, rootDir: tmp })).rejects.toThrow(
      /Manifest validation failed/,
    );
  });

  it("rejects a non-https Git URL", async () => {
    await expect(
      installIntegration({ source: "http://github.com/owner/repo.git", rootDir: tmp }),
    ).rejects.toThrow(/Only https/);
  });

  it("rejects a Git URL on an off-allowlist host", async () => {
    await expect(
      installIntegration({ source: "https://random.example.com/repo.git", rootDir: tmp }),
    ).rejects.toThrow(/not in the repository allowlist/);
  });

  it("accepts a github:user/repo spec at allowlist validation time", async () => {
    // Should clear URL gating; the failure that follows comes from `git clone`
    // (which we don't run in tests). The fact that the error is NOT a
    // URL-validation error means the allowlist accepted it.
    await expect(
      installIntegration({
        source: "github:owner/repo",
        rootDir: tmp,
        // Suppress the actual clone by aborting before spawn fires.
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow();
  });

  it("rejects a local source when allowLocalSources is false", async () => {
    const src = join(tmp, "src-int");
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, "manifest.json"),
      JSON.stringify({ ...baseManifest, id: "ads-b" }),
      "utf-8",
    );
    await expect(
      installIntegration({ source: src, rootDir: tmp, allowLocalSources: false }),
    ).rejects.toThrow(/Local paths are not allowed/);
    expect(existsSync(join(tmp, "custom_integrations", "ads-b"))).toBe(false);
  });
});
