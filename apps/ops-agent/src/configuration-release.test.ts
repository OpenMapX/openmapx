import { createHash } from "node:crypto";
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIGURATION_RELEASE_IMAGE_NAMES } from "@openmapx/core/ops";
import { services } from "@openmapx/core/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readCheckedConfigurationRelease } from "./configuration-release";
import { inspectConfigurationReleaseDownloads } from "./configuration-release-downloads";

let root: string, directory: string, raw: string, manifestDigest: string;
const releaseId = "checked-release-01";
beforeEach(() => {
  vi.stubEnv("OPENMAPX_RELEASE", "main");
  vi.stubEnv("OPENMAPX_RELEASE_MANIFEST_REPOSITORY", "ghcr.io/openmapx/release-manifest");
  root = mkdtempSync(join(tmpdir(), "openmapx-configuration-release-"));
  directory = join(root, ".ops-agent-releases");
  mkdirSync(directory, { mode: 0o700 });
  raw = services.canonicalReleaseManifest(
    services.parseReleaseManifest(
      JSON.stringify({
        schemaVersion: 1,
        release: releaseId,
        images: Object.fromEntries(
          services.RELEASE_IMAGE_NAMES.map((name) => [
            name,
            `ghcr.io/openmapx/${name}@sha256:${"a".repeat(64)}`,
          ]),
        ),
        privacyReleaseValidation: {
          version: 1,
          sourceBuildFingerprint: "b".repeat(64),
          validatedAt: "2026-10-30T00:00:00.000Z",
          checks: { translationsConsistent: true, openApiConsistent: true, policyConsistent: true },
        },
      }),
    ),
  );
  manifestDigest = createHash("sha256").update(raw).digest("hex");
  writeFileSync(join(directory, `${releaseId}.json`), raw, { mode: 0o600 });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
it("loads only the exact checked canonical manifest and derives the finite pinned map", () => {
  const release = readCheckedConfigurationRelease(root, { releaseId, manifestDigest });
  expect(release).toMatchObject({
    releaseId,
    manifestDigest,
    serviceImages: {
      "app-api": `ghcr.io/openmapx/api@sha256:${"a".repeat(64)}`,
      "app-web": `ghcr.io/openmapx/web@sha256:${"a".repeat(64)}`,
      "ops-agent": `ghcr.io/openmapx/ops-agent@sha256:${"a".repeat(64)}`,
      "data-manager": `ghcr.io/openmapx/data-manager@sha256:${"a".repeat(64)}`,
      "transitous-runner": `ghcr.io/openmapx/transitous-runner@sha256:${"a".repeat(64)}`,
    },
  });
  expect(Object.isFrozen(release)).toBe(true);
});
it.each(["../outside", "/absolute", "checked/child"])(
  "rejects non-identity input %s",
  (invalid) => {
    expect(() =>
      readCheckedConfigurationRelease(root, { releaseId: invalid, manifestDigest }),
    ).toThrow();
  },
);
it("rejects digest drift and noncanonical cached bytes", () => {
  expect(() =>
    readCheckedConfigurationRelease(root, { releaseId, manifestDigest: "0".repeat(64) }),
  ).toThrow();
  writeFileSync(join(directory, `${releaseId}.json`), `${raw}\n`);
  expect(() => readCheckedConfigurationRelease(root, { releaseId, manifestDigest })).toThrow();
});
it.each(["symlink", "hardlink"])("rejects a %s cached manifest", (kind) => {
  const path = join(directory, `${releaseId}.json`),
    original = join(root, "original.json");
  writeFileSync(original, raw, { mode: 0o600 });
  rmSync(path);
  if (kind === "symlink") symlinkSync(original, path);
  else linkSync(original, path);
  expect(() => readCheckedConfigurationRelease(root, { releaseId, manifestDigest })).toThrow();
});
it.each(["foreign", "tag", "oversized", "privacy", "local"])(
  "rejects ineligible checked data: %s",
  (kind) => {
    const manifest = JSON.parse(raw);
    if (kind === "foreign") manifest.images.api = `ghcr.io/foreign/api@sha256:${"a".repeat(64)}`;
    if (kind === "tag") manifest.images.api = "ghcr.io/openmapx/api:latest";
    if (kind === "privacy") manifest.privacyReleaseValidation.checks.policyConsistent = false;
    if (kind === "local") vi.stubEnv("OPENMAPX_RELEASE", "local");
    const modified = JSON.stringify(manifest) + (kind === "oversized" ? " ".repeat(32768) : "");
    writeFileSync(join(directory, `${releaseId}.json`), modified);
    const digest = createHash("sha256").update(modified).digest("hex");
    expect(() =>
      readCheckedConfigurationRelease(root, { releaseId, manifestDigest: digest }),
    ).toThrow();
  },
);
it.each(["single", "indexed"])(
  "preflights declared OCI bytes and platform without pulling images: %s",
  async (kind) => {
    expect(CONFIGURATION_RELEASE_IMAGE_NAMES).toEqual(services.RELEASE_IMAGE_NAMES);
    const release = readCheckedConfigurationRelease(root, { releaseId, manifestDigest });
    const execFile = vi.fn(async (_file: string, args: readonly string[]) => {
      let stdout: string;
      if (args[0] === "info") stdout = "linux/x86_64";
      else if (args[0] === "manifest" && args[1] === "inspect") {
        const reference = args[2]!;
        stdout = JSON.stringify(
          kind === "indexed" && reference.endsWith(`@sha256:${"a".repeat(64)}`)
            ? {
                schemaVersion: 2,
                manifests: [
                  {
                    digest: `sha256:${"b".repeat(64)}`,
                    size: 512,
                    platform: { os: "linux", architecture: "amd64" },
                  },
                ],
              }
            : {
                schemaVersion: 2,
                config: { size: 256, digest: `sha256:${"c".repeat(64)}` },
                layers: [{ size: 1024, digest: `sha256:${"d".repeat(64)}` }],
              },
        );
      } else throw Error("Unexpected Docker mutation during preflight");
      return { stdout, stderr: "" };
    });
    const result = await inspectConfigurationReleaseDownloads({
      release,
      execFile,
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ version: 1, platform: "linux/amd64", declaredBytes: 7 * 1280 });
    expect(result.images).toHaveLength(7);
    expect(result.images[0]).toMatchObject({
      image: "api",
      reference: release.manifest.images.api,
      platformManifestDigest: `sha256:${(kind === "indexed" ? "b" : "a").repeat(64)}`,
      configDigest: `sha256:${"c".repeat(64)}`,
    });
    expect(
      execFile.mock.calls.every(
        ([file, args]) => file === "docker" && ["info", "manifest"].includes(args[0]!),
      ),
    ).toBe(true);
  },
);
it.each([
  "platform",
  "unavailable-index",
  "ambiguous",
  "oversized-image",
  "oversized-total",
  "malformed",
  "aborted",
  "too-much-output",
])("refuses unsafe download preflight without a pull: %s", async (kind) => {
  const release = readCheckedConfigurationRelease(root, { releaseId, manifestDigest }),
    controller = new AbortController();
  if (kind === "aborted") controller.abort(Error("Synthetic observation canceled"));
  const execFile = vi.fn(async (_file: string, args: readonly string[]) => {
    if (args[0] === "info")
      return { stdout: kind === "platform" ? "windows/amd64" : "linux/amd64", stderr: "" };
    if (args[0] !== "manifest" || args[1] !== "inspect") throw Error("Unexpected mutation");
    let value: unknown = {
      schemaVersion: 2,
      config: { size: 256, digest: `sha256:${"c".repeat(64)}` },
      layers: [
        {
          size:
            kind === "oversized-image"
              ? 8 * 1024 ** 3 + 1
              : kind === "oversized-total"
                ? 5 * 1024 ** 3
                : 1024,
          digest: `sha256:${"d".repeat(64)}`,
        },
      ],
      ...(kind === "too-much-output" ? { annotations: { value: "x".repeat(1024 * 1024) } } : {}),
    };
    if (kind === "malformed") value = { schemaVersion: 2, layers: [] };
    if (kind === "ambiguous" || kind === "unavailable-index")
      value = {
        schemaVersion: 2,
        manifests: Array.from({ length: kind === "ambiguous" ? 2 : 1 }, () => ({
          size: 512,
          digest: `sha256:${"b".repeat(64)}`,
          platform: { os: "linux", architecture: kind === "unavailable-index" ? "arm64" : "amd64" },
        })),
      };
    return { stdout: JSON.stringify(value), stderr: "" };
  });
  await expect(
    inspectConfigurationReleaseDownloads({ release, execFile, signal: controller.signal }),
  ).rejects.toThrow();
  expect(execFile.mock.calls.every(([, args]) => ["info", "manifest"].includes(args[0]!))).toBe(
    true,
  );
  if (kind === "aborted") expect(execFile).not.toHaveBeenCalled();
});

// The checked preflight joins the real private cache/lock to registry reads;
// this is not a target grant, pull or release runtime acceptance test.
it.each([false, true])(
  "binds one checked preflight snapshot and rejects metadata-time source drift: %s",
  async (drift) => {
    const { preflightConfigurationRelease } = await import("./configuration-release-preflight");
    let changed = false;
    const execFile = vi.fn(async (_file: string, args: readonly string[]) => {
      if (args[0] === "info") return { stdout: "linux/amd64", stderr: "" };
      expect(args.slice(0, 2)).toEqual(["manifest", "inspect"]);
      if (drift && !changed) {
        changed = true;
        writeFileSync(join(directory, `${releaseId}.json`), `${raw}\n`, { mode: 0o600 });
      }
      return {
        stdout: JSON.stringify({
          schemaVersion: 2,
          config: { digest: `sha256:${"c".repeat(64)}`, size: 32 },
          layers: [{ digest: `sha256:${"d".repeat(64)}`, size: 64 }],
        }),
        stderr: "",
      };
    });
    const run = () =>
      preflightConfigurationRelease({
        infraDir: root,
        selection: { releaseId, manifestDigest },
        execFile,
        signal: new AbortController().signal,
      });
    if (drift) await expect(run()).rejects.toThrow("Checked configuration release changed");
    else
      expect(await run()).toMatchObject({
        releaseId,
        manifestDigest,
        canonicalManifest: raw,
        imagePrefix: "ghcr.io/openmapx",
        downloads: { declaredBytes: 7 * 96 },
      });
    expect(
      execFile.mock.calls.every(([, args]) => args[0] === "info" || args[0] === "manifest"),
    ).toBe(true);
    writeFileSync(join(directory, `${releaseId}.json`), raw, { mode: 0o600 });
    // Original lock is released on either return path; no cleanup/admission is needed.
    expect(await run()).toMatchObject({ releaseId, manifestDigest });
  },
);
