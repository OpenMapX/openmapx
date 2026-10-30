import { createHash } from "node:crypto";
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { services } from "@openmapx/core/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readCheckedConfigurationRelease } from "./configuration-release";

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
