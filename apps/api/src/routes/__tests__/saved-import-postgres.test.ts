import * as sdk from "@openmapx/core/saved-places-sdk";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../../../../../packages/core/src/api/client";
import { labeledPlace, savedList, savedPlace, user } from "../../db/schema";
import { buildTestApp } from "../../test/app";
import { createMigratedPostgresFixture } from "../../test/postgres-fixture";
import { administrationSdkFetch } from "./helpers/administration-sdk-fetch";

const connection = vi.hoisted(() => ({
  db: null as unknown as Awaited<ReturnType<typeof createMigratedPostgresFixture>>["db"],
}));
vi.mock("../../db/index", () => ({
  get db() {
    return connection.db;
  },
}));
vi.mock("../../utils/require-auth", () => ({
  requireAuthHook: async () => {},
  getUserId: () => "import-user",
}));

describe.skipIf(process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1")(
  "saved imports in PostgreSQL",
  () => {
    let fixture: Awaited<ReturnType<typeof createMigratedPostgresFixture>>;
    let app: FastifyInstance;
    beforeAll(async () => {
      fixture = await createMigratedPostgresFixture();
      connection.db = fixture.db;
      const { savedRoute } = await import("../saved");
      app = await buildTestApp(savedRoute, { prefix: "/api" });
      await fixture.db
        .insert(user)
        .values({ id: "import-user", name: "Importer", email: "import@example.test" });
    }, 120_000);
    afterAll(async () => {
      try {
        await app?.close();
      } finally {
        await fixture?.stop();
      }
    });
    const fieldContributors = { lat: [{ sourceId: "geo", name: "Original geocoder" }], lng: [] };
    const point = { name: "Cafe", lat: 52, lng: 13, fieldContributors };
    const send = (target: unknown, places: object[] = [point]) =>
      app.inject({ method: "POST", url: "/api/saved/lists/import", payload: { target, places } });

    it("suffixes concurrent new-list imports and serializes duplicate membership", async () => {
      const responses = await Promise.all([send({ name: "Trip" }), send({ name: "Trip" })]);
      expect(responses.map((r) => r.statusCode)).toEqual([200, 200]);
      expect(responses.map((r) => r.json().name).sort()).toEqual(["Trip", "Trip (2)"]);
      const listId = responses[0].json().listId as string;
      const duplicate = await send({ listId }, [
        { ...point, lat: 52.000009 },
        { ...point, name: "Museum", lat: 53, lng: 14 },
        { ...point, name: "Museum", lat: 53, lng: 14 },
      ]);
      expect(duplicate.json()).toMatchObject({ imported: 1, skippedDuplicates: 2 });
      const more = await Promise.all([
        send({ listId }, [{ ...point, name: "Park", lat: 54, lng: 15 }]),
        send({ listId }, [{ ...point, name: "Park", lat: 54, lng: 15 }]),
      ]);
      expect(more.map((r) => r.json().imported).sort()).toEqual([0, 1]);
      const places = await fixture.db
        .select()
        .from(savedPlace)
        .where(eq(savedPlace.listId, listId))
        .orderBy(savedPlace.sortOrder);
      expect(places.map((p) => p.sortOrder)).toEqual([0, 1, 2]);
      expect(places.every((p) => p.placeId === null)).toBe(true);
      expect(places.map((p) => p.fieldContributors)).toEqual([
        fieldContributors,
        fieldContributors,
        fieldContributors,
      ]);
    });
    it("rolls back a newly created list if any place cannot be inserted", async () => {
      await fixture.sql`CREATE FUNCTION import_test_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.name = 'Reject' THEN RAISE EXCEPTION 'test failure'; END IF; RETURN NEW; END $$`;
      await fixture.sql`CREATE TRIGGER import_test_reject BEFORE INSERT ON saved_place FOR EACH ROW EXECUTE FUNCTION import_test_reject()`;
      expect(
        (await send({ name: "Rollback" }, [point, { ...point, name: "Reject" }])).statusCode,
      ).toBe(500);
      expect(
        await fixture.db.select().from(savedList).where(eq(savedList.name, "Rollback")),
      ).toHaveLength(0);
      expect(
        await fixture.db.select().from(savedPlace).where(eq(savedPlace.name, "Reject")),
      ).toHaveLength(0);
    });
    it("validates persisted read records, receipts, icon clearing, captured edits and downloads through the SDK", async () => {
      vi.stubGlobal("fetch", administrationSdkFetch(app));
      const client = createApiClient({
        baseUrl: "https://saved-db.example",
        credentials: "include",
      });
      try {
        const created = sdk.unwrapSavedResponse(
          await sdk.createSavedList({ name: "SDK persisted", icon: "star" }, { client }),
        );
        const id = created.id;
        expect(
          sdk.unwrapSavedResponse(await sdk.updateSavedList(id, { icon: null }, { client })),
        ).toEqual({ ok: true });
        const lists = sdk.unwrapSavedResponse(await sdk.listSavedLists({ client })).lists;
        expect(lists.find((list) => list.id === id)).toMatchObject({
          icon: null,
          placeCount: 0,
          createdAt: expect.stringMatching(/^\d{4}-/),
        });
        const added = sdk.unwrapSavedResponse(
          await sdk.createSavedPlace(id, { ...point, placeId: "osm:node:1" }, { client }),
        );
        expect(
          sdk.unwrapSavedResponse(await sdk.checkSavedPlace({ placeId: "osm:node:1" }, { client })),
        ).toEqual({ listIds: [id] });
        const places = sdk.unwrapSavedResponse(
          await sdk.listSavedListPlaces(id, { client }),
        ).places;
        expect(places).toEqual([
          expect.objectContaining({
            id: added.id,
            fieldContributors,
            sortOrder: 0,
            createdAt: expect.any(String),
          }),
        ]);
        expect(
          sdk.unwrapSavedResponse(await sdk.updateSavedPlace(added.id, { lat: 53 }, { client })),
        ).toEqual({ ok: true });
        const changed = sdk.unwrapSavedResponse(await sdk.listSavedListPlaces(id, { client }))
          .places[0];
        expect(changed.fieldContributors).toEqual({ lat: [], lng: [] });
        const written = sdk.unwrapSavedResponse(
          await sdk.writeSavedLabel("SDK home", { ...point }, { client }),
        );
        const label = sdk
          .unwrapSavedResponse(await sdk.listSavedLabels({ client }))
          .labels.find((label) => label.id === written.id);
        expect(label).toMatchObject({ label: "SDK home", fieldContributors });
        expect(label).not.toHaveProperty("userId");
        const imported = sdk.unwrapSavedResponse(
          await sdk.importSavedPlaces(
            { target: { listId: id }, places: [point, point] },
            { client },
          ),
        );
        expect(imported).toMatchObject({ imported: 1, skippedDuplicates: 1 });
        for (const format of ["gpx", "geojson", "kml"] as const) {
          const blob = sdk.unwrapSavedResponse(
            await sdk.exportSavedList(id, { format }, { client }),
          );
          expect(await blob.text()).toContain("Cafe");
        }
        expect(sdk.unwrapSavedResponse(await sdk.deleteSavedLabel("SDK home", { client }))).toEqual(
          { ok: true },
        );
        expect(sdk.unwrapSavedResponse(await sdk.deleteSavedPlace(added.id, { client }))).toEqual({
          ok: true,
        });
        expect(sdk.unwrapSavedResponse(await sdk.deleteSavedList(id, { client }))).toEqual({
          ok: true,
        });
        expect(
          sdk.unwrapSavedResponse(await sdk.checkSavedPlace({ placeId: "osm:node:1" }, { client })),
        ).toEqual({ listIds: [] });
      } finally {
        vi.unstubAllGlobals();
      }
    });
    it("answers 409 for duplicate list names on create and rename", async () => {
      const create = (name: string) =>
        app.inject({ method: "POST", url: "/api/saved/lists", payload: { name } });
      const first = await create("Duplicate fixture");
      expect(first.statusCode).toBe(200);
      const duplicate = await create("Duplicate fixture");
      expect(duplicate.statusCode).toBe(409);
      expect(duplicate.json()).toEqual({
        error: "A list with this name already exists",
        code: "SAVED_LIST_NAME_TAKEN",
      });
      const second = await create("Duplicate fixture 2");
      const renamed = await app.inject({
        method: "PATCH",
        url: `/api/saved/lists/${second.json().id}`,
        payload: { name: "Duplicate fixture" },
      });
      expect(renamed.statusCode).toBe(409);
      expect(renamed.json()).toMatchObject({ code: "SAVED_LIST_NAME_TAKEN" });
    });
    it("admits only one of two concurrent list creations at the last free slot", async () => {
      await fixture.sql`DELETE FROM saved_list WHERE user_id = 'import-user'`;
      await fixture.sql`INSERT INTO saved_list (id, user_id, name) SELECT 'cap-' || n, 'import-user', 'Cap ' || n FROM generate_series(1, 499) AS n`;
      const created = await Promise.all(
        ["Last A", "Last B"].map((name) =>
          app.inject({ method: "POST", url: "/api/saved/lists", payload: { name } }),
        ),
      );
      expect(created.map((response) => response.statusCode).sort()).toEqual([200, 409]);
      expect(created.find((response) => response.statusCode === 409)?.json()).toMatchObject({
        code: "SAVED_LIST_LIMIT",
      });
      const refusedImport = await send({ name: "Beyond the limit" });
      expect(refusedImport.statusCode).toBe(409);
      const [{ count }] = await fixture.sql<
        { count: number }[]
      >`SELECT count(*)::int AS count FROM saved_list WHERE user_id = 'import-user'`;
      expect(count).toBe(500);
    });
    it("applies only one of two concurrent imports that together pass the place limit", async () => {
      await fixture.sql`DELETE FROM saved_list WHERE user_id = 'import-user'`;
      await fixture.sql`INSERT INTO saved_list (id, user_id, name) VALUES ('bulk', 'import-user', 'Bulk')`;
      await fixture.sql`INSERT INTO saved_place (id, list_id, name, lat, lng) SELECT 'bulk-' || n, 'bulk', 'Bulk ' || n, 10, 10 FROM generate_series(1, 49000) AS n`;
      const batch = (prefix: string) =>
        Array.from({ length: 600 }, (_, index) => ({
          name: `${prefix} ${index}`,
          lat: 40 + index / 1000,
          lng: 5,
        }));
      const imports = await Promise.all([
        send({ name: "Batch A" }, batch("A")),
        send({ name: "Batch B" }, batch("B")),
      ]);
      expect(imports.map((response) => response.statusCode).sort()).toEqual([200, 409]);
      expect(imports.find((response) => response.statusCode === 409)?.json()).toMatchObject({
        code: "SAVED_PLACE_LIMIT",
      });
      const [{ places }] = await fixture.sql<
        { places: number }[]
      >`SELECT count(*)::int AS places FROM saved_place JOIN saved_list ON saved_list.id = saved_place.list_id WHERE saved_list.user_id = 'import-user'`;
      expect(places).toBe(49_600);
      // The refused batch's new list was rolled back with it.
      const lists = await fixture.sql<
        { name: string }[]
      >`SELECT name FROM saved_list WHERE user_id = 'import-user' AND name LIKE 'Batch %'`;
      expect(lists).toHaveLength(1);
      const single = await app.inject({
        method: "POST",
        url: `/api/saved/lists/bulk/places`,
        payload: { name: "Fits", lat: 1, lng: 1 },
      });
      expect(single.statusCode).toBe(200);
      await fixture.sql`INSERT INTO saved_place (id, list_id, name, lat, lng) SELECT 'fill-' || n, 'bulk', 'Fill ' || n, 11, 11 FROM generate_series(1, 399) AS n`;
      const full = await app.inject({
        method: "POST",
        url: `/api/saved/lists/bulk/places`,
        payload: { name: "Over", lat: 1, lng: 1 },
      });
      expect(full.statusCode).toBe(409);
      expect(full.json()).toMatchObject({ code: "SAVED_PLACE_LIMIT" });
      await fixture.sql`DELETE FROM saved_list WHERE user_id = 'import-user'`;
    });
    it("does not import into another account's list", async () => {
      await fixture.db
        .insert(user)
        .values({ id: "other-import-user", name: "Other", email: "other-import@example.test" });
      await fixture.db
        .insert(savedList)
        .values({ id: "other-import-list", userId: "other-import-user", name: "Other" });
      expect((await send({ listId: "other-import-list" })).statusCode).toBe(404);
    });
    it("replaces a label atomically and keeps the old one when the new write fails", async () => {
      const writeLabel = (label: string, payload: object) =>
        app.inject({ method: "PUT", url: `/api/saved/labels/${label}`, payload });
      const labels = async () =>
        (
          await fixture.db
            .select({ label: labeledPlace.label, name: labeledPlace.name })
            .from(labeledPlace)
            .where(eq(labeledPlace.userId, "import-user"))
        ).map((row) => row.label);

      expect((await writeLabel("office", point)).statusCode).toBe(200);
      expect((await writeLabel("studio", { ...point, replaces: "office" })).statusCode).toBe(200);
      expect(await labels()).toEqual(["studio"]);

      await fixture.sql`CREATE FUNCTION label_test_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.name = 'Reject' THEN RAISE EXCEPTION 'test failure'; END IF; RETURN NEW; END $$`;
      await fixture.sql`CREATE TRIGGER label_test_reject BEFORE INSERT ON labeled_place FOR EACH ROW EXECUTE FUNCTION label_test_reject()`;
      const failed = await writeLabel("gym", { ...point, name: "Reject", replaces: "studio" });
      expect(failed.statusCode).toBe(500);
      expect(await labels()).toEqual(["studio"]);
    });
  },
);
