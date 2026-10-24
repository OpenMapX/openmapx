import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { BuiltInServiceManifestSource } from "../built-in-service-source";
import { embeddedBuiltInServiceManifests } from "../embedded-built-in-services";
import { embeddedBuiltInServiceManifests as bundledBuiltInServiceManifests } from "../embedded-built-in-services.bundle";
import { ServiceRegistry } from "../registry";
import {
  captureReleaseServiceAuthority,
  describeBuiltInServiceDrift,
  inspectBuiltInServiceDrift,
  RELEASE_BUILT_IN_SERVICE_IDS,
  readBuiltInServices,
  validateReleaseServiceAuthority,
} from "../release-authority-inventory";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function manifest(id: string, image = `ghcr.io/openmapx/${id}`): Record<string, unknown> {
  return {
    id,
    name: id,
    version: "1.0.0",
    quality: "built-in",
    container: { image, tag: "1.0.0", digest: `sha256:${"a".repeat(64)}` },
  };
}

function temporary(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

/** A checkout (or a release's manifest set) holding one manifest per ID. */
function fixture(ids: readonly string[] = RELEASE_BUILT_IN_SERVICE_IDS): string {
  const root = temporary("openmapx-release-authority-");
  for (const id of ids) {
    const directory = join(root, "services", id);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "service.json"), JSON.stringify(manifest(id)));
  }
  return root;
}

/** The manifests a release embeds, laid out like the bundle's own copies. */
function releaseSource(ids: readonly string[]): BuiltInServiceManifestSource {
  const release = fixture(ids);
  return {
    ids: [...ids].sort(),
    manifestPath: (id) => join(release, "services", id, "service.json"),
    embedded: true,
  };
}

/** What a umask of 002 leaves after `git clone` or `git pull`. */
function makeGroupWritable(root: string): void {
  chmodSync(root, 0o775);
  chmodSync(join(root, "services"), 0o775);
  for (const id of readdirSync(join(root, "services"))) {
    chmodSync(join(root, "services", id), 0o775);
    chmodSync(join(root, "services", id, "service.json"), 0o664);
  }
}

describe("built-in service manifests", () => {
  it("embeds exactly the release's built-in services in the ops-agent bundle", () => {
    const bundled = bundledBuiltInServiceManifests();
    expect(bundled?.embedded).toBe(true);
    expect(bundled?.ids).toEqual([...RELEASE_BUILT_IN_SERVICE_IDS].sort());
    const directories = readdirSync(join(REPOSITORY_ROOT, "services"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort();
    expect(bundled?.ids).toEqual(directories);
    for (const id of bundled?.ids ?? []) {
      expect(bundled?.manifestPath(id)).toBe(join(REPOSITORY_ROOT, "services", id, "service.json"));
    }
    expect(() => bundled?.manifestPath("unlisted-service")).toThrow();
  });

  it("runs the checkout's manifests from source", async () => {
    expect(embeddedBuiltInServiceManifests()).toBeNull();
    await expect(validateReleaseServiceAuthority(REPOSITORY_ROOT)).resolves.toEqual(
      new Set(RELEASE_BUILT_IN_SERVICE_IDS),
    );
  });

  it("validates the embedded manifests exactly as the release ships them", () => {
    const bundled = bundledBuiltInServiceManifests();
    if (!bundled) throw new Error("expected the bundle variant");
    const captured = readBuiltInServices("/srv/openmapx", { source: bundled });
    expect(captured.serviceIds).toEqual([...RELEASE_BUILT_IN_SERVICE_IDS].sort());
    expect(captured.digest).toBe(readBuiltInServices(REPOSITORY_ROOT).digest);
    expect(captured.services.find((service) => service.manifest.id === "valhalla")).toMatchObject({
      directory: "/srv/openmapx/services/valhalla",
      isBuiltIn: true,
    });
  });
});

describe("fixed release service authority", () => {
  it.each([
    "missing-directory",
    "missing-manifest",
    "malformed",
    "invalid",
    "mismatched",
    "symlink",
  ] as const)("fails closed for %s release input", async (failure) => {
    const root = fixture();
    const id = RELEASE_BUILT_IN_SERVICE_IDS[0];
    const directory = join(root, "services", id);
    const path = join(directory, "service.json");
    if (failure === "missing-directory") {
      rmSync(directory, { recursive: true });
    } else if (failure === "missing-manifest") {
      rmSync(path);
    } else if (failure === "malformed") {
      writeFileSync(path, "{");
    } else if (failure === "invalid") {
      writeFileSync(path, JSON.stringify({ id }));
    } else if (failure === "mismatched") {
      writeFileSync(path, JSON.stringify(manifest("other-service")));
    } else {
      const real = join(root, "real-service.json");
      rmSync(path);
      writeFileSync(real, JSON.stringify(manifest(id)));
      symlinkSync(real, path);
    }
    await expect(validateReleaseServiceAuthority(root)).rejects.toThrow(
      "Release service authority is unavailable",
    );
  });

  it("refuses a manifest set without a service the agent never manages", async () => {
    const ids = RELEASE_BUILT_IN_SERVICE_IDS.filter((id) => id !== "ops-agent");
    await expect(
      captureReleaseServiceAuthority(fixture(ids), { source: releaseSource(ids) }),
    ).rejects.toThrow("Release service authority is unavailable");
  });

  it("returns immutable manifests that cannot be replaced after validation", async () => {
    const root = fixture();
    const captured = await captureReleaseServiceAuthority(root);
    const id = RELEASE_BUILT_IN_SERVICE_IDS[0];
    writeFileSync(
      join(root, "services", id, "service.json"),
      JSON.stringify(manifest(id, "replacement.invalid/payload")),
    );
    expect(
      captured.services.find((service) => service.manifest.id === id)?.manifest.container.image,
    ).toBe(`ghcr.io/openmapx/${id}`);
    expect(() => {
      (captured.services[0].manifest.container as { image: string }).image = "mutated.invalid";
    }).toThrow();
  });

  it("accepts a checkout that a umask of 002 left group-writable", async () => {
    const checkout = fixture();
    makeGroupWritable(checkout);
    expect(statSync(join(checkout, "services", "valhalla", "service.json")).mode & 0o777).toBe(
      0o664,
    );
    const fromSource = await captureReleaseServiceAuthority(checkout);
    expect(fromSource.serviceIds).toEqual([...RELEASE_BUILT_IN_SERVICE_IDS].sort());
    const fromRelease = await captureReleaseServiceAuthority(checkout, {
      source: releaseSource(RELEASE_BUILT_IN_SERVICE_IDS),
    });
    expect(fromRelease.serviceIds).toEqual([...RELEASE_BUILT_IN_SERVICE_IDS].sort());
    expect(
      inspectBuiltInServiceDrift(checkout, releaseSource(RELEASE_BUILT_IN_SERVICE_IDS)),
    ).toEqual({ missing: [], changed: [], unexpected: [] });
  });

  it("runs the release's manifest when the checkout's was tampered with", async () => {
    const checkout = fixture();
    const source = releaseSource(RELEASE_BUILT_IN_SERVICE_IDS);
    writeFileSync(
      join(checkout, "services", "valhalla", "service.json"),
      JSON.stringify({
        ...manifest("valhalla", "attacker.invalid/valhalla"),
        container: {
          image: "attacker.invalid/valhalla",
          tag: "1.0.0",
          digest: `sha256:${"b".repeat(64)}`,
          privileged: true,
        },
      }),
    );
    const captured = await captureReleaseServiceAuthority(checkout, { source });
    const valhalla = captured.services.find((service) => service.manifest.id === "valhalla");
    expect(valhalla?.manifest.container.image).toBe("ghcr.io/openmapx/valhalla");
    expect(valhalla?.directory).toBe(join(checkout, "services", "valhalla"));

    const registry = new ServiceRegistry({
      rootDir: checkout,
      builtInServices: readBuiltInServices(checkout, { source }).services,
    });
    await registry.load();
    expect(registry.get("valhalla")?.manifest.container.image).toBe("ghcr.io/openmapx/valhalla");

    const drift = inspectBuiltInServiceDrift(checkout, source);
    expect(drift).toEqual({ missing: [], changed: ["valhalla"], unexpected: [] });
    expect(describeBuiltInServiceDrift(drift)).toContain("changed valhalla");
  });

  it("starts a release that adds a built-in service the checkout does not have yet", async () => {
    const ids = [...RELEASE_BUILT_IN_SERVICE_IDS, "new-engine"];
    const checkout = fixture();
    const source = releaseSource(ids);
    const captured = await captureReleaseServiceAuthority(checkout, { source });
    expect(captured.serviceIds).toContain("new-engine");
    expect(captured.services.find((service) => service.manifest.id === "new-engine")).toMatchObject(
      { directory: join(checkout, "services", "new-engine"), isBuiltIn: true },
    );
    const drift = inspectBuiltInServiceDrift(checkout, source);
    expect(drift).toEqual({ missing: ["new-engine"], changed: [], unexpected: [] });
    expect(describeBuiltInServiceDrift(drift)).toContain("missing new-engine");
  });

  it("reports checkout services the release does not have, without running them", async () => {
    const ids = RELEASE_BUILT_IN_SERVICE_IDS.filter((id) => id !== "brouter");
    const checkout = fixture();
    mkdirSync(join(checkout, "services", "_template"));
    mkdirSync(join(checkout, "services", ".community"));
    const source = releaseSource(ids);
    const captured = await captureReleaseServiceAuthority(checkout, { source });
    expect(captured.serviceIds).not.toContain("brouter");
    expect(inspectBuiltInServiceDrift(checkout, source)).toEqual({
      missing: [],
      changed: [],
      unexpected: ["brouter"],
    });
  });

  it("reports no drift from source or when the checkout matches", () => {
    const checkout = fixture();
    expect(inspectBuiltInServiceDrift(checkout)).toBeNull();
    expect(describeBuiltInServiceDrift(null)).toBeNull();
    expect(describeBuiltInServiceDrift({ missing: [], changed: [], unexpected: [] })).toBeNull();
  });
});
