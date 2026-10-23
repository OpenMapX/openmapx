import type { OpsOperation, OpsResourcePolicy } from "@openmapx/core/ops";
import { describe, expect, it, vi } from "vitest";
import { createDockerRuntime } from "./docker-runtime";
import { type BuildOpsAgentServerOptions, buildOpsAgentServer, type OpsAuditEvent } from "./server";

const apiToken = Buffer.alloc(32, 1).toString("base64url");
const dataManagerToken = Buffer.alloc(32, 2).toString("base64url");
const nowIso = "2026-08-23T18:00:00.000Z";
const allowAll: OpsResourcePolicy = {
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

function envelope(
  operation: OpsOperation | Record<string, unknown>,
  requestId = "ops1_0123456789abcdef",
  operationKey = "opk1_0123456789abcdef",
  issuedAt = nowIso,
  expiresAt = "2026-08-23T18:00:20.000Z",
) {
  return { version: 2, requestId, operationKey, issuedAt, expiresAt, operation };
}

function auth(token: string) {
  return { authorization: `Bearer ${token}`, "x-ops-protocol-version": "2" };
}

describe("ops-agent request boundary", () => {
  it("publishes exact live privacy backup evidence and fails closed", async () => {
    const collectorImage = `ghcr.io/openmapx/privacy-backup@sha256:${"a".repeat(64)}`;
    const app = buildOpsAgentServer({
      tokens: { api: apiToken, "data-manager": dataManagerToken },
      privacyBackupHealth: async () => ({
        ready: true,
        inventoryReadable: true,
        collectorImage,
      }),
    });
    expect((await app.inject({ method: "GET", url: "/health" })).json()).toEqual({
      ok: true,
      privacyBackup: { ready: true, inventoryReadable: true, collectorImage },
    });
    await app.close();

    const failedApp = buildOpsAgentServer({
      tokens: { api: apiToken, "data-manager": dataManagerToken },
      privacyBackupHealth: async () => {
        throw new Error("docker socket detail");
      },
    });
    expect((await failedApp.inject({ method: "GET", url: "/health" })).json()).toEqual({
      ok: true,
      privacyBackup: { ready: false, inventoryReadable: false, collectorImage: null },
    });
    await failedApp.close();
  });

  it("authenticates and resolves role before operation validation or dispatch", async () => {
    const dispatch = vi.fn();
    const app = buildOpsAgentServer({
      tokens: { api: apiToken, "data-manager": dataManagerToken },
      resourcePolicy: allowAll,
      now: () => new Date(nowIso),
      dispatch,
    });
    const unauthenticated = await app.inject({
      method: "POST",
      url: "/v1/operations",
      headers: auth("not-a-token"),
      payload: { command: "docker", args: ["ps"] },
    });
    expect(unauthenticated.statusCode).toBe(401);

    const wrongRole = await app.inject({
      method: "POST",
      url: "/v1/operations",
      headers: auth(apiToken),
      payload: envelope({ kind: "motis.primary.restart", command: "docker" }),
    });
    expect(wrongRole.statusCode).toBe(403);
    expect(wrongRole.json().error.class).toBe("authorization");
    expect(dispatch).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects unknown fields, stale/future/duplicate requests, and excessive bodies", async () => {
    const app = buildOpsAgentServer({
      tokens: { api: apiToken, "data-manager": dataManagerToken },
      resourcePolicy: allowAll,
      now: () => new Date(nowIso),
      bodyLimit: 512,
      dispatch: async () => ({ reachable: true }),
    });
    for (const [payload, errorClass] of [
      [envelope({ kind: "docker.status", args: [] }), "validation"],
      [
        envelope(
          { kind: "docker.status" },
          "ops1_stale00000000000",
          "opk1_stale00000000000",
          "2026-08-23T17:59:30.000Z",
          "2026-08-23T17:59:59.999Z",
        ),
        "stale",
      ],
      [
        envelope(
          { kind: "docker.status" },
          "ops1_future0000000000",
          "opk1_future0000000000",
          "2026-08-23T18:00:06.000Z",
        ),
        "future",
      ],
    ] as const) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/operations",
        headers: auth(apiToken),
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.class).toBe(errorClass);
    }

    const valid = envelope({ kind: "docker.status" }, "ops1_replay0000000000");
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/operations",
          headers: auth(apiToken),
          payload: valid,
        })
      ).statusCode,
    ).toBe(200);
    const replay = await app.inject({
      method: "POST",
      url: "/v1/operations",
      headers: auth(apiToken),
      payload: valid,
    });
    expect(replay.statusCode).toBe(409);
    expect(replay.json().error.class).toBe("replay");

    const oversized = await app.inject({
      method: "POST",
      url: "/v1/operations",
      headers: { ...auth(apiToken), "content-type": "application/json" },
      payload: JSON.stringify({ padding: "x".repeat(1_000) }),
    });
    expect(oversized.statusCode).toBe(413);
    expect(oversized.json().error.class).toBe("validation");
    await app.close();
  });

  it("emits only structured audit fields and redacts runtime failures", async () => {
    const events: OpsAuditEvent[] = [];
    const secret = `${apiToken} docker argv http://ops-agent:4300`;
    const app = buildOpsAgentServer({
      tokens: { api: apiToken, "data-manager": dataManagerToken },
      resourcePolicy: allowAll,
      now: () => new Date(nowIso),
      audit: (event) => events.push(event),
      dispatch: async () => {
        throw new Error(secret);
      },
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/operations",
      headers: auth(apiToken),
      payload: envelope({ kind: "docker.status" }),
    });
    expect(response.statusCode).toBe(500);
    expect(response.json().error).toEqual({ class: "runtime", message: "Operation failed" });
    expect(events).toEqual([
      expect.objectContaining({
        role: "api",
        kind: "docker.status",
        resourceId: "docker.status",
        result: "error",
        errorClass: "runtime",
      }),
    ]);
    expect(Object.keys(events[0]).sort()).toEqual(
      ["durationMs", "errorClass", "kind", "resourceId", "result", "role"].sort(),
    );
    expect(JSON.stringify({ events, response: response.json() })).not.toContain(secret);
    await app.close();
  });

  it("requires distinct role credentials and fails closed on resource authorization", async () => {
    expect(() =>
      buildOpsAgentServer({
        tokens: { api: apiToken, "data-manager": apiToken },
      }),
    ).toThrow("distinct");
    const app = buildOpsAgentServer({
      tokens: { api: apiToken, "data-manager": dataManagerToken },
      resourcePolicy: {},
      now: () => new Date(nowIso),
      dispatch: vi.fn(),
    });
    const denied = await app.inject({
      method: "POST",
      url: "/v1/operations",
      headers: auth(apiToken),
      payload: envelope({ kind: "service.restart", serviceId: "motis" }),
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.class).toBe("authorization");
    await app.close();
  });
});

describe("ops-agent lifecycle deadlines", () => {
  it.each([
    ["service.restart", [240_000]],
    ["service.stop", [299_999]],
    ["service.recreate", [240_000, 220_000]],
  ] as const)("allows bounded shutdown and dependency work for %s", async (kind, durations) => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date(nowIso));
    let aborted = false;
    const completed: number[] = [];
    const runtime = createDockerRuntime({
      stack: {
        infraDir: "/trusted",
        composePath: "/trusted/compose.yml",
        composeReleasePath: "/trusted/release.yml",
      },
      fileExists: () => false,
      execFile: (_file, _args, options) =>
        new Promise((resolve, reject) => {
          const timers: ReturnType<typeof setTimeout>[] = [];
          const cleanup = () => {
            for (const timer of timers) clearTimeout(timer);
            options.signal.removeEventListener("abort", abort);
          };
          const abort = () => {
            aborted = true;
            cleanup();
            reject(new Error("Contained process failed"));
          };
          options.signal.addEventListener("abort", abort, { once: true });
          timers.push(setTimeout(abort, options.timeout));
          let elapsed = 0;
          for (const duration of durations) {
            elapsed += duration;
            timers.push(
              setTimeout(() => {
                completed.push(duration);
                if (completed.length === durations.length) {
                  cleanup();
                  resolve({ stdout: "", stderr: "" });
                }
              }, elapsed),
            );
          }
        }),
    });
    const app = buildOpsAgentServer({
      tokens: { api: apiToken, "data-manager": dataManagerToken },
      resourcePolicy: allowAll,
      now: () => new Date(nowIso),
      runtime,
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/operations",
        headers: auth(apiToken),
        payload: envelope({ kind, serviceId: "postgis" }),
      });
      expect(response.statusCode).toBe(202);
      const { operationId } = response.json().result;
      await vi.advanceTimersByTimeAsync(durations.reduce((sum, duration) => sum + duration, 0));
      const status = (
        await app.inject({
          method: "GET",
          url: `/v1/operations/${operationId}`,
          headers: auth(apiToken),
        })
      ).json().result;
      expect(status).toMatchObject({ state: "succeeded", result: { changed: true } });
      expect(aborted).toBe(false);
      expect(completed).toEqual([...durations]);
    } finally {
      await app.close();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it.each(["deadline", "cancellation"] as const)(
    "settles lifecycle %s without retrying",
    async (mode) => {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      vi.setSystemTime(new Date(nowIso));
      let signal: AbortSignal | undefined;
      const dispatch = vi.fn<NonNullable<BuildOpsAgentServerOptions["dispatch"]>>(
        (_operation, _runtime, context) =>
          new Promise((_resolve, reject) => {
            signal = context.signal;
            context.signal.addEventListener(
              "abort",
              () => reject(new Error("Contained process failed")),
              { once: true },
            );
          }),
      );
      const app = buildOpsAgentServer({
        tokens: { api: apiToken, "data-manager": dataManagerToken },
        resourcePolicy: allowAll,
        now: () => new Date(nowIso),
        dispatch,
      });
      try {
        const response = await app.inject({
          method: "POST",
          url: "/v1/operations",
          headers: auth(apiToken),
          payload: envelope({ kind: "service.stop", serviceId: "postgis" }),
        });
        expect(response.statusCode).toBe(202);
        const { operationId, fingerprint } = response.json().result;
        await vi.advanceTimersByTimeAsync(mode === "deadline" ? 629_999 : 1_000);
        expect(signal?.aborted).toBe(false);
        expect(
          (
            await app.inject({
              method: "GET",
              url: `/v1/operations/${operationId}`,
              headers: auth(apiToken),
            })
          ).json().result.state,
        ).toBe("running");
        if (mode === "deadline") await vi.advanceTimersByTimeAsync(1);
        else
          await app.inject({
            method: "DELETE",
            url: `/v1/operations/${operationId}`,
            headers: { ...auth(apiToken), "x-ops-operation-fingerprint": fingerprint },
          });
        expect(signal?.aborted).toBe(true);
        const status = (
          await app.inject({
            method: "GET",
            url: `/v1/operations/${operationId}`,
            headers: auth(apiToken),
          })
        ).json().result;
        expect(status).toMatchObject({
          state: mode === "deadline" ? "timed_out" : "failed",
          errorClass: mode === "deadline" ? "timeout" : "runtime",
        });
        expect(status.result).toBeUndefined();
        expect(dispatch).toHaveBeenCalledTimes(1);
      } finally {
        await app.close();
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    },
  );
});

describe("retained execution deadlines", () => {
  it("retains original admission across duplicate, extension attempt and old 30 minute limit", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date(nowIso));
    let signal: AbortSignal | undefined;
    let finish!: (x: unknown) => void;
    let calls = 0;
    const records: import("./journal").PersistedOpsJob[][] = [];
    const app = buildOpsAgentServer({
      tokens: { api: apiToken, "data-manager": dataManagerToken },
      resourcePolicy: allowAll,
      journal: {
        records: () => [],
        replace: async (x) => {
          records.push(structuredClone([...x]));
        },
      },
      dispatch: async (_op, _runtime, ctx) => {
        calls++;
        signal = ctx.signal;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    });
    try {
      const first = await app.inject({
        method: "POST",
        url: "/v1/operations",
        headers: auth(apiToken),
        payload: {
          ...envelope({ kind: "service.build", serviceId: "valhalla" }),
          execution: { requestedDeadlineAt: Date.now() + 4 * 3600_000 },
        },
      });
      const admitted = first.json().result;
      expect(admitted.deadlineAt).toBe(Date.now() + 4 * 3600_000);
      expect(records.at(-1)?.[0]).toMatchObject({
        admittedAt: Date.now(),
        deadlineAt: admitted.deadlineAt,
        operationFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      await vi.advanceTimersByTimeAsync(31 * 60_000);
      expect(signal?.aborted).toBe(false);
      const duplicate = await app.inject({
        method: "POST",
        url: "/v1/operations",
        headers: auth(apiToken),
        payload: {
          ...envelope(
            { kind: "service.build", serviceId: "valhalla" },
            "ops1_duplicateabcdefgh",
            undefined,
            new Date().toISOString(),
            new Date(Date.now() + 20_000).toISOString(),
          ),
          execution: { requestedDeadlineAt: admitted.deadlineAt },
        },
      });
      expect(duplicate.json().result).toMatchObject({
        operationId: admitted.operationId,
        admittedAt: admitted.admittedAt,
        deadlineAt: admitted.deadlineAt,
        fingerprint: admitted.fingerprint,
      });
      const changed = await app.inject({
        method: "POST",
        url: "/v1/operations",
        headers: auth(apiToken),
        payload: {
          ...envelope(
            { kind: "service.build", serviceId: "valhalla" },
            "ops1_changedabcdefghij",
            undefined,
            new Date().toISOString(),
            new Date(Date.now() + 20_000).toISOString(),
          ),
          execution: { requestedDeadlineAt: admitted.deadlineAt + 1 },
        },
      });
      expect(changed.statusCode).toBe(409);
      expect(calls).toBe(1);
    } finally {
      finish?.({ changed: true });
      await vi.advanceTimersByTimeAsync(0);
      await app.close();
      vi.useRealTimers();
    }
  });
  it("persists true expiry intent while unresolved containment stays pending after settlement grace", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date(nowIso));
    let signal: AbortSignal | undefined;
    let finish!: (x: unknown) => void;
    const app = buildOpsAgentServer({
      tokens: { api: apiToken, "data-manager": dataManagerToken },
      resourcePolicy: allowAll,
      dispatch: async (_o, _r, c) => {
        signal = c.signal;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/operations",
        headers: auth(apiToken),
        payload: {
          ...envelope({ kind: "service.build", serviceId: "valhalla" }),
          execution: { requestedDeadlineAt: Date.now() + 100 },
        },
      });
      const id = response.json().result.operationId;
      await vi.advanceTimersByTimeAsync(30_101);
      expect(signal?.aborted).toBe(true);
      const status = (
        await app.inject({ method: "GET", url: `/v1/operations/${id}`, headers: auth(apiToken) })
      ).json().result;
      expect(status).toMatchObject({
        state: "termination_pending",
        terminationRequestedAt: expect.any(String),
      });
      expect(status.errorClass).toBeUndefined();
    } finally {
      finish?.({ changed: true });
      await vi.advanceTimersByTimeAsync(0);
      await app.close();
      vi.useRealTimers();
    }
  });
  it("rejects unsigned wire parent and delegation headers before effects", async () => {
    const dispatch = vi.fn();
    const app = buildOpsAgentServer({
      tokens: { api: apiToken, "data-manager": dataManagerToken },
      resourcePolicy: allowAll,
      now: () => new Date(nowIso),
      dispatch,
    });
    try {
      for (const name of ["x-openmapx-parent-execution", "x-openmapx-control-delegation"]) {
        const r = await app.inject({
          method: "POST",
          url: "/v1/operations",
          headers: { ...auth(apiToken), [name]: "unverified" },
          payload: envelope(
            { kind: "service.build", serviceId: "valhalla" },
            `ops1_${name.replaceAll("-", "")}`,
          ),
        });
        expect(r.statusCode).toBe(403);
      }
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

describe("execution identity at the agent boundary", () => {
  it("clamps an authenticated late API child and keeps a duplicate after expiry immutable", async () => {
    const { createHmac } = await import("node:crypto");
    const { opsOperationFingerprint } = await import("@openmapx/core/ops");
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date(nowIso));
    const operation = { kind: "service.build" as const, serviceId: "valhalla" };
    const operationKey = "opk1_parentBoundChild";
    const fields = {
      version: 1,
      apiJobId: "123e4567-e89b-42d3-a456-426614174000",
      apiOwnerVersion: 1,
      parentOperationKey: "opk1_parentabcdefghij",
      parentFingerprint: "a".repeat(64),
      parentDeadlineAt: Date.now() + 1000,
      childOperationKey: operationKey,
      childOperationFingerprint: opsOperationFingerprint(operation),
      requestedDeadlineAt: Date.now() + 12 * 3600_000,
      attemptId: "123e4567-e89b-42d3-a456-426614174001",
    };
    const payload = Buffer.from(JSON.stringify(fields)).toString("base64url");
    const assertion =
      payload +
      "." +
      createHmac("sha256", apiToken)
        .update("openmapx-api-job-parent-v1\0")
        .update(payload)
        .digest("base64url");
    let finish!: (x: unknown) => void;
    let execution: import("@openmapx/core/ops").ExecutionRef | undefined;
    const app = buildOpsAgentServer({
      tokens: { api: apiToken, "data-manager": dataManagerToken },
      resourcePolicy: allowAll,
      dispatch: async (_o, _r, c) => {
        execution = c.execution;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    });
    try {
      const send = (id: string) =>
        app.inject({
          method: "POST",
          url: "/v1/operations",
          headers: { ...auth(apiToken), "x-openmapx-parent-execution": assertion },
          payload: {
            ...envelope(
              operation,
              id,
              operationKey,
              new Date().toISOString(),
              new Date(Date.now() + 20_000).toISOString(),
            ),
            execution: { requestedDeadlineAt: fields.requestedDeadlineAt },
          },
        });
      const first = (await send("ops1_parentFirstChild000")).json().result;
      expect(first.deadlineAt).toBe(fields.parentDeadlineAt);
      expect(execution).toMatchObject({
        deadlineAt: first.deadlineAt,
        fingerprint: first.fingerprint,
        operationFingerprint: fields.childOperationFingerprint,
      });
      await vi.advanceTimersByTimeAsync(31_001);
      const duplicate = (await send("ops1_parentDuplicate000")).json().result;
      expect(duplicate).toMatchObject({
        operationId: first.operationId,
        deadlineAt: first.deadlineAt,
        admittedAt: first.admittedAt,
        fingerprint: first.fingerprint,
        state: "termination_pending",
      });
    } finally {
      finish?.({ changed: true });
      await vi.advanceTimersByTimeAsync(0);
      await app.close();
      vi.useRealTimers();
    }
  });
  it("retains a redacted live tail and independent failure evidence through the journal", async () => {
    const { OpsExecutionFailure } = await import("./runtime");
    let fail!: (x: unknown) => void;
    const snapshots: import("./journal").PersistedOpsJob[][] = [];
    const app = buildOpsAgentServer({
      tokens: { api: apiToken, "data-manager": dataManagerToken },
      resourcePolicy: allowAll,
      now: () => new Date(nowIso),
      journal: {
        records: () => [],
        replace: async (records) => {
          snapshots.push(structuredClone([...records]));
        },
      },
      dispatch: async (_o, _r, c) => {
        c.emitLog("stderr", "password=hidden");
        for (let i = 0; i < 100; i++) c.emitLog("stdout", "x".repeat(4096));
        c.emitLog("stderr", "last-diagnostic");
        return new Promise((_resolve, reject) => {
          fail = reject;
        });
      },
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/operations",
        headers: auth(apiToken),
        payload: envelope({ kind: "service.build", serviceId: "valhalla" }),
      });
      const id = response.json().result.operationId;
      const live = (
        await app.inject({ method: "GET", url: `/v1/operations/${id}`, headers: auth(apiToken) })
      ).json().result;
      expect(live.diagnostics.truncated).toBe(true);
      expect(live.diagnostics.tail[0].message).toBe("[output truncated]");
      expect(JSON.stringify(live)).not.toContain("hidden");
      fail(
        new OpsExecutionFailure("runtime", {
          diagnostics: {
            tail: [{ stream: "stderr", message: "password=private" }],
            truncated: false,
          },
        }),
      );
      await vi.waitFor(() => expect(snapshots.at(-1)?.[0]?.state).toBe("failed"));
      const retained = snapshots.at(-1)?.[0];
      expect(retained?.failureResult?.diagnostics?.tail[0]?.message).toBe("password=[redacted]");
      expect(retained?.result).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});

it("observer abort leaves the admitted backend running until its real completion", async () => {
  const { waitForOpsResult, OpsObservationPending } = await import(
    "../../api/src/services/ops-client"
  );
  const { parseOpsJobStatusForKind } = await import("@openmapx/core/ops");
  const observer = new AbortController();
  let backendSignal: AbortSignal | undefined;
  let finish!: (x: unknown) => void;
  const app = buildOpsAgentServer({
    tokens: { api: apiToken, "data-manager": dataManagerToken },
    resourcePolicy: allowAll,
    now: () => new Date(nowIso),
    dispatch: async (_o, _r, c) => {
      backendSignal = c.signal;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/v1/operations",
      headers: auth(apiToken),
      payload: envelope({ kind: "service.build", serviceId: "valhalla" }),
    });
    const admission = response.json().result;
    const status = async () =>
      parseOpsJobStatusForKind(
        "service.build",
        (
          await app.inject({
            method: "GET",
            url: `/v1/operations/${admission.operationId}`,
            headers: auth(apiToken),
          })
        ).json().result,
      );
    const cancel = vi.fn();
    await expect(
      waitForOpsResult(
        { status, cancel } as unknown as import("../../api/src/services/ops-client").ApiOpsClient,
        "service.build",
        admission,
        {
          signal: observer.signal,
          sleep: async () => {
            observer.abort();
          },
        },
      ),
    ).rejects.toBeInstanceOf(OpsObservationPending);
    expect(backendSignal?.aborted).toBe(false);
    expect(cancel).not.toHaveBeenCalled();
    finish({ completed: true });
    await vi.waitFor(async () => expect((await status()).state).toBe("succeeded"));
  } finally {
    finish?.({ completed: true });
    await app.close();
  }
});

it.each([0, 1])(
  "fix2 retains safe credential continuations, truncation and final diagnostics through the real CLI/server boundary (exit %s)",
  async (exitCode) => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { createDefaultFixedCli, createAdministrativeRuntime } = await import(
      "./administrative-runtime"
    );
    const { createUnavailableRuntime } = await import("./runtime");
    const root = mkdtempSync(join(tmpdir(), "openmapx-fix1-diagnostics-"));
    const suffix = " https://synthetic-user:443";
    const frames = [
      'password="closed" token="synthetic-first\n',
      'synthetic-continuation\\"still-open\n',
      'synthetic-final"\n',
      'pass\x1b[31mword="ansi-first\n',
      'ansi-continuation"\n',
      ...["accesstoken", "accessToken", "ACCESSTOKEN"].flatMap((key, index) => {
        const ending = ["\n", "\r\n", "\r"][index];
        return [
          `${key}="synthetic-access-first-${index}${ending}`,
          `synthetic-access-second-${index}"${ending}`,
        ];
      }),
      ...["Bearer", "Basic", "Token"].flatMap((scheme, index) => {
        const ending = ["\n", "\r\n", "\r"][index];
        return [`Authorization: ${scheme}${ending}`, `synthetic-auth-value-${index}${ending}`];
      }),
      `${"x".repeat(4096 - Buffer.byteLength(suffix))}${suffix}@host.invalid/path\n`,
      `${"x".repeat(6000)}\n`,
      "last-diagnostic\n",
    ];
    writeFileSync(
      join(root, "cli.mjs"),
      `for(const frame of ${JSON.stringify(frames)})for(const byte of Buffer.from(frame))process.stdout.write(Buffer.from([byte]));process.exitCode=${exitCode};`,
    );
    const runtime = createUnavailableRuntime();
    createAdministrativeRuntime(runtime, {
      rootDir: root,
      runFixedCli: createDefaultFixedCli(root, join(root, "agent.mjs")),
      loadBuildAuthority: async () => [
        {
          serviceId: "osrm",
          enabled: true,
          isBuiltIn: true,
          buildCommand: "openmapx services build osrm",
        },
      ],
    });
    const retained: import("./journal").PersistedOpsJob[][] = [];
    const app = buildOpsAgentServer({
      tokens: { api: apiToken, "data-manager": dataManagerToken },
      resourcePolicy: allowAll,
      runtime,
      journal: {
        records: () => [],
        replace: async (x) => {
          retained.push(structuredClone([...x]));
        },
      },
    });
    try {
      const payload = {
        ...envelope({ kind: "service.build", serviceId: "osrm" }),
        version: 2,
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 20000).toISOString(),
      };
      const response = await app.inject({
        method: "POST",
        url: "/v1/operations",
        headers: auth(apiToken),
        payload,
      });
      const id = response.json().result.operationId;
      await vi.waitFor(
        () => expect(retained.at(-1)?.[0]?.state).toBe(exitCode === 0 ? "succeeded" : "failed"),
        { timeout: 3000 },
      );
      const status = (
        await app.inject({
          method: "GET",
          url: `/v1/operations/${id}`,
          headers: { ...auth(apiToken), "x-ops-protocol-version": "2" },
        })
      ).json().result;
      expect(status.diagnostics.truncated).toBe(true);
      expect(status.diagnostics.tail).toContainEqual({
        stream: "stdout",
        message: "last-diagnostic",
      });
      expect(retained.at(-1)?.[0]?.diagnostics?.truncated).toBe(true);
      const events = (
        await app.inject({
          method: "GET",
          url: `/v1/operations/${id}/events`,
          headers: auth(apiToken),
        })
      ).json();
      const all = JSON.stringify({ status, events, retained });
      for (const secret of [
        "synthetic-first",
        "synthetic-continuation",
        "synthetic-final",
        "ansi-first",
        "ansi-continuation",
        "synthetic-user",
        "synthetic-access-first-",
        "synthetic-access-second-",
        "synthetic-auth-value-",
      ])
        expect(all).not.toContain(secret);
      if (exitCode !== 0)
        expect(status.failureResult.diagnostics.tail).toContainEqual({
          stream: "stdout",
          message: "last-diagnostic",
        });
    } finally {
      await app.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

describe("fix1 baseline protocol compatibility", () => {
  const legacyEnvelope = (...args: Parameters<typeof envelope>) => ({
    ...envelope(...args),
    version: 1,
  });
  it("projects the exact historical admission/status/lookup/cancel shapes for a v1 caller", async () => {
    const { opsOperationFingerprint } = await import("@openmapx/core/ops");
    let finish!: (x: unknown) => void;
    let signal: AbortSignal | undefined;
    let dispatches = 0;
    const operation = { kind: "service.build" as const, serviceId: "osrm" };
    const app = buildOpsAgentServer({
      tokens: { api: apiToken, "data-manager": dataManagerToken },
      resourcePolicy: allowAll,
      now: () => new Date(nowIso),
      dispatch: async (_o, _r, c) => {
        dispatches += 1;
        signal = c.signal;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/operations",
        headers: { authorization: `Bearer ${apiToken}` },
        payload: legacyEnvelope(operation),
      });
      const admission = response.json().result;
      expect(Object.keys(admission).sort()).toEqual(
        ["execution", "operationId", "operationKey", "kind", "state"].sort(),
      );
      const duplicate = (
        await app.inject({
          method: "POST",
          url: "/v1/operations",
          headers: { authorization: `Bearer ${apiToken}` },
          payload: legacyEnvelope(operation, "ops1_legacyretry00000"),
        })
      ).json().result;
      expect(duplicate).toEqual(admission);
      expect(dispatches).toBe(1);
      for (const url of [
        `/v1/operations/${admission.operationId}`,
        `/v1/operation-keys/${admission.operationKey}`,
      ]) {
        const status = (
          await app.inject({
            method: "GET",
            url,
            headers: {
              ...{ authorization: `Bearer ${apiToken}` },
              "x-ops-operation-fingerprint": opsOperationFingerprint(operation),
            },
          })
        ).json().result;
        expect(status.version).toBe(1);
        expect(Object.keys(status).sort()).toEqual(
          [
            "version",
            "operationId",
            "operationKey",
            "kind",
            "resourceId",
            "state",
            "submittedAt",
            "updatedAt",
          ].sort(),
        );
      }
      const cancel = app.inject({
        method: "DELETE",
        url: `/v1/operations/${admission.operationId}`,
        headers: { authorization: `Bearer ${apiToken}` },
      });
      await vi.waitFor(() => expect(signal?.aborted).toBe(true));
      finish({ completed: true });
      expect((await cancel).statusCode).toBe(200);
      const modern = (
        await app.inject({
          method: "GET",
          url: `/v1/operations/${admission.operationId}`,
          headers: { ...{ authorization: `Bearer ${apiToken}` }, "x-ops-protocol-version": "2" },
        })
      ).json().result;
      expect(modern.version).toBe(2);
      expect(modern.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      finish?.({ completed: true });
      await app.close();
    }
  });
});

it("fix1 cannot downgrade modern-origin cancellation to the legacy fence", async () => {
  let finish!: (x: unknown) => void;
  const app = buildOpsAgentServer({
    tokens: { api: apiToken, "data-manager": dataManagerToken },
    resourcePolicy: allowAll,
    now: () => new Date(nowIso),
    dispatch: async () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  try {
    const admission = (
      await app.inject({
        method: "POST",
        url: "/v1/operations",
        headers: auth(apiToken),
        payload: envelope({ kind: "service.build", serviceId: "osrm" }),
      })
    ).json().result;
    const rejected = await app.inject({
      method: "DELETE",
      url: `/v1/operations/${admission.operationId}`,
      headers: { authorization: `Bearer ${apiToken}` },
    });
    expect(rejected.statusCode).toBe(409);
    const cancellation = app.inject({
      method: "DELETE",
      url: `/v1/operations/${admission.operationId}`,
      headers: { ...auth(apiToken), "x-ops-operation-fingerprint": admission.fingerprint },
    });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    finish({ completed: true });
    expect((await cancellation).statusCode).toBe(200);
  } finally {
    finish?.({ completed: true });
    await app.close();
  }
});
