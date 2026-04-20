import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ServiceRegistry } from "../services/registry";

let tmp: string;

function writeManifest(slug: string, body: Record<string, unknown>) {
  const dir = join(tmp, "services", slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "service.json"), JSON.stringify(body), "utf-8");
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "openmapx-svc-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const baseManifest = {
  name: "Test",
  version: "1.0.0",
  quality: "built-in",
  container: { image: "test/image", tag: "latest", expose: [80] },
};

describe("ServiceRegistry.load", () => {
  it("discovers manifests under services/", async () => {
    writeManifest("alpha", { ...baseManifest, id: "alpha", provides: ["routing-engine"] });
    writeManifest("beta", { ...baseManifest, id: "beta", provides: ["geocoder"] });

    const registry = new ServiceRegistry({ rootDir: tmp });
    await registry.load();

    expect(
      registry
        .list()
        .map((s) => s.manifest.id)
        .sort(),
    ).toEqual(["alpha", "beta"]);
  });

  it("skips directories without service.json", async () => {
    mkdirSync(join(tmp, "services", "no-manifest"), { recursive: true });
    writeManifest("real", { ...baseManifest, id: "real" });

    const registry = new ServiceRegistry({ rootDir: tmp });
    await registry.load();

    expect(registry.list().map((s) => s.manifest.id)).toEqual(["real"]);
  });

  it("skips manifests that fail validation", async () => {
    writeManifest("good", { ...baseManifest, id: "good" });
    writeManifest("bad", { ...baseManifest, id: "BAD-UPPERCASE" });

    const registry = new ServiceRegistry({ rootDir: tmp });
    await registry.load();

    expect(registry.list().map((s) => s.manifest.id)).toEqual(["good"]);
  });

  it("marks community services discovered under services/.community/", async () => {
    writeManifest("alpha", { ...baseManifest, id: "alpha" });
    const communityDir = join(tmp, "services", ".community", "abc123", "extra");
    mkdirSync(communityDir, { recursive: true });
    writeFileSync(
      join(communityDir, "service.json"),
      JSON.stringify({ ...baseManifest, id: "extra", quality: "community" }),
    );

    const registry = new ServiceRegistry({ rootDir: tmp });
    await registry.load();

    expect(registry.get("alpha")?.isBuiltIn).toBe(true);
    expect(registry.get("extra")?.isBuiltIn).toBe(false);
  });

  it("returns undefined for unknown id", async () => {
    const registry = new ServiceRegistry({ rootDir: tmp });
    await registry.load();
    expect(registry.get("nope")).toBeUndefined();
  });

  it("can apply an enabled id set after loading installed services", async () => {
    writeManifest("alpha", { ...baseManifest, id: "alpha" });
    writeManifest("beta", { ...baseManifest, id: "beta" });

    const registry = new ServiceRegistry({ rootDir: tmp });
    await registry.load();
    registry.applyEnabledIds(new Set(["beta"]));

    expect(registry.list().map((s) => [s.manifest.id, s.enabled])).toEqual([
      ["alpha", false],
      ["beta", true],
    ]);
    expect(registry.enabled().map((s) => s.manifest.id)).toEqual(["beta"]);
  });
});
