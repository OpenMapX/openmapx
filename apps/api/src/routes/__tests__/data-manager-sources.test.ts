import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../auth", () => ({ auth: { api: { getSession: vi.fn().mockResolvedValue(null) } } }));
vi.mock("../../db/index.js", () => {
  const builder: Record<string, unknown> = {};
  Object.assign(builder, {
    from: () => builder,
    where: () => builder,
    orderBy: () => builder,
    limit: () => builder,
    offset: () => builder,
    groupBy: () => builder,
    // biome-ignore lint/suspicious/noThenProperty: drizzle builders are thenable.
    then: (resolve: (value: unknown) => unknown) => Promise.resolve([]).then(resolve),
  });
  return { db: { select: () => builder }, sql: {} };
});
vi.mock("../../services/transit-catalog/index.js", () => ({
  searchTransitCatalog: vi.fn(async () => []),
}));
const audit = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../../utils/audit-log.js", () => ({ writeAuditLog: audit }));

const fetchMock = vi.hoisted(() => vi.fn());
let app: FastifyInstance;

beforeAll(async () => {
  process.env.DATA_MANAGER_AUTH_TOKEN = "service-token";
  process.env.DATA_MANAGER_URL = "https://data-manager.test:4000";
  vi.stubGlobal("fetch", fetchMock);
  const { dataManagerRoute } = await import("../data-manager.js");
  app = Fastify({ logger: false });
  await app.register(dataManagerRoute);
  await app.ready();
});

beforeEach(() => {
  fetchMock.mockReset();
  audit.mockClear();
});

afterAll(async () => {
  await app?.close();
  vi.unstubAllGlobals();
});

describe("transit source proxy", () => {
  it("rejects unauthenticated source mutations", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/data-manager/transit/sources",
      payload: {},
    });
    expect(response.statusCode).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards an accepted mutation and audits its visible Activity job", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          jobId: "job-visible",
          sourceId: "operator:de:demo",
          status: "started",
        }),
        { status: 202, headers: { "content-type": "application/json" } },
      ),
    );
    const response = await app.inject({
      method: "POST",
      url: "/data-manager/transit/sources",
      headers: { authorization: "Bearer service-token" },
      payload: {
        expectedSourceRevision: "a".repeat(64),
        region: "de",
        name: "demo",
        url: "https://example.test/demo.zip",
        license: { spdxIdentifier: "CC0-1.0", attribution: "Demo" },
      },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ jobId: "job-visible" });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "transit.source.add",
        targetId: "operator:de:demo",
        details: { jobId: "job-visible" },
      }),
    );
  });

  it("forwards Disable as its own encoded mutation with the original revision and identity", async () => {
    fetchMock.mockImplementation(async (url, init) => {
      expect(String(url)).toBe(
        "https://data-manager.test:4000/transit/sources/operator%3Ade%3Alocal/disable",
      );
      expect(JSON.parse(init.body)).toEqual({
        expectedSourceRevision: "a".repeat(64),
        idempotencyKey: "source-disable-fixture",
        triggeredBy: "service-token",
      });
      return Response.json(
        { jobId: "disable-job", sourceId: "operator:de:local", status: "started" },
        { status: 202 },
      );
    });
    const result = await app.inject({
      method: "POST",
      url: "/data-manager/transit/sources/operator%3Ade%3Alocal/disable",
      headers: { authorization: "Bearer service-token" },
      payload: { expectedSourceRevision: "a".repeat(64), idempotencyKey: "source-disable-fixture" },
    });
    expect(result.statusCode, result.body).toBe(202);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "transit.source.disable",
        details: { jobId: "disable-job" },
      }),
    );
  });
  it("preserves unavailable-action codes without a successful removal audit", async () => {
    fetchMock.mockResolvedValue(
      Response.json(
        {
          ok: false,
          error: "Catalog sources cannot be removed",
          code: "source_action_not_allowed",
        },
        { status: 409 },
      ),
    );
    const result = await app.inject({
      method: "DELETE",
      url: "/data-manager/transit/sources/catalog%3Ade%3Alocal",
      headers: { authorization: "Bearer service-token" },
      payload: { expectedSourceRevision: "a".repeat(64) },
    });
    expect(result.statusCode, result.body).toBe(409);
    expect(result.json()).toMatchObject({ code: "source_action_not_allowed" });
    expect(audit).not.toHaveBeenCalled();
  });
  it("propagates a conflict without writing a successful-mutation audit", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ ok: false, reason: "in-flight", existingJobId: "running-job" }),
        {
          status: 409,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    const response = await app.inject({
      method: "DELETE",
      url: "/data-manager/transit/sources/catalog%3Ade%3Avbb",
      headers: { authorization: "Bearer service-token" },
      payload: { expectedSourceRevision: "a".repeat(64) },
    });
    expect(response.statusCode).toBe(409);
    expect(audit).not.toHaveBeenCalled();
  });
});
