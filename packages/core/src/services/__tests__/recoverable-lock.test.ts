import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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

  it("reclaims a holder of this container from before the container restarted", async () => {
    const container = "b".repeat(64);
    const self = { ...currentLockHolder("self"), bootId: null, containerId: container };
    const before = foreign({ bootId: null, containerId: container, pidNamespace: "pid:[old]" });
    expect(await lockHolderGone(before, { ...self, pidNamespace: "pid:[new]" }, neverAsked)).toBe(
      true,
    );
    // The same namespace keeps judging the holder's own process.
    expect(
      await lockHolderGone(
        { ...before, pidNamespace: "pid:[new]", pid: process.pid },
        { ...self, pidNamespace: "pid:[new]" },
        neverAsked,
      ),
    ).toBe(false);
  });

  it("refuses a lock path that is not a lock file at once", async () => {
    const path = lockPath();
    const { mkdirSync } = await import("node:fs");
    mkdirSync(path);
    await expect(acquireRecoverableLock(path, { purpose: "next", waitMs: 60_000 })).rejects.toThrow(
      "is not a lock file",
    );
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

  it("never removes a new holder's file that replaced the stale one it judged", async () => {
    const path = lockPath();
    writeFileSync(
      path,
      JSON.stringify(
        foreign({ pidNamespace: "elsewhere", containerId: "c".repeat(64), pid: 4242 }),
      ),
    );
    let live: number | undefined;
    // While this reclaimer asks Docker about the old holder, another reclaimer
    // removes that file and a new writer takes the lock.
    const replaced = async () => {
      unlinkSync(path);
      writeFileSync(path, JSON.stringify(currentLockHolder("new writer")));
      live = statSync(path).ino;
      return false;
    };
    await expect(
      acquireRecoverableLock(path, {
        purpose: "late reclaimer",
        waitMs: 200,
        containerRunning: replaced,
      }),
    ).rejects.toBeInstanceOf(LockBusyError);
    expect(statSync(path).ino).toBe(live);
    expect(readLockHolder(path)?.purpose).toBe("new writer");
    expect(existsSync(`${path}.reclaim`)).toBe(false);
  });
});
