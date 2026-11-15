import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { services } from "@openmapx/core/server";
import { afterEach, expect, it } from "vitest";
import { SystemUpdateReceiptStore } from "../src/lib/system-update-receipt";

const roots: string[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "openmapx-update-receipt-"));
  roots.push(dir);
  return new SystemUpdateReceiptStore(join(dir, "update.json"));
}
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const identity = {
  origin: "https://maps.example.test",
  actorId: "admin",
  release: { releaseId: "release", manifestDigest: "a".repeat(64) },
  configuredSelector: "main",
  configurationIdentity: "b".repeat(64),
};
it("reserves keys durably once and refuses an existing fresh receipt", async () => {
  const store = fixture();
  const r = await store.create(identity);
  expect(new Set(Object.values(r.steps).map((s) => s.key)).size).toBe(3);
  expect(
    Object.values(r.steps).every((s) => /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(s.key)),
  ).toBe(true);
  expect(store.read()).toEqual(r);
  expect(readFileSync(store.path, "utf8")).not.toContain("cookie");
  await expect(store.create(identity)).rejects.toThrow(/exists|resume/i);
});
it("freezes request bytes before sending and prevents conflicting resumption", async () => {
  const store = fixture();
  await store.create(identity);
  await store.freeze("backup", { name: "backup" });
  await store.freeze("backup", { name: "backup" });
  await expect(store.freeze("backup", { name: "other" })).rejects.toThrow(/frozen|changed/i);
  expect(store.read().steps.backup.body).toEqual({ name: "backup" });
});
it("requires a private receipt parent rather than silently changing permissions", async () => {
  const store = fixture();
  chmodSync(join(store.path, ".."), 0o755);
  await expect(store.create(identity)).rejects.toThrow(/private|unsafe/i);
});
it("keeps backups enabled when reading an older receipt without a backup choice", async () => {
  const store = fixture();
  await store.create(identity);
  const original = JSON.parse(readFileSync(store.path, "utf8"));
  delete original.createBackup;
  writeFileSync(store.path, JSON.stringify(original));
  expect(store.read().createBackup).toBe(true);
});
it("refuses a second writer at once while the receipt lock is held", async () => {
  const store = fixture();
  const lock = join(store.path, "..", ".update.json.lock");
  await services.withRecoverableLock(lock, { purpose: "other update" }, async () => {
    await expect(store.create(identity)).rejects.toThrow(/held by other update/);
  });
  await expect(store.create(identity)).resolves.toMatchObject({ version: 1 });
  expect(existsSync(lock)).toBe(false);
});
it("reclaims the receipt lock of a writer that has exited", async () => {
  const store = fixture();
  const lock = join(store.path, "..", ".update.json.lock");
  const exited = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
    encoding: "utf8",
  });
  let self: ReturnType<typeof services.readLockHolder> | undefined;
  await services.withRecoverableLock(lock, { purpose: "crashed update" }, () => {
    self = services.readLockHolder(lock);
  });
  writeFileSync(lock, JSON.stringify({ ...self, pid: Number(exited.stdout), startTime: null }), {
    mode: 0o600,
  });
  await expect(store.create(identity)).resolves.toMatchObject({ version: 1 });
  expect(existsSync(lock)).toBe(false);
});
