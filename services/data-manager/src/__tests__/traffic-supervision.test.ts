import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createMaintenancePauseReporter,
  recoverTrafficWriterLock,
} from "../jobs/traffic/supervision.js";

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
  it("waits out a watchdog lock whose pid lives in another container", async () => {
    const dir = await mkdtemp(join(tmpdir(), "traffic-supervision-"));
    const statePath = join(dir, "state");
    const lock = `${statePath}.lock`;
    const writeOwner = (acquiredAt: number) =>
      writeFile(
        join(lock, "owner.json"),
        JSON.stringify({ pid: process.pid, acquiredAt, owner: "valhalla-watchdog" }),
      );
    try {
      await mkdir(lock);
      await writeOwner(Date.now());
      let stopped = false;
      const stopWorker = async () => {
        stopped = true;
      };

      // A forced recovery (traffic maintenance in progress) leaves it alone.
      await recoverTrafficWriterLock({
        statePath,
        now: Number.MAX_SAFE_INTEGER,
        workerPid: 123,
        stopWorker,
      });
      expect(await readFile(join(lock, "owner.json"), "utf8")).toContain("valhalla-watchdog");

      await writeOwner(Date.now() - 11 * 60_000);
      await recoverTrafficWriterLock({ statePath, workerPid: 123, stopWorker });
      await expect(readFile(join(lock, "owner.json"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(stopped).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("maintenance pause reporting", () => {
  const fence = JSON.stringify({
    schemaVersion: 1,
    operationId: "b".repeat(64),
    plan: "rebuild-extract",
    startedAt: "2026-10-30T15:44:08.055Z",
  });
  const started = Date.parse("2026-10-30T15:44:08.055Z");

  it("reports a pause once, again when it outlasts any maintenance, and the resume", () => {
    const messages: string[] = [];
    let clock = started + 2_000;
    let reads = 0;
    const reporter = createMaintenancePauseReporter({
      report: (message) => messages.push(message),
      now: () => clock,
    });
    const read = () => {
      reads += 1;
      return fence;
    };

    reporter.paused(read);
    clock += 10 * 60_000;
    reporter.paused(read);
    expect(messages).toEqual([
      "Traffic worker paused for Valhalla maintenance rebuild-extract (job bbbbbbbbbbbbbbbb, started 2026-10-30T15:44:08.055Z); it resumes when the maintenance fence is removed",
    ]);

    clock = started + 36 * 60_000;
    reporter.paused(read);
    clock += 60_000;
    reporter.paused(read);
    clock += 30 * 60_000;
    reporter.paused(read);
    expect(messages.filter((message) => message.includes("still paused"))).toHaveLength(2);
    expect(messages[1]).toContain("longer than any maintenance runs");
    expect(reads).toBe(1);

    reporter.resumed();
    reporter.resumed();
    expect(messages.at(-1)).toBe(
      "Traffic worker resumed after Valhalla maintenance job bbbbbbbbbbbbbbbb",
    );
    expect(messages).toHaveLength(4);
  });

  it("reports an unreadable fence as an unknown job timed from the pause", () => {
    const messages: string[] = [];
    const reporter = createMaintenancePauseReporter({
      report: (message) => messages.push(message),
      now: () => started,
    });
    reporter.paused(() => "not json");
    expect(messages).toEqual([
      "Traffic worker paused for Valhalla maintenance (job unknown, started 2026-10-30T15:44:08.055Z); it resumes when the maintenance fence is removed",
    ]);
  });

  it("stays quiet when the worker was never paused", () => {
    const messages: string[] = [];
    createMaintenancePauseReporter({ report: (message) => messages.push(message) }).resumed();
    expect(messages).toEqual([]);
  });
});
