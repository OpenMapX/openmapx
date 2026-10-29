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
  return { version: 1, requestId, operationKey, issuedAt, expiresAt, operation };
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
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
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
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
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
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
        const { operationId } = response.json().result;
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
            headers: auth(apiToken),
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
