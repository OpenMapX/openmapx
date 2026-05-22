import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const fakeDb = vi.hoisted(() => ({
  feeds: [] as Array<Record<string, unknown>>,
  totalCount: 0,
  lastQuery: { limit: 0, offset: 0 },
  callIndex: 0,
}));

vi.mock("../../auth", () => ({
  auth: {
    api: {
      getSession: vi.fn().mockResolvedValue(null),
    },
  },
}));

vi.mock("../../db/index.js", () => {
  function makeBuilder(resolveTo: () => unknown) {
    const captured = { limit: 100, offset: 0 };
    const self = {
      from() {
        return self;
      },
      where() {
        return self;
      },
      orderBy() {
        return self;
      },
      limit(n: number) {
        captured.limit = n;
        fakeDb.lastQuery = { ...captured };
        return self;
      },
      offset(n: number) {
        captured.offset = n;
        fakeDb.lastQuery = { ...captured };
        return self;
      },
      groupBy() {
        return self;
      },
      // biome-ignore lint/suspicious/noThenProperty: drizzle builders are thenable; the stub must mirror that.
      then(onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) {
        return Promise.resolve(resolveTo()).then(onFulfilled, onRejected);
      },
    };
    return self;
  }

  return {
    db: {
      select() {
        const idx = fakeDb.callIndex++;
        // Feeds route: idx 0 = feeds list, idx 1 = total count.
        if (idx === 0) return makeBuilder(() => fakeDb.feeds);
        return makeBuilder(() => [{ total: fakeDb.totalCount }]);
      },
    },
    sql: {},
  };
});

let app: FastifyInstance;

beforeAll(async () => {
  process.env.DATA_MANAGER_AUTH_TOKEN = "test-token";
  const { dataManagerRoute } = await import("../data-manager.js");
  app = Fastify({ logger: false });
  await app.register(dataManagerRoute);
  await app.ready();
});

beforeEach(() => {
  fakeDb.callIndex = 0;
  fakeDb.feeds = [];
  fakeDb.totalCount = 0;
  fakeDb.lastQuery = { limit: 0, offset: 0 };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /data-manager/transit/feeds", () => {
  it("returns paginated feed_state rows", async () => {
    fakeDb.feeds = [
      {
        id: "uuid-1",
        region: "de",
        name: "delfi",
        lastFetchedAt: new Date("2026-05-21T03:00:00.000Z"),
        lastImportedAt: new Date("2026-05-21T03:30:00.000Z"),
        hash: "abc123",
        validationStatus: "ok",
        validationMessage: null,
        status: "active",
      },
    ];
    fakeDb.totalCount = 87;

    const res = await app.inject({
      method: "GET",
      url: "/data-manager/transit/feeds?region=de&status=active&limit=10&offset=20",
      headers: { authorization: "Bearer test-token" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.limit).toBe(10);
    expect(body.offset).toBe(20);
    expect(body.total).toBe(87);
    expect((body.feeds as unknown[]).length).toBe(1);
    const first = (body.feeds as Array<Record<string, unknown>>)[0];
    expect(first.region).toBe("de");
    expect(first.lastFetchedAt).toBe("2026-05-21T03:00:00.000Z");
    expect(fakeDb.lastQuery).toEqual({ limit: 10, offset: 20 });
  });

  it("defaults pagination to limit=100 offset=0", async () => {
    fakeDb.feeds = [];
    fakeDb.totalCount = 0;
    const res = await app.inject({
      method: "GET",
      url: "/data-manager/transit/feeds",
      headers: { authorization: "Bearer test-token" },
    });
    expect(res.statusCode).toBe(200);
    expect(fakeDb.lastQuery).toEqual({ limit: 100, offset: 0 });
  });

  it("rejects unauthenticated requests with 401", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/data-manager/transit/feeds",
    });
    expect(res.statusCode).toBe(401);
  });
});
