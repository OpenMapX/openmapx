import cors from "@fastify/cors";
import * as sdk from "@openmapx/core/sharing-sdk";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApiClient } from "../../../../../packages/core/src/api/client";
import { corsOptions, uniformErrorHandler } from "../../server-wiring";
import { createDbMock } from "../../test/db";
import { makeCsrfGuardHook } from "../../utils/csrf";
import { administrationSdkFetch } from "./helpers/administration-sdk-fetch";

let database = createDbMock();
const session = vi.fn();
vi.mock("../../db/index", () => ({
  get db() {
    return database.db;
  },
}));
vi.mock("../../auth", () => ({
  auth: { api: { getSession: (...args: unknown[]) => session(...args) } },
}));
let app: FastifyInstance;
const client = createApiClient({ baseUrl: "https://sharing.example", credentials: "include" });
const at = new Date("2026-10-23T00:00:00Z");
const row = {
  id: "share",
  userId: "owner",
  tokenHash: "private",
  targetType: "list",
  targetId: "list",
  mode: "snapshot",
  label: "Trip",
  createdAt: at,
  updatedAt: at,
  expiresAt: null,
  snapshot: { name: "Trip", icon: null, places: [] },
};
beforeEach(async () => {
  database = createDbMock();
  session.mockResolvedValue({ user: { id: "owner" } });
  app = Fastify();
  await app.register(cors, corsOptions(["https://web.example"]));
  app.setErrorHandler(uniformErrorHandler);
  app.addHook("onRequest", makeCsrfGuardHook(["https://sharing.example"]));
  const { sharesRoute, resetShareRateLimitsForTests } = await import("../shares");
  resetShareRateLimitsForTests();
  await app.register(sharesRoute, { prefix: "/api" });
  await app.ready();
  vi.stubGlobal("fetch", administrationSdkFetch(app));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await app?.close();
});
it("round-trips all five producers through the generated SDK without private fields", async () => {
  database.queueSelect([row]);
  const listed = await sdk.listOwnerShares({ client });
  expect(listed.status).toBe(200);
  expect(listed.headers.get("vary")).toBe("Cookie");
  const owner = sdk.unwrapSharingResponse(listed).shares[0];
  expect(owner).not.toHaveProperty("tokenHash");
  expect(owner).not.toHaveProperty("snapshot");
  database.queueSelect([{ id: "owner" }]);
  database.queueSelect([{ count: 0 }]);
  const created = await sdk.createShare(
    {
      targetType: "route",
      route: {
        mode: "walking",
        waypoints: [
          { lat: 52, lng: 13 },
          { lat: 53, lng: 14 },
        ],
        schedules: [null, { fixedAt: "2026-10-23T12:00", timeZone: "Europe/Berlin" }],
      },
    },
    { client },
  );
  expect(created.status).toBe(201);
  const token = sdk.unwrapSharingResponse(created).token;
  expect(token).toHaveLength(43);
  database.queueUpdate([{ id: "share" }]);
  expect(sdk.unwrapSharingResponse(await sdk.rotateShareToken("share", { client })).token).not.toBe(
    token,
  );
  database.queueDelete([{ id: "share" }]);
  expect(sdk.unwrapSharingResponse(await sdk.revokeShare("share", { client }))).toEqual({
    ok: true,
  });
  session.mockResolvedValue(null);
  session.mockClear();
  database.queueSelect([row]);
  const resolved = await sdk.resolvePublicShare(token, { client });
  expect(resolved.status).toBe(200);
  expect(resolved.headers.get("cache-control")).toBe("no-store");
  expect(sdk.unwrapSharingResponse(resolved)).toEqual({
    type: "list",
    mode: "snapshot",
    name: "Trip",
    icon: null,
    places: [],
  });
  expect(session).not.toHaveBeenCalled();
});
it("enforces real session and CSRF guards before writes", async () => {
  session.mockResolvedValue(null);
  expect((await sdk.createShare({} as never, { client })).status).toBe(401);
  expect(database.db.select).not.toHaveBeenCalled();
  session.mockResolvedValue({ user: { id: "owner" } });
  expect(
    (
      await sdk.revokeShare("share", {
        client,
        headers: { origin: "https://foreign.example", cookie: "session=synthetic" },
      })
    ).status,
  ).toBe(403);
  expect(database.db.delete).not.toHaveBeenCalled();
});
it("keeps missing, expired, dangling and malformed snapshots indistinguishable", async () => {
  for (const rows of [
    [],
    [{ ...row, expiresAt: new Date(0) }],
    [{ ...row, snapshot: {} }],
    [{ ...row, mode: "live", targetId: "deleted" }],
  ]) {
    database.queueSelect(rows);
    if (rows[0]?.mode === "live") database.queueSelect([]);
    const result = await sdk.resolvePublicShare("A".repeat(43), { client });
    expect(result.status).toBe(404);
    expect(result.data).toEqual({ error: "Share link not found" });
  }
});
it("retains public acquisition rate limiting and typed Retry-After", async () => {
  let response: Awaited<ReturnType<typeof sdk.resolvePublicShare>> | undefined;
  for (let i = 0; i < 121; i++) {
    response = await sdk.resolvePublicShare("A".repeat(43), { client });
    if (response.status === 429) break;
  }
  expect(response?.status).toBe(429);
  expect(Number(response?.headers.get("retry-after"))).toBeGreaterThan(0);
});

it.each(["live", "snapshot"] as const)(
  "normalizes credential-bearing attribution URLs in %s public replies",
  async (mode) => {
    const capture = {
      name: [
        {
          sourceId: "fixture",
          name: "Publisher",
          url: "https://synthetic-user:synthetic-secret@unsafe.example/receipt",
          attributionText: "Required notice",
          publisher: {
            name: "Publisher",
            url: "https://synthetic-user:synthetic-secret@unsafe.example/publisher",
          },
        },
      ],
      address: [{ sourceId: "safe", name: "Safe publisher", url: "https://safe.example/terms" }],
      lat: [],
    };
    const place = {
      name: "Place",
      address: "Street",
      lat: 52,
      lng: 13,
      note: null,
      placeId: null,
      fieldContributors: capture,
    };
    database.queueSelect([
      { ...row, mode, snapshot: { name: "Trip", icon: null, places: [place] } },
    ]);
    if (mode === "live") {
      database.queueSelect([{ id: "list", name: "Trip", icon: null }]);
      database.queueSelect([place]);
    }
    const result = await sdk.resolvePublicShare("A".repeat(43), { client });
    expect(result.status).toBe(200);
    expect(result.data).toEqual({
      type: "list",
      mode,
      name: "Trip",
      icon: null,
      places: [
        {
          ...place,
          fieldContributors: {
            name: [
              {
                sourceId: "fixture",
                name: "Publisher",
                attributionText: "Required notice",
                publisher: { name: "Publisher" },
              },
            ],
            address: capture.address,
            lat: [],
          },
        },
      ],
    });
    expect(JSON.stringify(result.data)).not.toContain("synthetic-secret");
  },
);

it("exposes the owner cache contract to a credentialed cross-origin SDK", async () => {
  const wireFetch = administrationSdkFetch(app);
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(init?.credentials).toBe("include");
    const requestHeaders = new Headers(init?.headers);
    requestHeaders.set("origin", "https://web.example");
    const response = await wireFetch(input, { ...init, headers: requestHeaders });
    expect(response.headers.get("access-control-allow-origin")).toBe("https://web.example");
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
    const visible = new Set([
      "cache-control",
      "content-language",
      "content-length",
      "content-type",
      "expires",
      "last-modified",
      "pragma",
      ...(response.headers.get("access-control-expose-headers") ?? "").toLowerCase().split(/,\s*/),
    ]);
    const headers = new Headers();
    response.headers.forEach((value, name) => {
      if (visible.has(name)) headers.set(name, value);
    });
    return new Response(response.body, { status: response.status, headers });
  });
  const result = await sdk.listOwnerShares({ client });
  expect(sdk.unwrapSharingResponse(result)).toEqual({ shares: [] });
  expect(result.headers.get("vary")).toMatch(/Cookie/);
});
