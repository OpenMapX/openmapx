import { controlChildOperationKey } from "@openmapx/core/build-artifacts";
import { afterEach, expect, it, vi } from "vitest";
import type { JobContext } from "../job-runner";

const fixture = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  batches: [] as Record<string, unknown>[][],
}));
vi.mock("../../db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (fixture.batches.length ? fixture.batches.shift()! : fixture.rows),
        }),
      }),
    }),
  },
}));

import { cancelDataManagerActivityJob } from "../activity-jobs";
import { cancelAdminDataChildren } from "../admin-data-children";
import { hasUnsettledManagedOperation } from "../admin-job-state";

const key = "opk1_abcdefghijklmnop",
  at = Date.now(),
  deadline = at + 60000;
function child(index: number) {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    operationKey: `opk1_abcdefghijklmnop${index}`,
    fingerprint: String(index).repeat(64),
    parentAgentOperationKey: key,
    kind: "download-fonts" as const,
    admittedAt: at,
    deadlineAt: deadline,
    cancellationRequestedAt: null,
    state: "observing" as const,
    status: "running" as const,
    publication: "not_started" as const,
  };
}
function context(result: Record<string, unknown>): JobContext {
  return {
    jobId: "fixture-job",
    payload: {},
    signal: new AbortController().signal,
    checkpointResult: result,
    log: async () => {},
    setProgress: async () => {},
    checkpoint: async function (value) {
      this.checkpointResult = value;
    },
  };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fixture.rows = [];
  fixture.batches = [];
});
it("keeps an interrupted unknown durable Activity execution explicitly cancelable", async () => {
  vi.stubEnv("DATA_MANAGER_URL", "https://synthetic-dm.test");
  const owned = child(1);
  fixture.rows = [
    {
      id: owned.id,
      kind: owned.kind,
      executionVersion: 2,
      status: "interrupted",
      finishedAt: null,
      executionState: { publication: "unknown" },
      executionInput: { kind: "download-fonts" },
      operationKey: owned.operationKey,
      executionFingerprint: owned.fingerprint,
    },
  ];
  const sent = vi.fn(async () =>
    Response.json({
      id: owned.id,
      operationKey: owned.operationKey,
      fingerprint: owned.fingerprint,
      kind: owned.kind,
      status: "cancel_pending",
      admittedAt: at,
      deadlineAt: deadline,
      cancellationRequestedAt: new Date().toISOString(),
      progress: null,
      diagnostics: { tail: [], truncated: false },
      publication: "unknown",
    }),
  );
  vi.stubGlobal("fetch", sent);
  expect(await cancelDataManagerActivityJob(owned.id)).toBe(true);
  expect(sent).toHaveBeenCalledTimes(1);
  fixture.rows[0]!.executionVersion = 1;
  expect(await cancelDataManagerActivityJob(owned.id)).toBe(false);
  expect(sent).toHaveBeenCalledTimes(1);
});
it("cancels every registered backend with zero agent projections and retains pending after lost responses", async () => {
  vi.stubEnv("DATA_MANAGER_URL", "https://synthetic-dm.test");
  const children = [child(1), child(2)],
    ctx = context({ _cancelRequestedAt: new Date().toISOString(), _dataExecutions: children }),
    sent: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options?: RequestInit) => {
      const id = url.split("/").at(-1) === "cancel" ? url.split("/").at(-2) : url.split("/").at(-1),
        owned = children.find((child) => child.id === id);
      if (!owned) throw Error("Foreign backend");
      if (options?.method === "POST") {
        expect(
          (ctx.checkpointResult?._dataExecutions as typeof children).find(
            (child) => child.id === id,
          )?.cancellationRequestedAt,
        ).not.toBeNull();
        sent.push(id!);
        throw Error("Lost real cancellation response");
      }
      return Response.json({
        ...owned,
        status: sent.includes(id!) ? "cancel_pending" : "running",
        cancellationRequestedAt: sent.includes(id!) ? new Date().toISOString() : null,
        progress: null,
        diagnostics: { tail: [], truncated: false },
        parentAgentOperationKey: undefined,
        state: undefined,
      });
    }),
  );
  expect(
    await cancelAdminDataChildren(ctx.checkpointResult, [], {
      context: ctx,
      sleep: async () => {},
    }),
  ).toBe("pending");
  expect(sent).toEqual(children.map((child) => child.id));
  expect(hasUnsettledManagedOperation(ctx.checkpointResult)).toBe(true);
});
it("discovers the exact fixed CLI descendant from its durable DM row before cancellation", async () => {
  vi.stubEnv("DATA_MANAGER_URL", "https://synthetic-dm.test");
  const cliKey = controlChildOperationKey(key, "data-workflow", 0),
    dataKey = controlChildOperationKey(cliKey, "data-step", 0),
    owned = { ...child(1), operationKey: dataKey },
    ctx = context({ _cancelRequestedAt: new Date().toISOString() });
  fixture.rows = [
    {
      id: owned.id,
      kind: owned.kind,
      status: "running",
      operationKey: dataKey,
      executionFingerprint: owned.fingerprint,
      admittedAt: at,
      deadlineAt: deadline,
      executionVersion: 2,
      executionParent: {
        issuer: "host-cli",
        execution: { executor: "host-cli", operationKey: cliKey },
      },
      executionState: {
        cancellationRequestedAt: null,
        progress: null,
        diagnostics: { tail: [], truncated: false },
        publication: "not_started",
      },
    },
  ];
  let canceled = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, options?: RequestInit) => {
      if (options?.method === "POST") {
        expect((ctx.checkpointResult?._dataExecutions as (typeof owned)[])[0]).toMatchObject({
          id: owned.id,
          operationKey: dataKey,
          parentAgentOperationKey: key,
          cancellationRequestedAt: expect.any(String),
        });
        canceled = true;
      }
      return Response.json({
        id: owned.id,
        operationKey: dataKey,
        fingerprint: owned.fingerprint,
        admittedAt: at,
        deadlineAt: deadline,
        kind: owned.kind,
        status: canceled ? "canceled" : "running",
        cancellationRequestedAt: canceled ? new Date().toISOString() : null,
        progress: null,
        diagnostics: { tail: [], truncated: false },
        publication: "not_started",
      });
    }),
  );
  expect(
    await cancelAdminDataChildren(
      ctx.checkpointResult,
      [{ kind: "data.downloadFonts", operationKey: key }],
      { context: ctx, sleep: async () => {} },
    ),
  ).toBe("contained");
  expect(canceled).toBe(true);
  expect(hasUnsettledManagedOperation(ctx.checkpointResult)).toBe(false);
});

it("keeps malformed or unknown backend terminal metadata behind the finalization fence", () => {
  expect(
    hasUnsettledManagedOperation({
      _dataExecutions: [{ ...child(1), state: "terminal", publication: undefined }],
    }),
  ).toBe(true);
  expect(
    hasUnsettledManagedOperation({
      _dataExecutions: [
        { ...child(1), state: "terminal", publication: "committed", status: "running" },
      ],
    }),
  ).toBe(true);
});

it("discovers and cancels Full Update's original nested generation leaf", async () => {
  vi.stubEnv("DATA_MANAGER_URL", "https://synthetic-dm.test");
  const cliKey = controlChildOperationKey(key, "data-finalization", 1),
    dataKey = controlChildOperationKey(cliKey, "hardlinks", 0),
    owned = { ...child(1), operationKey: dataKey, kind: "generation-hardlinks" },
    ctx = context({ _cancelRequestedAt: new Date().toISOString() });
  fixture.batches = [
    [],
    [],
    [],
    [
      {
        id: owned.id,
        kind: owned.kind,
        status: "running",
        operationKey: dataKey,
        executionFingerprint: owned.fingerprint,
        admittedAt: at,
        deadlineAt: deadline,
        executionVersion: 2,
        executionParent: {
          issuer: "host-cli",
          execution: { executor: "host-cli", operationKey: cliKey },
        },
        executionState: {
          cancellationRequestedAt: null,
          progress: null,
          diagnostics: { tail: [], truncated: false },
          publication: "not_started",
        },
      },
    ],
  ];
  let canceled = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, options?: RequestInit) => {
      if (options?.method === "POST") canceled = true;
      return Response.json({
        id: owned.id,
        operationKey: dataKey,
        fingerprint: owned.fingerprint,
        admittedAt: at,
        deadlineAt: deadline,
        kind: owned.kind,
        status: canceled ? "canceled" : "running",
        cancellationRequestedAt: canceled ? new Date().toISOString() : null,
        progress: null,
        diagnostics: { tail: [], truncated: false },
        publication: "not_started",
      });
    }),
  );
  expect(
    await cancelAdminDataChildren(
      ctx.checkpointResult,
      [{ kind: "data.update", operationKey: key }],
      { context: ctx, sleep: async () => {} },
    ),
  ).toBe("contained");
  expect(canceled).toBe(true);
  expect(fixture.batches).toHaveLength(0);
});
