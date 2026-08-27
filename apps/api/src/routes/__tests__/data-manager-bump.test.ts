import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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

// Capture tryAdminSession behaviour so we can flip between "session present"
// and "no session" between tests without spinning up better-auth.
const tryAdminSessionMock = vi.hoisted(() => vi.fn());
vi.mock("../../utils/require-admin.js", () => ({
  tryAdminSession: tryAdminSessionMock,
}));

const fetchMock = vi.hoisted(() => vi.fn());
const auditMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../../utils/audit-log.js", () => ({ writeAuditLog: auditMock }));
vi.mock("../../utils/rate-limit.js", () => ({
  systemMaintenanceLimit: { preHandler: () => vi.fn().mockResolvedValue(undefined) },
}));

beforeAll(() => {
  process.env.DATA_MANAGER_AUTH_TOKEN = "service-token";
  process.env.DATA_MANAGER_URL = "https://data-manager.test:4000";
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
  tryAdminSessionMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /data-manager/transit/bump-transitous-ref", () => {
  it("returns 200 + proxies to data-manager when caller has an admin session", async () => {
    tryAdminSessionMock.mockResolvedValue({
      user: { id: "admin-1", role: "admin" },
      session: { id: "sess-1" },
    });
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          unchanged: false,
          ref: "main@deadbeef",
          previousRef: "main@cafef00d",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const res = await app.inject({
      method: "POST",
      url: "/data-manager/transit/bump-transitous-ref",
      payload: { branch: "main", force: false },
    });

    expect(res.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const args = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(args.body as string)).toMatchObject({
      branch: "main",
      force: false,
      lockedBy: "admin-1",
    });
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "transit.lock.bump", actorId: "admin-1" }),
    );
  });

  it("rejects flag-shaped and traversal-like branch names", async () => {
    tryAdminSessionMock.mockResolvedValue({ user: { id: "admin-1", role: "admin" } });
    const res = await app.inject({
      method: "POST",
      url: "/data-manager/transit/bump-transitous-ref",
      payload: { branch: "--upload-pack=evil" },
    });
    expect(res.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 403 when caller authenticates with only a bearer token", async () => {
    tryAdminSessionMock.mockResolvedValue(null);

    const res = await app.inject({
      method: "POST",
      url: "/data-manager/transit/bump-transitous-ref",
      headers: { authorization: "Bearer service-token" },
      payload: { branch: "main" },
    });

    expect(res.statusCode).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 401 when neither bearer nor admin session is present", async () => {
    tryAdminSessionMock.mockResolvedValue(null);

    const res = await app.inject({
      method: "POST",
      url: "/data-manager/transit/bump-transitous-ref",
      payload: { branch: "main" },
    });

    expect(res.statusCode).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
