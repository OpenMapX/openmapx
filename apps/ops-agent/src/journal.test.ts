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
import { OPS_JOB_JOURNAL_MAX_ORPHANS, openOpsJobJournal, type PersistedOpsJob } from "./journal";
import { persistedJob } from "./test-fixtures/persisted-job";

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
  const operation = overrides.operation ?? {
    kind: "service.pull",
    serviceId: "redis",
    expectedConfigurationRevisionId: `cfg1_${"a".repeat(43)}`,
  };
  return persistedJob(operation, {
    operationId: "job1_journalOperation0",
    operationKey: "opk1_journalOperation0",
    ...overrides,
  });
}

const pullResult = {
  changed: true,
  revisionId: `cfg1_${"a".repeat(43)}`,
  imageReference: "redis:8",
  imageId: `sha256:${"b".repeat(64)}`,
  releaseSelectionDigest: null,
};

/** A row as a release with a different operation schema would write it. */
function otherReleaseRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...job({
      operationId: "job1_otherReleaseRow0",
      operationKey: "opk1_otherReleaseRow0",
      state: "succeeded",
      result: pullResult,
      terminalAt: "2026-08-23T18:00:01.000Z",
    }),
    requestVersion: 2,
    operation: { kind: "service.pull", serviceId: "redis", pullPolicy: "always" },
    ...overrides,
  };
}

function writeJournal(path: string, jobs: unknown[]): void {
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify({ version: 1, jobs }), { mode: 0o600 });
}

describe("durable ops job journal", () => {
  it("refuses another envelope version and a row without its identity", async () => {
    const directory = join(root(), "journal");
    mkdirSync(directory, { mode: 0o700 });
    const path = join(directory, "jobs.json");
    writeFileSync(path, JSON.stringify({ version: 2, jobs: [] }), { mode: 0o600 });
    await expect(openOpsJobJournal(path)).rejects.toThrow("Ops job journal is unavailable");

    const {
      requestVersion: _requestVersion,
      admittedAt: _admittedAt,
      deadlineAt: _deadlineAt,
      ...withoutIdentity
    } = job({
      state: "succeeded",
      terminalAt: "2026-08-23T18:00:01.000Z",
      result: pullResult,
    });
    writeJournal(path, [withoutIdentity]);
    await expect(openOpsJobJournal(path)).rejects.toThrow("Ops job journal is unavailable");
    writeJournal(path, [{ ...job(), operationId: "not-an-operation-id" }]);
    await expect(openOpsJobJournal(path)).rejects.toThrow("Ops job journal is unavailable");
    writeJournal(path, [{ ...job(), state: "parked" }]);
    await expect(openOpsJobJournal(path)).rejects.toThrow("Ops job journal is unavailable");
    writeJournal(path, [{ ...job({ state: "succeeded", result: pullResult }) }]);
    await expect(openOpsJobJournal(path)).rejects.toThrow("Ops job journal is unavailable");
  });

  it("durably probes a missing journal before open succeeds", async () => {
    const path = join(root(), "journal", "jobs.json");
    await openOpsJobJournal(path);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ version: 1, jobs: [] });
  });

  it("fails open when an existing readable journal directory is not writable", async () => {
    const directory = join(root(), "journal");
    mkdirSync(directory, { mode: 0o700 });
    const path = join(directory, "jobs.json");
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
    const path = join(directory, "jobs.json");
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
    const path = join(directory, "jobs.json");
    await openOpsJobJournal(path);
    const orphan = join(directory, `.jobs.json.${"a".repeat(24)}.tmp`);
    const unrelated = join(directory, "operator-note.txt");
    writeFileSync(unrelated, "keep");
    writeFileSync(orphan, "partial");
    await openOpsJobJournal(path);
    expect(existsSync(orphan)).toBe(false);
    expect(readFileSync(unrelated, "utf8")).toBe("keep");

    const target = join(directory, "unowned-target");
    writeFileSync(target, "partial");
    const symlink = join(directory, `.jobs.json.${"b".repeat(24)}.tmp`);
    symlinkSync(target, symlink);
    await expect(openOpsJobJournal(path)).rejects.toThrow("Ops job journal is unavailable");
    rmSync(symlink);
    const hardlink = join(directory, `.jobs.json.${"c".repeat(24)}.tmp`);
    linkSync(target, hardlink);
    await expect(openOpsJobJournal(path)).rejects.toThrow("Ops job journal is unavailable");
    rmSync(hardlink);

    for (let index = 0; index <= OPS_JOB_JOURNAL_MAX_ORPHANS; index += 1) {
      writeFileSync(
        join(directory, `.jobs.json.${index.toString(16).padStart(24, "0")}.tmp`),
        "partial",
      );
    }
    await expect(openOpsJobJournal(path)).rejects.toThrow("Ops job journal is unavailable");
  });

  it("refuses any other journal file name", async () => {
    await expect(openOpsJobJournal(join(root(), "journal", "jobs-v1.json"))).rejects.toThrow(
      "Ops job journal is unavailable",
    );
  });

  it("rejects non-canonical UTF-8 before JSON decoding", async () => {
    const directory = join(root(), "journal");
    mkdirSync(directory, { mode: 0o700 });
    const path = join(directory, "jobs.json");
    writeFileSync(path, Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]));
    await expect(openOpsJobJournal(path)).rejects.toThrow("Ops job journal is unavailable");
  });

  it("atomically retains terminal results and reconciles active work without rerunning it", async () => {
    const path = join(root(), "data", "jobs.json");
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

    await restored.replace([
      job({
        state: "succeeded",
        result: pullResult,
        updatedAt: "2026-08-23T18:03:00.000Z",
        terminalAt: "2026-08-23T18:03:00.000Z",
      }),
    ]);
    const terminal = await openOpsJobJournal(path);
    expect(terminal.records()).toEqual([
      expect.objectContaining({
        state: "succeeded",
        result: expect.objectContaining({ changed: true, imageReference: "redis:8" }),
      }),
    ]);
  });

  it("marks a job a restart ended as interrupted, never one that failed by itself", async () => {
    const path = join(root(), "data", "jobs.json");
    const journal = await openOpsJobJournal(path);
    await journal.replace([
      job({ state: "running" }),
      job({
        operationId: "job1_journalOperation1",
        operationKey: "opk1_journalOperation1",
        state: "failed",
        errorClass: "recovery_required",
        terminalAt: "2026-08-23T18:01:00.000Z",
      }),
    ]);
    const restored = await openOpsJobJournal(path);
    expect(
      restored.records().map((entry) => [entry.operationId, entry.state, entry.interrupted]),
    ).toEqual([
      ["job1_journalOperation0", "failed", true],
      ["job1_journalOperation1", "failed", undefined],
    ]);
    // Only a failed job carries the mark.
    await expect(
      restored.replace([{ ...job({ state: "running" }), interrupted: true }]),
    ).rejects.toThrow();
  });

  it("fails closed for symlink, hardlink, corrupt, and oversized journal files", async () => {
    const base = root();
    const target = join(base, "target");
    writeFileSync(target, JSON.stringify({ version: 1, jobs: [] }));
    const symlinkDirectory = join(base, "symlink");
    mkdirSync(symlinkDirectory, { mode: 0o700 });
    const symlink = join(symlinkDirectory, "jobs.json");
    symlinkSync(target, symlink);
    const hardlinkDirectory = join(base, "hardlink");
    mkdirSync(hardlinkDirectory, { mode: 0o700 });
    const hardlink = join(hardlinkDirectory, "jobs.json");
    const hardlinkTarget = join(hardlinkDirectory, "target");
    writeFileSync(hardlinkTarget, JSON.stringify({ version: 1, jobs: [] }));
    linkSync(hardlinkTarget, hardlink);
    const corruptDirectory = join(base, "corrupt");
    mkdirSync(corruptDirectory, { mode: 0o700 });
    const corrupt = join(corruptDirectory, "jobs.json");
    writeFileSync(corrupt, "not-json");
    const oversizedDirectory = join(base, "oversized");
    mkdirSync(oversizedDirectory, { mode: 0o700 });
    const oversized = join(oversizedDirectory, "jobs.json");
    writeFileSync(oversized, " ".repeat(128) + JSON.stringify({ version: 1, jobs: [] }));

    for (const path of [symlink, hardlink, corrupt]) {
      await expect(openOpsJobJournal(path)).rejects.toThrow("Ops job journal is unavailable");
    }
    await expect(openOpsJobJournal(oversized, { maxBytes: 128 })).rejects.toThrow(
      "Ops job journal is unavailable",
    );
  });

  it("serializes concurrent snapshots and enforces the entry bound", async () => {
    const path = join(root(), "journal", "jobs.json");
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
        openOpsJobJournal(join(root(), "journal", "jobs.json"), options),
      ).rejects.toThrow("Invalid ops job journal limits");
    }
  });
});

describe("settlement of a configuration apply", () => {
  const vaultApply = {
    kind: "vault.apply",
    serviceId: "api",
    revisionId: "vault-1",
    payloadDigest: "c".repeat(64),
    expectedCurrentRevisionId: null,
    expectedSourceRevision: "55555555-5555-4555-8555-555555555555",
    coordinatorMode: "ensure-running",
  } as const;
  const applied = {
    outcome: "committed",
    revisionId: `cfg1_${"d".repeat(43)}`,
    enabledServiceIds: ["api", "web"],
    followUp: "complete",
    cleanupFailed: false,
  } as const;

  it("writes it beside the result and reads the row back whole", async () => {
    const path = join(root(), "journal", "jobs.json");
    writeJournal(path, []);
    const journal = await openOpsJobJournal(path);
    const succeeded = job({
      operation: vaultApply,
      state: "succeeded",
      result: applied,
      terminalAt: "2026-08-23T18:00:01.000Z",
    });
    await journal.replace([succeeded]);
    const file = JSON.parse(readFileSync(path, "utf8")) as { jobs: Record<string, unknown>[] };
    expect(file.jobs[0]?.settlement).toEqual({
      outcome: "committed",
      summary: {
        revisionId: applied.revisionId,
        enabledServiceIds: ["api", "web"],
        followUp: "complete",
        cleanupFailed: false,
      },
    });
    const reopened = await openOpsJobJournal(path);
    expect(reopened.foreignRecords()).toEqual([]);
    expect(reopened.records()).toEqual([succeeded]);
  });

  it("keeps a row whose settlement does not restate its result as another release's", async () => {
    const path = join(root(), "journal", "jobs.json");
    writeJournal(path, [
      {
        ...job({
          operation: vaultApply,
          state: "succeeded",
          result: applied,
          terminalAt: "2026-08-23T18:00:01.000Z",
        }),
        settlement: {
          outcome: "not_committed",
          summary: { reason: "failed", cleanupFailed: false },
        },
      },
    ]);
    const journal = await openOpsJobJournal(path);
    expect(journal.records()).toEqual([]);
    expect(journal.foreignRecords()[0]?.settlement?.outcome).toBe("not_committed");
  });
});

describe("rows another release wrote", () => {
  it("keeps the writer's protocol version as data", async () => {
    const path = join(root(), "journal", "jobs.json");
    writeJournal(path, [
      {
        ...job(),
        requestVersion: 7,
        state: "succeeded",
        result: pullResult,
        terminalAt: "2026-08-23T18:00:01.000Z",
      },
    ]);
    const journal = await openOpsJobJournal(path);
    expect(journal.records()).toEqual([
      expect.objectContaining({ requestVersion: 7, state: "succeeded" }),
    ]);
    expect(journal.foreignRecords()).toEqual([]);
  });

  it("keeps a finished row whose operation no longer parses as written, beside readable rows", async () => {
    const path = join(root(), "journal", "jobs.json");
    const foreign = otherReleaseRow();
    const readable = job({
      state: "succeeded",
      result: pullResult,
      terminalAt: "2026-08-23T18:00:01.000Z",
    });
    writeJournal(path, [readable, foreign]);
    const journal = await openOpsJobJournal(path);
    expect(journal.records().map((entry) => entry.operationId)).toEqual([readable.operationId]);
    expect(journal.foreignRecords()).toEqual([
      expect.objectContaining({
        operationId: "job1_otherReleaseRow0",
        operationKey: "opk1_otherReleaseRow0",
        role: "api",
        requestVersion: 2,
        state: "succeeded",
        recoveryRequired: false,
        row: foreign,
      }),
    ]);
    // A rewrite of this release's rows keeps the foreign row byte for byte.
    await journal.replace(journal.records());
    const file = JSON.parse(readFileSync(path, "utf8")) as { version: number; jobs: unknown[] };
    expect(file.version).toBe(1);
    expect(file.jobs).toContainEqual(foreign);
    expect((await openOpsJobJournal(path)).foreignRecords()[0]?.row).toEqual(foreign);
  });

  it("keeps a row whose result, execution or extra field the current schemas refuse", async () => {
    const path = join(root(), "journal", "jobs.json");
    const valid = job({
      state: "succeeded",
      result: pullResult,
      terminalAt: "2026-08-23T18:00:01.000Z",
    });
    const rows = [
      {
        ...valid,
        operationId: "job1_changedResult000",
        operationKey: "opk1_changedResult000",
        result: { changed: "maybe" },
      },
      {
        ...valid,
        operationId: "job1_changedExecution",
        operationKey: "opk1_changedExecution",
        execution: { epoch: 3 },
      },
      {
        ...valid,
        operationId: "job1_addedRowField000",
        operationKey: "opk1_addedRowField000",
        priority: "high",
      },
      {
        ...valid,
        operationId: "job1_otherExecVersion",
        operationKey: "opk1_otherExecVersion",
        executionVersion: 2,
      },
    ];
    writeJournal(path, rows);
    const journal = await openOpsJobJournal(path);
    expect(journal.records()).toEqual([]);
    expect(journal.foreignRecords().map((entry) => entry.row)).toEqual(rows);
  });

  it("fails an unfinished foreign row as needing recovery instead of refusing to start", async () => {
    const path = join(root(), "journal", "jobs.json");
    const {
      result: _result,
      terminalAt: _terminalAt,
      ...running
    } = otherReleaseRow({
      state: "running",
    });
    const progressResult = { serviceBatch: { outcome: "partial" } };
    writeJournal(path, [{ ...running, progressResult }]);
    const journal = await openOpsJobJournal(path, {
      now: () => new Date("2026-08-23T18:05:00.000Z"),
    });
    expect(journal.records()).toEqual([]);
    const [foreign] = journal.foreignRecords();
    expect(foreign).toMatchObject({
      state: "failed",
      recoveryRequired: true,
      terminalAt: "2026-08-23T18:05:00.000Z",
      row: {
        state: "failed",
        errorClass: "recovery_required",
        interrupted: true,
        failureResult: progressResult,
        updatedAt: "2026-08-23T18:05:00.000Z",
        terminalAt: "2026-08-23T18:05:00.000Z",
        operation: running.operation,
      },
    });
    expect(foreign?.row).not.toHaveProperty("progressResult");
    // The conversion is durable: a second start reads the failed row.
    const again = await openOpsJobJournal(path, {
      now: () => new Date("2026-08-23T18:09:00.000Z"),
    });
    expect(again.foreignRecords()[0]?.terminalAt).toBe("2026-08-23T18:05:00.000Z");
  });

  it("drops only the foreign rows the caller stops naming, and keeps identities unique", async () => {
    const path = join(root(), "journal", "jobs.json");
    const foreign = otherReleaseRow();
    writeJournal(path, [foreign]);
    const journal = await openOpsJobJournal(path);
    await expect(journal.replace([], ["job1_neverWrittenHere0"])).rejects.toThrow(
      "Unknown foreign journal row",
    );
    await expect(
      journal.replace([
        job({
          operationId: "job1_otherReleaseRow0",
          operationKey: "opk1_freshKeyForTheRow0",
        }),
      ]),
    ).rejects.toThrow("Ops job journal contains duplicate identity");
    await journal.replace([job()], ["job1_otherReleaseRow0"]);
    expect((await openOpsJobJournal(path)).foreignRecords()).toHaveLength(1);
    await journal.replace([job()], []);
    const reopened = await openOpsJobJournal(path);
    expect(reopened.foreignRecords()).toEqual([]);
    expect(reopened.records()).toHaveLength(1);
  });

  it("counts foreign rows against the entry bound", async () => {
    const path = join(root(), "journal", "jobs.json");
    writeJournal(path, [otherReleaseRow()]);
    const journal = await openOpsJobJournal(path, { maxEntries: 1 });
    await expect(journal.replace([job()])).rejects.toThrow("Ops job journal capacity exceeded");
  });
});

describe("execution journal", () => {
  it("recomputes both hashes and never renews a running deadline on restart", async () => {
    const { normalizeExecutionAdmission, opsOperationFingerprint } = await import(
      "@openmapx/core/ops"
    );
    const path = join(root(), "jobs.json");
    const operation = { kind: "service.build" as const, serviceId: "valhalla" };
    const operationFingerprint = opsOperationFingerprint(operation);
    const admittedAt = Date.parse("2026-08-23T18:00:00.000Z");
    const operationKey = "opk1_abcdefghijklmnop";
    const normalized = normalizeExecutionAdmission({
      operationFingerprint,
      operationKey,
      kind: operation.kind,
      admittedAt,
      requestedDeadlineAt: admittedAt + 1000,
    });
    const record = {
      executionVersion: 1 as const,
      requestVersion: 1,
      ...normalized,
      operationFingerprint,
      requestedDeadlineAt: admittedAt + 1000,
      deploymentBudgetMs: 12 * 3600_000,
      operation,
      operationKey,
      operationId: "job1_abcdefghijklmnop",
      role: "api" as const,
      resourceId: "valhalla",
      state: "running" as const,
      submittedAt: new Date(admittedAt).toISOString(),
      updatedAt: new Date(admittedAt).toISOString(),
    };
    const journal = await openOpsJobJournal(path);
    await journal.replace([record]);
    const recovered = await openOpsJobJournal(path, { now: () => new Date(admittedAt + 2000) });
    expect(recovered.records()[0]).toMatchObject({
      admittedAt,
      deadlineAt: admittedAt + 1000,
      fingerprint: normalized.fingerprint,
      requestVersion: 1,
      state: "failed",
      errorClass: "recovery_required",
      terminationRequestedAt: new Date(admittedAt + 1000).toISOString(),
    });
    const retained = recovered.records()[0];
    if (!retained) throw new Error("Missing retained execution");
    await expect(
      recovered.replace([{ ...retained, deploymentBudgetMs: 6 * 3600_000 }]),
    ).rejects.toThrow("Retained execution identity is immutable");
    const extended = normalizeExecutionAdmission({
      operationFingerprint,
      operationKey,
      kind: operation.kind,
      admittedAt,
      requestedDeadlineAt: admittedAt + 5000,
    });
    await expect(
      recovered.replace([{ ...retained, ...extended, requestedDeadlineAt: admittedAt + 5000 }]),
    ).rejects.toThrow("Retained execution identity is immutable");
    await expect(
      recovered.replace([{ ...retained, deadlineAt: admittedAt + 5000 }]),
    ).rejects.toThrow();
    await expect(
      recovered.replace([{ ...retained, operationFingerprint: "c".repeat(64) }]),
    ).rejects.toThrow();
  });
});

it("reloads strict failed evidence and rejects it on a successful record", async () => {
  const { normalizeExecutionAdmission } = await import("@openmapx/core/ops");
  const operation = { kind: "service.build", serviceId: "valhalla" } as const;
  const operationKey = "opk1_retainedFailure123";
  const operationFingerprint = opsOperationFingerprint(operation);
  const admittedAt = Date.parse("2026-10-23T12:00:00.000Z");
  const normalized = normalizeExecutionAdmission({
    kind: operation.kind,
    operationKey,
    operationFingerprint,
    admittedAt,
  });
  const evidence = {
    serviceBatch: {
      outcome: "partial" as const,
      completedServiceIds: ["tileserver"],
      failedServiceIds: ["valhalla"],
      skippedServiceIds: [],
    },
    diagnostics: {
      truncated: false,
      tail: [{ stream: "stderr" as const, message: "retained diagnostic" }],
    },
  };
  const record = job({
    operation,
    operationKey,
    operationFingerprint,
    resourceId: "valhalla",
    submittedAt: new Date(admittedAt).toISOString(),
    ...normalized,
    executionVersion: 1,
    requestVersion: 1,
    deploymentBudgetMs: 12 * 3600_000,
    state: "failed",
    errorClass: "runtime",
    terminalAt: "2026-10-23T12:00:01.000Z",
    failureResult: evidence,
    diagnostics: evidence.diagnostics,
  });
  const path = join(root(), "journal", "jobs.json");
  const journal = await openOpsJobJournal(path);
  await journal.replace([record]);
  const reopened = await openOpsJobJournal(path);
  expect(reopened.records()[0]).toMatchObject({
    state: "failed",
    failureResult: evidence,
    diagnostics: evidence.diagnostics,
  });
  await expect(
    reopened.replace([
      { ...record, state: "succeeded", errorClass: undefined, result: { completed: true } },
    ]),
  ).rejects.toThrow();
});
it("retains Full Update progress while running, then keeps it as interrupted evidence without granting completion", async () => {
  const { normalizeExecutionAdmission } = await import("@openmapx/core/ops");
  const operation = { kind: "data.update" as const, regionId: "europe/germany" },
    operationKey = "opk1_workflowProgress123",
    operationFingerprint = opsOperationFingerprint(operation),
    admittedAt = Date.parse("2026-10-28T10:00:00.000Z");
  const normalized = normalizeExecutionAdmission({
    kind: operation.kind,
    operationKey,
    operationFingerprint,
    admittedAt,
    requestedDeadlineAt: admittedAt + 60000,
  });
  const progressResult = {
    dataWorkflow: {
      version: 1 as const,
      phase: "transit" as const,
      children: [],
      completedBuildIds: [],
      failedBuildIds: [],
      skippedBuildIds: [],
    },
  };
  const record = {
    ...job({
      operation,
      operationKey,
      operationFingerprint,
      resourceId: "europe/germany",
      ...normalized,
      requestedDeadlineAt: admittedAt + 60000,
      executionVersion: 1,
      requestVersion: 1,
      deploymentBudgetMs: 24 * 3600000,
      state: "running",
      submittedAt: new Date(admittedAt).toISOString(),
      updatedAt: new Date(admittedAt).toISOString(),
    }),
    progressResult,
  };
  const path = join(root(), "journal/jobs.json"),
    journal = await openOpsJobJournal(path);
  await journal.replace([record]);
  expect(journal.records()[0]).toMatchObject({ state: "running", progressResult });
  const reopened = await openOpsJobJournal(path, { now: () => new Date(admittedAt + 1000) });
  expect(reopened.records()[0]).toMatchObject({
    state: "failed",
    errorClass: "recovery_required",
    failureResult: progressResult,
  });
  expect(reopened.records()[0]).not.toHaveProperty("progressResult");
  expect(reopened.records()[0]).not.toHaveProperty("result");
});
