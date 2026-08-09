import type { PersonalTimelineDayV1 } from "@openmapx/core";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authMock = vi.hoisted(() => ({
  requireAuthHook: vi.fn(async (request: FastifyRequest) => {
    const userId = request.headers["x-test-user"];
    if (typeof userId !== "string" || !userId) {
      throw Object.assign(new Error("Authentication required"), { statusCode: 401 });
    }
    (request as FastifyRequest & { userId?: string }).userId = userId;
  }),
  getUserId: vi.fn((request: FastifyRequest) => {
    const userId = (request as FastifyRequest & { userId?: string }).userId;
    if (!userId) throw new Error("Missing authenticated user");
    return userId;
  }),
}));

vi.mock("../../utils/require-auth.js", () => authMock);

const DAY: PersonalTimelineDayV1 = {
  version: 1,
  date: "2026-08-09",
  timeZone: "Etc/UTC",
  distanceUnit: "km",
  summary: { totalDistance: 0, placesVisited: 0, movingMinutes: 0, stationaryMinutes: 0 },
  bounds: null,
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
  vi.resetModules();
  vi.stubEnv("RATE_LIMIT_EXPENSIVE_MAX", "1");
  vi.stubEnv("RATE_LIMIT_EXPENSIVE_WINDOW_MS", String(2 * 86_400_000));
  const serviceModule = await import("../../services/dawarich/day-service.js");
  service = serviceModule.timelineDayService;
  vi.spyOn(service, "getPersonalTimelineDay").mockResolvedValue(DAY);
  const { timelineRoute } = await import("../timeline.js");
  app = Fastify({ logger: false });
  await app.register(timelineRoute, { prefix: "/api" });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("timeline day per-user rate limit", () => {
  it("runs after auth, isolates users on one IP, and returns a stable private 429", async () => {
    const request = (userId?: string) => ({
      method: "GET" as const,
      url: "/api/timeline/day/2026-08-09",
      remoteAddress: "198.51.100.44",
      headers: userId ? { "x-test-user": userId } : {},
    });

    const unauthenticated = await app.inject(request());
    const userAFirst = await app.inject(request("user-a"));
    const userAExhausted = await app.inject(request("user-a"));
    const userBFirst = await app.inject(request("user-b"));

    expect(unauthenticated.statusCode).toBe(401);
    expect(userAFirst.statusCode).toBe(200);
    expect(userAExhausted.statusCode).toBe(429);
    expect(userAExhausted.json()).toEqual({
      error: "Timeline source is rate limited",
      code: "TIMELINE_RATE_LIMITED",
      retryAfterSeconds: 86_400,
    });
    expect(userAExhausted.headers["retry-after"]).toBe("86400");
    expect(userAExhausted.headers["cache-control"]).toBe("private, no-store");
    expect(userAExhausted.headers.pragma).toBe("no-cache");
    expect(userAExhausted.headers.vary).toContain("Cookie");
    expect(userBFirst.statusCode).toBe(200);
    expect(service.getPersonalTimelineDay).toHaveBeenCalledTimes(2);
    expect(service.getPersonalTimelineDay).toHaveBeenNthCalledWith(1, "user-a", "2026-08-09");
    expect(service.getPersonalTimelineDay).toHaveBeenNthCalledWith(2, "user-b", "2026-08-09");
  });
});
