import { createHash } from "node:crypto";
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
import { canonicalJson, opsOperationFingerprint } from "@openmapx/core/ops";
import { afterEach, describe, expect, it } from "vitest";
import {
  OPS_JOB_JOURNAL_MAX_BYTES,
  OPS_JOB_JOURNAL_MAX_ORPHANS,
  openOpsJobJournal,
  type PersistedOpsJob,
} from "./journal";
import { buildOpsAgentServer } from "./server";

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
  it("keeps an original historical pull journal as byte-identical observation without dispatchable work", async () => {
    const path = join(root(), "journal", "jobs-v1.json");
    await openOpsJobJournal(path);
    const operation = { kind: "service.pull", serviceId: "redis" },
      record = {
        role: "api",
        operation,
        operationId: "job1_legacyPullObservation0",
        operationKey: "opk1_legacyPullObservation0",
        fingerprint: createHash("sha256").update(canonicalJson(operation)).digest("hex"),
        resourceId: "redis",
        state: "succeeded",
        submittedAt: "2026-08-23T18:00:00.000Z",
        updatedAt: "2026-08-23T18:00:01.000Z",
        terminalAt: "2026-08-23T18:00:01.000Z",
        result: { changed: true },
      },
      encoded = JSON.stringify(record);
    writeFileSync(path, JSON.stringify({ version: 2, jobs: [record] }), { mode: 0o600 });
    const journal = await openOpsJobJournal(path);
    expect(journal.records()).toHaveLength(0);
    expect(JSON.stringify(journal.historicalPullRecords?.()[0])).toBe(encoded);
    const token = Buffer.alloc(32, 3).toString("base64url"),
      app = buildOpsAgentServer({
        tokens: { api: token, "data-manager": Buffer.alloc(32, 4).toString("base64url") },
        journal,
      });
    try {
      const response = await app.inject({
        method: "GET",
        url: `/v1/operations/${record.operationId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().result).toEqual({
        version: 1,
        operationId: record.operationId,
        operationKey: record.operationKey,
        kind: "service.pull",
        resourceId: "redis",
        state: record.state,
        submittedAt: record.submittedAt,
        updatedAt: record.updatedAt,
        result: record.result,
      });
      const now = Date.now(),
        rejected = await app.inject({
          method: "POST",
          url: "/v1/operations",
          headers: { authorization: `Bearer ${token}` },
          payload: {
            version: 1,
            requestId: "ops1_legacyPullRejected00",
            operationKey: record.operationKey,
            issuedAt: new Date(now).toISOString(),
            expiresAt: new Date(now + 20000).toISOString(),
            operation,
          },
        });
      expect(rejected.statusCode).toBe(400);
      expect(journal.records()).toHaveLength(0);
    } finally {
      await app.close();
    }
    await journal.replace([]);
    expect(JSON.stringify(JSON.parse(readFileSync(path, "utf8")).jobs[0])).toBe(encoded);
  });
  it("durably probes a missing journal before open succeeds", async () => {
    const path = join(root(), "journal", "jobs-v1.json");
    await openOpsJobJournal(path);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ version: 2, jobs: [] });
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
        result: {
          changed: true,
          revisionId: `cfg1_${"a".repeat(43)}`,
          imageReference: "redis:8",
          imageId: `sha256:${"b".repeat(64)}`,
          releaseSelectionDigest: null,
        },
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

describe("version2 execution journal", () => {
  it("recomputes both hashes and never renews a running deadline on restart", async () => {
    const { normalizeExecutionAdmission, opsOperationFingerprint } = await import(
      "@openmapx/core/ops"
    );
    const path = join(root(), "jobs-v1.json");
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
      executionVersion: 2 as const,
      requestVersion: 1 as const,
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
    await expect(recovered.replace([{ ...retained, requestVersion: 2 }])).rejects.toThrow(
      "Retained execution identity is immutable",
    );
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

it("reloads strict v2 failed evidence and rejects it on a successful record", async () => {
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
    executionVersion: 2,
    requestVersion: 2,
    deploymentBudgetMs: 12 * 3600_000,
    state: "failed",
    errorClass: "runtime",
    terminalAt: "2026-10-23T12:00:01.000Z",
    failureResult: evidence,
    diagnostics: evidence.diagnostics,
  });
  const path = join(root(), "journal", "jobs-v1.json");
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
