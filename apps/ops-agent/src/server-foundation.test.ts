import {
  type OpsOperation,
  type OpsResourcePolicy,
  opsOperationFingerprint,
} from "@openmapx/core/ops";
import { assert, describe, expect, it, vi } from "vitest";
import {
  buildControlTestServer as buildOpsAgentServer,
  controlTestKey,
} from "./__fixtures__/server";
import { OPS_AGENT_RETENTION_LIMITS } from "./job-table";
import type { OpsJobJournal, PersistedOpsJob } from "./journal";
import {
  type OpsExecutionContext,
  OpsExecutionFailure,
  OpsHostUpdateRequiredError,
} from "./runtime";
import type { OpsAuditEvent } from "./server";

const apiToken = Buffer.alloc(32, 21).toString("base64url");
const dataManagerToken = Buffer.alloc(32, 22).toString("base64url");
const baseTime = Date.now();
const deadlineAt = baseTime + 3_600_000;
const key = (label: string) => controlTestKey(label, deadlineAt);
const pullResult = {
  changed: true as const,
  revisionId: `cfg1_${"a".repeat(43)}`,
  imageReference: "example/redis:1",
  imageId: `sha256:${"b".repeat(64)}`,
  releaseSelectionDigest: null,
};

const allowAllResources: OpsResourcePolicy = {
  allowGlobal: () => true,
  allowService: () => true,
  allowBackup: () => true,
  allowPreparedRun: () => true,
  allowCandidate: () => true,
  allowRelease: () => true,
  allowRegion: () => true,
  allowDataType: () => true,
  allowIntegration: () => true,
  allowTrustedRevision: () => true,
};

function auth(token = apiToken) {
  return { authorization: `Bearer ${token}`, "x-ops-protocol-version": "1" };
}

function request(operation: OpsOperation, requestId: string, operationKey: string) {
  return {
    version: 1,
    requestId,
    operationKey,
    execution: { requestedDeadlineAt: deadlineAt },
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
      return operation.kind === "service.pull" ? pullResult : { reachable: true };
    });
    const app = await buildOpsAgentServer({
      tokens: { api: apiToken, "data-manager": dataManagerToken },
      resourcePolicy: allowAllResources,
      now: () => new Date(baseTime),
      randomBytes: () => Buffer.alloc(18, 23),
      dispatch,
    });
    const operationKey = key("opk1_stableTransportRetry");
    const operation = {
      kind: "service.pull",
      serviceId: "redis",
      expectedConfigurationRevisionId: `cfg1_${"a".repeat(43)}`,
    } as const;
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
        {
          kind: "service.pull",
          serviceId: "motis",
          expectedConfigurationRevisionId: `cfg1_${"a".repeat(43)}`,
        },
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
        "x-ops-body-fingerprint": opsOperationFingerprint(operation),
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
        "x-ops-body-fingerprint": "0".repeat(64),
      },
    });
    expect(keyHiddenFromOtherRole.statusCode).toBe(404);
    const mismatchedResource = await app.inject({
      method: "GET",
      url: `/v1/operation-keys/${operationKey}`,
      headers: {
        ...auth(),
        "x-ops-body-fingerprint": opsOperationFingerprint({
          kind: "service.pull",
          serviceId: "motis",
          expectedConfigurationRevisionId: `cfg1_${"a".repeat(43)}`,
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
    expect(succeeded.json().result.result).toEqual(pullResult);

    const terminalLookup = await app.inject({
      method: "GET",
      url: `/v1/operation-keys/${operationKey}`,
      headers: {
        ...auth(),
        "x-ops-body-fingerprint": opsOperationFingerprint(operation),
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
    const app = await buildOpsAgentServer({
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
    const operationKey = key("opk1_terminalExactLookup00");
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
            "x-ops-body-fingerprint": opsOperationFingerprint(mismatch),
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
    const app = await buildOpsAgentServer({
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
    const operationKey = key("opk1_cancelFollow00000");
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
      headers: { ...auth(), "x-ops-operation-fingerprint": admitted.json().result.fingerprint },
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
          key("opk1_restartAdmission00"),
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
      headers: {
        ...auth(),
        "x-ops-operation-fingerprint": restartAdmission.json().result.fingerprint,
      },
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
        foreignRecords: () => [],
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
      const app = await buildOpsAgentServer({
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
          key(`opk1_cancelPersist${behavior === "abort-respecting" ? "Respect" : "Ignore"}00`),
        ),
      });
      const operationId = admitted.json().result.operationId as string;
      const canceled = await app.inject({
        method: "DELETE",
        url: `/v1/operations/${operationId}`,
        headers: { ...auth(), "x-ops-operation-fingerprint": admitted.json().result.fingerprint },
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
            key("opk1_cancelPersistBusy00"),
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
    const app = await buildOpsAgentServer({
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
        key("opk1_timedOutOperation0"),
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
        key("opk1_busyAfterTimeout00"),
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
        key("opk1_afterSettlement00"),
      ),
    });
    expect(afterSettlement.statusCode).toBe(200);
    await app.close();
  });

  it("accepts only bounded UTF-8 log events from the typed execution context", async () => {
    const app = await buildOpsAgentServer({
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
        key("opk1_followOperation000"),
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

  it("reports a host update as its safe error code through the async protocol", async () => {
    const app = await buildOpsAgentServer({
      tokens: { api: apiToken, "data-manager": dataManagerToken },
      resourcePolicy: allowAllResources,
      now: () => new Date(baseTime),
      dispatch: async () => {
        throw new OpsHostUpdateRequiredError();
      },
    });
    const admitted = await app.inject({
      method: "POST",
      url: "/v1/operations",
      headers: auth(),
      payload: request(
        { kind: "release.images.pull", releaseId: "test-release", manifestDigest: "a".repeat(64) },
        "ops1_hostUpdateRequest",
        key("opk1_hostUpdateRequest"),
      ),
    });
    expect(admitted.statusCode).toBe(202);
    const operationId = admitted.json().result.operationId as string;
    const status = await eventually(
      async () =>
        (
          await app.inject({
            method: "GET",
            url: `/v1/operations/${operationId}`,
            headers: auth(),
          })
        ).json().result,
      (result) => result.state === "failed",
    );
    expect(status).toMatchObject({ state: "failed", errorClass: "host_update_required" });
    await app.close();
  });

  it("rejects oversized sync output and retains the maximum build-all receipt", async () => {
    const app = await buildOpsAgentServer({
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
            (_, index) => `service-${String(index).padStart(3, "0")}-${"x".repeat(36)}`,
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
        key("opk1_syncOverflow00000"),
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
        key("opk1_asyncOverflow0000"),
      ),
    });
    const operationId = admitted.json().result.operationId as string;
    const completed = await eventually(
      async () =>
        app.inject({ method: "GET", url: `/v1/operations/${operationId}`, headers: auth() }),
      (response) => response.json().result.state === "succeeded",
    );
    // 256 ids of the maximum length: the largest receipt a build-all can produce.
    const completedIds = completed.json().result.result.completedServiceIds as string[];
    expect(completedIds).toHaveLength(256);
    expect(completedIds.every((id) => id.length === 48)).toBe(true);
    await app.close();
  });

  it("retains terminal idempotency through bounded result retrieval, then prunes by TTL", async () => {
    let nowMs = baseTime;
    let randomValue = 30;
    const app = await buildOpsAgentServer({
      tokens: { api: apiToken, "data-manager": dataManagerToken },
      resourcePolicy: allowAllResources,
      now: () => new Date(nowMs),
      randomBytes: () => Buffer.alloc(18, randomValue++),
      maxJobEntries: 1,
      jobRetentionMs: 1_000,
      dispatch: async (operation) =>
        operation.kind === "service.logs.follow"
          ? { lines: 0, truncated: false }
          : { changed: true },
    });
    const firstPayload = request(
      {
        kind: "service.logs.follow",
        serviceId: "redis",
        tail: 10,
        maxDurationSeconds: 300,
      },
      "ops1_retainedFirst0000",
      key("opk1_retainedFirst0000"),
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
        key("opk1_retainedSecond000"),
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

    nowMs += 72 * 3600_000 + 1;
    const afterTtl = await app.inject({
      method: "POST",
      url: "/v1/operations",
      headers: auth(),
      payload: {
        ...request(
          { kind: "service.restart", serviceId: "redis" },
          "ops1_afterRetention000",
          controlTestKey("after-retention", nowMs + 3600_000),
        ),
        issuedAt: new Date(nowMs).toISOString(),
        expiresAt: new Date(nowMs + 20_000).toISOString(),
        execution: { requestedDeadlineAt: nowMs + 3600_000 },
      },
    });
    expect(afterTtl.statusCode).toBe(202);
    expect(afterTtl.json().result.operationId).not.toBe(firstId);
    await app.close();
  });

  it("bounds entries that need recovery separately from capacity for new work", async () => {
    let randomValue = 60;
    const app = await buildOpsAgentServer({
      tokens: { api: apiToken, "data-manager": dataManagerToken },
      resourcePolicy: allowAllResources,
      now: () => new Date(baseTime),
      randomBytes: () => Buffer.alloc(18, randomValue++),
      maxJobEntries: 2,
      dispatch: async (operation) => {
        if (operation.kind === "service.stop")
          throw new OpsExecutionFailure("recovery_required", {});
        return { changed: true };
      },
    });
    // A stop that needs recovery keeps its target leased; new work uses another one.
    const submit = (kind: "service.stop" | "service.restart", name: string) =>
      app.inject({
        method: "POST",
        url: "/v1/operations",
        headers: auth(),
        payload: request(
          { kind, serviceId: kind === "service.stop" ? "redis" : "osrm" },
          `ops1_${name}`,
          key(`opk1_${name}`),
        ),
      });
    const finish = async (id: string) =>
      eventually(
        async () => app.inject({ method: "GET", url: `/v1/operations/${id}`, headers: auth() }),
        (response) => ["succeeded", "failed"].includes(response.json().result.state),
      );
    const stuck = (await submit("service.stop", "recoveryCapStuck0")).json().result
      .operationId as string;
    expect((await finish(stuck)).json().result.errorClass).toBe("recovery_required");
    const first = await submit("service.restart", "recoveryCapFirst0");
    expect(first.statusCode).toBe(202);
    await finish(first.json().result.operationId);
    // Two retained entries, one of them needing recovery: new work still fits.
    const second = await submit("service.restart", "recoveryCapSecond");
    expect(second.statusCode).toBe(202);
    await finish(second.json().result.operationId);
    expect((await submit("service.restart", "recoveryCapThird0")).statusCode).toBe(429);
    expect((await finish(stuck)).json().result.errorClass).toBe("recovery_required");
    await app.close();
  });
});

describe("one admission path for target effects", () => {
  it("answers busy for a restart or removal of a held target and audits the holder", async () => {
    const control = await import("@openmapx/core/build-artifacts");
    const { mkdtempSync, mkdirSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "omx-leased-admission-"));
    mkdirSync(join(root, "data"), { mode: 0o700 });
    await control.provisionControlDirectories(root);
    const installation = control.openControlInstallation({
      infraDir: root,
      role: "ops-agent",
      serviceIds: ["redis", "osrm"],
    });
    const leaseStore = control.openLeaseStore({
      directory: control.leaseStoreDirectory(root),
      purpose: "test",
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const audit: OpsAuditEvent[] = [];
    const app = await buildOpsAgentServer({
      tokens: { api: apiToken, "data-manager": dataManagerToken },
      resourcePolicy: allowAllResources,
      controlInstallation: installation,
      leaseStore,
      audit: (event) => audit.push(event),
      dispatch: async (operation) => {
        if (operation.kind === "service.stop") await blocked;
        return { changed: true };
      },
    });
    try {
      const submit = (operation: OpsOperation, name: string) =>
        app.inject({
          method: "POST",
          url: "/v1/operations",
          headers: auth(),
          // Issued now: this test may run long after the module's base time.
          payload: {
            ...request(operation, `ops1_${name}Lease`, key(`opk1_${name}Lease`)),
            issuedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 20_000).toISOString(),
          },
        });
      const stop = await submit({ kind: "service.stop", serviceId: "redis" }, "leasedStop00000");
      expect(stop.statusCode).toBe(202);
      await eventually(
        async () => leaseStore.list(),
        (leases) => leases.some((lease) => lease.targets.includes("redis")),
      );
      const [heldLease] = leaseStore.list();
      assert.isDefined(heldLease);
      const holder = heldLease.owner.operationKey;
      for (const [operation, name] of [
        [{ kind: "service.restart", serviceId: "redis" }, "leasedRestart00"],
        [{ kind: "service.remove", serviceId: "redis" }, "leasedRemove000"],
      ] as const) {
        const refused = await submit(operation, name);
        expect(refused.statusCode).toBe(409);
        expect(refused.json().error).toEqual({
          class: "busy",
          message: `Target redis is busy: held by ops-agent operation ${holder} (service.stop, held). See \`openmapx control status\`.`,
        });
      }
      // A refusal records nothing: the leases are unchanged and no job exists.
      expect(leaseStore.list().map((lease) => lease.owner.operationKey)).toEqual([holder]);
      expect(
        audit
          .filter((event) => event.heldBy?.includes(holder))
          .map((event) => [event.kind, event.result]),
      ).toEqual([
        ["service.restart", "denied"],
        ["service.remove", "denied"],
      ]);
      // Another target is free, and admits while a refusal still spends its grace.
      const graced = submit({ kind: "service.restart", serviceId: "redis" }, "leasedGrace0000");
      await new Promise((resolve) => setTimeout(resolve, 200));
      const started = Date.now();
      expect(
        (await submit({ kind: "service.restart", serviceId: "osrm" }, "leasedOther0000"))
          .statusCode,
      ).toBe(202);
      expect(Date.now() - started).toBeLessThan(2_000);
      expect((await graced).statusCode).toBe(409);
      release();
      await eventually(
        async () => leaseStore.list(),
        (leases) => !leases.some((lease) => lease.targets.includes("redis")),
      );
      expect(
        (await submit({ kind: "service.restart", serviceId: "redis" }, "leasedAfter0000"))
          .statusCode,
      ).toBe(202);
    } finally {
      release();
      await app.close();
      control.closeControlInstallation(installation);
      rmSync(root, { recursive: true, force: true });
    }
  }, 40_000);

  it("holds every registered service during a start, so another service cannot be removed", async () => {
    const control = await import("@openmapx/core/build-artifacts");
    const { mkdtempSync, mkdirSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "omx-leased-start-"));
    mkdirSync(join(root, "data"), { mode: 0o700 });
    await control.provisionControlDirectories(root);
    const installation = control.openControlInstallation({
      infraDir: root,
      role: "ops-agent",
      serviceIds: ["redis", "osrm"],
    });
    const leaseStore = control.openLeaseStore({
      directory: control.leaseStoreDirectory(root),
      purpose: "test",
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const app = await buildOpsAgentServer({
      tokens: { api: apiToken, "data-manager": dataManagerToken },
      resourcePolicy: allowAllResources,
      controlInstallation: installation,
      leaseStore,
      dispatch: async (operation) => {
        if (operation.kind === "service.start") await blocked;
        return { changed: true };
      },
    });
    try {
      const submit = (operation: OpsOperation, name: string) =>
        app.inject({
          method: "POST",
          url: "/v1/operations",
          headers: auth(),
          payload: {
            ...request(operation, `ops1_${name}Start`, key(`opk1_${name}Start`)),
            issuedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 20_000).toISOString(),
          },
        });
      expect(
        (
          await submit(
            {
              kind: "service.start",
              serviceId: "redis",
              expectedConfigurationRevisionId: `cfg1_${"d".repeat(43)}`,
            },
            "leasedStart0000",
          )
        ).statusCode,
      ).toBe(202);
      await eventually(
        async () => leaseStore.list(),
        (leases) => leases.some((lease) => lease.targets.includes("osrm")),
      );
      const refused = await submit(
        { kind: "service.remove", serviceId: "osrm" },
        "leasedRemove000",
      );
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error.message).toContain("Target osrm is busy");
    } finally {
      release();
      await app.close();
      control.closeControlInstallation(installation);
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("drops the lease of an update whose configuration revision is no longer current", async () => {
    const control = await import("@openmapx/core/build-artifacts");
    const { installServiceLifecycleRuntime } = await import("./service-lifecycle-runtime");
    const { mkdtempSync, mkdirSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "omx-leased-stale-"));
    mkdirSync(join(root, "data"), { mode: 0o700 });
    await control.provisionControlDirectories(root);
    const installation = control.openControlInstallation({
      infraDir: root,
      role: "ops-agent",
      serviceIds: ["redis", "osrm"],
    });
    const leaseStore = control.openLeaseStore({
      directory: control.leaseStoreDirectory(root),
      purpose: "test",
    });
    const runtime = {} as import("./runtime").OpsRuntime;
    installServiceLifecycleRuntime(runtime, {
      rootDir: root,
      infraDir: root,
      runFixedCli: async () => {
        throw new Error("no child may start");
      },
    });
    const app = await buildOpsAgentServer({
      tokens: { api: apiToken, "data-manager": dataManagerToken },
      resourcePolicy: allowAllResources,
      controlInstallation: installation,
      leaseStore,
      runtime,
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/operations",
        headers: auth(),
        payload: {
          ...request(
            {
              kind: "service.update",
              serviceId: "redis",
              expectedConfigurationRevisionId: `cfg1_${"c".repeat(43)}`,
            },
            "ops1_staleUpdateLease",
            key("opk1_staleUpdateLease"),
          ),
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 20_000).toISOString(),
        },
      });
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(leaseStore.list()).toEqual([]);
    } finally {
      await app.close();
      control.closeControlInstallation(installation);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("releases the targets of a stop that reported a failure, and keeps those of a killed one", async () => {
    const control = await import("@openmapx/core/build-artifacts");
    const { runContainedStreamingProcess } = await import("./docker-runtime");
    const { mkdtempSync, mkdirSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "omx-leased-failure-"));
    mkdirSync(join(root, "data"), { mode: 0o700 });
    await control.provisionControlDirectories(root);
    const installation = control.openControlInstallation({
      infraDir: root,
      role: "ops-agent",
      serviceIds: ["redis", "osrm"],
    });
    const leaseStore = control.openLeaseStore({
      directory: control.leaseStoreDirectory(root),
      purpose: "test",
    });
    const app = await buildOpsAgentServer({
      tokens: { api: apiToken, "data-manager": dataManagerToken },
      resourcePolicy: allowAllResources,
      controlInstallation: installation,
      leaseStore,
      dispatch: async (operation, _runtime, context) => {
        // The Docker command exits 3 for redis; for osrm it is killed by a signal.
        const script =
          "serviceId" in operation && operation.serviceId === "redis" ? "exit 3" : "kill -9 $$";
        await runContainedStreamingProcess("sh", ["-c", script], {
          signal: context.signal,
          timeout: 10_000,
          onLine: () => {},
          redact: (message) => message,
        });
        return { changed: true };
      },
    });
    try {
      const submit = (operation: OpsOperation, name: string) =>
        app.inject({
          method: "POST",
          url: "/v1/operations",
          headers: auth(),
          payload: {
            ...request(operation, `ops1_${name}Fail`, key(`opk1_${name}Fail`)),
            issuedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 20_000).toISOString(),
          },
        });
      for (const [serviceId, name] of [
        ["redis", "reportedStop000"],
        ["osrm", "killedStop00000"],
      ] as const) {
        expect((await submit({ kind: "service.stop", serviceId }, name)).statusCode).toBe(202);
      }
      let settled = leaseStore.list();
      for (
        const endBy = Date.now() + 10_000;
        Date.now() < endBy &&
        (settled.some((lease) => lease.targets.includes("redis")) ||
          !settled.some((lease) => lease.targets.includes("osrm") && lease.state !== "held"));
        settled = leaseStore.list()
      )
        await new Promise((resolve) => setTimeout(resolve, 20));
      expect(settled.map((lease) => [lease.targets, lease.state])).toEqual([
        [["osrm"], "recovery_required"],
      ]);
    } finally {
      await app.close();
      control.closeControlInstallation(installation);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
