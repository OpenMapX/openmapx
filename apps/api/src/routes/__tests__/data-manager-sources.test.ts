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
  await app.close();
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
        { status: 202 },
      ),
    );
    const response = await app.inject({
      method: "POST",
      url: "/data-manager/transit/sources",
      headers: { authorization: "Bearer service-token" },
      payload: {
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

  it("propagates a conflict without writing a successful-mutation audit", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ reason: "in-flight", existingJobId: "running-job" }), {
        status: 409,
      }),
    );
    const response = await app.inject({
      method: "DELETE",
      url: "/data-manager/transit/sources/catalog%3Ade%3Avbb",
      headers: { authorization: "Bearer service-token" },
      payload: {},
    });
    expect(response.statusCode).toBe(409);
    expect(audit).not.toHaveBeenCalled();
  });
});
