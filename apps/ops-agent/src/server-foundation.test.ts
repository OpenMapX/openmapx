import {
  type OpsOperation,
  type OpsResourcePolicy,
  opsOperationFingerprint,
} from "@openmapx/core/ops";
import { describe, expect, it, vi } from "vitest";
import type { OpsJobJournal, PersistedOpsJob } from "./journal";
import type { OpsExecutionContext } from "./runtime";
import { buildOpsAgentServer, OPS_AGENT_RETENTION_LIMITS, type OpsAuditEvent } from "./server";

const apiToken = Buffer.alloc(32, 21).toString("base64url");
const dataManagerToken = Buffer.alloc(32, 22).toString("base64url");
const baseTime = Date.parse("2026-08-23T18:00:00.000Z");

const allowAllResources: OpsResourcePolicy = {
  allowGlobal: () => true,
  allowService: () => true,
  allowBackup: () => true,
  allowPreparedRun: () => true,
  allowCandidate: () => true,
  allowRelease: () => true,
  allowRegion: () => true,
  allowDataType: () => true,
  allowExtension: () => true,
  allowIntegration: () => true,
  allowTrustedRevision: () => true,
};

function auth(token = apiToken) {
  return { authorization: `Bearer ${token}` };
}

function request(operation: OpsOperation, requestId: string, operationKey: string) {
  return {
    version: 1,
    requestId,
    operationKey,
    issuedAt: new Date(baseTime).toISOString(),
    expiresAt: new Date(baseTime + 20_000).toISOString(),
    operation,
  };
}

async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const value = await read();
    if (accept(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition not reached");
}

describe("ops-agent async foundation", () => {
  it("caps the provable aggregate retained job/event/result memory below the container budget", () => {
    expect(
      OPS_AGENT_RETENTION_LIMITS.maxAggregateJournalBytes +
        OPS_AGENT_RETENTION_LIMITS.maxAggregateEventBytes,
    ).toBeLessThanOrEqual(40 * 1024 * 1024);
  });
  it("binds a canonical idempotent async job and retained typed result to its owner role", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const dispatch = vi.fn(async (operation: OpsOperation) => {
      await blocked;
      return operation.kind === "service.pull" ? { changed: true } : { reachable: true };
    });
    const app = buildOpsAgentServer({
      tokens: { api: apiToken, "data-manager": dataManagerToken },
      resourcePolicy: allowAllResources,
      now: () => new Date(baseTime),
      randomBytes: () => Buffer.alloc(18, 23),
      dispatch,
    });
    const operationKey = "opk1_stableTransportRetry";
    const operation = { kind: "service.pull", serviceId: "redis" } as const;
    const admitted = await app.inject({
      method: "POST",
      url: "/v1/operations",
      headers: auth(),
      payload: request(operation, "ops1_firstRequest000000", operationKey),
    });
    expect(admitted.statusCode).toBe(202);
    const admission = admitted.json().result as { operationId: string };

    const retry = await app.inject({
      method: "POST",
      url: "/v1/operations",
      headers: auth(),
      payload: request(operation, "ops1_retryRequest000000", operationKey),
    });
    expect(retry.statusCode).toBe(202);
    expect(retry.json().result.operationId).toBe(admission.operationId);
    expect(dispatch).toHaveBeenCalledTimes(1);

    const conflict = await app.inject({
      method: "POST",
      url: "/v1/operations",
      headers: auth(),
      payload: request(
        { kind: "service.pull", serviceId: "motis" },
        "ops1_conflictRequest000",
        operationKey,
      ),
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.class).toBe("conflict");

    const hidden = await app.inject({
      method: "GET",
      url: `/v1/operations/${admission.operationId}`,
      headers: auth(dataManagerToken),
    });
    expect(hidden.statusCode).toBe(404);

    const running = await app.inject({
      method: "GET",
      url: `/v1/operations/${admission.operationId}`,
      headers: auth(),
    });
    expect(running.statusCode).toBe(200);
    expect(running.json().result).toMatchObject({
      kind: "service.pull",
      operationKey,
      state: "running",
    });

    const byKey = await app.inject({
      method: "GET",
      url: `/v1/operation-keys/${operationKey}`,
      headers: {
        ...auth(),
        "x-ops-operation-fingerprint": opsOperationFingerprint(operation),
      },
    });
    expect(byKey.statusCode).toBe(200);
    expect(byKey.json().result).toMatchObject({
      operationId: admission.operationId,
      kind: "service.pull",
      operationKey,
      state: "running",
    });
    const keyHiddenFromOtherRole = await app.inject({
      method: "GET",
      url: `/v1/operation-keys/${operationKey}`,
      headers: {
        ...auth(dataManagerToken),
        "x-ops-operation-fingerprint": "0".repeat(64),
      },
    });
    expect(keyHiddenFromOtherRole.statusCode).toBe(404);
    const mismatchedResource = await app.inject({
      method: "GET",
      url: `/v1/operation-keys/${operationKey}`,
      headers: {
        ...auth(),
        "x-ops-operation-fingerprint": opsOperationFingerprint({
          kind: "service.pull",
          serviceId: "motis",
        }),
      },
    });
    expect(mismatchedResource.statusCode).toBe(409);
    expect(mismatchedResource.json().error.class).toBe("conflict");

    release();
    const succeeded = await eventually(
      async () =>
        app.inject({
          method: "GET",
          url: `/v1/operations/${admission.operationId}`,
          headers: auth(),
        }),
      (response) => response.json().result.state === "succeeded",
    );
    expect(succeeded.json().result.result).toEqual({ changed: true });

    const terminalLookup = await app.inject({
      method: "GET",
      url: `/v1/operation-keys/${operationKey}`,
      headers: {
        ...auth(),
        "x-ops-operation-fingerprint": opsOperationFingerprint(operation),
      },
    });
    expect(terminalLookup.statusCode).toBe(200);

    const retainedRetry = await app.inject({
      method: "POST",
      url: "/v1/operations",
      headers: auth(),
      payload: request(operation, "ops1_terminalRetry00000", operationKey),
    });
    expect(retainedRetry.json().result.operationId).toBe(admission.operationId);
    expect(dispatch).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("rejects resource and option mismatches for an exact retained terminal key", async () => {
    const app = buildOpsAgentServer({
      tokens: { api: apiToken, "data-manager": dataManagerToken },
      resourcePolicy: allowAllResources,
      now: () => new Date(baseTime),
      randomBytes: () => Buffer.alloc(18, 29),
      dispatch: async () => ({ lines: 0, truncated: false }),
    });
    const operation = {
      kind: "service.logs.follow",
      serviceId: "redis",
      tail: 20,
      maxDurationSeconds: 900,
    } as const;
    const operationKey = "opk1_terminalExactLookup00";
    const admitted = await app.inject({
      method: "POST",
      url: "/v1/operations",
      headers: auth(),
      payload: request(operation, "ops1_terminalExactLookup0", operationKey),
    });
    expect(admitted.statusCode).toBe(202);
    const operationId = admitted.json().result.operationId as string;
    await eventually(
      () =>
        app.inject({
          method: "GET",
          url: `/v1/operations/${operationId}`,
          headers: auth(),
        }),
      (response) => response.json().result.state === "succeeded",
    );

    const lookups = await Promise.all(
      [
        { ...operation, serviceId: "motis" },
        { ...operation, tail: 21 },
      ].map((mismatch) =>
        app.inject({
          method: "GET",
          url: `/v1/operation-keys/${operationKey}`,
          headers: {
            ...auth(),
            "x-ops-operation-fingerprint": opsOperationFingerprint(mismatch),
          },
        }),
      ),
    );
    for (const lookup of lookups) {
      expect(lookup.statusCode).toBe(409);
      expect(lookup.json().error.class).toBe("conflict");
    }
    await app.close();
  });

  it("cancels only an owner-bound active job and retains its idempotency key", async () => {
    let aborted = false;
    let restartAborted = false;
    let releaseRestart!: () => void;
    const restart = new Promise<void>((resolve) => {
      releaseRestart = resolve;
    });
    let idByte = 31;
    const dispatch = vi.fn(
      async (submittedOperation: OpsOperation, _runtime: unknown, context: OpsExecutionContext) => {
        if (submittedOperation.kind === "service.restart") {
          context.signal.addEventListener("abort", () => {
            restartAborted = true;
          });
          await restart;
          return { changed: true };
        }
        return new Promise<never>((_resolve, reject) => {
          context.signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
          );
        });
      },
    );
    const app = buildOpsAgentServer({
      tokens: { api: apiToken, "data-manager": dataManagerToken },
      resourcePolicy: allowAllResources,
      now: () => new Date(baseTime),
      randomBytes: () => Buffer.alloc(18, idByte++),
      maxConcurrency: 1,
      dispatch,
    });
    const operation = {
      kind: "service.logs.follow",
      serviceId: "redis",
      tail: 20,
      maxDurationSeconds: 300,
    } as const;
    const operationKey = "opk1_cancelFollow00000";
    const admitted = await app.inject({
      method: "POST",
      url: "/v1/operations",
      headers: auth(),
      payload: request(operation, "ops1_cancelFollow00000", operationKey),
    });
    const operationId = admitted.json().result.operationId as string;

    const hidden = await app.inject({
      method: "DELETE",
      url: `/v1/operations/${operationId}`,
      headers: auth(dataManagerToken),
    });
    expect(hidden.statusCode).toBe(404);
    expect(aborted).toBe(false);

    const canceled = await app.inject({
      method: "DELETE",
      url: `/v1/operations/${operationId}`,
      headers: auth(),
    });
    expect(canceled.statusCode).toBe(200);
    expect(canceled.json().result).toMatchObject({
      operationId,
      operationKey,
    });
    expect(["termination_pending", "failed"]).toContain(canceled.json().result.state);
    expect(aborted).toBe(true);
    await eventually(
      async () =>
        app.inject({ method: "GET", url: `/v1/operations/${operationId}`, headers: auth() }),
      (response) => response.json().result.state === "failed",
    );

    const retry = await app.inject({
      method: "POST",
      url: "/v1/operations",
      headers: auth(),
      payload: request(operation, "ops1_cancelRetry000000", operationKey),
    });
    expect(retry.json().result.operationId).toBe(operationId);
    expect(dispatch).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 1));

    let restartAdmission: Awaited<ReturnType<typeof app.inject>> | undefined;
    let lastRestartResponse: Awaited<ReturnType<typeof app.inject>> | undefined;
    for (let restartAttempt = 1; restartAttempt <= 50; restartAttempt += 1) {
      lastRestartResponse = await app.inject({
        method: "POST",
        url: "/v1/operations",
        headers: auth(),
        payload: request(
          { kind: "service.restart", serviceId: "redis" },
          `ops1_restartAttempt${String(restartAttempt).padStart(4, "0")}`,
          "opk1_restartAdmission00",
        ),
      });
      if (lastRestartResponse.statusCode === 202) {
        restartAdmission = lastRestartResponse;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    if (!restartAdmission) {
      throw new Error(
        `restart admission failed: ${lastRestartResponse?.statusCode} ${lastRestartResponse?.body}`,
      );
    }
    const restartId = restartAdmission.json().result.operationId as string;
    const migratedCancel = await app.inject({
      method: "DELETE",
      url: `/v1/operations/${restartId}`,
      headers: auth(),
    });
    expect(migratedCancel.statusCode).toBe(200);
    expect(migratedCancel.json().result.state).toBe("termination_pending");
    expect(restartAborted).toBe(true);
    releaseRestart();
    await eventually(
      async () =>
        app.inject({ method: "GET", url: `/v1/operations/${restartId}`, headers: auth() }),
      (response) => response.json().result.state === "failed",
    );
    await app.close();
  });

  it.each(["abort-respecting", "abort-ignoring"] as const)(
    "keeps recovery_required sticky when cancellation persistence fails (%s)",
    async (behavior) => {
      let persisted: PersistedOpsJob[] = [];
      let writes = 0;
      const journal: OpsJobJournal = {
        records: () => persisted,
        replace: async (records) => {
          writes += 1;
          if (writes === 3) throw new Error("termination checkpoint unavailable");
          persisted = records.map((record) => structuredClone(record));
        },
      };
      let release!: () => void;
      const hostile = new Promise<void>((resolve) => {
        release = resolve;
      });
      let aborted = false;
      const dispatch = vi.fn(
        async (_operation: OpsOperation, _runtime: unknown, context: OpsExecutionContext) => {
          context.signal.addEventListener("abort", () => {
            aborted = true;
          });
          if (behavior === "abort-respecting") {
            await new Promise<never>((_resolve, reject) =>
              context.signal.addEventListener(
                "abort",
                () => reject(new DOMException("Aborted", "AbortError")),
                { once: true },
              ),
            );
          }
          await hostile;
          return { lines: 0, truncated: false };
        },
      );
      const app = buildOpsAgentServer({
        tokens: { api: apiToken, "data-manager": dataManagerToken },
        resourcePolicy: allowAllResources,
        journal,
        maxConcurrency: 1,
        now: () => new Date(baseTime),
        randomBytes: () => Buffer.alloc(18, 44),
        dispatch,
      });
      const admitted = await app.inject({
        method: "POST",
        url: "/v1/operations",
        headers: auth(),
        payload: request(
          {
            kind: "service.logs.follow",
            serviceId: "redis",
            tail: 20,
            maxDurationSeconds: 300,
          },
          `ops1_cancelPersist${behavior === "abort-respecting" ? "Respect" : "Ignore"}00`,
          `opk1_cancelPersist${behavior === "abort-respecting" ? "Respect" : "Ignore"}00`,
        ),
      });
      const operationId = admitted.json().result.operationId as string;
      const canceled = await app.inject({
        method: "DELETE",
        url: `/v1/operations/${operationId}`,
        headers: auth(),
      });
      expect(canceled.statusCode).toBe(500);
      expect(aborted).toBe(true);

      if (behavior === "abort-ignoring") {
        const busy = await app.inject({
          method: "POST",
          url: "/v1/operations",
          headers: auth(),
          payload: request(
            { kind: "service.restart", serviceId: "redis" },
            "ops1_cancelPersistBusy00",
            "opk1_cancelPersistBusy00",
          ),
        });
        expect(busy.statusCode).toBe(429);
        release();
      }
      const status = await eventually(
        () => app.inject({ method: "GET", url: `/v1/operations/${operationId}`, headers: auth() }),
        (response) => response.json().result.state === "failed",
      );
      expect(status.json().result).toMatchObject({
        state: "failed",
        errorClass: "recovery_required",
      });
      await app.close();
    },
  );

  it("returns a bounded timeout but holds the active slot until uncooperative work settles", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const audits: OpsAuditEvent[] = [];
    const app = buildOpsAgentServer({
      tokens: { api: apiToken, "data-manager": dataManagerToken },
      resourcePolicy: allowAllResources,
      now: () => new Date(baseTime),
      operationTimeoutMs: 10,
      maxConcurrency: 1,
      audit: (event) => audits.push(event),
      dispatch: async () => {
        calls += 1;
        if (calls === 1) await blocked;
        return calls === 1 ? { invalid: true } : { reachable: true };
      },
    });
    const first = await app.inject({
      method: "POST",
      url: "/v1/operations",
      headers: auth(),
      payload: request(
        { kind: "docker.status" },
        "ops1_timedOutRequest000",
        "opk1_timedOutOperation0",
      ),
    });
    expect(first.statusCode).toBe(504);

    const stillBusy = await app.inject({
      method: "POST",
      url: "/v1/operations",
      headers: auth(),
      payload: request(
        { kind: "docker.status" },
        "ops1_busyAfterTimeout0",
        "opk1_busyAfterTimeout00",
      ),
    });
    expect(stillBusy.statusCode).toBe(429);
    release();
    await eventually(
      async () => audits,
      (events) => events.some((event) => event.result === "late_completion"),
    );

    const afterSettlement = await app.inject({
      method: "POST",
      url: "/v1/operations",
      headers: auth(),
      payload: request(
        { kind: "docker.status" },
        "ops1_afterSettlement0",
        "opk1_afterSettlement00",
      ),
    });
    expect(afterSettlement.statusCode).toBe(200);
    await app.close();
  });

  it("accepts only bounded UTF-8 log events from the typed execution context", async () => {
    const app = buildOpsAgentServer({
      tokens: { api: apiToken, "data-manager": dataManagerToken },
      resourcePolicy: allowAllResources,
      now: () => new Date(baseTime),
      randomBytes: () => Buffer.alloc(18, 24),
      dispatch: async (_operation, _runtime, context: OpsExecutionContext) => {
        context.emitLog("stdout", "😀".repeat(2_000));
        for (let index = 0; index < 1_100; index += 1) {
          context.emitLog("stderr", `line-${index}`);
        }
        return { lines: 1_101, truncated: true };
      },
    });
    const admitted = await app.inject({
      method: "POST",
      url: "/v1/operations",
      headers: auth(),
      payload: request(
        { kind: "service.logs.follow", serviceId: "redis", tail: 10, maxDurationSeconds: 1 },
        "ops1_followRequest00000",
        "opk1_followOperation000",
      ),
    });
    const operationId = admitted.json().result.operationId as string;
    const events = await eventually(
      async () =>
        app.inject({
          method: "GET",
          url: `/v1/operations/${operationId}/events?after=0&limit=100`,
          headers: auth(),
        }),
      (response) => response.json().result.terminal === true,
    );
    const body = events.json().result as {
      truncated: boolean;
      events: Array<{ type: string; message?: string }>;
    };
    expect(body.truncated).toBe(true);
    expect(body.events.length).toBeLessThanOrEqual(100);
    expect(body.events.some((event) => event.type === "log")).toBe(true);
    for (const event of body.events) {
      if (event.type === "log") {
        expect(new TextEncoder().encode(event.message).byteLength).toBeLessThanOrEqual(4_096);
      }
    }
    const status = await app.inject({
      method: "GET",
      url: `/v1/operations/${operationId}`,
      headers: auth(),
    });
    expect(status.json().result).toMatchObject({
      state: "succeeded",
      result: { lines: 1_101, truncated: true },
    });
    await app.close();
  });

  it("rejects validated sync and async results that exceed their per-kind byte budgets", async () => {
    const app = buildOpsAgentServer({
      tokens: { api: apiToken, "data-manager": dataManagerToken },
      resourcePolicy: allowAllResources,
      now: () => new Date(baseTime),
      randomBytes: () => Buffer.alloc(18, 25),
      dispatch: async (operation) => {
        if (operation.kind === "service.logs") {
          return { lines: Array.from({ length: 300 }, () => "x".repeat(4_096)), truncated: false };
        }
        return {
          completedServiceIds: Array.from(
            { length: 256 },
            (_, index) => `service-${String(index).padStart(3, "0")}-${"x".repeat(52)}`,
          ),
          failedServiceIds: [],
        };
      },
    });
    const sync = await app.inject({
      method: "POST",
      url: "/v1/operations",
      headers: auth(),
      payload: request(
        { kind: "service.logs", serviceId: "redis", tail: 300 },
        "ops1_syncOverflow00000",
        "opk1_syncOverflow00000",
      ),
    });
    expect(sync.statusCode).toBe(500);
    expect(sync.json().error.class).toBe("runtime");

    const admitted = await app.inject({
      method: "POST",
      url: "/v1/operations",
      headers: auth(),
      payload: request(
        { kind: "services.buildAll" },
        "ops1_asyncOverflow0000",
        "opk1_asyncOverflow0000",
      ),
    });
    const operationId = admitted.json().result.operationId as string;
    const failed = await eventually(
      async () =>
        app.inject({ method: "GET", url: `/v1/operations/${operationId}`, headers: auth() }),
      (response) => response.json().result.state === "failed",
    );
    expect(failed.json().result.errorClass).toBe("runtime");
    await app.close();
  });

  it("retains terminal idempotency through bounded result retrieval, then prunes by TTL", async () => {
    let nowMs = baseTime;
    let randomValue = 30;
    const app = buildOpsAgentServer({
      tokens: { api: apiToken, "data-manager": dataManagerToken },
      resourcePolicy: allowAllResources,
      now: () => new Date(nowMs),
      randomBytes: () => Buffer.alloc(18, randomValue++),
      maxJobEntries: 1,
      jobRetentionMs: 1_000,
      dispatch: async () => ({ changed: true }),
    });
    const firstPayload = request(
      { kind: "service.pull", serviceId: "redis" },
      "ops1_retainedFirst0000",
      "opk1_retainedFirst0000",
    );
    const first = await app.inject({
      method: "POST",
      url: "/v1/operations",
      headers: auth(),
      payload: firstPayload,
    });
    const firstId = first.json().result.operationId as string;
    await eventually(
      async () => app.inject({ method: "GET", url: `/v1/operations/${firstId}`, headers: auth() }),
      (response) => response.json().result.state === "succeeded",
    );
    const full = await app.inject({
      method: "POST",
      url: "/v1/operations",
      headers: auth(),
      payload: request(
        { kind: "service.restart", serviceId: "redis" },
        "ops1_retainedFull00000",
        "opk1_retainedSecond000",
      ),
    });
    expect(full.statusCode).toBe(429);

    const retry = await app.inject({
      method: "POST",
      url: "/v1/operations",
      headers: auth(),
      payload: { ...firstPayload, requestId: "ops1_retainedRetry0000" },
    });
    expect(retry.statusCode).toBe(202);
    expect(retry.json().result.operationId).toBe(firstId);

    nowMs += 1_001;
    const afterTtl = await app.inject({
      method: "POST",
      url: "/v1/operations",
      headers: auth(),
      payload: request(
        { kind: "service.restart", serviceId: "redis" },
        "ops1_afterRetention000",
        "opk1_retainedSecond000",
      ),
    });
    expect(afterTtl.statusCode).toBe(202);
    expect(afterTtl.json().result.operationId).not.toBe(firstId);
    await app.close();
  });
});
