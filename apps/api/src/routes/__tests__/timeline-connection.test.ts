import type { TimelineConnectionView } from "@openmapx/core";
import { httpError } from "@openmapx/integration-framework";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTestApp } from "../../test/app.js";
import { mockRequireAuth } from "../../test/auth.js";

const USER_ID = "timeline-user-a";
const authMock = mockRequireAuth(USER_ID);

vi.mock("../../utils/require-auth.js", () => authMock);

const CONNECTED_VIEW: TimelineConnectionView = {
  connected: true,
  connection: {
    mode: "external",
    publicOrigin: "https://dawarich.example.test",
    displayName: "My timeline",
    upstreamEmail: "person@example.test",
    timeZone: "Europe/Berlin",
    distanceUnit: "km",
    status: "connected",
    validatedAt: "2026-02-02T12:00:00.000Z",
    lastReadAt: null,
  },
  managed: { available: false, healthy: false, publicOrigin: null, reason: "disabled" },
};

let app: FastifyInstance;
let service: typeof import("../../services/dawarich/connection-service.js").timelineConnectionService;

beforeEach(async () => {
  const serviceModule = await import("../../services/dawarich/connection-service.js");
  service = serviceModule.timelineConnectionService;
  vi.spyOn(service, "getConnectionView").mockResolvedValue(CONNECTED_VIEW);
  vi.spyOn(service, "connect").mockResolvedValue(CONNECTED_VIEW);
  vi.spyOn(service, "testConnection").mockResolvedValue(CONNECTED_VIEW);
  vi.spyOn(service, "deleteConnection").mockResolvedValue(undefined);
  const { timelineRoute } = await import("../timeline.js");
  app = await buildTestApp(timelineRoute, { prefix: "/api" });
});

afterEach(async () => {
  await app.close();
  vi.restoreAllMocks();
  authMock.requireAuthHook.mockReset();
  authMock.getUserId.mockReset();
  authMock.requireAuthHook.mockImplementation(async (request) => {
    (request as { userId?: string }).userId = USER_ID;
  });
  authMock.getUserId.mockImplementation(() => USER_ID);
});

function expectNoStore(response: { headers: Record<string, unknown> }) {
  expect(response.headers["cache-control"]).toBe("private, no-store");
}

describe("timeline connection authentication and safe views", () => {
  it.each([
    ["GET", "/api/timeline/connection", undefined],
    ["PUT", "/api/timeline/connection", { mode: "managed", apiKey: "key" }],
    ["POST", "/api/timeline/connection/test", undefined],
    ["DELETE", "/api/timeline/connection", undefined],
  ] as const)("returns a no-store 401 for unauthenticated %s %s", async (method, url, payload) => {
    authMock.requireAuthHook.mockRejectedValueOnce(httpError(401, "Authentication required"));

    const response = await app.inject({ method, url, ...(payload ? { payload } : {}) });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "Authentication required", code: "UNAUTHORIZED" });
    expectNoStore(response);
  });

  it("returns only the authenticated user's safe metadata", async () => {
    const response = await app.inject({ method: "GET", url: "/api/timeline/connection" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(CONNECTED_VIEW);
    expect(service.getConnectionView).toHaveBeenCalledWith(USER_ID);
    expect(response.payload).not.toMatch(
      /apiKey|encryptedApiKey|encryptionIv|encryptionTag|ciphertext/,
    );
    expectNoStore(response);
  });
});

describe("PUT /api/timeline/connection validation", () => {
  it("accepts a display name of 100 Unicode code points, not 100 UTF-16 units", async () => {
    const displayName = "🗺️".repeat(50);
    expect([...displayName]).toHaveLength(100);
    expect(displayName.length).toBeGreaterThan(100);

    const response = await app.inject({
      method: "PUT",
      url: "/api/timeline/connection",
      payload: {
        mode: "external",
        instanceUrl: "https://dawarich.example.test",
        apiKey: "key",
        displayName,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(service.connect).toHaveBeenCalledWith(USER_ID, expect.objectContaining({ displayName }));
  });

  it.each([
    {
      label: "101-code-point display name",
      payload: {
        mode: "external",
        instanceUrl: "https://dawarich.example.test",
        apiKey: "key",
        displayName: "🗺".repeat(101),
      },
    },
    {
      label: "API key over 4 KiB in UTF-8",
      payload: { mode: "managed", apiKey: "🗺".repeat(1025) },
    },
    {
      label: "instance URL over 2 KiB in UTF-8",
      payload: { mode: "external", instanceUrl: `https://${"a".repeat(2036)}.test`, apiKey: "key" },
    },
    {
      label: "unknown field",
      payload: { mode: "managed", apiKey: "key", instanceUrl: "http://attacker.internal" },
    },
  ])("rejects $label with a safe no-store 400", async ({ payload }) => {
    const response = await app.inject({
      method: "PUT",
      url: "/api/timeline/connection",
      payload,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: "Invalid timeline connection request",
      code: "TIMELINE_INSTANCE_UNSUPPORTED",
    });
    expect(service.connect).not.toHaveBeenCalled();
    expectNoStore(response);
  });

  it("passes only the parsed request and authenticated user to the connection service", async () => {
    const payload = { mode: "managed" as const, apiKey: "key" };
    const response = await app.inject({
      method: "PUT",
      url: "/api/timeline/connection",
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(service.connect).toHaveBeenCalledWith(USER_ID, payload);
    expectNoStore(response);
  });
});

describe("timeline connection lifecycle errors", () => {
  it.each([
    ["TIMELINE_INSTANCE_UNSUPPORTED", 400, "Timeline instance is not supported", null],
    ["TIMELINE_NOT_CONNECTED", 400, "Timeline is not connected", null],
    ["TIMELINE_CREDENTIAL_INVALID", 422, "Timeline credential is invalid", null],
    ["TIMELINE_PLAN_RESTRICTED", 422, "Timeline access is restricted", null],
    ["TIMELINE_RATE_LIMITED", 429, "Timeline source is rate limited", 17],
    ["TIMELINE_RESPONSE_INVALID", 502, "Timeline source returned an invalid response", null],
    ["TIMELINE_UPSTREAM_UNAVAILABLE", 503, "Timeline source is unavailable", null],
    ["TIMELINE_MANAGED_DISABLED", 503, "Managed timeline is unavailable", null],
  ] as const)("maps %s to a redacted %i response", async (code, status, message, retry) => {
    const { TimelineConnectionError } = await import(
      "../../services/dawarich/connection-service.js"
    );
    vi.mocked(service.testConnection).mockRejectedValueOnce(
      new TimelineConnectionError(code, retry),
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/timeline/connection/test",
    });

    expect(response.statusCode).toBe(status);
    expect(response.json()).toEqual({
      error: message,
      code,
      ...(retry === null ? {} : { retryAfterSeconds: retry }),
    });
    if (retry !== null) expect(response.headers["retry-after"]).toBe(String(retry));
    expect(response.payload).not.toMatch(/secret|stack|Bearer/i);
    expectNoStore(response);
  });

  it("keeps the previous safe view available after a failed replacement", async () => {
    const { TimelineConnectionError } = await import(
      "../../services/dawarich/connection-service.js"
    );
    vi.mocked(service.connect).mockRejectedValueOnce(
      new TimelineConnectionError("TIMELINE_CREDENTIAL_INVALID"),
    );
    const failed = await app.inject({
      method: "PUT",
      url: "/api/timeline/connection",
      payload: {
        mode: "external",
        instanceUrl: "https://new.example.test",
        apiKey: "rejected-secret",
      },
    });
    const current = await app.inject({ method: "GET", url: "/api/timeline/connection" });

    expect(failed.statusCode).toBe(422);
    expect(failed.payload).not.toContain("rejected-secret");
    expect(current.json()).toEqual(CONNECTED_VIEW);
    expectNoStore(failed);
    expectNoStore(current);
  });
});

describe("timeline test and disconnect", () => {
  it("tests the authenticated user's connection", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/timeline/connection/test",
    });
    expect(response.statusCode).toBe(200);
    expect(service.testConnection).toHaveBeenCalledWith(USER_ID);
    expect(response.json()).toEqual(CONNECTED_VIEW);
    expectNoStore(response);
  });

  it("deletes idempotently and returns only ok", async () => {
    for (let index = 0; index < 2; index += 1) {
      const response = await app.inject({ method: "DELETE", url: "/api/timeline/connection" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true });
      expectNoStore(response);
    }
    expect(service.deleteConnection).toHaveBeenNthCalledWith(1, USER_ID);
    expect(service.deleteConnection).toHaveBeenNthCalledWith(2, USER_ID);
  });
});
