import type { PersonalTimelineDayV1 } from "@openmapx/core";
import { httpError } from "@openmapx/integration-framework";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTestApp } from "../../test/app.js";
import { mockRequireAuth } from "../../test/auth.js";

const USER_ID = "timeline-day-user";
const authMock = mockRequireAuth(USER_ID);

vi.mock("../../utils/require-auth.js", () => authMock);

const DAY: PersonalTimelineDayV1 = {
  version: 1,
  date: "2026-08-09",
  timeZone: "Europe/Berlin",
  distanceUnit: "km",
  summary: { totalDistance: 2, placesVisited: 1, movingMinutes: 10, stationaryMinutes: 20 },
  bounds: [12, 45, 13, 46],
  entries: [],
  map: {
    tracks: { type: "FeatureCollection", features: [] },
    visits: { type: "FeatureCollection", features: [] },
  },
  capabilities: { trackGeometry: false, elevation: false },
  warnings: [],
};

let app: FastifyInstance;
let service: typeof import("../../services/dawarich/day-service.js").timelineDayService;

beforeEach(async () => {
  const serviceModule = await import("../../services/dawarich/day-service.js");
  service = serviceModule.timelineDayService;
  vi.spyOn(service, "getPersonalTimelineDay").mockResolvedValue(DAY);
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
  expect(response.headers.pragma).toBe("no-cache");
  expect(response.headers.vary).toContain("Cookie");
}

describe("GET /api/timeline/day/:date", () => {
  it("requires authentication before reading a day", async () => {
    authMock.requireAuthHook.mockRejectedValueOnce(httpError(401, "Authentication required"));

    const response = await app.inject({ method: "GET", url: "/api/timeline/day/2026-08-09" });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "Authentication required", code: "UNAUTHORIZED" });
    expect(service.getPersonalTimelineDay).not.toHaveBeenCalled();
    expectNoStore(response);
  });

  it.each(["2026-8-09", "2026-02-30", "2026-08-09T00:00:00Z"])(
    "rejects invalid calendar date %s without calling the service",
    async (date) => {
      const response = await app.inject({
        method: "GET",
        url: `/api/timeline/day/${encodeURIComponent(date)}`,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: "Invalid timeline date",
        code: "TIMELINE_RESPONSE_INVALID",
      });
      expect(service.getPersonalTimelineDay).not.toHaveBeenCalled();
      expectNoStore(response);
    },
  );

  it("scopes the read to the authenticated user and serializes only the normalized day", async () => {
    const response = await app.inject({ method: "GET", url: "/api/timeline/day/2026-08-09" });

    expect(response.statusCode).toBe(200);
    expect(service.getPersonalTimelineDay).toHaveBeenCalledWith(USER_ID, "2026-08-09");
    expect(response.json()).toEqual(DAY);
    expect(response.payload).not.toMatch(/apiKey|Bearer|encrypted|upstream body/i);
    expectNoStore(response);
  });

  it("keeps the requested calendar date out of automatic request logs", async () => {
    let logOutput = "";
    const loggedApp = Fastify({
      logger: {
        level: "info",
        stream: { write: (chunk: string) => (logOutput += chunk) },
      },
    });
    const { timelineRoute } = await import("../timeline.js");
    await loggedApp.register(timelineRoute, { prefix: "/api" });
    await loggedApp.ready();

    const response = await loggedApp.inject({
      method: "GET",
      url: "/api/timeline/day/2026-08-09",
    });
    await loggedApp.close();

    expect(response.statusCode).toBe(200);
    expect(logOutput).not.toContain("2026-08-09");
  });

  it.each([
    ["TIMELINE_NOT_CONNECTED", 404, "Timeline is not connected", null],
    ["TIMELINE_MANAGED_DISABLED", 409, "Managed timeline is unavailable", null],
    ["TIMELINE_CREDENTIAL_INVALID", 422, "Timeline credential is invalid", null],
    ["TIMELINE_INSTANCE_UNSUPPORTED", 422, "Timeline instance is not supported", null],
    ["TIMELINE_PLAN_RESTRICTED", 422, "Timeline access is restricted", null],
    ["TIMELINE_RATE_LIMITED", 429, "Timeline source is rate limited", 17],
    ["TIMELINE_RESPONSE_INVALID", 502, "Timeline source returned an invalid response", null],
    ["TIMELINE_UPSTREAM_UNAVAILABLE", 503, "Timeline source is unavailable", null],
  ] as const)("maps %s to a redacted no-store %i", async (code, status, message, retry) => {
    const { TimelineConnectionError } = await import(
      "../../services/dawarich/connection-service.js"
    );
    vi.mocked(service.getPersonalTimelineDay).mockRejectedValueOnce(
      new TimelineConnectionError(code, retry),
    );

    const response = await app.inject({ method: "GET", url: "/api/timeline/day/2026-08-09" });

    expect(response.statusCode).toBe(status);
    expect(response.json()).toEqual({
      error: message,
      code,
      ...(retry === null ? {} : { retryAfterSeconds: retry }),
    });
    if (retry === null) expect(response.headers["retry-after"]).toBeUndefined();
    else expect(response.headers["retry-after"]).toBe(String(retry));
    expect(response.payload).not.toMatch(/secret|stack|Bearer|upstream detail/i);
    expectNoStore(response);
  });

  it.each([-1, 1.5, 86_401, Number.POSITIVE_INFINITY])(
    "omits unsafe retry delay %s",
    async (retryAfterSeconds) => {
      const { TimelineConnectionError } = await import(
        "../../services/dawarich/connection-service.js"
      );
      vi.mocked(service.getPersonalTimelineDay).mockRejectedValueOnce(
        new TimelineConnectionError("TIMELINE_RATE_LIMITED", retryAfterSeconds),
      );

      const response = await app.inject({ method: "GET", url: "/api/timeline/day/2026-08-09" });

      expect(response.statusCode).toBe(429);
      expect(response.json()).toEqual({
        error: "Timeline source is rate limited",
        code: "TIMELINE_RATE_LIMITED",
      });
      expect(response.headers["retry-after"]).toBeUndefined();
      expectNoStore(response);
    },
  );

  it("redacts unexpected service errors", async () => {
    vi.mocked(service.getPersonalTimelineDay).mockRejectedValueOnce(
      new Error("raw upstream detail and secret"),
    );

    const response = await app.inject({ method: "GET", url: "/api/timeline/day/2026-08-09" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: "Timeline source is unavailable",
      code: "TIMELINE_UPSTREAM_UNAVAILABLE",
    });
    expect(response.payload).not.toMatch(/raw upstream|secret/);
    expectNoStore(response);
  });
});
