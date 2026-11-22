import * as sdk from "@openmapx/core/saved-places-sdk";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../../../../../packages/core/src/api/client";
import { uniformErrorHandler } from "../../server-wiring";
import { createDbMock } from "../../test/db";
import { makeCsrfGuardHook } from "../../utils/csrf";
import { RateLimiter } from "../../utils/rate-limit";
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
let floor: RateLimiter;
const registered: { id: string | undefined; auth: unknown }[] = [];
const timestamp = "2026-10-01T00:00:00.000Z";
const list = {
  id: "0193e4a0-0000-7000-8000-000000000001",
  name: "Trip",
  icon: null,
  isPrivate: true,
  sortOrder: 0,
  placeCount: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const capture = {
  name: [{ sourceId: "synthetic", name: "Source", notes: "Captured credit" }],
  lat: [],
  lng: [],
};
const place = {
  id: "0193e4a0-0000-7000-8000-000000000101",
  listId: "0193e4a0-0000-7000-8000-000000000001",
  name: "Cafe",
  address: null,
  lat: 52,
  lng: 13,
  placeId: "osm:node:1",
  fieldContributors: capture,
  note: null,
  sortOrder: 0,
  createdAt: timestamp,
};
const client = createApiClient({ baseUrl: "https://saved.example", credentials: "include" });
beforeEach(async () => {
  session.mockResolvedValue({ user: { id: "saved-sdk-user" } });
  registered.length = 0;
  database = createDbMock();
  app = Fastify();
  floor = new RateLimiter({ max: 100, windowMs: 60_000 });
  app.setErrorHandler(uniformErrorHandler);
  app.addHook("onRequest", floor.preHandler());
  app.addHook("onRequest", makeCsrfGuardHook(["https://saved.example"]));
  app.addHook("onRoute", (route) => {
    if (route.method !== "HEAD")
      registered.push({
        id: route.schema?.operationId,
        auth: (route.config as { auth?: unknown })?.auth,
      });
  });
  const { savedRoute } = await import("../saved");
  await app.register(savedRoute, { prefix: "/api" });
  await app.ready();
  vi.stubGlobal("fetch", administrationSdkFetch(app));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  floor.destroy();
  await app?.close();
});
describe("saved serialized wire contracts", () => {
  it("rejects malformed persisted lists rather than publishing a typed successful response", async () => {
    database.queueSelect([{ ...list, placeCount: "not-a-count" }]);
    const response = await app.inject({ method: "GET", url: "/api/saved/lists" });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("not-a-count");
  });
  it("registers the complete fourteen-operation session family", () => {
    expect(registered.map((route) => route.id).sort()).toEqual([
      "checkSavedPlace",
      "createSavedList",
      "createSavedPlace",
      "deleteSavedLabel",
      "deleteSavedList",
      "deleteSavedPlace",
      "exportSavedList",
      "importSavedPlaces",
      "listSavedLabels",
      "listSavedListPlaces",
      "listSavedLists",
      "updateSavedList",
      "updateSavedPlace",
      "writeSavedLabel",
    ]);
    expect(registered.every((route) => route.auth === "session")).toBe(true);
  });
  it("round-trips all fourteen real producers through the generated SDK and actual ApiClient", async () => {
    database.queueSelect([
      { ...list, createdAt: new Date(timestamp), updatedAt: new Date(timestamp) },
    ]);
    expect(sdk.unwrapSavedResponse(await sdk.listSavedLists({ client }))).toEqual({
      lists: [list],
    });
    const created = sdk.unwrapSavedResponse(await sdk.createSavedList({ name: "New" }, { client }));
    expect(created).toEqual({ id: expect.any(String), name: "New", icon: null, isPrivate: true });
    database.queueSelect([{ name: "Trip" }]);
    database.queueUpdate([{ id: "0193e4a0-0000-7000-8000-000000000001" }]);
    expect(
      sdk.unwrapSavedResponse(
        await sdk.updateSavedList(
          "0193e4a0-0000-7000-8000-000000000001",
          { name: "Changed" },
          { client },
        ),
      ),
    ).toEqual({ ok: true });
    database.queueSelect([{ name: "Trip" }]);
    expect(
      sdk.unwrapSavedResponse(
        await sdk.deleteSavedList("0193e4a0-0000-7000-8000-000000000001", { client }),
      ),
    ).toEqual({
      ok: true,
    });
    database.queueSelect([{ id: "0193e4a0-0000-7000-8000-000000000001" }]);
    database.queueSelect([place]);
    expect(
      sdk.unwrapSavedResponse(
        await sdk.listSavedListPlaces("0193e4a0-0000-7000-8000-000000000001", { client }),
      ),
    ).toEqual({
      places: [place],
    });
    database.queueSelect([]); // account quota lock
    database.queueSelect([{ id: "0193e4a0-0000-7000-8000-000000000001" }]);
    const added = sdk.unwrapSavedResponse(
      await sdk.createSavedPlace(
        "0193e4a0-0000-7000-8000-000000000001",
        { name: "Cafe", lat: 52, lng: 13, fieldContributors: capture },
        { client },
      ),
    );
    expect(added).toEqual({
      id: expect.any(String),
      listId: "0193e4a0-0000-7000-8000-000000000001",
      name: "Cafe",
      address: null,
      lat: 52,
      lng: 13,
      placeId: null,
      note: null,
      fieldContributors: capture,
    });
    database.queueSelect([
      { placeId: "0193e4a0-0000-7000-8000-000000000101", listUserId: "saved-sdk-user" },
    ]);
    expect(
      sdk.unwrapSavedResponse(
        await sdk.updateSavedPlace(
          "0193e4a0-0000-7000-8000-000000000101",
          { note: "Edited" },
          { client },
        ),
      ),
    ).toEqual({ ok: true });
    database.queueSelect([
      {
        placeId: "0193e4a0-0000-7000-8000-000000000101",
        listUserId: "saved-sdk-user",
        listId: "0193e4a0-0000-7000-8000-000000000001",
      },
    ]);
    expect(
      sdk.unwrapSavedResponse(
        await sdk.deleteSavedPlace("0193e4a0-0000-7000-8000-000000000101", { client }),
      ),
    ).toEqual({
      ok: true,
    });
    const label = {
      id: "0193e4a0-0000-7000-8000-000000000201",
      label: "home / café",
      icon: null,
      name: "Home",
      address: null,
      lat: 52,
      lng: 13,
      placeId: null,
      fieldContributors: capture,
    };
    database.queueSelect([label]);
    expect(sdk.unwrapSavedResponse(await sdk.listSavedLabels({ client }))).toEqual({
      labels: [label],
    });
    database.queueSelect([]);
    expect(
      sdk.unwrapSavedResponse(
        await sdk.writeSavedLabel("home / café", { name: "Home", lat: 52, lng: 13 }, { client }),
      ),
    ).toEqual({ id: expect.any(String), label: "home / café" });
    database.queueDelete([{ id: "0193e4a0-0000-7000-8000-000000000201" }]);
    expect(sdk.unwrapSavedResponse(await sdk.deleteSavedLabel("home / café", { client }))).toEqual({
      ok: true,
    });
    database.queueSelect([{ listId: "0193e4a0-0000-7000-8000-000000000001" }]);
    expect(
      sdk.unwrapSavedResponse(await sdk.checkSavedPlace({ placeId: "osm:node:1" }, { client })),
    ).toEqual({ listIds: ["0193e4a0-0000-7000-8000-000000000001"] });
    database.queueSelect([]); // account quota lock
    database.queueSelect([{ id: "0193e4a0-0000-7000-8000-000000000001", name: "Trip" }]);
    database.queueSelect([]);
    expect(
      sdk.unwrapSavedResponse(
        await sdk.importSavedPlaces(
          {
            target: { listId: "0193e4a0-0000-7000-8000-000000000001" },
            places: [{ name: "Imported", lat: 52, lng: 13, fieldContributors: capture }],
          },
          { client },
        ),
      ),
    ).toEqual({
      listId: "0193e4a0-0000-7000-8000-000000000001",
      name: "Trip",
      imported: 1,
      skippedDuplicates: 0,
    });
    for (const [format, media, marker] of [
      ["gpx", "application/gpx+xml", "<gpx"],
      ["geojson", "application/geo+json", "FeatureCollection"],
      ["kml", "application/vnd.google-earth.kml+xml", "<kml"],
    ] as const) {
      database.queueSelect([{ id: "0193e4a0-0000-7000-8000-000000000001", name: "Trip" }]);
      database.queueSelect([place]);
      const response = await sdk.exportSavedList(
        "0193e4a0-0000-7000-8000-000000000001",
        { format },
        { client },
      );
      const blob = sdk.unwrapSavedResponse(response);
      expect(blob.type.split(";", 1)[0]).toBe(media);
      expect(response.headers.get("content-disposition")).toContain(`Trip.${format}`);
      const text = await blob.text();
      expect(text).toContain(marker);
      expect(text).toContain("Captured credit");
    }
  });
  it("checks actual session auth before contract validation and performs no database work", async () => {
    session.mockResolvedValue(null);
    const response = await sdk.createSavedList({} as never, { client });
    expect(response.status).toBe(401);
    expect(database.db.insert).not.toHaveBeenCalled();
    expect(database.db.select).not.toHaveBeenCalled();
  });
  it("retains cross-account absence without mutation and rejects malformed bodies before mutation", async () => {
    database.queueSelect([]);
    expect(
      (
        await sdk.updateSavedList(
          "0193e4a0-0000-7000-8000-000000000f01",
          { name: "New" },
          { client },
        )
      ).status,
    ).toBe(404);
    expect(database.db.update).not.toHaveBeenCalled();
    expect(
      (
        await sdk.createSavedPlace(
          "0193e4a0-0000-7000-8000-000000000001",
          { name: "X", lat: 91, lng: 13 },
          { client },
        )
      ).status,
    ).toBe(400);
    expect(database.db.insert).not.toHaveBeenCalled();
  });
  it("keeps cookie mutation origin protection on the real producer", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/saved/lists",
      headers: { cookie: "session=synthetic", origin: "https://untrusted.example" },
      payload: { name: "Trip" },
    });
    expect(response.statusCode).toBe(403);
    expect(database.db.insert).not.toHaveBeenCalled();
  });
});

it("clears a custom list icon with the null value sent by the existing editor", async () => {
  database.queueSelect([{ name: "Trip" }]);
  database.queueUpdate([{ id: "0193e4a0-0000-7000-8000-000000000001" }]);
  const response = await sdk.updateSavedList(
    "0193e4a0-0000-7000-8000-000000000001",
    { icon: null },
    { client },
  );
  expect(response.status).toBe(200);
});

it("preserves the actual limiter's Retry-After contract through generated acquisition", async () => {
  for (let index = 0; index < 100; index++) {
    expect((await sdk.createSavedList({} as never, { client })).status).toBe(400);
  }
  const limited = await sdk.createSavedList({ name: "Limited" }, { client });
  expect(limited.status).toBe(429);
  expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  expect(database.db.insert).not.toHaveBeenCalled();
});
