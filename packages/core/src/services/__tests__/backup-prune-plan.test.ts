import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { backupPruneInventory } from "../backup-prune-plan";

let infra: string;
const at = new Date("2026-08-31T00:00:00.000Z");
function archive(name: string, createdAt: string, expiresAt?: string) {
  const dir = join(infra, "backups", name);
  mkdirSync(dir, { mode: 0o755, recursive: true });
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({ formatVersion: 2, name, createdAt, expiresAt, services: [] }),
    { mode: 0o644 },
  );
  writeFileSync(join(dir, "archive.tar.gz"), "synthetic archive", { mode: 0o644 });
  return dir;
}
beforeEach(() => {
  infra = mkdtempSync(join(tmpdir(), "openmapx-prune-plan-"));
  mkdirSync(join(infra, "backups"), { mode: 0o755 });
});
afterEach(() => rmSync(infra, { recursive: true, force: true }));
it("previews only the original eligible set and does not write archive metadata", () => {
  const dir = archive("old", "2026-07-01T00:00:00.000Z"),
    before = readFileSync(join(dir, "manifest.json"));
  archive("boundary", "2026-08-01T00:00:00.000Z");
  const plan = backupPruneInventory(infra, 30, at);
  expect(plan.candidates.map((entry) => entry.backupId)).toEqual(["old"]);
  expect(plan.retainedCount).toBe(1);
  expect(readFileSync(join(dir, "manifest.json"))).toEqual(before);
});
it("binds newly created archives and byte-identical inode replacements", () => {
  const dir = archive("old", "2026-07-01T00:00:00.000Z"),
    before = backupPruneInventory(infra, 30, at);
  const path = join(dir, "manifest.json");
  writeFileSync(`${path}.new`, readFileSync(path), { mode: 0o644 });
  renameSync(`${path}.new`, path);
  expect(backupPruneInventory(infra, 30, at).inventoryDigest).not.toBe(before.inventoryDigest);
  const replaced = backupPruneInventory(infra, 30, at);
  archive("new", "2026-08-20T00:00:00.000Z");
  expect(backupPruneInventory(infra, 30, at).inventoryDigest).not.toBe(replaced.inventoryDigest);
});
it("keeps stamped ceilings and reports unreadable metadata separately", () => {
  archive("stamped", "2026-08-01T00:00:00.000Z", "2026-08-15T00:00:00.000Z");
  const broken = archive("broken", "2026-08-20T00:00:00.000Z");
  writeFileSync(join(broken, "manifest.json"), "broken", { mode: 0o644 });
  utimesSync(broken, at, at);
  const plan = backupPruneInventory(infra, 365, at);
  expect(plan.candidates.map((entry) => entry.backupId)).toEqual(["stamped"]);
  expect(plan.corruptBackups).toEqual(["broken"]);
});
it("refuses links and ignores only the existing store lock", () => {
  const dir = archive("old", "2026-07-01T00:00:00.000Z");
  mkdirSync(join(infra, "backups", ".backup-store.lock"), { mode: 0o755 });
  expect(backupPruneInventory(infra, 30, at).candidates).toHaveLength(1);
  symlinkSync(join(dir, "manifest.json"), join(dir, "link"));
  expect(() => backupPruneInventory(infra, 30, at)).toThrow();
});
