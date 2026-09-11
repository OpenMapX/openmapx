import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { recoverTrafficWriterLock } from "../jobs/traffic/supervision.js";

describe("traffic writer supervision", () => {
  it("fences its hung worker before releasing the lock", async () => {
    const dir = await mkdtemp(join(tmpdir(), "traffic-supervision-"));
    const statePath = join(dir, "state");
    const lock = `${statePath}.lock`;
    try {
      await mkdir(lock);
      await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: 123, acquiredAt: 100 }));
      let stopped = false;
      await recoverTrafficWriterLock({
        statePath,
        now: 30_100,
        workerPid: 123,
        stopWorker: async () => {
          expect(JSON.parse(await readFile(join(lock, "owner.json"), "utf8")).pid).toBe(123);
          stopped = true;
        },
      });
      expect(stopped).toBe(true);
      await expect(readFile(join(lock, "owner.json"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("never removes another live process's lock", async () => {
    const dir = await mkdtemp(join(tmpdir(), "traffic-supervision-"));
    const statePath = join(dir, "state");
    try {
      await mkdir(`${statePath}.lock`);
      await writeFile(
        join(`${statePath}.lock`, "owner.json"),
        JSON.stringify({ pid: process.pid, acquiredAt: 0 }),
      );
      await expect(
        recoverTrafficWriterLock({
          statePath,
          now: 30_100,
          workerPid: 123,
          stopWorker: async () => {},
        }),
      ).rejects.toThrow();
      expect(await readFile(join(`${statePath}.lock`, "owner.json"), "utf8")).toContain(
        String(process.pid),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
