import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { opsOperationFingerprint, opsResourceId } from "@openmapx/core/ops";
import { services } from "@openmapx/core/server";
import { afterEach, describe, expect, it } from "vitest";
import { readAgentHandoff } from "./agent-handoff";
import { openOpsJobJournal } from "./journal";
import { importLegacyAgentState, retireLegacyAgentState } from "./legacy-state";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const rootDir = mkdtempSync(join(tmpdir(), "openmapx-legacy-state-"));
  roots.push(rootDir);
  const infraDir = join(rootDir, "infra", "docker");
  const legacy = services.legacyAgentStatePaths(infraDir);
  const current = services.agentStatePaths(infraDir);
  mkdirSync(legacy.directory, { recursive: true, mode: 0o700 });
  let helpers = new Set<string>();
  const options = {
    rootDir,
    handoffHelperRunning: async (handoffId?: string) =>
      handoffId === undefined ? helpers.size > 0 : helpers.has(handoffId),
  };
  return {
    rootDir,
    legacy,
    current,
    options,
    setHelpers: (ids: string[]) => {
      helpers = new Set(ids);
    },
  };
}

const operation = { kind: "backup.create", backupId: "nightly-20261020" } as const;
const job = {
  role: "api" as const,
  operation,
  operationId: `job1_${"a".repeat(24)}`,
  operationKey: `opk1_${"b".repeat(24)}`,
  fingerprint: opsOperationFingerprint(operation),
  resourceId: opsResourceId(operation),
  state: "running" as const,
  submittedAt: "2026-10-20T10:00:00.000Z",
  updatedAt: "2026-10-20T10:00:01.000Z",
};

const finishedOperation = { kind: "backup.delete", backupId: "nightly-20261019" } as const;
const finished = {
  role: "api" as const,
  operation: finishedOperation,
  operationId: `job1_${"c".repeat(24)}`,
  operationKey: `opk1_${"d".repeat(24)}`,
  fingerprint: opsOperationFingerprint(finishedOperation),
  resourceId: opsResourceId(finishedOperation),
  state: "failed" as const,
  errorClass: "runtime" as const,
  submittedAt: "2026-10-19T10:00:00.000Z",
  updatedAt: "2026-10-19T10:00:01.000Z",
  terminalAt: "2026-10-19T10:00:01.000Z",
};

/** The journal as the previous agent's own writer left it. */
async function writeLegacyJournal(path: string): Promise<void> {
  await (await openOpsJobJournal(path)).replace([job, finished]);
}

function handoff(phase: string, overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    version: 1,
    handoffId: "handoff-1",
    releaseId: "release-1",
    digest: "c".repeat(64),
    phase,
    previousOverlay: "services: {}\n",
    createdAt: "2026-10-20T10:00:00.000Z",
    updatedAt: "2026-10-20T10:00:00.000Z",
    ...overrides,
  });
}

describe("importing an earlier release's agent state", () => {
  it("keeps the job the previous agent left unfinished", async () => {
    const f = fixture();
    await writeLegacyJournal(f.legacy.journal);
    await expect(importLegacyAgentState(f.options)).resolves.toEqual({
      journal: "imported",
      handoff: "absent",
    });
    // Only the unfinished job: a finished record's result could have been
    // written by data-manager and would answer lookups in place of a real run.
    const journal = await openOpsJobJournal(f.current.journal);
    expect(journal.records()).toEqual([
      expect.objectContaining({
        operationId: job.operationId,
        state: "failed",
        errorClass: "recovery_required",
      }),
    ]);
  });

  it("imports once and never reads the old location again", async () => {
    const f = fixture();
    await importLegacyAgentState(f.options);
    // data-manager can write here; whatever appears later is never trusted.
    await writeLegacyJournal(f.legacy.journal);
    writeFileSync(f.legacy.handoff, handoff("recreated"), { mode: 0o600 });
    f.setHelpers(["handoff-1"]);
    await expect(importLegacyAgentState(f.options)).resolves.toBeNull();
    expect(existsSync(f.current.journal)).toBe(false);
    expect(readAgentHandoff(f.rootDir)).toBeNull();
  });

  it("discards a handoff record no running helper vouches for", async () => {
    const f = fixture();
    // A planted record whose previous overlay a rollback would restore.
    writeFileSync(
      f.legacy.handoff,
      handoff("recreated", { previousOverlay: "services:\n  app-api:\n    image: evil\n" }),
      { mode: 0o600 },
    );
    await expect(importLegacyAgentState(f.options)).resolves.toMatchObject({
      handoff: "discarded",
    });
    expect(readAgentHandoff(f.rootDir)).toBeNull();
  });

  it("discards a finished handoff record, which only a rollback target could use", async () => {
    const f = fixture();
    writeFileSync(f.legacy.handoff, handoff("applied"), { mode: 0o600 });
    f.setHelpers(["handoff-1"]);
    await expect(importLegacyAgentState(f.options)).resolves.toMatchObject({
      handoff: "discarded",
    });
    expect(readAgentHandoff(f.rootDir)).toBeNull();
  });

  it("imports the handoff whose helper is replacing the agent with this one", async () => {
    const f = fixture();
    writeFileSync(f.legacy.handoff, handoff("recreated"), { mode: 0o600 });
    f.setHelpers(["handoff-1"]);
    await expect(importLegacyAgentState(f.options)).resolves.toMatchObject({
      handoff: "imported",
    });
    // Never the previous overlay a rollback would restore.
    expect(readAgentHandoff(f.rootDir)).toMatchObject({
      handoffId: "handoff-1",
      phase: "recreated",
      previousOverlay: null,
      importedFromLegacy: true,
    });
  });

  it("removes the old files only once no helper could roll back to an agent that reads them", async () => {
    const f = fixture();
    await writeLegacyJournal(f.legacy.journal);
    writeFileSync(f.legacy.handoff, handoff("recreated"), { mode: 0o600 });
    writeFileSync(join(f.legacy.directory, "keep-me"), "operator file");
    f.setHelpers(["handoff-1"]);
    await importLegacyAgentState(f.options);

    await expect(retireLegacyAgentState(f.options)).resolves.toBe(false);
    expect(readFileSync(f.legacy.journal, "utf8")).toContain(job.operationId);

    f.setHelpers([]);
    await expect(retireLegacyAgentState(f.options)).resolves.toBe(true);
    expect(existsSync(f.legacy.journal)).toBe(false);
    expect(existsSync(f.legacy.handoff)).toBe(false);
    expect(existsSync(join(f.legacy.directory, "keep-me"))).toBe(true);
  });

  it("does not retire anything before the import", async () => {
    const f = fixture();
    await writeLegacyJournal(f.legacy.journal);
    await expect(retireLegacyAgentState(f.options)).resolves.toBe(false);
    expect(existsSync(f.legacy.journal)).toBe(true);
  });
});
