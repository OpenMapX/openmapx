import { createApiClient } from "@openmapx/core";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeRateLimitTierHook } from "../../server-wiring";
import { makeCsrfGuardHook } from "../../utils/csrf";
import { RateLimiter } from "../../utils/rate-limit";
import { createAdminTestApp, installAdminRouteMocks } from "./admin-test-helpers";
import { administrationSdkFetch } from "./helpers/administration-sdk-fetch";

const mocks = installAdminRouteMocks();
const list = vi.fn();
const detail = vi.fn();
const cancel = vi.fn();
const cancelData = vi.fn();
vi.mock("../../services/activity-jobs", () => ({
  listActivityJobs: (...args: unknown[]) => list(...args),
  getActivityJob: (...args: unknown[]) => detail(...args),
  cancelDataManagerActivityJob: (...args: unknown[]) => cancelData(...args),
}));
vi.mock("../../services/job-runner", () => ({
  jobRunner: { cancel: (...args: unknown[]) => cancel(...args) },
}));
const { adminActivityRoute } = await import("../admin-activity");

function activityDetail(source = "application") {
  const date = new Date("2026-10-19T10:00:00.000Z");
  return {
    source,
    id: "job-1",
    type: "operation",
    status: source === "application" ? "running" : "partial",
    payload: { nested: [null, { extra: true }] },
    result: { nested: [42] },
    error: null,
    progress: 4,
    createdBy: "actor",
    actorLabel: "Administrator",
    createdAt: date,
    startedAt: date,
    finishedAt: null,
    cancelable: source === "application",
    logs: [{ id: "log", jobId: "job-1", seq: 1, stream: "stderr", line: "hello", createdAt: date }],
    stages:
      source === "application"
        ? []
        : [
            {
              id: "stage",
              jobId: "job-1",
              stage: "download",
              status: "partial",
              startedAt: date,
              finishedAt: date,
              durationMs: 4,
              message: null,
              error: { code: 1 },
              artifacts: ["a"],
            },
          ],
  };
}

beforeEach(() => {
  vi.stubGlobal("fetch", () => {
    throw new Error("Network denied");
  });
  list.mockReset().mockResolvedValue({ jobs: [], total: 0 });
  detail.mockReset().mockResolvedValue(null);
  cancel.mockReset().mockResolvedValue(true);
  cancelData.mockReset().mockResolvedValue(false);
});
afterEach(() => vi.unstubAllGlobals());

describe("Activity canonical producer", () => {
  it("parses bounded defaults and rejects malformed queries before domain work", async () => {
    const app = await createAdminTestApp(adminActivityRoute);
    try {
      expect((await app.inject("/admin/jobs")).statusCode).toBe(200);
      expect(list).toHaveBeenLastCalledWith({ filter: undefined, limit: 50, offset: 0 });
      for (const query of [
        "limit=0",
        "limit=201",
        "limit=1x",
        "offset=-1",
        "offset=1.5",
        "limit=2&limit=3",
        "status=running",
      ]) {
        expect((await app.inject(`/admin/jobs?${query}`)).statusCode, query).toBe(400);
      }
      expect(list).toHaveBeenCalledTimes(1);
      expect((await app.inject("/admin/jobs/id?source=bad")).statusCode).toBe(400);
      expect(detail).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it("runs the inherited admin guard before contract parsing", async () => {
    const app = await createAdminTestApp(adminActivityRoute);
    try {
      for (const statusCode of [401, 403]) {
        mocks.requireAdmin.mockRejectedValueOnce(
          Object.assign(new Error("Denied"), { statusCode }),
        );
        const res = await app.inject("/admin/jobs?limit=secret");
        expect(res.statusCode).toBe(statusCode);
        expect(res.body).not.toContain("administration query");
      }
      expect(list).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it.each(["application", "data-manager"])(
    "preserves full %s detail JSON and Date fields",
    async (source) => {
      const app = await createAdminTestApp(adminActivityRoute);
      const job = activityDetail(source);
      detail.mockResolvedValue(job);
      try {
        const res = await app.inject(`/admin/jobs/job-1?source=${source}`);
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual(JSON.parse(JSON.stringify(job)));
      } finally {
        await app.close();
      }
    },
  );
  it("retains cancellation audit, rejection and real cookie CSRF guard", async () => {
    const app = Fastify();
    app.addHook("preHandler", makeCsrfGuardHook(["https://app.test"]));
    await app.register(adminActivityRoute, { prefix: "/api" });
    try {
      const blocked = await app.inject({
        method: "POST",
        url: "/api/admin/jobs/job-1/cancel",
        headers: { cookie: "session=fake", origin: "https://evil.test" },
      });
      expect(blocked.statusCode).toBe(403);
      expect(cancel).not.toHaveBeenCalled();
      const accepted = await app.inject({
        method: "POST",
        url: "/api/admin/jobs/job-1/cancel",
        headers: { cookie: "session=fake", origin: "https://app.test" },
      });
      expect(accepted.statusCode).toBe(200);
      expect(accepted.json()).toEqual({ ok: true });
      expect(mocks.writeAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "job.cancel",
          targetId: "job-1",
          actorId: mocks.session.user.id,
        }),
      );
      cancel.mockResolvedValue(false);
      expect(
        (await app.inject({ method: "POST", url: "/api/admin/jobs/job-1/cancel" })).statusCode,
      ).toBe(400);
      cancel.mockClear();
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/admin/jobs/job-1/cancel?source=data-manager",
          })
        ).statusCode,
      ).toBe(400);
      expect(cancel).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it("returns canonical missing, exception and malformed-output errors", async () => {
    const app = await createAdminTestApp(adminActivityRoute);
    try {
      expect((await app.inject("/admin/jobs/missing")).statusCode).toBe(404);
      list.mockRejectedValueOnce(new Error("Domain failed"));
      expect((await app.inject("/admin/jobs")).json()).toMatchObject({
        statusCode: 500,
        message: "Domain failed",
      });
      detail.mockResolvedValue({ ...activityDetail(), secret: "must-not-leak" });
      const res = await app.inject("/admin/jobs/job-1");
      expect(res.statusCode).toBe(500);
      expect(res.body).not.toContain("must-not-leak");
    } finally {
      await app.close();
    }
  });
});

describe("actual generated Activity SDK through Fastify serialization", () => {
  it("retains full list actor, both details, metrics, cancellation and native stream target", async () => {
    const sdk = await import("@openmapx/core/api-admin-sdk");
    expect(sdk.listAdminActivityJobs).toBeTypeOf("function");
    const { adminJobEventsRoute } = await import("../admin-job-events");
    const app = Fastify();
    await app.register(adminActivityRoute, { prefix: "/api" });
    await app.register(adminJobEventsRoute, { prefix: "/api" });
    const transport = administrationSdkFetch(app);
    const fetch = vi.fn<typeof globalThis.fetch>((input, init) => {
      if (new URL(String(input)).origin !== "https://app.test") throw new Error("Network denied");
      return transport(input, init);
    });
    vi.stubGlobal("fetch", fetch);
    const client = createApiClient({ baseUrl: "https://app.test", credentials: "include" });
    try {
      const { result: _result, logs: _logs, stages: _stages, ...row } = activityDetail();
      const actor = { id: "actor", name: "Admin", email: "admin@example.test" };
      list.mockResolvedValue({ jobs: [{ ...row, actor }], total: 1 });
      expect(await sdk.listAdminActivityJobs(undefined, { client })).toMatchObject({
        status: 200,
        data: { jobs: [{ ...JSON.parse(JSON.stringify(row)), actor }], total: 1 },
      });
      for (const source of ["application", "data-manager"] as const) {
        const job = activityDetail(source);
        detail.mockResolvedValue(job);
        expect(await sdk.getAdminActivityJob("job-1", { source }, { client })).toMatchObject({
          status: 200,
          data: JSON.parse(JSON.stringify(job)),
        });
      }
      expect(await sdk.cancelAdminActivityJob("job-1", undefined, { client })).toMatchObject({
        status: 200,
        data: { ok: true },
      });
      expect(await sdk.getAdminActivityJobStreamMetrics({ client })).toMatchObject({
        status: 200,
        data: { activeStreams: 0, handlerDurations: { count: expect.any(Number) } },
      });
      const acquisitions = fetch.mock.calls.length;
      expect(
        await sdk.streamAdminActivityJobEvents("source/id", { cursor: 2 }, { client }),
      ).toEqual({
        url: "https://app.test/api/admin/jobs/source%2Fid/events?cursor=2",
        withCredentials: true,
      });
      expect(fetch).toHaveBeenCalledTimes(acquisitions);
    } finally {
      await app.close();
    }
  });
  it("sends supported data cancellation through the authenticated receiver and audits its distinct identity", async () => {
    cancelData.mockResolvedValueOnce(true);
    const app = await createAdminTestApp(adminActivityRoute);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/admin/jobs/durable-data-id/cancel?source=data-manager",
      });
      expect(response.statusCode).toBe(200);
      expect(cancelData).toHaveBeenCalledWith("durable-data-id");
      expect(cancel).not.toHaveBeenCalled();
      expect(mocks.writeAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          targetId: "durable-data-id",
          targetType: "data-manager-job",
          action: "job.cancel",
        }),
      );
    } finally {
      await app.close();
    }
  });
  it("validates actual 400/401/403/404/429/500 JSON and Retry-After", async () => {
    const sdk = await import("@openmapx/core/api-admin-sdk");
    expect(sdk.listAdminActivityJobs).toBeTypeOf("function");
    const app = Fastify();
    await app.register(adminActivityRoute, { prefix: "/api" });
    vi.stubGlobal("fetch", administrationSdkFetch(app));
    const client = createApiClient({ baseUrl: "https://app.test", credentials: "include" });
    try {
      for (const statusCode of [401, 403]) {
        mocks.requireAdmin.mockRejectedValueOnce(
          Object.assign(new Error("Denied"), { statusCode }),
        );
        expect(await sdk.listAdminActivityJobs(undefined, { client })).toMatchObject({
          status: statusCode,
          data: { statusCode, message: "Denied" },
        });
      }
      expect(
        await sdk.cancelAdminActivityJob("job-1", { source: "data-manager" }, { client }),
      ).toMatchObject({
        status: 400,
        data: { error: "Job cannot be canceled (not running or queued)" },
      });
      expect(await sdk.getAdminActivityJob("missing", undefined, { client })).toMatchObject({
        status: 404,
        data: { error: "Job not found" },
      });
      list.mockRejectedValueOnce(new Error("Domain failed"));
      expect(await sdk.listAdminActivityJobs(undefined, { client })).toMatchObject({
        status: 500,
        data: { statusCode: 500, message: "Domain failed" },
      });
    } finally {
      await app.close();
    }
    const limitedApp = Fastify();
    const limiter = new RateLimiter({ max: 1, windowMs: 60_000 });
    const unexpectedTier = async () => {
      throw new Error("Wrong rate tier");
    };
    limitedApp.addHook(
      "onRequest",
      makeRateLimitTierHook({
        auth: unexpectedTier,
        tile: unexpectedTier,
        expensive: unexpectedTier,
        integrationIngress: unexpectedTier,
        status: unexpectedTier,
        public: limiter.preHandler(),
      }),
    );
    await limitedApp.register(adminActivityRoute, { prefix: "/api" });
    vi.stubGlobal("fetch", administrationSdkFetch(limitedApp, { remoteAddress: "198.51.100.7" }));
    try {
      expect((await sdk.listAdminActivityJobs(undefined, { client })).status).toBe(200);
      const limited = await sdk.listAdminActivityJobs(undefined, { client });
      expect(limited).toMatchObject({
        status: 429,
        data: { error: "Too many requests", retryAfter: expect.any(Number) },
      });
      expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    } finally {
      await limitedApp.close();
      limiter.destroy();
    }
  });
});

it("serializes retained failure and observation evidence through the actual SDK and rejects internal ownership", async () => {
  const { getAdminActivityJob } = await import("@openmapx/core/api-admin-sdk");
  const app = await createAdminTestApp(adminActivityRoute);
  try {
    const evidence = {
      serviceBatch: {
        outcome: "partial",
        completedServiceIds: ["tileserver"],
        failedServiceIds: ["valhalla"],
        skippedServiceIds: [],
      },
      diagnostics: { truncated: false, tail: [{ stream: "stderr", message: "final diagnostic" }] },
      observation: {
        state: "unknown",
        reason: "recovery_required",
        nextCheckAt: "2026-10-23T20:00:00.000Z",
      },
    };
    detail.mockResolvedValue({ ...activityDetail(), status: "cancel_pending", result: evidence });
    const response = await app.inject("/admin/jobs/job-1");
    expect(response.statusCode).toBe(200);
    expect(response.json().result).toEqual(evidence);
    // The generated JSON result decoder must preserve this same producer shape.
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(response.body, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = createApiClient({ baseUrl: "http://api.test" });
    expect(await getAdminActivityJob("job-1", {}, { client })).toMatchObject({
      data: { result: evidence },
    });
    detail.mockResolvedValue({
      ...activityDetail(),
      result: { _execution: { owner: "private", version: 1 } },
    });
    const rejected = await app.inject("/admin/jobs/job-1");
    expect(rejected.statusCode).toBe(500);
    expect(rejected.body).not.toContain("private");
  } finally {
    await app.close();
  }
});

it.each([401, 403])(
  "denies detail/cancel before any domain call for guard status %s",
  async (statusCode) => {
    const app = await createAdminTestApp(adminActivityRoute);
    try {
      for (const [method, url] of [
        ["GET", "/admin/jobs/job-1"],
        ["POST", "/admin/jobs/job-1/cancel"],
      ] as const) {
        mocks.requireAdmin.mockRejectedValueOnce(
          Object.assign(new Error("Denied"), { statusCode }),
        );
        expect((await app.inject({ method, url })).statusCode).toBe(statusCode);
      }
      expect(detail).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  },
);
