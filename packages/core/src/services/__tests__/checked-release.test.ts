import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as services from "../index";

const roots: string[] = [];
const locks = new Set<services.ReleaseStoreLock>();
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
function manifest(release = "checked-release"): services.ReleaseManifest {
  return {
    schemaVersion: 1,
    release,
    images: Object.fromEntries(
      services.RELEASE_IMAGE_NAMES.map((name) => [
        name,
        `ghcr.io/openmapx/${name}@sha256:${"a".repeat(64)}`,
      ]),
    ) as services.ReleaseManifest["images"],
    privacyReleaseValidation: {
      version: 1,
      sourceBuildFingerprint: "b".repeat(64),
      validatedAt: "2026-11-06T00:00:00.000Z",
      checks: { translationsConsistent: true, openApiConsistent: true, policyConsistent: true },
    },
  };
}
async function fixture() {
  const infraDir = mkdtempSync(join(tmpdir(), "openmapx-checked-release-"));
  roots.push(infraDir);
  const paths = services.ensureReleaseStateDirectories(infraDir);
  const lock = await services.acquireReleaseStoreLock(paths.store, {}, { failIfBusy: true });
  locks.add(lock);
  const input = {
    infraDir,
    manifest: manifest(),
    ociDigest: `sha256:${"c".repeat(64)}`,
    configurationIdentity: "d".repeat(64),
    lock,
  };
  return {
    input,
    paths,
    release() {
      locks.delete(lock);
      lock.release();
    },
  };
}
afterEach(() => {
  for (const lock of locks) lock.release();
  locks.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("checked release cache publication", () => {
  it("publishes canonical checked bytes and receipts without selecting or applying a release", async () => {
    const f = await fixture();
    services.writeReleaseComposeArtifacts(manifest("running-release"), f.input.infraDir);
    const before = readFileSync(f.paths.overlay, "utf8");
    writeFileSync(join(f.paths.store, "current.json"), "running-state", { mode: 0o600 });
    const result = services.cacheCheckedReleaseManifest(f.input);
    const raw = readFileSync(join(f.paths.store, "checked-release.json"), "utf8");
    expect(services.parseReleaseManifest(raw)).toEqual(f.input.manifest);
    expect(raw).toBe(services.canonicalReleaseManifest(f.input.manifest));
    expect(result).toEqual({ releaseId: "checked-release", manifestDigest: sha(raw) });
    expect(JSON.parse(readFileSync(join(f.paths.store, "selections.json"), "utf8"))).toEqual({
      "checked-release": {
        configuration: "d".repeat(64),
        ociDigest: `sha256:${"c".repeat(64)}`,
        digest: sha(raw),
      },
    });
    expect(JSON.parse(readFileSync(join(f.paths.store, "latest.json"), "utf8"))).toEqual({
      releaseId: "checked-release",
      digest: sha(raw),
    });
    expect(readFileSync(f.paths.overlay, "utf8")).toBe(before);
    expect(readFileSync(join(f.paths.store, "current.json"), "utf8")).toBe("running-state");
  });

  it("keeps the original immutable manifest inode on an exact repeated check", async () => {
    const f = await fixture();
    services.cacheCheckedReleaseManifest(f.input);
    const path = join(f.paths.store, "checked-release.json");
    const inode = statSync(path).ino;
    services.cacheCheckedReleaseManifest(f.input);
    expect(statSync(path).ino).toBe(inode);
    expect(readdirSync(f.paths.store).filter((name) => name.includes(".tmp"))).toEqual([]);
  });

  it("refuses different bytes under an already checked release ID", async () => {
    const f = await fixture();
    services.cacheCheckedReleaseManifest(f.input);
    const before = readFileSync(join(f.paths.store, "checked-release.json"), "utf8");
    const changed = {
      ...f.input.manifest,
      images: { ...f.input.manifest.images, web: `ghcr.io/openmapx/web@sha256:${"0".repeat(64)}` },
    };
    expect(() => services.cacheCheckedReleaseManifest({ ...f.input, manifest: changed })).toThrow(
      /authority|immutable|changed/i,
    );
    expect(readFileSync(join(f.paths.store, "checked-release.json"), "utf8")).toBe(before);
    expect(readdirSync(f.paths.store).filter((name) => name.includes(".tmp"))).toEqual([]);
  });

  it.each(["forged", "released"])("requires an actual held release lock (%s)", async (kind) => {
    const f = await fixture();
    const lock = kind === "forged" ? { release() {} } : f.input.lock;
    if (kind === "released") f.release();
    expect(() => services.cacheCheckedReleaseManifest({ ...f.input, lock })).toThrow(
      /lock|ownership/i,
    );
    expect(existsSync(join(f.paths.store, "checked-release.json"))).toBe(false);
  });

  it("refuses the sixty-fifth distinct release but permits the original immutable entry", async () => {
    const f = await fixture();
    for (let index = 0; index < 64; index++) {
      const value = manifest(`release-${index}`);
      writeFileSync(
        join(f.paths.store, `${value.release}.json`),
        services.canonicalReleaseManifest(value),
        { mode: 0o600 },
      );
    }
    expect(() => services.cacheCheckedReleaseManifest(f.input)).toThrow(/limit/i);
    expect(existsSync(join(f.paths.store, "checked-release.json"))).toBe(false);
    expect(
      services.cacheCheckedReleaseManifest({ ...f.input, manifest: manifest("release-0") })
        .releaseId,
    ).toBe("release-0");
  });

  it.each(["unknown-entry", "empty-entry", "oversized-entry", "writable-entry", "foreign-owner"])(
    "refuses unsafe existing state before publication (%s)",
    async (kind) => {
      const f = await fixture();
      if (kind === "unknown-entry")
        writeFileSync(join(f.paths.store, "unknown.txt"), "retain", { mode: 0o600 });
      if (kind === "empty-entry")
        writeFileSync(join(f.paths.store, "other.json"), "", { mode: 0o600 });
      if (kind === "oversized-entry")
        writeFileSync(join(f.paths.store, "other.json"), Buffer.alloc(32 * 1024 + 1), {
          mode: 0o600,
        });
      if (kind === "writable-entry") {
        writeFileSync(join(f.paths.store, "other.json"), "{}", { mode: 0o600 });
        chmodSync(join(f.paths.store, "other.json"), 0o620);
      }
      const uid = kind === "foreign-owner" ? (process.geteuid?.() ?? 0) + 1 : undefined;
      expect(() => services.cacheCheckedReleaseManifest({ ...f.input, uid })).toThrow(
        /unsafe|owned|owner|uid|limit/i,
      );
      expect(existsSync(join(f.paths.store, "checked-release.json"))).toBe(false);
      expect(existsSync(join(f.paths.store, "latest.json"))).toBe(false);
    },
  );

  it("does not invent transaction policy inside the shared legacy cache publisher", async () => {
    const f = await fixture();
    writeFileSync(join(f.paths.store, "transaction.json"), "{}", { mode: 0o600 });
    expect(services.cacheCheckedReleaseManifest(f.input).releaseId).toBe("checked-release");
    expect(readFileSync(join(f.paths.store, "transaction.json"), "utf8")).toBe("{}");
  });

  it.each(["current", "latest", "selections", "transaction"])(
    "never publishes a manifest over reserved state (%s)",
    async (release) => {
      const f = await fixture();
      expect(() =>
        services.cacheCheckedReleaseManifest({ ...f.input, manifest: manifest(release) }),
      ).toThrow(/reserved|identity/i);
      expect(existsSync(join(f.paths.store, `${release}.json`))).toBe(false);
    },
  );

  it("does not release another owner after the original guard was replaced", async () => {
    const f = await fixture();
    const path = join(f.paths.store, services.RELEASE_STORE_LOCK_NAME);
    renameSync(path, `${path}-original`);
    const successor = await services.acquireReleaseStoreLock(
      f.paths.store,
      {},
      { failIfBusy: true },
    );
    locks.add(successor);
    const owner = readFileSync(join(path, "owner.json"), "utf8");
    expect(() => f.release()).toThrow(/ownership.*changed/i);
    expect(readFileSync(join(path, "owner.json"), "utf8")).toBe(owner);
  });
});
