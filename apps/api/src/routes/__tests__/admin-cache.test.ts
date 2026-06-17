import { Readable } from "node:stream";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mockAdminSession } from "./admin-test-helpers.js";

// Auth guard mock — all three exports required.
const fakeSession = mockAdminSession();
const mockRequireAdmin = vi.fn().mockResolvedValue(fakeSession);
const mockGetAdminSession = vi.fn().mockReturnValue(fakeSession);
const mockTryAdminSession = vi.fn().mockResolvedValue(fakeSession);

vi.mock("../../utils/require-admin.js", () => ({
  requireAdmin: (...args: unknown[]) => mockRequireAdmin(...args),
  getAdminSession: (...args: unknown[]) => mockGetAdminSession(...args),
  tryAdminSession: (...args: unknown[]) => mockTryAdminSession(...args),
}));

// Audit log.
const mockWriteAuditLog = vi.fn().mockResolvedValue(undefined);
vi.mock("../../utils/audit-log.js", () => ({
  writeAuditLog: (...args: unknown[]) => mockWriteAuditLog(...args),
}));

// Fake Redis. `scanStream` returns a stream emitting one array of the keys
// whose name matches the requested glob prefix. `flushdb` is a spy so the
// "never wipes the whole DB" guarantee is assertable.
const cacheStore = new Map<string, string>([
  ["int:geocoding:a", "1"],
  ["int:geocoding:b", "1"],
  ["int:routing:c", "1"],
  ["cache:geocode:d", "1"],
  ["session:user:1", "1"], // NOT app-owned — must never be touched.
]);

function prefixFromGlob(match: string): string {
  return match.endsWith("*") ? match.slice(0, -1) : match;
}

const mockScanStream = vi.fn((opts: { match: string }) => {
  const prefix = prefixFromGlob(opts.match);
  const keys = [...cacheStore.keys()].filter((k) => k.startsWith(prefix));
  return Readable.from([keys]);
});

const mockUnlink = vi.fn((...keys: string[]) => {
  let removed = 0;
  for (const k of keys) {
    if (cacheStore.delete(k)) removed += 1;
  }
  return Promise.resolve(removed);
});

const mockFlushdb = vi.fn(() => Promise.resolve("OK"));

const fakeRedis = {
  scanStream: mockScanStream,
  unlink: mockUnlink,
  flushdb: mockFlushdb,
};

vi.mock("../../redis.js", () => ({ redis: fakeRedis }));

let app: FastifyInstance;

beforeAll(async () => {
  const { adminCacheRoute } = await import("../admin-cache.js");
  app = Fastify({ logger: false });
  await app.register(adminCacheRoute);
  await app.ready();
});

afterAll(() => app.close());
afterEach(() => {
  vi.clearAllMocks();
  // Restore the store between tests so destructive tests don't leak.
  cacheStore.clear();
  cacheStore.set("int:geocoding:a", "1");
  cacheStore.set("int:geocoding:b", "1");
  cacheStore.set("int:routing:c", "1");
  cacheStore.set("cache:geocode:d", "1");
  cacheStore.set("session:user:1", "1");
});

describe("GET /admin/cache", () => {
  it("lists app-owned namespaces with key counts", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/cache" });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { namespaces: Array<{ namespace: string; keyCount: number }> };
    expect(Array.isArray(body.namespaces)).toBe(true);

    const byName = Object.fromEntries(body.namespaces.map((n) => [n.namespace, n.keyCount]));
    expect(byName["int:geocoding"]).toBe(2);
    expect(byName["int:routing"]).toBe(1);
    expect(byName["cache:geocode"]).toBe(1);
    // The non-app-owned `session:*` prefix is never scanned.
    expect(byName["session:user"]).toBeUndefined();
  });

  it("rejects unauthenticated requests with 401", async () => {
    mockRequireAdmin.mockRejectedValueOnce(
      Object.assign(new Error("Authentication required"), { statusCode: 401 }),
    );
    const res = await app.inject({ method: "GET", url: "/admin/cache" });
    expect(res.statusCode).toBe(401);
  });
});

describe("POST /admin/cache/clear", () => {
  it("clears a single namespace and audit-logs it", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/cache/clear",
      payload: { namespace: "geocoding" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deleted: 2 });
    // Only the matching prefix was removed; other keys remain.
    expect(cacheStore.has("int:routing:c")).toBe(true);
    expect(cacheStore.has("cache:geocode:d")).toBe(true);
    expect(cacheStore.has("session:user:1")).toBe(true);
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "cache.clear",
        targetType: "cache",
        details: { namespace: "geocoding" },
      }),
    );
    expect(mockFlushdb).not.toHaveBeenCalled();
  });

  it("clears all app-owned prefixes but never the rest of the DB", async () => {
    const res = await app.inject({ method: "POST", url: "/admin/cache/clear", payload: {} });

    expect(res.statusCode).toBe(200);
    // int:* (3) + cache:* (1) removed; session:* untouched.
    expect(res.json()).toEqual({ deleted: 4 });
    expect(cacheStore.has("session:user:1")).toBe(true);
    expect(mockFlushdb).not.toHaveBeenCalled();
  });

  it('treats namespace "all" the same as an omitted namespace', async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/cache/clear",
      payload: { namespace: "all" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deleted: 4 });
    expect(mockFlushdb).not.toHaveBeenCalled();
  });

  it("rejects a namespace that resolves outside the app prefixes with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/cache/clear",
      payload: { namespace: "*" },
    });

    expect(res.statusCode).toBe(400);
    expect(mockUnlink).not.toHaveBeenCalled();
    expect(mockFlushdb).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated requests with 401", async () => {
    mockRequireAdmin.mockRejectedValueOnce(
      Object.assign(new Error("Authentication required"), { statusCode: 401 }),
    );
    const res = await app.inject({ method: "POST", url: "/admin/cache/clear", payload: {} });
    expect(res.statusCode).toBe(401);
  });
});

describe("when Redis is disabled", () => {
  it("GET returns an empty list and POST reports zero deletions", async () => {
    vi.resetModules();
    vi.doMock("../../redis.js", () => ({ redis: null }));
    vi.doMock("../../utils/require-admin.js", () => ({
      requireAdmin: (...args: unknown[]) => mockRequireAdmin(...args),
      getAdminSession: (...args: unknown[]) => mockGetAdminSession(...args),
      tryAdminSession: (...args: unknown[]) => mockTryAdminSession(...args),
    }));
    vi.doMock("../../utils/audit-log.js", () => ({
      writeAuditLog: (...args: unknown[]) => mockWriteAuditLog(...args),
    }));

    const { adminCacheRoute } = await import("../admin-cache.js");
    const nullApp = Fastify({ logger: false });
    await nullApp.register(adminCacheRoute);
    await nullApp.ready();

    const listRes = await nullApp.inject({ method: "GET", url: "/admin/cache" });
    expect(listRes.json()).toEqual({ namespaces: [] });

    const clearRes = await nullApp.inject({
      method: "POST",
      url: "/admin/cache/clear",
      payload: {},
    });
    expect(clearRes.json()).toEqual({ deleted: 0 });

    await nullApp.close();
    vi.doUnmock("../../redis.js");
    vi.resetModules();
  });
});
