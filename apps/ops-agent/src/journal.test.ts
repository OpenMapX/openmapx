import {
  chmodSync,
  existsSync,
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
import { opsOperationFingerprint } from "@openmapx/core/ops";
import { afterEach, describe, expect, it } from "vitest";
import {
  OPS_JOB_JOURNAL_MAX_BYTES,
  OPS_JOB_JOURNAL_MAX_ORPHANS,
  openOpsJobJournal,
  type PersistedOpsJob,
} from "./journal";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "openmapx-ops-journal-"));
  roots.push(value);
  return value;
}

function job(overrides: Partial<PersistedOpsJob> = {}): PersistedOpsJob {
  const operation = overrides.operation ?? { kind: "service.pull", serviceId: "redis" };
  return {
    role: "api",
    operation,
    operationId: "job1_journalOperation0",
    operationKey: "opk1_journalOperation0",
    fingerprint: opsOperationFingerprint(operation),
    resourceId: "redis",
    state: "queued",
    submittedAt: "2026-08-23T18:00:00.000Z",
    updatedAt: "2026-08-23T18:00:00.000Z",
    ...overrides,
  };
}

describe("durable ops job journal", () => {
  it("durably probes a missing journal before open succeeds", async () => {
    const path = join(root(), "journal", "jobs-v1.json");
    await openOpsJobJournal(path);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ version: 1, jobs: [] });
  });

  it("fails open when an existing readable journal directory is not writable", async () => {
    const directory = join(root(), "journal");
    mkdirSync(directory, { mode: 0o700 });
    const path = join(directory, "jobs-v1.json");
    writeFileSync(path, JSON.stringify({ version: 1, jobs: [] }));
    chmodSync(directory, 0o500);
    try {
      await expect(openOpsJobJournal(path)).rejects.toThrow("Ops job journal is unavailable");
    } finally {
      chmodSync(directory, 0o700);
    }
  });

  it("rejects a group/world-writable journal directory", async () => {
    const directory = join(root(), "journal");
    mkdirSync(directory, { mode: 0o700 });
    const path = join(directory, "jobs-v1.json");
    writeFileSync(path, JSON.stringify({ version: 1, jobs: [] }));
    chmodSync(directory, 0o722);
    try {
      await expect(openOpsJobJournal(path)).rejects.toThrow("Ops job journal is unavailable");
    } finally {
      chmodSync(directory, 0o700);
    }
  });

  it("scavenges only bounded safe owned crash-orphan files", async () => {
    const directory = join(root(), "journal");
    const path = join(directory, "jobs-v1.json");
    await openOpsJobJournal(path);
    const orphan = join(directory, `.jobs-v1.json.${"a".repeat(24)}.tmp`);
    const unrelated = join(directory, "operator-note.txt");
    writeFileSync(unrelated, "keep");
    writeFileSync(orphan, "partial");
    await openOpsJobJournal(path);
    expect(existsSync(orphan)).toBe(false);
    expect(readFileSync(unrelated, "utf8")).toBe("keep");

    const target = join(directory, "unowned-target");
    writeFileSync(target, "partial");
    const symlink = join(directory, `.jobs-v1.json.${"b".repeat(24)}.tmp`);
    symlinkSync(target, symlink);
    await expect(openOpsJobJournal(path)).rejects.toThrow("Ops job journal is unavailable");
    rmSync(symlink);
    const hardlink = join(directory, `.jobs-v1.json.${"c".repeat(24)}.tmp`);
    linkSync(target, hardlink);
    await expect(openOpsJobJournal(path)).rejects.toThrow("Ops job journal is unavailable");
    rmSync(hardlink);

    for (let index = 0; index <= OPS_JOB_JOURNAL_MAX_ORPHANS; index += 1) {
      writeFileSync(
        join(directory, `.jobs-v1.json.${index.toString(16).padStart(24, "0")}.tmp`),
        "partial",
      );
    }
    await expect(openOpsJobJournal(path)).rejects.toThrow("Ops job journal is unavailable");
  });

  it("rejects non-canonical UTF-8 before JSON decoding", async () => {
    const directory = join(root(), "journal");
    mkdirSync(directory, { mode: 0o700 });
    const path = join(directory, "jobs-v1.json");
    writeFileSync(path, Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]));
    await expect(openOpsJobJournal(path)).rejects.toThrow("Ops job journal is unavailable");
  });

  it("atomically retains terminal results and reconciles active work without rerunning it", async () => {
    const path = join(root(), "data", "jobs-v1.json");
    const journal = await openOpsJobJournal(path, {
      now: () => new Date("2026-08-23T18:01:00.000Z"),
    });
    await journal.replace([job({ state: "running" })]);

    const restored = await openOpsJobJournal(path, {
      now: () => new Date("2026-08-23T18:02:00.000Z"),
    });
    expect(restored.records()).toEqual([
      expect.objectContaining({
        operationId: "job1_journalOperation0",
        state: "failed",
        errorClass: "recovery_required",
        terminalAt: "2026-08-23T18:02:00.000Z",
      }),
    ]);
    expect(readFileSync(path, "utf8")).not.toContain("Bearer");

    await restored.replace([
      job({
        state: "succeeded",
        result: { changed: true },
        updatedAt: "2026-08-23T18:03:00.000Z",
        terminalAt: "2026-08-23T18:03:00.000Z",
      }),
    ]);
    const terminal = await openOpsJobJournal(path);
    expect(terminal.records()).toEqual([
      expect.objectContaining({ state: "succeeded", result: { changed: true } }),
    ]);
  });

  it("fails closed for symlink, hardlink, corrupt, and oversized journal files", async () => {
    const base = root();
    const target = join(base, "target");
    writeFileSync(target, JSON.stringify({ version: 1, jobs: [] }));
    const symlinkDirectory = join(base, "symlink");
    mkdirSync(symlinkDirectory, { mode: 0o700 });
    const symlink = join(symlinkDirectory, "jobs-v1.json");
    symlinkSync(target, symlink);
    const hardlinkDirectory = join(base, "hardlink");
    mkdirSync(hardlinkDirectory, { mode: 0o700 });
    const hardlink = join(hardlinkDirectory, "jobs-v1.json");
    linkSync(target, hardlink);
    const corruptDirectory = join(base, "corrupt");
    mkdirSync(corruptDirectory, { mode: 0o700 });
    const corrupt = join(corruptDirectory, "jobs-v1.json");
    writeFileSync(corrupt, "not-json");
    const oversizedDirectory = join(base, "oversized");
    mkdirSync(oversizedDirectory, { mode: 0o700 });
    const oversized = join(oversizedDirectory, "jobs-v1.json");
    writeFileSync(oversized, "x".repeat(OPS_JOB_JOURNAL_MAX_BYTES + 1));

    for (const path of [symlink, hardlink, corrupt, oversized]) {
      await expect(openOpsJobJournal(path)).rejects.toThrow("Ops job journal is unavailable");
    }
  });

  it("serializes concurrent snapshots and enforces the entry bound", async () => {
    const path = join(root(), "journal", "jobs-v1.json");
    const journal = await openOpsJobJournal(path, { maxEntries: 2 });
    const first = job();
    const second = job({
      operationId: "job1_journalOperation1",
      operationKey: "opk1_journalOperation1",
    });
    await Promise.all([journal.replace([first]), journal.replace([first, second])]);
    expect((await openOpsJobJournal(path)).records()).toHaveLength(2);
    await expect(
      journal.replace([
        first,
        second,
        job({
          operationId: "job1_journalOperation2",
          operationKey: "opk1_journalOperation2",
        }),
      ]),
    ).rejects.toThrow("Ops job journal capacity exceeded");
  });

  it("rejects invalid configured bounds", async () => {
    for (const options of [{ maxEntries: 0 }, { maxBytes: 0 }, { maxEntries: 1.5 }]) {
      await expect(
        openOpsJobJournal(join(root(), "journal", "jobs-v1.json"), options),
      ).rejects.toThrow("Invalid ops job journal limits");
    }
  });
});
