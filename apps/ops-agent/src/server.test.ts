import type { OpsOperation, OpsResourcePolicy } from "@openmapx/core/ops";
import { describe, expect, it, vi } from "vitest";
import { buildOpsAgentServer, type OpsAuditEvent } from "./server";

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
  allowExtension: () => true,
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
