import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { backupPruneInventory } from "../backup-prune-plan";
import {
  backupStoreLockPath,
  retainBackupExpiryCeilings,
  withBackupRetentionPolicyChange,
  withBackupStoreLock,
} from "../backup-retention-store";
import { readLockHolder, withRecoverableLock } from "../recoverable-lock";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "openmapx-backup-policy-"));
  mkdirSync(join(root, "backups", "original"), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(root, "backups", "original", "manifest.json"),
    JSON.stringify({
      formatVersion: 1,
      name: "original",
      createdAt: "2026-08-01T00:00:00.000Z",
      services: [],
    }),
    { mode: 0o600 },
  );
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
it("keeps the existing backup lock through policy publication and preserves shorter ceilings", async () => {
  await withBackupRetentionPolicyChange(root, 30, 60, async () => {
    expect(readLockHolder(backupStoreLockPath(root))?.purpose).toBe("backup-store");
    await expect(
      withRecoverableLock(backupStoreLockPath(root), { purpose: "other", waitMs: 0 }, () => {}),
    ).rejects.toThrow(/held by backup-store/);
    const manifest = JSON.parse(
      readFileSync(join(root, "backups", "original", "manifest.json"), "utf8"),
    );
    expect(manifest.expiresAt).toBe("2026-08-31T00:00:00.000Z");
  });
  retainBackupExpiryCeilings(root, 10);
  retainBackupExpiryCeilings(root, 365);
  expect(
    JSON.parse(readFileSync(join(root, "backups", "original", "manifest.json"), "utf8")).expiresAt,
  ).toBe("2026-08-11T00:00:00.000Z");
});
it("keeps a stricter expiry when the later configuration commit fails", async () => {
  await expect(
    withBackupRetentionPolicyChange(root, 30, 5, async () => {
      throw Error("commit refused");
    }),
  ).rejects.toThrow("commit refused");
  expect(
    JSON.parse(readFileSync(join(root, "backups", "original", "manifest.json"), "utf8")).expiresAt,
  ).toBe("2026-08-06T00:00:00.000Z");
});
it.each(["symlink", "hardlink"])(
  "refuses a %s manifest before publishing the policy",
  async (mode) => {
    const path = join(root, "backups", "original", "manifest.json"),
      other = join(root, "foreign.json"),
      before = readFileSync(path);
    writeFileSync(other, before, { mode: 0o600 });
    rmSync(path);
    if (mode === "symlink") symlinkSync(other, path);
    else linkSync(other, path);
    let published = false;
    await expect(
      withBackupRetentionPolicyChange(root, 30, 60, async () => {
        published = true;
      }),
    ).rejects.toThrow();
    expect(published).toBe(false);
    expect(readFileSync(other)).toEqual(before);
  },
);
it("serialises backup effects on one lock file that inventories skip", async () => {
  const order: string[] = [];
  let releaseFirst!: () => void;
  const first = withBackupStoreLock(root, async () => {
    order.push("first");
    await new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    order.push("first done");
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(() => backupPruneInventory(root, 30, new Date())).not.toThrow();
  const second = withBackupStoreLock(root, async () => {
    order.push("second");
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  releaseFirst();
  await Promise.all([first, second]);
  expect(order).toEqual(["first", "first done", "second"]);
});
