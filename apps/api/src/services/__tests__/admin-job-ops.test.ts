import { OpsClientError, type OpsOperation } from "@openmapx/core/ops";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  cancelAdminJobOperations,
  executeAdminJobOperation,
  resumeAdminJobObservation,
} from "../admin-job-ops";
import type { JobContext } from "../job-runner";

let fixtureRoot: string, previousToken: string | undefined;
beforeAll(async () => {
  const { mkdtemp, writeFile } = await import("node:fs/promises"),
    { join } = await import("node:path"),
    { tmpdir } = await import("node:os");
  fixtureRoot = await mkdtemp(join(tmpdir(), "omx-api-broker-"));
  const file = join(fixtureRoot, "api-token");
  await writeFile(file, Buffer.alloc(32, 7).toString("base64url"), { mode: 0o600 });
  previousToken = process.env.OPS_AGENT_TOKEN_FILE;
  process.env.OPS_AGENT_TOKEN_FILE = file;
});
afterAll(async () => {
  if (previousToken === undefined) delete process.env.OPS_AGENT_TOKEN_FILE;
  else process.env.OPS_AGENT_TOKEN_FILE = previousToken;
  await (await import("node:fs/promises")).rm(fixtureRoot, { recursive: true, force: true });
});
function context(): JobContext {
  const ctx: JobContext = {
    jobId: "1d2b29cd-23de-4b19-8c32-86c196833b79",
    execution: { owner: "4c0c9623-252c-41b6-8f99-41915ad38b12", version: 1 },
    payload: {},
    signal: new AbortController().signal,
    log: vi.fn().mockResolvedValue(undefined),
    setProgress: vi.fn().mockResolvedValue(undefined),
    checkpoint: vi.fn(async (value) => {
      ctx.checkpointResult = structuredClone(value);
    }),
  };
  return ctx;
}
function legacy(ctx: JobContext, key: string, kind: OpsOperation["kind"], id?: string) {
  ctx.checkpointResult = {
    opsProjection: {
      version: 2,
      eventTotal: 0,
      byteTotal: 0,
      truncated: false,
      operations: {
        [key]: {
          kind,
          operationKey: key,
          ...(id ? { operationId: id } : {}),
          phase: id ? "observing" : "admitting",
          operation: kind === "backup.delete" ? { kind, backupId: "nightly" } : undefined,
          cursor: 0,
          events: 0,
          bytes: 0,
          truncated: false,
          terminal: false,
        },
      },
    },
  };
}

describe("administrative job operations broker", () => {
  it("submits an exact typed operation under a deterministic durable key", async () => {
    const ctx = context();
    const operation = { kind: "backup.list" } as const;
    const execute = vi.fn().mockResolvedValue({
      execution: "sync",
      kind: operation.kind,
      value: { backups: [], warningCount: 0 },
    });

    await expect(
      executeAdminJobOperation(ctx, operation, "admin-job.backup.create", {
        client: { execute } as never,
      }),
    ).resolves.toEqual({ backups: [], warningCount: 0 });

    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0]).toEqual(operation);
    expect(execute.mock.calls[0]?.[1]).toMatchObject({
      operationKey: expect.stringMatching(/^opk1_t1_/),
      signal: expect.any(AbortSignal),
      execution: { requestedDeadlineAt: expect.any(Number) },
      parentAssertion: expect.any(String),
    });
  });

  it("retains the original attempted body before a lost admission and restart", async () => {
    const operation = { kind: "backup.delete", backupId: "original" } as const;
    const operationKey = "opk1_abcdefghijklmnop";
    const operationId = "job1_abcdefghijklmnop";
    const ctx = context();
    let durable: Record<string, unknown> | undefined;
    ctx.checkpoint = vi.fn(async (value) => {
      durable = structuredClone(value);
      ctx.checkpointResult = structuredClone(value);
    });
    const client = {
      execute: vi.fn(async (operation: OpsOperation) => {
        if (operation.kind === "controlRetention.acknowledge")
          return { execution: "sync", kind: operation.kind, value: { acknowledged: true } };
        throw new OpsClientError("timeout");
      }),
      lookup: vi.fn(async (..._args: unknown[]) => {
        throw new OpsClientError("authorization");
      }),
      status: vi.fn(),
      events: vi.fn(),
      cancel: vi.fn(),
    };
    await executeAdminJobOperation(ctx, operation, "admin-job.backup.delete", {
      client: client as never,
      operationKey,
      pollIntervalMs: 1,
    }).catch(() => undefined);
    const saved = (await import("../admin-job-ops")).readProjection(durable),
      mapping = saved.steps[operationKey];
    if (!mapping) throw Error("Missing stable fixture mapping");
    const finalKey = mapping.operationKey;
    expect(saved).toMatchObject({
      version: 3,
      operations: { [finalKey]: { operation, phase: "admitting", operationKey: finalKey } },
    });
    const restarted = context();
    restarted.checkpointResult = durable;
    const status = {
      version: 2,
      admittedAt: mapping.requestedDeadlineAt - 300000,
      deadlineAt: mapping.requestedDeadlineAt,
      fingerprint: "a".repeat(64),
      operationId,
      operationKey: finalKey,
      kind: operation.kind,
      resourceId: "original",
      state: "succeeded",
      result: { backupId: "original" },
      submittedAt: "2026-10-23T00:00:00.000Z",
      updatedAt: "2026-10-23T00:00:01.000Z",
    };
    client.lookup.mockResolvedValue(status as never);
    client.status.mockResolvedValue(status);
    client.events.mockResolvedValue({
      version: 1,
      operationId,
      terminal: true,
      events: [],
      nextCursor: 0,
      truncated: false,
    });
    await expect(
      executeAdminJobOperation(
        restarted,
        { ...operation, backupId: "newer-desired-state" },
        "admin-job.backup.delete",
        {
          client: client as never,
          operationKey,
          pollIntervalMs: 1,
        },
      ),
    ).resolves.toEqual({ backupId: "original" });
    expect(
      client.execute.mock.calls.filter(([operation]) => operation.kind === "backup.delete"),
    ).toHaveLength(1);
    expect(client.lookup.mock.calls.at(-1)?.[0]).toEqual(operation);
    expect(restarted.checkpointResult).toMatchObject({
      opsProjection: {
        operations: {
          [finalKey]: { operation, operationId, phase: "terminal" },
        },
      },
    });
  });

  it("retains the host-update failure code in the durable admin job", async () => {
    const ctx = context();
    const operationKey = "opk1_abcdefghijklmnop";
    const operationId = "job1_abcdefghijklmnop";
    legacy(ctx, operationKey, "system.update", operationId);
    const client = {
      execute: vi.fn().mockResolvedValue({
        execution: "async",
        kind: "system.update",
        operationId,
        operationKey,
        state: "queued",
      }),
      status: vi.fn().mockResolvedValue({
        version: 1,
        operationId,
        operationKey,
        kind: "system.update",
        resourceId: "release-123",
        state: "failed",
        errorClass: "host_update_required",
        submittedAt: "2026-10-19T00:00:00.000Z",
        updatedAt: "2026-10-19T00:00:01.000Z",
      }),
      events: vi.fn().mockResolvedValue({
        version: 1,
        operationId,
        nextCursor: 0,
        terminal: true,
        truncated: false,
        events: [],
      }),
      lookup: vi.fn(),
      cancel: vi.fn(),
    };
    await expect(
      executeAdminJobOperation(
        ctx,
        {
          kind: "system.update",
          releaseId: "release-123",
          expectedDigest: "a".repeat(64),
          createBackup: false,
        },
        "admin-job.system.update",
        { client: client as never, operationKey, pollIntervalMs: 1 },
      ),
    ).rejects.toMatchObject({
      errorClass: "host_update_required",
      message: expect.stringContaining("host"),
    });
    expect(ctx.checkpointResult).toMatchObject({ errorCode: "host_update_required" });
    expect(ctx.checkpoint).toHaveBeenLastCalledWith(
      expect.objectContaining({ errorCode: "host_update_required" }),
    );
  });

  it("mirrors bounded durable agent events without cancelling a running operation", async () => {
    const ctx = context();
    const operation: Extract<OpsOperation, { kind: "backup.delete" }> = {
      kind: "backup.delete",
      backupId: "nightly",
    };
    const operationKey = "opk1_abcdefghijklmnop";
    const operationId = "job1_abcdefghijklmnop";
    legacy(ctx, operationKey, operation.kind, operationId);
    const cancel = vi.fn();
    const client = {
      execute: vi.fn().mockResolvedValue({
        execution: "async",
        kind: operation.kind,
        operationId,
        operationKey,
        state: "queued",
      }),
      lookup: vi.fn(),
      status: vi.fn().mockResolvedValue({
        version: 1,
        kind: operation.kind,
        operationId,
        operationKey,
        resourceId: "nightly",
        state: "succeeded",
        submittedAt: "2026-08-25T00:00:00.000Z",
        updatedAt: "2026-08-25T00:00:01.000Z",
        result: { backupId: "nightly" },
      }),
      events: vi.fn().mockResolvedValue({
        version: 1,
        operationId,
        nextCursor: 1,
        terminal: true,
        truncated: false,
        events: [{ cursor: 1, type: "log", stream: "stdout", message: "done" }],
      }),
      cancel,
    };

    await expect(
      executeAdminJobOperation(ctx, operation, "admin-job.backup.delete", {
        client: client as never,
        operationKey,
        pollIntervalMs: 1,
      }),
    ).resolves.toEqual({ backupId: "nightly" });

    expect(ctx.log).toHaveBeenCalledWith("done", "stdout", `ops:${operationId}:1`, 1);
    expect(client.events).toHaveBeenCalledWith(operationId, {
      after: 0,
      limit: 100,
      signal: expect.any(AbortSignal),
    });
    expect(cancel).not.toHaveBeenCalled();
    expect(ctx.checkpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        opsProjection: expect.objectContaining({
          version: 2,
          eventTotal: 1,
          byteTotal: 4,
          operations: expect.objectContaining({
            [operationKey]: expect.objectContaining({
              operationId,
              cursor: 1,
              terminal: true,
            }),
          }),
        }),
      }),
    );
  });

  it("reconstructs admission and resumes after the persisted cursor without duplicate logs", async () => {
    const operation = { kind: "backup.delete", backupId: "nightly" } as const;
    const operationKey = "opk1_abcdefghijklmnop";
    const operationId = "job1_abcdefghijklmnop";
    const ctx = context();
    ctx.checkpointResult = {
      opsProjection: {
        version: 1,
        eventTotal: 1,
        byteTotal: 4,
        truncated: false,
        operations: {
          [operationKey]: {
            kind: operation.kind,
            operationKey,
            operationId,
            cursor: 1,
            events: 1,
            bytes: 4,
            truncated: false,
            terminal: false,
          },
        },
      },
    };
    const execute = vi.fn();
    const events = vi.fn().mockResolvedValue({
      version: 1,
      operationId,
      nextCursor: 2,
      terminal: true,
      truncated: false,
      events: [{ cursor: 2, type: "log", stream: "stdout", message: "next" }],
    });
    const client = {
      execute,
      lookup: vi.fn().mockResolvedValue({
        version: 1,
        operationId,
        operationKey,
        kind: operation.kind,
        resourceId: "nightly",
        state: "running",
        submittedAt: "2026-08-25T00:00:00.000Z",
        updatedAt: "2026-08-25T00:00:01.000Z",
      }),
      status: vi.fn().mockResolvedValue({
        version: 1,
        operationId,
        operationKey,
        kind: operation.kind,
        resourceId: "nightly",
        state: "succeeded",
        submittedAt: "2026-08-25T00:00:00.000Z",
        updatedAt: "2026-08-25T00:00:02.000Z",
        result: { backupId: "nightly" },
      }),
      events,
      cancel: vi.fn(),
    };
    await executeAdminJobOperation(ctx, operation, "admin-job.backup.delete", {
      client: client as never,
      operationKey,
      pollIntervalMs: 1,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(events).toHaveBeenCalledWith(operationId, {
      after: 1,
      limit: 100,
      signal: expect.any(AbortSignal),
    });
    expect(ctx.log).toHaveBeenCalledTimes(1);
    expect(ctx.log).toHaveBeenCalledWith("next", "stdout", `ops:${operationId}:2`, 2);
  });

  it("requests exact agent cancellation and treats response loss as pending until terminal", async () => {
    const operationId = "job1_abcdefghijklmnop";
    const projection = {
      opsProjection: {
        version: 1,
        eventTotal: 0,
        byteTotal: 0,
        truncated: false,
        operations: {
          opk1_abcdefghijklmnop: {
            kind: "backup.create",
            operationKey: "opk1_abcdefghijklmnop",
            operationId,
            cursor: 0,
            events: 0,
            bytes: 0,
            truncated: false,
            terminal: false,
          },
        },
      },
    };
    const client = {
      cancel: vi.fn().mockRejectedValue(new Error("response lost")),
      status: vi
        .fn()
        .mockResolvedValueOnce({
          state: "termination_pending",
          kind: "backup.create",
          operationId,
          operationKey: "opk1_abcdefghijklmnop",
        })
        .mockResolvedValueOnce({
          state: "failed",
          kind: "backup.create",
          operationId,
          operationKey: "opk1_abcdefghijklmnop",
          errorClass: "runtime",
        }),
    };
    await expect(
      cancelAdminJobOperations(projection, client as never, {
        pollIntervalMs: 1,
        sleep: async () => undefined,
      }),
    ).resolves.toBe("canceled");
    expect(client.cancel).toHaveBeenCalledWith(operationId, {
      signal: expect.any(AbortSignal),
    });
    expect(client.status).toHaveBeenCalledTimes(2);
  });

  it("reports containment when one operation is canceled alongside a succeeded sibling", async () => {
    const succeededId = "job1_abcdefghijklmnop";
    const canceledId = "job1_bbbbbbbbbbbbbbbb";
    const projection = {
      opsProjection: {
        version: 1,
        eventTotal: 0,
        byteTotal: 0,
        truncated: false,
        operations: {
          opk1_abcdefghijklmnop: {
            kind: "backup.create",
            operationKey: "opk1_abcdefghijklmnop",
            operationId: succeededId,
            cursor: 0,
            events: 0,
            bytes: 0,
            truncated: false,
            terminal: false,
          },
          opk1_bbbbbbbbbbbbbbbb: {
            kind: "backup.create",
            operationKey: "opk1_bbbbbbbbbbbbbbbb",
            operationId: canceledId,
            cursor: 0,
            events: 0,
            bytes: 0,
            truncated: false,
            terminal: false,
          },
        },
      },
    };
    const client = {
      cancel: vi.fn(async (operationId: string) =>
        operationId === succeededId
          ? {
              state: "succeeded",
              kind: "backup.create",
              operationId: succeededId,
              operationKey: "opk1_abcdefghijklmnop",
              result: {},
            }
          : {
              state: "failed",
              kind: "backup.create",
              operationId: canceledId,
              operationKey: "opk1_bbbbbbbbbbbbbbbb",
              errorClass: "runtime",
              terminationRequestedAt: "2026-08-25T00:00:00.000Z",
            },
      ),
      status: vi.fn(),
    };

    client.status.mockImplementation((_kind: string, id: string) => client.cancel(id));

    // A succeeded sibling must not mask the operation this request contained:
    // reporting "completed" would restore the job to running.
    await expect(
      cancelAdminJobOperations(projection, client as never, {
        pollIntervalMs: 1,
        sleep: async () => undefined,
      }),
    ).resolves.toBe("canceled");
  });

  it("does not claim a cancellation for a failure that predates the request", async () => {
    const operationId = "job1_abcdefghijklmnop";
    const projection = {
      opsProjection: {
        version: 1,
        eventTotal: 0,
        byteTotal: 0,
        truncated: false,
        operations: {
          opk1_abcdefghijklmnop: {
            kind: "backup.create",
            operationKey: "opk1_abcdefghijklmnop",
            operationId,
            cursor: 0,
            events: 0,
            bytes: 0,
            truncated: false,
            terminal: false,
          },
        },
      },
    };
    // The agent returns an already-terminal job unchanged, so there is no
    // `termination_pending` transition and no durable marker.
    const client = {
      cancel: vi.fn().mockResolvedValue({
        state: "failed",
        kind: "backup.create",
        operationId,
        operationKey: "opk1_abcdefghijklmnop",
        errorClass: "runtime",
      }),
      status: vi.fn(),
    };

    client.status.mockImplementation(client.cancel);
    await expect(
      cancelAdminJobOperations(projection, client as never, {
        pollIntervalMs: 1,
        sleep: async () => undefined,
      }),
    ).resolves.toBe("already_terminal");
  });
});

it("refuses admission when the write-ahead checkpoint fails", async () => {
  const ctx = context();
  ctx.checkpoint = vi.fn().mockRejectedValue(new Error("CAS lost"));
  const execute = vi.fn();
  await expect(
    executeAdminJobOperation(
      ctx,
      { kind: "backup.delete", backupId: "nightly" },
      "admin-job.backup.delete",
      { client: { execute } as never },
    ),
  ).rejects.toThrow("CAS lost");
  expect(execute).not.toHaveBeenCalled();
});

it("retains a service workflow parent budget beyond its short render child", async () => {
  const { prepareApiJobChildAttempt } = await import("../admin-job-parent");
  const { opsExecutionBudget } = await import("@openmapx/core/ops");
  const ctx = context();
  ctx.jobType = "service.start";
  ctx.execution = { owner: "4c0c9623-252c-41b6-8f99-41915ad38b12", version: 1 };
  const now = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
  try {
    const render = prepareApiJobChildAttempt(
      ctx,
      {
        kind: "stack.render",
        revisionId: "generation",
        expectedCurrentRevisionId: null,
      },
      "opk1_renderAttempt12345",
    );
    if (!render) throw Error("Missing retained parent fixture");
    ctx.checkpointResult = {
      _parentExecution: {
        operationKey: render.parentOperationKey,
        fingerprint: render.parentFingerprint,
        deadlineAt: render.parentDeadlineAt,
      },
    };
    now.mockReturnValue(1_800_000_000_000 + opsExecutionBudget("stack.render").processMs);
    const start = prepareApiJobChildAttempt(
      ctx,
      { kind: "service.start", serviceId: "tileserver" },
      "opk1_serviceAttempt1234",
    );
    expect(start?.parentDeadlineAt).toBe(render?.parentDeadlineAt);
    expect(start?.requestedDeadlineAt).toBe(
      Date.now() + opsExecutionBudget("service.start").processMs,
    );
  } finally {
    now.mockRestore();
  }
});

it("validates a resumed operation identity before reading its event stream", async () => {
  const ctx = context();
  const operationKey = "opk1_abcdefghijklmnop";
  const operationId = "job1_abcdefghijklmnop";
  ctx.checkpointResult = {
    opsProjection: {
      version: 1,
      eventTotal: 0,
      byteTotal: 0,
      truncated: false,
      operations: {
        [operationKey]: {
          kind: "backup.delete",
          operationKey,
          operationId,
          cursor: 0,
          events: 0,
          bytes: 0,
          truncated: false,
          terminal: false,
        },
      },
    },
  };
  const client = {
    execute: vi.fn(),
    cancel: vi.fn(),
    lookup: vi.fn(),
    status: vi.fn().mockResolvedValue({
      kind: "backup.delete",
      operationId,
      operationKey: "opk1_foreignOperation12",
      state: "succeeded",
      result: { backupId: "foreign" },
    }),
    events: vi.fn().mockResolvedValue({
      version: 1,
      operationId,
      nextCursor: 1,
      terminal: true,
      truncated: false,
      events: [{ cursor: 1, type: "log", stream: "stdout", message: "foreign log" }],
    }),
  };
  await expect(
    executeAdminJobOperation(
      ctx,
      { kind: "backup.delete", backupId: "nightly" },
      "admin-job.backup.delete",
      { client: client as never, operationKey },
    ),
  ).rejects.toMatchObject({ reason: "invalid_identity" });
  expect(client.events).not.toHaveBeenCalled();
  expect(ctx.log).not.toHaveBeenCalled();
  expect(client.execute).not.toHaveBeenCalled();
});

it.each([false, true])(
  "observes one real journal admission across lost response and both restarts (failure=%s)",
  async (failed) => {
    const { mkdtemp, writeFile, rm, mkdir } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { OpsClient } = await import("@openmapx/core/ops");
    const { buildOpsAgentServer } = await import("../../../../ops-agent/src/server");
    const { openOpsJobJournal } = await import("../../../../ops-agent/src/journal");
    const { OpsExecutionFailure } = await import("../../../../ops-agent/src/runtime");
    const root = await mkdtemp(join(tmpdir(), "task022-admission-"));
    const control = await import("@openmapx/core/build-artifacts");
    await mkdir(join(root, "data"), { mode: 0o700 });
    await control.provisionControlInstallation(root);
    const installation = control.openControlInstallation({
      infraDir: root,
      role: "ops-agent",
      serviceIds: ["motis"],
    });
    const token = Buffer.alloc(32, 7).toString("base64url");
    const tokenFile = join(root, "token");
    await writeFile(tokenFile, token, { mode: 0o600 });
    vi.stubEnv("OPS_AGENT_TOKEN_FILE", tokenFile);
    const path = join(root, "journal", "jobs-v1.json");
    const journal = await openOpsJobJournal(path);
    const dispatch = vi.fn(async () => {
      if (failed)
        throw new OpsExecutionFailure("runtime", {
          diagnostics: {
            truncated: false,
            tail: [{ stream: "stderr", message: "final diagnostic" }],
          },
        });
      return { backupId: "original" };
    });
    let app = buildOpsAgentServer({
      tokens: { api: token, "data-manager": Buffer.alloc(32, 8).toString("base64url") },
      journal,
      controlInstallation: installation,
      dispatch,
      resourcePolicy: { allowBackup: () => true },
    });
    const controller = new AbortController();
    let loseResponse = true;
    let posts = 0;
    const responses: unknown[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const response = await app.inject({
        method: (init?.method as "GET" | "POST" | "DELETE") ?? "GET",
        url: url.pathname + url.search,
        headers: Object.fromEntries(new Headers(init?.headers)),
        payload: init?.body as string,
      });
      responses.push({ path: url.pathname, status: response.statusCode, body: response.body });
      if (
        init?.method === "POST" &&
        JSON.parse(String(init.body)).operation.kind !== "controlRetention.acknowledge"
      ) {
        posts++;
        if (loseResponse) {
          controller.abort();
          throw new TypeError("Response dropped after admission");
        }
      }
      return new Response(response.body, {
        status: response.statusCode,
        headers: { "content-type": "application/json" },
      });
    };
    const client = () =>
      new OpsClient({ baseUrl: "http://ops-agent:4300", tokenFile, fetch: fetcher });
    let durable: Record<string, unknown> | undefined;
    const first = context();
    first.signal = controller.signal;
    first.execution = { owner: "4c0c9623-252c-41b6-8f99-41915ad38b12", version: 3 };
    first.checkpoint = async (value) => {
      durable = structuredClone(value);
      first.checkpointResult = structuredClone(value);
    };
    const key = "opk1_restartAccepted1234";
    try {
      const initial = await executeAdminJobOperation(
        first,
        { kind: "backup.delete", backupId: "original" },
        "admin-job.backup.delete",
        { client: client(), operationKey: key, pollIntervalMs: 1 },
      ).catch((error) => error);
      expect(initial, JSON.stringify(responses)).toMatchObject({ name: "OpsObservationPending" });
      await vi.waitFor(() =>
        expect(journal.records()[0]?.state).toBe(failed ? "failed" : "succeeded"),
      );
      const admitted = journal.records()[0];
      if (!admitted) throw new Error("Missing retained admission");
      if (admitted.parent?.issuer !== "api") throw Error("Missing exact API parent");
      expect(admitted.parent?.apiJobId).toBe(first.jobId);
      expect(admitted.parent?.apiOwnerVersion).toBe(3);
      expect(admitted.operation).toEqual({ kind: "backup.delete", backupId: "original" });
      await app.close();
      const reloaded = await openOpsJobJournal(path);
      app = buildOpsAgentServer({
        tokens: { api: token, "data-manager": Buffer.alloc(32, 8).toString("base64url") },
        journal: reloaded,
        controlInstallation: installation,
        dispatch,
      });
      loseResponse = false;
      const restarted = context();
      restarted.checkpointResult = durable;
      restarted.checkpoint = async (value) => {
        durable = structuredClone(value);
        restarted.checkpointResult = structuredClone(value);
      };
      restarted.execution = { owner: "5c0c9623-252c-41b6-8f99-41915ad38b12", version: 4 };
      const observation = executeAdminJobOperation(
        restarted,
        { kind: "backup.delete", backupId: "newer-state" },
        "admin-job.backup.delete",
        { client: client(), operationKey: key, pollIntervalMs: 1 },
      );
      if (failed)
        await expect(observation).rejects.toMatchObject({
          name: "ApiOpsError",
          failureResult: {
            diagnostics: { tail: [{ stream: "stderr", message: "final diagnostic" }] },
          },
        });
      else await expect(observation).resolves.toEqual({ backupId: "original" });
      vi.stubEnv("OPS_AGENT_URL", "http://ops-agent:4300");
      vi.stubGlobal("fetch", fetcher);
      const reconciled = context();
      reconciled.jobType = "backup.operation";
      reconciled.observationOnly = true;
      reconciled.payload = { name: "newer-state" };
      reconciled.checkpointResult = durable;
      const recovery = resumeAdminJobObservation(reconciled);
      if (failed)
        await expect(recovery).rejects.toMatchObject({
          name: "AdminJobFailure",
          result: { diagnostics: { tail: [{ stream: "stderr", message: "final diagnostic" }] } },
        });
      else await expect(recovery).resolves.toMatchObject({ backupId: "original" });
      expect(posts).toBe(1);
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(reloaded.records()[0]?.fingerprint).toBe(admitted.fingerprint);
      expect(restarted.checkpointResult).toMatchObject({
        opsProjection: {
          operations: {
            [admitted.operationKey]: {
              operationId: admitted.operationId,
              fingerprint: admitted.fingerprint,
              phase: "terminal",
              attempt: { apiOwnerVersion: 3 },
            },
          },
        },
      });
      const events = await client().events(admitted.operationId, { after: 100, limit: 10 });
      expect(events.truncated).toBe(true);
      expect(events.events).toEqual([]);
      for (const path of [
        `/v1/operations/${admitted.operationId}`,
        `/v1/operations/${admitted.operationId}/events`,
        `/v1/operation-keys/${admitted.operationKey}`,
      ]) {
        const denied = await app.inject({
          method: "GET",
          url: path,
          headers: { authorization: `Bearer ${Buffer.alloc(32, 8).toString("base64url")}` },
        });
        expect(denied.statusCode).toBe(404);
      }
      expect(
        (
          await app.inject({
            method: "DELETE",
            url: `/v1/operations/${admitted.operationId}`,
            headers: { authorization: `Bearer ${Buffer.alloc(32, 8).toString("base64url")}` },
          })
        ).statusCode,
      ).toBe(404);
      expect(dispatch).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
      control.closeControlInstallation(installation);
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("does not read or cancel an attempted child belonging to another API job", async () => {
  const ctx = context();
  const key = "opk1_foreignAttempt1234";
  const { opsOperationFingerprint } = await import("@openmapx/core/ops");
  ctx.checkpointResult = {
    opsProjection: {
      version: 2,
      eventTotal: 0,
      byteTotal: 0,
      truncated: false,
      operations: {
        [key]: {
          kind: "backup.delete",
          operationKey: key,
          operationId: "job1_foreignAttempt1234",
          operation: { kind: "backup.delete", backupId: "nightly" },
          phase: "observing",
          cursor: 0,
          events: 0,
          bytes: 0,
          terminal: false,
          truncated: false,
          attempt: {
            version: 1,
            apiJobId: "4c0c9623-252c-41b6-8f99-41915ad38b12",
            apiOwnerVersion: 1,
            parentOperationKey: "opk1_parentAttempt12345",
            parentFingerprint: "a".repeat(64),
            parentDeadlineAt: 2000000000000,
            childOperationKey: key,
            childOperationFingerprint: opsOperationFingerprint({
              kind: "backup.delete",
              backupId: "nightly",
            }),
            requestedDeadlineAt: 2000000000000,
            attemptId: "5c0c9623-252c-41b6-8f99-41915ad38b12",
          },
        },
      },
    },
  };
  const client = {
    status: vi.fn().mockRejectedValue(new Error("unavailable")),
    execute: vi.fn(),
    lookup: vi.fn(),
    events: vi.fn(),
    cancel: vi.fn(),
  };
  await executeAdminJobOperation(
    ctx,
    { kind: "backup.delete", backupId: "nightly" },
    "admin-job.backup.delete",
    { client: client as never, operationKey: key },
  ).catch(() => undefined);
  expect(client.status).not.toHaveBeenCalled();
  expect(client.events).not.toHaveBeenCalled();
  expect(client.cancel).not.toHaveBeenCalled();
});

it.each(["log", "checkpoint", "output"])(
  "retires ownership loss but tolerates ordinary %s projection failure without backend cancel",
  async (edge) => {
    const { JobOwnershipLost } = await import("../admin-job-state");
    const ctx = context();
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    let writes = 0;
    ctx.checkpoint = async (value) => {
      writes++;
      if (edge === "checkpoint" && writes >= 3) {
        entered.resolve();
        await resume.promise;
        throw new JobOwnershipLost();
      }
      ctx.checkpointResult = structuredClone(value);
    };
    if (edge === "log" || edge === "output")
      ctx.log = async () => {
        entered.resolve();
        await resume.promise;
        throw edge === "log" ? new JobOwnershipLost() : new Error("output unavailable");
      };
    const key = "opk1_displacedObserver1";
    const id = "job1_displacedObserver1";
    legacy(ctx, key, "backup.delete");
    const client = {
      execute: vi.fn().mockResolvedValue({
        execution: "async",
        kind: "backup.delete",
        operationKey: key,
        operationId: id,
        state: "queued",
      }),
      status: vi.fn(async () => {
        await resume.promise;
        return {
          kind: "backup.delete",
          operationId: id,
          operationKey: key,
          state: "succeeded",
          result: { backupId: "nightly" },
        };
      }),
      events: vi.fn().mockResolvedValue({
        version: 1,
        operationId: id,
        terminal: true,
        truncated: false,
        nextCursor: 1,
        events: [{ cursor: 1, type: "log", stream: "stdout", message: "old owner" }],
      }),
      cancel: vi.fn(),
      lookup: vi.fn().mockResolvedValue({
        version: 1,
        kind: "backup.delete",
        operationId: id,
        operationKey: key,
        state: "queued",
      }),
    };
    const result = executeAdminJobOperation(
      ctx,
      { kind: "backup.delete", backupId: "nightly" },
      "admin-job.backup.delete",
      { client: client as never, operationKey: key },
    );
    const outcome = result.then(
      () => "fulfilled",
      (error) => error,
    );
    await entered.promise;
    resume.resolve();
    if (edge === "output") expect(await outcome).toBe("fulfilled");
    else expect(await outcome).toBeInstanceOf(JobOwnershipLost);
    expect(client.cancel).not.toHaveBeenCalled();
    expect(client.execute).not.toHaveBeenCalled();
  },
);
