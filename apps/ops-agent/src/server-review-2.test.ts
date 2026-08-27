import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OPS_KIND_POLICIES,
  OPS_MAX_HTTP_RESPONSE_BYTES,
  type OpsOperation,
  opsOperationFingerprint,
} from "@openmapx/core/ops";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type OpsJobJournal, openOpsJobJournal, type PersistedOpsJob } from "./journal";
import type { OpsResourceClaimer } from "./policy";
import { buildOpsAgentServer } from "./server";

const apiToken = Buffer.alloc(32, 31).toString("base64url");
const dataManagerToken = Buffer.alloc(32, 32).toString("base64url");
const baseTime = Date.parse("2026-08-23T18:00:00.000Z");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

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

function auth() {
  return { authorization: `Bearer ${apiToken}` };
}

const allow: OpsResourceClaimer = {
  claim: async (operation, fingerprint) => ({
    operation,
    fingerprint,
    source: "registry",
    capability: { revisionId: "registry-v1", values: {} },
  }),
};

function persisted(
  operation: OpsOperation,
  overrides: Partial<PersistedOpsJob> = {},
): PersistedOpsJob {
  return {
    role: "api",
    operation,
    operationId: "job1_restoredOperation0",
    operationKey: "opk1_restoredOperation0",
    fingerprint: opsOperationFingerprint(operation),
    resourceId: "redis",
    state: "running",
    submittedAt: new Date(baseTime).toISOString(),
    updatedAt: new Date(baseTime).toISOString(),
    ...overrides,
  };
}

describe("reviewed durable admission boundary", () => {
  it("rolls back an authenticated late claim after the claim timeout without admitting a job", async () => {
    let finish!: () => void;
    let rollbacks = 0;
    const operation = { kind: "stack.render" as const, revisionId: `cfg1_${"t".repeat(43)}` };
    const app = buildOpsAgentServer({
      tokens: { api: apiToken, "data-manager": dataManagerToken },
      claimTimeoutMs: 5,
      resourceClaimer: {
        claim: async (_operation, fingerprint) => {
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
          return {
            operation,
            fingerprint,
            source: "trusted-data" as const,
            capability: { revisionId: operation.revisionId, values: {} },
            admission: {
              rollback: async () => {
                rollbacks += 1;
              },
              commit: async () => undefined,
              release: async () => undefined,
            },
          };
        },
      },
      now: () => new Date(baseTime),
      dispatch: vi.fn(),
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/operations",
      headers: auth(),
      payload: request(operation, "ops1_lateClaimRollback0", "opk1_lateClaimRollback0"),
    });
    expect(response.statusCode).toBe(504);
    finish();
    for (let attempt = 0; attempt < 100 && rollbacks === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(rollbacks).toBe(1);
    await app.close();
  });

  it.each(["succeeded", "failed"] as const)(
    "releases confidential trusted data only after the job is durably %s",
    async (outcome) => {
      let retained = true;
      let committed = false;
      const operation = {
        kind: "stack.render" as const,
        revisionId: `cfg1_${"r".repeat(43)}`,
      };
      const app = buildOpsAgentServer({
        tokens: { api: apiToken, "data-manager": dataManagerToken },
        resourceClaimer: {
          claim: async (_operation, fingerprint) => ({
            operation,
            fingerprint,
            source: "trusted-data" as const,
            capability: { revisionId: operation.revisionId, values: {} },
            admission: {
              rollback: async () => undefined,
              commit: async () => {
                committed = true;
              },
              release: async () => {
                if (!committed) throw new Error("released before durable admission");
                retained = false;
              },
            },
          }),
        },
        now: () => new Date(baseTime),
        dispatch: async () => {
          expect(retained).toBe(true);
          if (outcome === "failed") throw new Error("runtime failed");
          return { revisionId: operation.revisionId };
        },
      });
      const admitted = await app.inject({
        method: "POST",
        url: "/v1/operations",
        headers: auth(),
        payload: request(
          operation,
          `ops1_terminalRelease${outcome}0`,
          `opk1_terminalRelease${outcome}0`,
        ),
      });
      expect(admitted.statusCode).toBe(202);
      const operationId = admitted.json().result.operationId as string;
      let status = admitted.json().result.state as string;
      for (
        let attempt = 0;
        attempt < 100 && (!["succeeded", "failed"].includes(status) || retained);
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        const response = await app.inject({
          method: "GET",
          url: `/v1/operations/${operationId}`,
          headers: { ...auth(), "x-ops-request-id": `ops1_terminalStatus${outcome}0` },
        });
        status = response.json().result.state as string;
      }
      expect(status).toBe(outcome);
      expect(retained).toBe(false);
      await app.close();
    },
  );

  it("retains recovery-required tombstones beyond TTL and capacity to prevent silent rerun", async () => {
    const operation = { kind: "service.pull", serviceId: "redis" } as const;
    const tombstone = persisted(operation, {
      operationId: "job1_recoveryTombstone0",
      operationKey: "opk1_recoveryTombstone0",
      state: "failed",
      errorClass: "recovery_required",
      terminalAt: new Date(baseTime).toISOString(),
    });
    const dispatch = vi.fn(async () => ({ changed: true }));
    const app = buildOpsAgentServer({
      tokens: { api: apiToken, "data-manager": dataManagerToken },
      resourceClaimer: allow,
      journal: { records: () => [tombstone], replace: async () => undefined },
      maxJobEntries: 1,
      jobRetentionMs: 1,
      now: () => new Date(baseTime + 10_000),
      dispatch,
    });
    const retry = await app.inject({
      method: "POST",
      url: "/v1/operations",
      headers: auth(),
      payload: request(operation, "ops1_tombstoneRetry000", "opk1_recoveryTombstone0"),
    });
    expect(retry.statusCode).toBe(202);
    expect(retry.json().result).toMatchObject({
      operationId: "job1_recoveryTombstone0",
      state: "failed",
    });
    expect(dispatch).not.toHaveBeenCalled();
    const capacity = await app.inject({
      method: "POST",
      url: "/v1/operations",
      headers: auth(),
      payload: request(operation, "ops1_tombstoneCapacity0", "opk1_tombstoneCapacity0"),
    });
    expect(capacity.statusCode).toBe(429);
    expect(dispatch).not.toHaveBeenCalled();
    await app.close();
  });

  it("dispatches and persists only the server-owned operation snapshot after a claim mutates its reference", async () => {
    let sourceReference: OpsOperation | undefined;
    let persistedServiceIds: readonly string[] | undefined;
    const journal: OpsJobJournal = {
      records: () => [],
      replace: async (records) => {
        if (sourceReference?.kind === "backup.restore") {
          try {
            sourceReference.serviceIds?.splice(0, 1, "traefik");
          } catch {
            // A server-owned frozen operation is intentionally immutable.
          }
        }
        const operation = records[0]?.operation;
        if (operation?.kind === "backup.restore") {
          persistedServiceIds = structuredClone(operation.serviceIds);
        }
      },
    };
    const dispatched: string[][] = [];
    const app = buildOpsAgentServer({
      tokens: { api: apiToken, "data-manager": dataManagerToken },
      resourceClaimer: {
        claim: async (operation, fingerprint) => {
          sourceReference = operation;
          return {
            operation: structuredClone(operation),
            fingerprint,
            source: "trusted-data",
            capability: { revisionId: "backup-revision-1", values: {} },
          };
        },
      },
      journal,
      now: () => new Date(baseTime),
      dispatch: async (operation) => {
        if (operation.kind === "backup.restore") {
          dispatched.push([...(operation.serviceIds ?? [])]);
          return { backupId: operation.backupId };
        }
        throw new Error("unexpected operation");
      },
    });
    const admitted = await app.inject({
      method: "POST",
      url: "/v1/operations",
      headers: auth(),
      payload: request(
        {
          kind: "backup.restore",
          backupId: "backup_1",
          serviceIds: ["redis"],
          stopRunning: true,
        },
        "ops1_ownedSnapshot000",
        "opk1_ownedSnapshot000",
      ),
    });
    expect(admitted.statusCode).toBe(202);
    for (let attempt = 0; attempt < 100 && dispatched.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(persistedServiceIds).toEqual(["redis"]);
    expect(dispatched).toEqual([["redis"]]);
    await app.close();
  });

  it("fails the retained live key closed when queued-to-running persistence fails", async () => {
    let writes = 0;
    const journal: OpsJobJournal = {
      records: () => [],
      replace: async () => {
        writes += 1;
        if (writes === 2) throw new Error("disk unavailable");
      },
    };
    const dispatch = vi.fn(async () => ({ changed: true }));
    const app = buildOpsAgentServer({
      tokens: { api: apiToken, "data-manager": dataManagerToken },
      resourceClaimer: allow,
      journal,
      now: () => new Date(baseTime),
      dispatch,
    });
    const operation = { kind: "service.pull", serviceId: "redis" } as const;
    const first = await app.inject({
      method: "POST",
      url: "/v1/operations",
      headers: auth(),
      payload: request(operation, "ops1_startPersistFail00", "opk1_startPersistFail00"),
    });
    expect(first.statusCode).toBe(500);
    const retry = await app.inject({
      method: "POST",
      url: "/v1/operations",
      headers: auth(),
      payload: request(operation, "ops1_startPersistRetry0", "opk1_startPersistFail00"),
    });
    expect(retry.statusCode).toBe(202);
    expect(retry.json().result.state).toBe("failed");
    expect(dispatch).not.toHaveBeenCalled();
    await app.close();
  });

  it("never exposes success when terminal and fallback persistence both fail", async () => {
    let writes = 0;
    const journal: OpsJobJournal = {
      records: () => [],
      replace: async () => {
        writes += 1;
        if (writes >= 3) throw new Error("disk unavailable");
      },
    };
    const app = buildOpsAgentServer({
      tokens: { api: apiToken, "data-manager": dataManagerToken },
      resourceClaimer: allow,
      journal,
      now: () => new Date(baseTime),
      dispatch: async () => ({ changed: true }),
    });
    const operation = { kind: "service.pull", serviceId: "redis" } as const;
    const admitted = await app.inject({
      method: "POST",
      url: "/v1/operations",
      headers: auth(),
      payload: request(operation, "ops1_terminalFail0000", "opk1_terminalFail0000"),
    });
    const operationId = admitted.json().result.operationId as string;
    let status = await app.inject({
      method: "GET",
      url: `/v1/operations/${operationId}`,
      headers: auth(),
    });
    for (let attempt = 0; attempt < 100 && status.json().result.state !== "failed"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
      status = await app.inject({
        method: "GET",
        url: `/v1/operations/${operationId}`,
        headers: auth(),
      });
    }
    expect(status.json().result).toMatchObject({
      state: "failed",
      errorClass: "recovery_required",
    });
    expect(status.json().result).not.toHaveProperty("result");
    const retry = await app.inject({
      method: "POST",
      url: "/v1/operations",
      headers: auth(),
      payload: request(operation, "ops1_terminalRetry000", "opk1_terminalFail0000"),
    });
    expect(retry.json().result.state).toBe("failed");
    await app.close();
  });

  it("serializes admission and terminal full snapshots so neither durable key is lost", async () => {
    const root = mkdtempSync(join(tmpdir(), "openmapx-ops-interleave-"));
    roots.push(root);
    const path = join(root, "journal", "jobs-v1.json");
    const durable = await openOpsJobJournal(path);
    let blockAdmission = false;
    let entered!: () => void;
    let unblock!: () => void;
    const admissionEntered = new Promise<void>((resolve) => (entered = resolve));
    const admissionBlocked = new Promise<void>((resolve) => (unblock = resolve));
    const journal: OpsJobJournal = {
      records: () => durable.records(),
      replace: async (records) => {
        if (blockAdmission && records.some((record) => record.operation.kind === "service.stop")) {
          blockAdmission = false;
          entered();
          await admissionBlocked;
        }
        await durable.replace(records);
      },
    };
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => (releaseFirst = resolve));
    const app = buildOpsAgentServer({
      tokens: { api: apiToken, "data-manager": dataManagerToken },
      resourceClaimer: allow,
      journal,
      now: () => new Date(baseTime),
      dispatch: async (operation) => {
        if (operation.kind === "service.pull") await firstBlocked;
        return { changed: true };
      },
    });
    const first = await app.inject({
      method: "POST",
      url: "/v1/operations",
      headers: auth(),
      payload: request(
        { kind: "service.pull", serviceId: "redis" },
        "ops1_interleaveFirst00",
        "opk1_interleaveFirst00",
      ),
    });
    expect(first.statusCode).toBe(202);
    blockAdmission = true;
    const secondPromise = app.inject({
      method: "POST",
      url: "/v1/operations",
      headers: auth(),
      payload: request(
        { kind: "service.stop", serviceId: "motis" },
        "ops1_interleaveSecond0",
        "opk1_interleaveSecond0",
      ),
    });
    await admissionEntered;
    releaseFirst();
    unblock();
    expect((await secondPromise).statusCode).toBe(202);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (durable.records().every((record) => record.state === "succeeded")) break;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await app.close();
    const reopened = await openOpsJobJournal(path);
    expect(reopened.records()).toHaveLength(2);
    expect(new Set(reopened.records().map((record) => record.operationKey))).toEqual(
      new Set(["opk1_interleaveFirst00", "opk1_interleaveSecond0"]),
    );
    expect(reopened.records().every((record) => record.state === "succeeded")).toBe(true);
  });

  it("serializes concurrent same-key admissions into one durable job and one dispatch", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const dispatch = vi.fn(async () => {
      await blocked;
      return { changed: true };
    });
    const app = buildOpsAgentServer({
      tokens: { api: apiToken, "data-manager": dataManagerToken },
      resourceClaimer: allow,
      now: () => new Date(baseTime),
      dispatch,
    });
    const operation = { kind: "service.pull", serviceId: "redis" } as const;
    const [first, second] = await Promise.all([
      app.inject({
        method: "POST",
        url: "/v1/operations",
        headers: auth(),
        payload: request(operation, "ops1_concurrentFirst00", "opk1_concurrentShared0"),
      }),
      app.inject({
        method: "POST",
        url: "/v1/operations",
        headers: auth(),
        payload: request(operation, "ops1_concurrentSecond0", "opk1_concurrentShared0"),
      }),
    ]);
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(first.json().result.operationId).toBe(second.json().result.operationId);
    expect(dispatch).toHaveBeenCalledTimes(1);
    release();
    await app.close();
  });

  it("serves a result at the declared exact byte limit within the shared envelope budget", async () => {
    const budget = OPS_KIND_POLICIES["service.logs"].maxResultBytes;
    const result = { lines: [...Array(255).fill("x".repeat(4_096)), ""], truncated: false };
    const baseBytes = Buffer.byteLength(JSON.stringify(result), "utf8");
    result.lines[255] = "x".repeat(budget - baseBytes);
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBe(budget);
    const app = buildOpsAgentServer({
      tokens: { api: apiToken, "data-manager": dataManagerToken },
      resourceClaimer: allow,
      now: () => new Date(baseTime),
      dispatch: async () => result,
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/operations",
      headers: auth(),
      payload: request(
        { kind: "service.logs", serviceId: "redis", tail: 256 },
        "ops1_exactBudget00000",
        "opk1_exactBudget00000",
      ),
    });
    expect(response.statusCode).toBe(200);
    expect(Buffer.byteLength(response.body, "utf8")).toBeLessThanOrEqual(
      OPS_MAX_HTTP_RESPONSE_BYTES,
    );
    await app.close();
  });

  it("returns the exact retained state for every idempotent retry", async () => {
    const states = [
      "queued",
      "running",
      "termination_pending",
      "succeeded",
      "failed",
      "timed_out",
    ] as const;
    const operation = { kind: "service.pull", serviceId: "redis" } as const;
    const records = states.map((state, index) =>
      persisted(operation, {
        operationId: `job1_retainedState${index}0000`,
        operationKey: `opk1_retainedState${index}0000`,
        state,
        ...(state === "succeeded"
          ? { result: { changed: true }, terminalAt: new Date(baseTime).toISOString() }
          : state === "failed" || state === "timed_out"
            ? {
                errorClass: state === "timed_out" ? ("timeout" as const) : ("runtime" as const),
                terminalAt: new Date(baseTime).toISOString(),
              }
            : {}),
      }),
    );
    const app = buildOpsAgentServer({
      tokens: { api: apiToken, "data-manager": dataManagerToken },
      resourceClaimer: allow,
      journal: { records: () => records, replace: async () => undefined },
      now: () => new Date(baseTime),
      dispatch: vi.fn(),
    });
    for (const [index, state] of states.entries()) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/operations",
        headers: auth(),
        payload: request(
          operation,
          `ops1_retainedState${index}0000`,
          `opk1_retainedState${index}0000`,
        ),
      });
      expect(response.statusCode).toBe(202);
      expect(response.json().result.state).toBe(state);
    }
    await app.close();
  });

  it("restores an interrupted key as recovery-required and never reruns it", async () => {
    const root = mkdtempSync(join(tmpdir(), "openmapx-ops-restart-"));
    roots.push(root);
    const path = join(root, "journal", "jobs-v1.json");
    const before = await openOpsJobJournal(path);
    const operation = { kind: "service.pull", serviceId: "redis" } as const;
    await before.replace([persisted(operation)]);
    const journal = await openOpsJobJournal(path, {
      now: () => new Date(baseTime + 1_000),
    });
    const dispatch = vi.fn(async () => ({ changed: true }));
    const app = buildOpsAgentServer({
      tokens: { api: apiToken, "data-manager": dataManagerToken },
      resourceClaimer: allow,
      journal,
      now: () => new Date(baseTime + 1_000),
      dispatch,
    });
    const retry = await app.inject({
      method: "POST",
      url: "/v1/operations",
      headers: auth(),
      payload: request(operation, "ops1_restartRetry00000", "opk1_restoredOperation0"),
    });
    expect(retry.statusCode).toBe(202);
    expect(retry.json().result).toMatchObject({
      operationId: "job1_restoredOperation0",
      state: "failed",
    });
    expect(dispatch).not.toHaveBeenCalled();

    const explicitRetry = await app.inject({
      method: "POST",
      url: "/v1/operations",
      headers: auth(),
      payload: request(operation, "ops1_explicitRetry000", "opk1_explicitRetry000"),
    });
    expect(explicitRetry.statusCode).toBe(202);
    expect(explicitRetry.json().result.operationId).not.toBe("job1_restoredOperation0");
    await app.close();
  });

  it("fails closed after bounded collisions with a restored operation ID", async () => {
    const bytes = Buffer.alloc(18, 7);
    const collisionId = `job1_${bytes.toString("base64url")}`;
    const operation = { kind: "service.pull", serviceId: "redis" } as const;
    const existing = persisted(operation, {
      operationId: collisionId,
      state: "failed",
      errorClass: "recovery_required",
      terminalAt: new Date(baseTime).toISOString(),
    });
    const app = buildOpsAgentServer({
      tokens: { api: apiToken, "data-manager": dataManagerToken },
      resourceClaimer: allow,
      journal: { records: () => [existing], replace: async () => undefined },
      now: () => new Date(baseTime),
      randomBytes: () => bytes,
      dispatch: vi.fn(),
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/operations",
      headers: auth(),
      payload: request(operation, "ops1_collisionRequest0", "opk1_collisionRequest0"),
    });
    expect(response.statusCode).toBe(429);
    expect(response.json().error.class).toBe("busy");
    await app.close();
  });

  it("holds the admission slot for a stalled claim and passes an immutable resolved snapshot", async () => {
    let release!: () => void;
    let calls = 0;
    const mutable = {
      operation: { kind: "docker.status" } as OpsOperation,
      fingerprint: opsOperationFingerprint({ kind: "docker.status" }),
      source: "trusted-data" as const,
      capability: { revisionId: "revision-1", values: { target: "original" } },
    };
    const claimer: OpsResourceClaimer = {
      claim: async () => {
        calls += 1;
        if (calls === 1) await new Promise<void>((resolve) => (release = resolve));
        return mutable;
      },
    };
    const seen: string[] = [];
    const app = buildOpsAgentServer({
      tokens: { api: apiToken, "data-manager": dataManagerToken },
      resourceClaimer: claimer,
      claimTimeoutMs: 5,
      maxConcurrency: 1,
      now: () => new Date(baseTime),
      dispatch: async (_operation, _runtime, context) => {
        seen.push(String(context.claim.capability.values.target));
        return { reachable: true };
      },
    });
    const first = await app.inject({
      method: "POST",
      url: "/v1/operations",
      headers: auth(),
      payload: request(
        { kind: "docker.status" },
        "ops1_claimTimeout00000",
        "opk1_claimTimeout00000",
      ),
    });
    expect(first.statusCode).toBe(504);
    const busy = await app.inject({
      method: "POST",
      url: "/v1/operations",
      headers: auth(),
      payload: request({ kind: "docker.status" }, "ops1_claimBusy0000000", "opk1_claimBusy0000000"),
    });
    expect(busy.statusCode).toBe(429);
    release();
    await new Promise((resolve) => setTimeout(resolve, 1));
    const accepted = await app.inject({
      method: "POST",
      url: "/v1/operations",
      headers: auth(),
      payload: request({ kind: "docker.status" }, "ops1_claimAccepted000", "opk1_claimAccepted000"),
    });
    mutable.capability.values.target = "mutated";
    expect(accepted.statusCode).toBe(200);
    expect(seen).toEqual(["original"]);
    await app.close();
  });

  it("rejects hostile cyclic/BigInt claim snapshots without leaking the active slot", async () => {
    let calls = 0;
    const hostile: Record<string, unknown> = { value: 1n };
    hostile.self = hostile;
    const claimer: OpsResourceClaimer = {
      claim: async (operation, fingerprint) => {
        calls += 1;
        return calls === 1
          ? ({
              operation,
              fingerprint,
              source: "trusted-data",
              capability: { revisionId: "hostile", values: hostile },
            } as never)
          : {
              operation,
              fingerprint,
              source: "registry",
              capability: { revisionId: "registry-v1", values: {} },
            };
      },
    };
    const app = buildOpsAgentServer({
      tokens: { api: apiToken, "data-manager": dataManagerToken },
      resourceClaimer: claimer,
      maxConcurrency: 1,
      now: () => new Date(baseTime),
      dispatch: async () => ({ reachable: true }),
    });
    const send = (requestId: string, operationKey: string) =>
      app.inject({
        method: "POST",
        url: "/v1/operations",
        headers: auth(),
        payload: request({ kind: "docker.status" }, requestId, operationKey),
      });
    const denied = await send("ops1_hostileClaim0000", "opk1_hostileClaim0000");
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.class).toBe("authorization");
    expect((await send("ops1_afterHostile0000", "opk1_afterHostile0000")).statusCode).toBe(200);
    await app.close();
  });

  it("contains a throwing audit sink on success and failure", async () => {
    let fail = false;
    const app = buildOpsAgentServer({
      tokens: { api: apiToken, "data-manager": dataManagerToken },
      resourceClaimer: allow,
      now: () => new Date(baseTime),
      audit: () => {
        throw new Error("audit unavailable");
      },
      dispatch: async () => {
        if (fail) throw new Error("failure");
        return { reachable: true };
      },
    });
    const success = await app.inject({
      method: "POST",
      url: "/v1/operations",
      headers: auth(),
      payload: request({ kind: "docker.status" }, "ops1_auditSuccess0000", "opk1_auditSuccess0000"),
    });
    expect(success.statusCode).toBe(200);
    fail = true;
    const failure = await app.inject({
      method: "POST",
      url: "/v1/operations",
      headers: auth(),
      payload: request({ kind: "docker.status" }, "ops1_auditFailure0000", "opk1_auditFailure0000"),
    });
    expect(failure.statusCode).toBe(500);
    await app.close();
  });

  it("contains a throwing timeout audit and releases the slot only after late settlement", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    let calls = 0;
    const app = buildOpsAgentServer({
      tokens: { api: apiToken, "data-manager": dataManagerToken },
      resourceClaimer: allow,
      now: () => new Date(baseTime),
      operationTimeoutMs: 5,
      maxConcurrency: 1,
      audit: () => {
        throw new Error("audit unavailable");
      },
      dispatch: async () => {
        calls += 1;
        if (calls === 1) await blocked;
        return { reachable: true };
      },
    });
    const send = (requestId: string, operationKey: string) =>
      app.inject({
        method: "POST",
        url: "/v1/operations",
        headers: auth(),
        payload: request({ kind: "docker.status" }, requestId, operationKey),
      });
    expect((await send("ops1_auditTimeout0000", "opk1_auditTimeout0000")).statusCode).toBe(504);
    expect((await send("ops1_auditStillBusy00", "opk1_auditStillBusy00")).statusCode).toBe(429);
    release();
    await new Promise((resolve) => setTimeout(resolve, 2));
    expect((await send("ops1_auditAfterLate00", "opk1_auditAfterLate00")).statusCode).toBe(200);
    await app.close();
  });
});
