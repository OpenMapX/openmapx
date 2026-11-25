import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPS_PUBLIC_ERROR_MESSAGES, type OpsOperation } from "@openmapx/core/ops";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildControlTestServer as buildOpsAgentServer,
  controlTestKey,
} from "./__fixtures__/server";
import { openOpsJobJournal } from "./journal";
import type { OpsResourceClaimer } from "./policy";
import { persistedJob } from "./test-fixtures/persisted-job";

const apiToken = Buffer.alloc(32, 41).toString("base64url");
const dataManagerToken = Buffer.alloc(32, 42).toString("base64url");
const baseTime = Date.now();
const deadlineAt = baseTime + 3_600_000;
const key = (label: string) => controlTestKey(label, deadlineAt);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const operation = {
  kind: "service.pull",
  serviceId: "redis",
  expectedConfigurationRevisionId: `cfg1_${"a".repeat(43)}`,
} as const satisfies OpsOperation;

const allow: OpsResourceClaimer = {
  claim: async (claimed, fingerprint) => ({
    operation: claimed,
    fingerprint,
    source: "registry",
    capability: { revisionId: "registry-v1", values: {} },
  }),
};

function auth(token = apiToken) {
  return { authorization: `Bearer ${token}`, "x-ops-protocol-version": "1" };
}

/** A finished row whose operation a release with another schema wrote. */
function foreignRow(label: string, overrides: Record<string, unknown> = {}) {
  return {
    ...persistedJob(operation, {
      operationId: `job1_${label}`,
      operationKey: key(`opk1_${label}`),
      requestedDeadlineAt: deadlineAt,
      submittedAt: new Date(baseTime).toISOString(),
      state: "succeeded",
      result: { changed: true },
      terminalAt: new Date(baseTime).toISOString(),
    }),
    requestVersion: 2,
    operation: { kind: "service.pull", serviceId: "redis", pullPolicy: "always" },
    ...overrides,
  };
}

async function journalWith(rows: unknown[], now = baseTime) {
  const root = mkdtempSync(join(tmpdir(), "openmapx-ops-foreign-"));
  roots.push(root);
  const path = join(root, "journal", "jobs.json");
  mkdirSync(join(root, "journal"), { mode: 0o700 });
  writeFileSync(path, JSON.stringify({ version: 1, jobs: rows }), { mode: 0o600 });
  return { path, journal: await openOpsJobJournal(path, { now: () => new Date(now) }) };
}

function otherRelease() {
  return {
    ok: false,
    error: { class: "other_release", message: OPS_PUBLIC_ERROR_MESSAGES.other_release },
  };
}

describe("journal rows another release wrote", () => {
  it("starts on them and tells callers that another release recorded them", async () => {
    const row = foreignRow("foreignStatusRow0000");
    const { journal } = await journalWith([row]);
    const dispatch = vi.fn();
    const app = await buildOpsAgentServer({
      tokens: { api: apiToken, "data-manager": dataManagerToken },
      resourceClaimer: allow,
      journal,
      now: () => new Date(baseTime + 1_000),
      dispatch,
    });
    const status = await app.inject({
      method: "GET",
      url: `/v1/operations/${row.operationId}`,
      headers: { ...auth(), "x-ops-request-id": "ops1_foreignStatus00000" },
    });
    expect(status.statusCode).toBe(409);
    expect(status.json()).toMatchObject(otherRelease());

    const events = await app.inject({
      method: "GET",
      url: `/v1/operations/${row.operationId}/events`,
      headers: { ...auth(), "x-ops-request-id": "ops1_foreignEvents00000" },
    });
    expect(events.statusCode).toBe(409);

    // Another role does not learn that the row exists.
    const otherRole = await app.inject({
      method: "GET",
      url: `/v1/operations/${row.operationId}`,
      headers: { ...auth(dataManagerToken), "x-ops-request-id": "ops1_foreignOtherRole00" },
    });
    expect(otherRole.statusCode).toBe(404);

    const lookup = await app.inject({
      method: "GET",
      url: `/v1/operation-keys/${row.operationKey}`,
      headers: {
        ...auth(),
        "x-ops-request-id": "ops1_foreignLookup00000",
        "x-ops-body-fingerprint": "a".repeat(64),
      },
    });
    expect(lookup.statusCode).toBe(409);
    expect(lookup.json()).toMatchObject(otherRelease());

    const resubmit = await app.inject({
      method: "POST",
      url: "/v1/operations",
      headers: auth(),
      payload: {
        version: 1,
        requestId: "ops1_foreignResubmit000",
        operationKey: row.operationKey,
        execution: { requestedDeadlineAt: deadlineAt },
        issuedAt: new Date(baseTime + 1_000).toISOString(),
        expiresAt: new Date(baseTime + 20_000).toISOString(),
        operation,
      },
    });
    expect(resubmit.statusCode).toBe(409);
    expect(resubmit.json()).toMatchObject(otherRelease());
    expect(dispatch).not.toHaveBeenCalled();
    await app.close();
  });

  it("answers a finished configuration apply with the settlement its row states", async () => {
    const settlement = {
      outcome: "committed",
      summary: {
        revisionId: `cfg1_${"b".repeat(43)}`,
        enabledServiceIds: ["api", "web"],
        followUp: "complete",
        cleanupFailed: false,
      },
    };
    // The operation and the full result are in shapes no release reads.
    const row = foreignRow("foreignSettledRow000", {
      operation: { kind: "configurationMaintenance.apply", maintenanceId: "m-1", extra: true },
      result: { outcome: "complete", generation: { revision: "unreadable" } },
      settlement,
    });
    const { path, journal } = await journalWith([row]);
    expect(journal.foreignRecords()[0]?.settlement).toEqual(settlement);
    const app = await buildOpsAgentServer({
      tokens: { api: apiToken, "data-manager": dataManagerToken },
      resourceClaimer: allow,
      journal,
      now: () => new Date(baseTime + 1_000),
      dispatch: vi.fn(),
    });
    const status = await app.inject({
      method: "GET",
      url: `/v1/operations/${row.operationId}`,
      headers: { ...auth(), "x-ops-request-id": "ops1_foreignSettled0000" },
    });
    expect(status.statusCode).toBe(409);
    expect(status.json()).toMatchObject({
      ok: false,
      error: { ...otherRelease().error, settlement },
    });
    // A caller that lost the operation id finds it by key, with the same answer.
    const lookup = await app.inject({
      method: "GET",
      url: `/v1/operation-keys/${row.operationKey}`,
      headers: {
        ...auth(),
        "x-ops-request-id": "ops1_foreignSettledKey0",
        "x-ops-body-fingerprint": "a".repeat(64),
      },
    });
    expect(lookup.statusCode).toBe(409);
    expect(lookup.json()).toMatchObject({ error: { ...otherRelease().error, settlement } });
    await app.close();
    const file = JSON.parse(readFileSync(path, "utf8")) as { jobs: Record<string, unknown>[] };
    expect(file.jobs[0]).toEqual(row);
  });

  it.each([
    ["a settlement in another shape", { outcome: "committed", summary: { revisionId: "x" } }],
    ["a settlement of an unfinished row", undefined],
  ])("refuses the journal for %s", async (_label, settlement) => {
    const row =
      settlement === undefined
        ? foreignRow("foreignBadSettled000", {
            state: "running",
            result: undefined,
            terminalAt: undefined,
            settlement: {
              outcome: "not_committed",
              summary: { reason: "busy", cleanupFailed: false },
            },
          })
        : foreignRow("foreignBadSettled000", { settlement });
    await expect(journalWith([row])).rejects.toThrow("Ops job journal is unavailable");
  });

  it("prunes a finished foreign row after retention and keeps one that needs recovery", async () => {
    const finished = foreignRow("foreignPrunedRow0000", {
      operationKey: "opk1_foreignPrunedRow0000",
    });
    const recovery = foreignRow("foreignRecoveryRow00", {
      operationKey: "opk1_foreignRecoveryRow00",
      state: "failed",
      result: undefined,
      errorClass: "recovery_required",
    });
    const later = baseTime + 4 * 24 * 3_600_000;
    const { path, journal } = await journalWith([finished, recovery], later);
    const app = await buildOpsAgentServer({
      tokens: { api: apiToken, "data-manager": dataManagerToken },
      resourceClaimer: allow,
      journal,
      jobRetentionMs: 1,
      now: () => new Date(later),
      dispatch: vi.fn(),
    });
    await app.ready();
    const file = JSON.parse(readFileSync(path, "utf8")) as { jobs: { operationId: string }[] };
    expect(file.jobs.map((entry) => entry.operationId)).toEqual([recovery.operationId]);
    await app.close();
  });
});
