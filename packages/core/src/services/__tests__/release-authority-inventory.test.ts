import {
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
import { afterEach, describe, expect, it } from "vitest";
import {
  captureReleaseServiceAuthority,
  RELEASE_BUILT_IN_SERVICE_IDS,
  validateReleaseServiceAuthority,
} from "../release-authority-inventory";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function manifest(id: string): Record<string, unknown> {
  return {
    id,
    name: id,
    version: "1.0.0",
    quality: "built-in",
    container: {
      image: `ghcr.io/openmapx/${id}`,
      tag: "1.0.0",
      digest: `sha256:${"a".repeat(64)}`,
    },
  };
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "openmapx-release-authority-"));
  roots.push(root);
  const services = join(root, "services");
  mkdirSync(services, { recursive: true });
  for (const id of RELEASE_BUILT_IN_SERVICE_IDS) {
    const directory = join(services, id);
    mkdirSync(directory);
    writeFileSync(join(directory, "service.json"), JSON.stringify(manifest(id)));
  }
  return root;
}

describe("fixed release service authority inventory", () => {
  it("exactly matches every non-hidden release service directory", async () => {
    const root = process.cwd();
    await expect(validateReleaseServiceAuthority(root)).resolves.toEqual(
      new Set(RELEASE_BUILT_IN_SERVICE_IDS),
    );
  });

  it.each([
    "missing-directory",
    "missing-manifest",
    "malformed",
    "invalid",
    "mismatched",
    "extra",
  ] as const)("fails closed for %s release input", async (failure) => {
    const root = fixture();
    const id = RELEASE_BUILT_IN_SERVICE_IDS[0];
    const directory = join(root, "services", id);
    if (failure === "missing-directory") {
      rmSync(directory, { recursive: true });
    } else if (failure === "missing-manifest") {
      rmSync(join(directory, "service.json"));
    } else if (failure === "malformed") {
      writeFileSync(join(directory, "service.json"), "{");
    } else if (failure === "invalid") {
      writeFileSync(join(directory, "service.json"), JSON.stringify({ id }));
    } else if (failure === "mismatched") {
      writeFileSync(join(directory, "service.json"), JSON.stringify(manifest("other-service")));
    } else {
      mkdirSync(join(root, "services", "unlisted-service"));
      writeFileSync(
        join(root, "services", "unlisted-service", "service.json"),
        JSON.stringify(manifest("unlisted-service")),
      );
    }
    await expect(validateReleaseServiceAuthority(root)).rejects.toThrow(
      "Release service authority is unavailable",
    );
  });

  it("rejects symlinked release directories and manifests", async () => {
    for (const target of ["directory", "manifest"] as const) {
      const root = fixture();
      const id = RELEASE_BUILT_IN_SERVICE_IDS[0];
      const directory = join(root, "services", id);
      if (target === "directory") {
        const real = join(root, "real-service");
        rmSync(directory, { recursive: true });
        mkdirSync(real);
        writeFileSync(join(real, "service.json"), JSON.stringify(manifest(id)));
        symlinkSync(real, directory);
      } else {
        const real = join(root, "real-service.json");
        rmSync(join(directory, "service.json"));
        writeFileSync(real, JSON.stringify(manifest(id)));
        symlinkSync(real, join(directory, "service.json"));
      }
      await expect(validateReleaseServiceAuthority(root)).rejects.toThrow(
        "Release service authority is unavailable",
      );
    }
  });

  it("returns immutable manifests that cannot be replaced after validation", async () => {
    const root = fixture();
    const captured = await captureReleaseServiceAuthority(root);
    const id = RELEASE_BUILT_IN_SERVICE_IDS[0];
    writeFileSync(
      join(root, "services", id, "service.json"),
      JSON.stringify({
        ...manifest(id),
        container: { image: "replacement.invalid/payload", tag: "1" },
      }),
    );
    expect(
      captured.services.find((service) => service.manifest.id === id)?.manifest.container.image,
    ).toBe(`ghcr.io/openmapx/${id}`);
    expect(() => {
      (captured.services[0].manifest.container as { image: string }).image = "mutated.invalid";
    }).toThrow();
  });

  it("rejects a services-parent replacement during descriptor-anchored capture", async () => {
    const root = fixture();
    let swapped = false;
    await expect(
      captureReleaseServiceAuthority(root, {
        beforeManifestOpen: () => {
          if (swapped) return;
          swapped = true;
          renameSync(join(root, "services"), join(root, "services-original"));
          mkdirSync(join(root, "services"));
        },
      }),
    ).rejects.toThrow("Release service authority is unavailable");
  });

  it.each(["replace", "truncate", "same-size", "hardlink", "symlink"] as const)(
    "rejects a final manifest %s during its stable descriptor capture",
    async (failure) => {
      const root = fixture();
      const targetId = RELEASE_BUILT_IN_SERVICE_IDS[0];
      let changed = false;
      await expect(
        captureReleaseServiceAuthority(root, {
          afterFirstManifestRead: (id, path) => {
            if (changed || id !== targetId) return;
            changed = true;
            if (failure === "replace") {
              renameSync(path, `${path}.original`);
              writeFileSync(path, JSON.stringify(manifest(id)));
            } else if (failure === "truncate") {
              writeFileSync(path, "{");
            } else if (failure === "same-size") {
              const original = readFileSync(path, "utf8");
              const replacement = original.replace("ghcr", "evil");
              expect(replacement).toHaveLength(original.length);
              writeFileSync(path, replacement);
            } else if (failure === "hardlink") {
              linkSync(path, `${path}.link`);
            } else {
              renameSync(path, `${path}.original`);
              symlinkSync(`${path}.original`, path);
            }
          },
        }),
      ).rejects.toThrow("Release service authority is unavailable");
    },
  );
});
