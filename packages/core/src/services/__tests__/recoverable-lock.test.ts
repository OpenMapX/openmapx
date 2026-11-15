import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireRecoverableLock,
  clearRecoverableLock,
  currentLockHolder,
  LockBusyError,
  type LockHolder,
  lockHolderGone,
  readLockHolder,
} from "../recoverable-lock";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function lockPath(): string {
  const root = mkdtempSync(join(tmpdir(), "omx-lock-"));
  roots.push(root);
  return join(root, "store.lock");
}
/** A pid that is certainly not running: a child that has already exited. */
function exitedPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""]);
  if (!child.pid) throw new Error("no pid");
  return child.pid;
}
const foreign = (overrides: Partial<LockHolder>): LockHolder => ({
  ...currentLockHolder("other writer"),
  ...overrides,
});
const neverAsked = async () => {
  throw new Error("Docker must not be asked");
};

describe("recoverable lock", () => {
  it("records its holder and removes the file on release", async () => {
    const path = lockPath();
    const release = await acquireRecoverableLock(path, { purpose: "test writer" });
    expect(readLockHolder(path)).toMatchObject({ purpose: "test writer", pid: process.pid });
    release();
    expect(existsSync(path)).toBe(false);
  });

  it("refuses a live holder after the wait and names it", async () => {
    const path = lockPath();
    const release = await acquireRecoverableLock(path, { purpose: "first writer" });
    const error = await acquireRecoverableLock(path, { purpose: "second", waitMs: 50 }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(LockBusyError);
    expect((error as LockBusyError).holder?.purpose).toBe("first writer");
    expect((error as Error).message).toContain("openmapx control clear --lock store.lock");
    release();
  });

  it("waits for a holder that releases within the wait", async () => {
    const path = lockPath();
    const release = await acquireRecoverableLock(path, { purpose: "first writer" });
    setTimeout(release, 50);
    const second = await acquireRecoverableLock(path, { purpose: "second", waitMs: 2_000 });
    expect(readLockHolder(path)?.purpose).toBe("second");
    second();
  });

  it("reclaims a lock whose holder in this PID namespace has exited", async () => {
    const path = lockPath();
    writeFileSync(path, JSON.stringify(foreign({ pid: exitedPid() })));
    const release = await acquireRecoverableLock(path, {
      purpose: "next writer",
      waitMs: 50,
      containerRunning: neverAsked,
    });
    expect(readLockHolder(path)?.purpose).toBe("next writer");
    release();
    expect(readdirSync(join(path, ".."))).toEqual([]);
  });

  it("reclaims a lock left before the last boot", async () => {
    const self = currentLockHolder("self");
    const stale = foreign({ bootId: "before-reboot", pidNamespace: "elsewhere", pid: 1 });
    expect(await lockHolderGone(stale, { ...self, bootId: "after-reboot" }, neverAsked)).toBe(true);
  });

  it("asks Docker only for a holder in another namespace and container", async () => {
    const self = { ...currentLockHolder("self"), bootId: null, containerId: null };
    const inContainer = foreign({
      bootId: null,
      pidNamespace: "pid:[1]",
      pid: 1,
      containerId: "a".repeat(64),
    });
    const asked: string[] = [];
    expect(
      await lockHolderGone(inContainer, self, async (id) => {
        asked.push(id);
        return false;
      }),
    ).toBe(true);
    expect(await lockHolderGone(inContainer, self, async () => true)).toBe(false);
    // Docker could not answer: the holder is not provably gone.
    expect(await lockHolderGone(inContainer, self, async () => undefined)).toBe(false);
    expect(asked).toEqual(["a".repeat(64)]);
  });

  it("never reclaims a holder that cannot be proved gone", async () => {
    const path = lockPath();
    writeFileSync(
      path,
      JSON.stringify(foreign({ pidNamespace: "pid:[1]", pid: 1, containerId: null })),
    );
    await expect(
      acquireRecoverableLock(path, { purpose: "next", waitMs: 50, containerRunning: neverAsked }),
    ).rejects.toBeInstanceOf(LockBusyError);
    expect(readLockHolder(path)?.purpose).toBe("other writer");
  });

  it("treats a live process with another start time as a reused pid", async () => {
    const self = currentLockHolder("self");
    if (!self.startTime) return; // Start times are read from /proc, on Linux only.
    const reused = foreign({ pid: process.pid, startTime: "1" });
    expect(await lockHolderGone(reused, self, neverAsked)).toBe(true);
    expect(await lockHolderGone(foreign({ pid: process.pid }), self, neverAsked)).toBe(false);
  });

  it("lets the operator clear a lock and refuses a release after that", async () => {
    const path = lockPath();
    const release = await acquireRecoverableLock(path, { purpose: "stuck writer" });
    expect(clearRecoverableLock(path)?.purpose).toBe("stuck writer");
    expect(clearRecoverableLock(path)).toBeUndefined();
    const next = await acquireRecoverableLock(path, { purpose: "next" });
    expect(() => release()).toThrow(/taken from this holder/);
    expect(readLockHolder(path)?.purpose).toBe("next");
    next();
  });
});
