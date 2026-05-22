import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../auth", () => ({
  auth: {
    api: {
      getSession: vi.fn().mockResolvedValue(null),
    },
  },
}));

vi.mock("../../db/index.js", () => {
  const builder: Record<string, unknown> = {};
  Object.assign(builder, {
    from: () => builder,
    where: () => builder,
    orderBy: () => builder,
    limit: () => builder,
    offset: () => builder,
    groupBy: () => builder,
    // biome-ignore lint/suspicious/noThenProperty: drizzle builders are thenable; the stub must mirror that.
    then: (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
      Promise.resolve([]).then(onFulfilled, onRejected),
  });
  return {
    db: { select: () => builder },
    sql: {},
  };
});

const fetchMock = vi.hoisted(() => vi.fn());

beforeAll(() => {
  process.env.DATA_MANAGER_AUTH_TOKEN = "service-token";
  process.env.DATA_MANAGER_URL = "http://data-manager.test:4000";
  vi.stubGlobal("fetch", fetchMock);
});

let app: FastifyInstance;

beforeAll(async () => {
  const { dataManagerRoute } = await import("../data-manager.js");
  app = Fastify({ logger: false });
  await app.register(dataManagerRoute);
  await app.ready();
});

beforeEach(() => {
  fetchMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /data-manager/transit/sync", () => {
  it("rejects unauthenticated requests with 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/data-manager/transit/sync",
      payload: {},
    });
    expect(res.statusCode).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("proxies to data-manager and forwards the 202 response under bearer auth", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true, jobId: "job-xyz", status: "started" }), {
        status: 202,
        headers: { "content-type": "application/json" },
      }),
    );

    const res = await app.inject({
      method: "POST",
      url: "/data-manager/transit/sync",
      headers: { authorization: "Bearer service-token" },
      payload: { idempotencyKey: "abc-123" },
    });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ ok: true, jobId: "job-xyz", status: "started" });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://data-manager.test:4000/transit/sync",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer service-token",
        }),
      }),
    );
    const args = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(args.body as string)).toMatchObject({
      idempotencyKey: "abc-123",
      triggeredBy: "service-token",
    });
  });

  it("propagates 409 from data-manager when a sync is already in flight", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ ok: false, reason: "in-flight", existingJobId: "running-job" }),
        { status: 409, headers: { "content-type": "application/json" } },
      ),
    );

    const res = await app.inject({
      method: "POST",
      url: "/data-manager/transit/sync",
      headers: { authorization: "Bearer service-token" },
      payload: {},
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      ok: false,
      reason: "in-flight",
      existingJobId: "running-job",
    });
  });
});
