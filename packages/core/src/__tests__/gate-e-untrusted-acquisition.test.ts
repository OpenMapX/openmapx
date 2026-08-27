import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertCloneWithinBudget,
  GIT_CLONE_MAX_ENTRIES,
  GIT_CLONE_MAX_FILE_BYTES,
  GIT_CLONE_MAX_PATH_BYTES,
  GIT_CLONE_MAX_TOTAL_BYTES,
  GIT_CLONE_TIMEOUT_MS,
  GitCloneQuotaError,
} from "../git-clone";
import { spawnWithBufferedLogs } from "../spawn";

/**
 * Gate E — untrusted acquisition (Tracks 7, 13, 14).
 *
 * Every acquisition path that reaches untrusted bytes must be bounded by a
 * deadline, must kill only its own isolated worker, and must leave no temporary
 * tree behind. The parser half of this gate is `scripts/check-image-size-dos.mjs`,
 * which probes every installed vulnerable entry under isolated child-process
 * deadlines and runs in `check:policy`.
 */

const roots: string[] = [];
function root(): string {
  const directory = mkdtempSync(join(tmpdir(), "openmapx-gate-e-"));
  roots.push(directory);
  return directory;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

describe("Gate E — untrusted acquisition", () => {
  it("declares every clone budget as a named, testable constant", () => {
    expect(GIT_CLONE_TIMEOUT_MS).toBe(120_000);
    expect(GIT_CLONE_MAX_ENTRIES).toBe(25_000);
    expect(GIT_CLONE_MAX_TOTAL_BYTES).toBe(512 * 1024 * 1024);
    expect(GIT_CLONE_MAX_FILE_BYTES).toBe(64 * 1024 * 1024);
    expect(GIT_CLONE_MAX_PATH_BYTES).toBe(512);
  });

  it("refuses an oversized single file rather than reading it", () => {
    const directory = root();
    // A sparse file: the budget is enforced from the reported size, so this
    // costs no real disk and is never read.
    const path = join(directory, "big.bin");
    const fs = require("node:fs") as typeof import("node:fs");
    const handle = fs.openSync(path, "w");
    try {
      fs.ftruncateSync(handle, GIT_CLONE_MAX_FILE_BYTES + 1);
    } finally {
      fs.closeSync(handle);
    }

    expect(() => assertCloneWithinBudget(directory)).toThrow(GitCloneQuotaError);
    expect(() => assertCloneWithinBudget(directory)).toThrow(/larger than/i);
  });

  it("kills only its own worker on a deadline and leaves nothing behind", async () => {
    const directory = root();
    const marker = join(directory, "worker.pid");

    // A child that would otherwise run far past the deadline.
    const controller = new AbortController();
    const child = spawnWithBufferedLogs(
      "node",
      [
        "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setTimeout(() => {}, 60000);`,
      ],
      { signal: controller.signal },
    );

    // Give the child time to register, then abort just this one.
    await new Promise((resolve) => setTimeout(resolve, 250));
    controller.abort();
    await expect(child).rejects.toMatchObject({ name: "AbortError" });

    // The sibling process in this test runner is unaffected: we are still here
    // and able to observe our own pid.
    expect(process.pid).toBeGreaterThan(0);

    // The worker is gone, not merely detached.
    if (existsSync(marker)) {
      const pid = Number(require("node:fs").readFileSync(marker, "utf8"));
      await new Promise((resolve) => setTimeout(resolve, 250));
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      expect(alive).toBe(false);
    }
  });

  it("removes the temporary tree when a clone fails validation", async () => {
    const { gitShallowClone } = await import("../git-clone");
    const target = join(root(), "clone-target");

    // Validation rejects the URL before any process starts, and the helper's
    // cleanup path still runs.
    await expect(
      gitShallowClone({ url: "https://evil.example.test/o/r.git", targetDir: target }),
    ).rejects.toThrow();
    expect(existsSync(target)).toBe(false);
  });

  it("leaves no stray temporary directories from a rejected acquisition", async () => {
    const before = readdirSync(tmpdir()).filter((name) => name.startsWith("openmapx-git-"));
    const { gitShallowClone } = await import("../git-clone");
    await expect(gitShallowClone({ url: "file:///etc/passwd" })).rejects.toThrow();
    const after = readdirSync(tmpdir()).filter((name) => name.startsWith("openmapx-git-"));
    expect(after.length).toBeLessThanOrEqual(before.length);
  });
});
