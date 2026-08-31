import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTestApp } from "../../test/app.js";
import { mockRequireAuth } from "../../test/auth.js";
import { createDbMock } from "../../test/db.js";

const USER_ID = "user-1";
const authMock = mockRequireAuth(USER_ID);
vi.mock("../../utils/require-auth.js", () => authMock);

const dbMock = createDbMock();
vi.mock("../../db/index.js", () => ({ db: dbMock.db }));

const LIST_ROW = {
  id: "list-1",
  userId: USER_ID,
  name: "Trip",
  icon: null,
  isPrivate: true,
  sortOrder: 0,
  createdAt: new Date("2026-08-30T10:00:00Z"),
  updatedAt: new Date("2026-08-30T10:00:00Z"),
};
const PLACE_ROW = {
  id: "place-1",
  listId: "list-1",
  name: "Cafe",
  address: "Street 1",
  lat: 52.5,
  lng: 13.4,
  placeId: "osm:node/123",
  note: "good",
  sortOrder: 0,
  createdAt: new Date(),
};
const ROUTE_PAYLOAD = {
  waypoints: [
    { lat: 52.52, lng: 13.405, label: "Berlin" },
    { lat: 53.55, lng: 9.99, label: "Hamburg" },
  ],
  mode: "driving",
};

let app: FastifyInstance;

beforeAll(async () => {
  const { sharesRoute, resetShareRateLimitsForTests } = await import("../shares.js");
  resetShareRateLimitsForTests();
  app = await buildTestApp(sharesRoute, { prefix: "/api" });
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  const { resetShareRateLimitsForTests } = await import("../shares.js");
  resetShareRateLimitsForTests();
  vi.clearAllMocks();
});

function insertedRow(): Record<string, unknown> {
  const chain = dbMock.db.insert.mock.results[0]?.value as {
    values: { mock: { calls: unknown[][] } };
  };
  return chain.values.mock.calls[0][0] as Record<string, unknown>;
}

describe("POST /api/shares", () => {
  it("mints a live list share and returns the token exactly once", async () => {
    dbMock.queueSelect([{ count: 0 }]); // per-user cap
    dbMock.queueSelect([LIST_ROW]); // ownership check
    const res = await app.inject({
      method: "POST",
      url: "/api/shares",
      payload: { targetType: "list", targetId: "list-1", mode: "live" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.share).toMatchObject({
      targetType: "list",
      targetId: "list-1",
      mode: "live",
      label: "Trip",
      expiresAt: null,
    });
    const row = insertedRow();
    expect(row.tokenHash).toBe(createHash("sha256").update(body.token, "utf8").digest("base64url"));
    expect(JSON.stringify(row)).not.toContain(body.token);
    expect(row.snapshot).toBeNull();
    expect(res.headers["cache-control"]).toBe("private, no-store");
  });

  it("mints a snapshot list share with the frozen public projection", async () => {
    dbMock.queueSelect([{ count: 0 }]);
    dbMock.queueSelect([LIST_ROW]);
    dbMock.queueSelect([PLACE_ROW]); // snapshot source places
    const res = await app.inject({
      method: "POST",
      url: "/api/shares",
      payload: { targetType: "list", targetId: "list-1", mode: "snapshot", expiresInDays: 7 },
    });
    expect(res.statusCode).toBe(201);
    const row = insertedRow();
    expect(row.snapshot).toEqual({
      name: "Trip",
      icon: null,
      places: [
        {
          name: "Cafe",
          address: "Street 1",
          lat: 52.5,
          lng: 13.4,
          note: "good",
          placeId: "osm:node/123",
        },
      ],
    });
    expect(JSON.stringify(row.snapshot)).not.toMatch(/place-1|list-1|user-1/);
    expect(row.expiresAt).toBeInstanceOf(Date);
  });

  it("mints a route share with a derived label", async () => {
    dbMock.queueSelect([{ count: 0 }]);
    const res = await app.inject({
      method: "POST",
      url: "/api/shares",
      payload: { targetType: "route", route: ROUTE_PAYLOAD },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().share.label).toBe("Berlin → Hamburg");
    expect(insertedRow().targetId).toBeNull();
  });

  it("404s for a list the caller does not own", async () => {
    dbMock.queueSelect([{ count: 0 }]);
    dbMock.queueSelect([]); // ownership check finds nothing
    const res = await app.inject({
      method: "POST",
      url: "/api/shares",
      payload: { targetType: "list", targetId: "someone-elses", mode: "live" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "List not found" });
  });

  it("400s a list mint without targetId/mode and a route mint without payload", async () => {
    // [payload, reachesHandler] — schema-rejected bodies never consume the
    // per-user-cap select, so queuing for them would leak into later tests.
    const cases: Array<[Record<string, unknown>, boolean]> = [
      [{ targetType: "list" }, true],
      [{ targetType: "list", targetId: "list-1" }, true],
      [{ targetType: "route" }, true],
      [{ targetType: "route", route: { ...ROUTE_PAYLOAD, mode: "transit" } }, false],
    ];
    for (const [payload, reachesHandler] of cases) {
      if (reachesHandler) dbMock.queueSelect([{ count: 0 }]);
      const res = await app.inject({ method: "POST", url: "/api/shares", payload });
      expect(res.statusCode).toBe(400);
    }
  });

  it("409s over the per-user cap", async () => {
    dbMock.queueSelect([{ count: 100 }]);
    const res = await app.inject({
      method: "POST",
      url: "/api/shares",
      payload: { targetType: "route", route: ROUTE_PAYLOAD },
    });
    expect(res.statusCode).toBe(409);
  });

  it("401s when unauthenticated", async () => {
    const { httpError } = await import("@openmapx/integration-framework");
    authMock.requireAuthHook.mockRejectedValueOnce(httpError(401, "Authentication required"));
    const res = await app.inject({
      method: "POST",
      url: "/api/shares",
      payload: { targetType: "route", route: ROUTE_PAYLOAD },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /api/shares", () => {
  it("lists the owner's shares without hashes or snapshots", async () => {
    dbMock.queueSelect([
      {
        id: "share-1",
        userId: USER_ID,
        tokenHash: "HASH",
        targetType: "list",
        targetId: "list-1",
        mode: "live",
        label: "Trip",
        snapshot: null,
        createdAt: new Date("2026-08-30T10:00:00Z"),
        updatedAt: new Date("2026-08-30T10:00:00Z"),
        expiresAt: null,
      },
    ]);
    const res = await app.inject({ method: "GET", url: "/api/shares" });
    expect(res.statusCode).toBe(200);
    expect(res.json().shares).toHaveLength(1);
    expect(res.payload).not.toMatch(/HASH|tokenHash|snapshot|user-1/);
  });
});

describe("POST /api/shares/:id/rotate", () => {
  it("returns a fresh token and updates only the caller's row", async () => {
    dbMock.queueUpdate([{ id: "share-1" }]);
    const res = await app.inject({ method: "POST", url: "/api/shares/share-1/rotate" });
    expect(res.statusCode).toBe(200);
    expect(res.json().token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
  it("404s when the row is not owned", async () => {
    dbMock.queueUpdate([]);
    const res = await app.inject({ method: "POST", url: "/api/shares/other/rotate" });
    expect(res.statusCode).toBe(404);
  });
});

describe("DELETE /api/shares/:id", () => {
  it("hard-deletes and confirms", async () => {
    dbMock.queueDelete([{ id: "share-1" }]);
    const res = await app.inject({ method: "DELETE", url: "/api/shares/share-1" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
  it("404s when the row is not owned", async () => {
    dbMock.queueDelete([]);
    const res = await app.inject({ method: "DELETE", url: "/api/shares/other" });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /api/shares/:token (public)", () => {
  const VALID_TOKEN = "A".repeat(43);
  const NOW = Date.now();
  const baseRow = {
    id: "share-1",
    userId: USER_ID,
    tokenHash: "irrelevant-the-query-matches",
    targetType: "list",
    targetId: "list-1",
    mode: "live",
    label: "Trip",
    snapshot: null,
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
    expiresAt: null,
  };

  it("resolves a live list share to the public projection only", async () => {
    dbMock.queueSelect([baseRow]); // share by hash
    dbMock.queueSelect([LIST_ROW]); // live list
    dbMock.queueSelect([PLACE_ROW]); // its places
    const res = await app.inject({ method: "GET", url: `/api/shares/${VALID_TOKEN}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.json()).toEqual({
      type: "list",
      mode: "live",
      name: "Trip",
      icon: null,
      places: [
        {
          name: "Cafe",
          address: "Street 1",
          lat: 52.5,
          lng: 13.4,
          note: "good",
          placeId: "osm:node/123",
        },
      ],
    });
    expect(res.payload).not.toMatch(/user-1|share-1|list-1|place-1|tokenHash/);
  });

  it("resolves a snapshot list share from the frozen payload", async () => {
    dbMock.queueSelect([
      {
        ...baseRow,
        mode: "snapshot",
        snapshot: { name: "Trip", icon: null, places: [] },
      },
    ]);
    const res = await app.inject({ method: "GET", url: `/api/shares/${VALID_TOKEN}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      type: "list",
      mode: "snapshot",
      name: "Trip",
      icon: null,
      places: [],
    });
  });

  it("resolves a route share", async () => {
    dbMock.queueSelect([
      {
        ...baseRow,
        targetType: "route",
        targetId: null,
        mode: "snapshot",
        snapshot: ROUTE_PAYLOAD,
      },
    ]);
    const res = await app.inject({ method: "GET", url: `/api/shares/${VALID_TOKEN}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().type).toBe("route");
    expect(res.json().route.waypoints).toHaveLength(2);
  });

  it("uniform 404: unknown token, expired share, deleted live list, corrupt snapshot", async () => {
    const cases: Array<() => void> = [
      () => dbMock.queueSelect([]),
      () => dbMock.queueSelect([{ ...baseRow, expiresAt: new Date(NOW - 1000) }]),
      () => {
        dbMock.queueSelect([baseRow]);
        dbMock.queueSelect([]); // list gone
      },
      () => dbMock.queueSelect([{ ...baseRow, mode: "snapshot", snapshot: { bogus: true } }]),
    ];
    for (const queue of cases) {
      queue();
      const res = await app.inject({ method: "GET", url: `/api/shares/${VALID_TOKEN}` });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: "Share link not found" });
    }
  });

  it("400s a token that fails the pattern before touching the database", async () => {
    const res = await app.inject({ method: "GET", url: "/api/shares/short" });
    expect(res.statusCode).toBe(400);
    expect(dbMock.db.select).not.toHaveBeenCalled();
  });

  it("429s past the resolve rate limit", async () => {
    for (let i = 0; i < 60; i += 1) {
      dbMock.queueSelect([]);
      await app.inject({ method: "GET", url: `/api/shares/${VALID_TOKEN}` });
    }
    const res = await app.inject({ method: "GET", url: `/api/shares/${VALID_TOKEN}` });
    expect(res.statusCode).toBe(429);
    expect(res.headers["retry-after"]).toBeDefined();
  });
});
