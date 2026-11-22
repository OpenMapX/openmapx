import { chmodSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { releaseProvenance } from "../__fixtures__/release-provenance";
import {
  cachedReleases,
  cacheReleaseManifest,
  readCachedReleaseManifest,
  readCheckedConfigurationRelease,
  releaseCacheDirectory,
} from "../release-cache";
import {
  canonicalReleaseManifest,
  RELEASE_IMAGE_NAMES,
  type ReleaseManifest,
  releaseChannel,
  releaseManifestDigest,
} from "../release-manifest";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function infra(): string {
  const root = mkdtempSync(join(tmpdir(), "openmapx-release-cache-"));
  roots.push(root);
  return root;
}
function manifest(release: string, digit = "a"): ReleaseManifest {
  return {
    schemaVersion: 1,
    release,
    images: Object.fromEntries(
      RELEASE_IMAGE_NAMES.map((name) => [
        name,
        `ghcr.io/openmapx/${name}@sha256:${digit.repeat(64)}`,
      ]),
    ) as ReleaseManifest["images"],
    ...releaseProvenance(),
  };
}
const channel = releaseChannel("main", "ghcr.io/openmapx/release-manifest");

it("caches a checked manifest under its digest and reads it back by that digest", () => {
  const root = infra();
  const first = manifest("release-1");
  const cached = cacheReleaseManifest(root, first);
  expect(cached).toEqual({ releaseId: "release-1", manifestDigest: releaseManifestDigest(first) });
  expect(readdirSync(releaseCacheDirectory(root))).toEqual([`${cached.manifestDigest}.json`]);
  expect(readCachedReleaseManifest(root, cached.manifestDigest, "ghcr.io/openmapx")).toEqual(first);
  // Caching the same release again is a no-op that marks it the newest.
  expect(cacheReleaseManifest(root, first)).toEqual(cached);
  expect(readCheckedConfigurationRelease(root, cached, channel)).toMatchObject({
    releaseId: "release-1",
    serviceImages: { api: first.images.api },
  });
});

it("refuses a cached file whose bytes are not the manifest its name says", () => {
  const root = infra();
  const cached = cacheReleaseManifest(root, manifest("release-1"));
  const path = join(releaseCacheDirectory(root), `${cached.manifestDigest}.json`);
  chmodSync(path, 0o600);
  writeFileSync(path, canonicalReleaseManifest(manifest("release-2")));
  expect(() => readCachedReleaseManifest(root, cached.manifestDigest, "ghcr.io/openmapx")).toThrow(
    /changed/,
  );
  expect(() => cacheReleaseManifest(root, manifest("release-1"))).toThrow(/another manifest/);
  expect(() =>
    readCheckedConfigurationRelease(root, { ...cached, releaseId: "release-2" }, channel),
  ).toThrow();
});

it("lists the releases of the configured repository, the one checked last first", () => {
  const root = infra();
  const older = cacheReleaseManifest(root, manifest("release-1", "1"));
  const newer = cacheReleaseManifest(root, manifest("release-2", "2"));
  const past = new Date(Date.now() - 60_000);
  utimesSync(join(releaseCacheDirectory(root), `${older.manifestDigest}.json`), past, past);
  expect(cachedReleases(root, "ghcr.io/openmapx").map((entry) => entry.manifestDigest)).toEqual([
    newer.manifestDigest,
    older.manifestDigest,
  ]);
  // Checking the older release again makes it the newest.
  cacheReleaseManifest(root, manifest("release-1", "1"));
  expect(cachedReleases(root, "ghcr.io/openmapx")[0]?.manifest.release).toBe("release-1");
  expect(cachedReleases(root, "registry.example.org/fork")).toEqual([]);
});

it("keeps at most 64 manifests, dropping the oldest", () => {
  const root = infra();
  for (let index = 0; index < 66; index += 1) {
    const cached = cacheReleaseManifest(
      root,
      manifest(`release-${index}`, (index % 10).toString()),
    );
    const at = new Date(Date.now() - (66 - index) * 1000);
    utimesSync(join(releaseCacheDirectory(root), `${cached.manifestDigest}.json`), at, at);
  }
  const releases = cachedReleases(root, "ghcr.io/openmapx");
  expect(releases).toHaveLength(64);
  expect(releases.map((entry) => entry.manifest.release)).not.toContain("release-0");
  expect(releases[0]?.manifest.release).toBe("release-65");
});

it("refuses a cache directory others can reach and a disabled channel", () => {
  const root = infra();
  const cached = cacheReleaseManifest(root, manifest("release-1"));
  expect(() => readCheckedConfigurationRelease(root, cached, releaseChannel("local"))).toThrow(
    /disabled/,
  );
  chmodSync(releaseCacheDirectory(root), 0o755);
  expect(() => readCachedReleaseManifest(root, cached.manifestDigest, "ghcr.io/openmapx")).toThrow(
    /Unsafe release cache/,
  );
});
