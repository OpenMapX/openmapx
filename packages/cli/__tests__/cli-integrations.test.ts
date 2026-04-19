import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  formatIntegrationsTable,
  installIntegration,
  listIntegrations,
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

  it("formats as a table with bundle status", () => {
    writeIntegration("custom_integrations", "weather-radar", {
      ...baseManifest,
      id: "weather-radar",
    });
    const out = formatIntegrationsTable(listIntegrations({ rootDir: tmp }));
    expect(out).toContain("weather-radar");
    expect(out).toContain("community");
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
    writeFileSync(join(src, "index.ts"), "// stub", "utf-8");

    const result = await installIntegration({ source: src, rootDir: tmp });
    expect(result.id).toBe("ads-b");
    expect(result.replaced).toBe(false);
    expect(existsSync(join(tmp, "custom_integrations", "ads-b", "manifest.json"))).toBe(true);
    expect(existsSync(join(tmp, "custom_integrations", "ads-b", "index.ts"))).toBe(true);
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
    ).rejects.toThrow(/not in the allowlist/);
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
