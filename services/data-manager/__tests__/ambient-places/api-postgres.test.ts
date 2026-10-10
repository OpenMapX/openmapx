import { readAmbientManifest } from "@openmapx/core/ambient-places-server";
import Fastify from "fastify";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { registerAmbientPlacesApi } from "../../src/jobs/ambient-places/api.js";
import {
  buildSearchIndexIndexesDDL,
  buildSearchIndexSchemaDDL,
} from "../../src/jobs/search-index/schema.js";
import { startPostgis } from "../helpers/postgis-testcontainer.js";

const request = {
  method: "POST" as const,
  url: "/ambient-places/build",
  payload: { name: "Aachen", bounds: [5.9, 50.65, 6.3, 50.95] },
};
describe.skipIf(process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1")(
  "ambient operator admission",
  () => {
    it("rejects competing API instances without aborting the winning repeatable-read build", async () => {
      const pg = await startPostgis();
      const barrier = postgres(pg.connectionString, { max: 1 });
      const coldSql = postgres(pg.connectionString, { max: 2 });
      const cold = Fastify();
      registerAmbientPlacesApi(cold, coldSql);
      const a = Fastify();
      const b = Fastify();
      registerAmbientPlacesApi(a, pg.sql);
      registerAmbientPlacesApi(b, pg.sql);
      try {
        await pg.sql.unsafe(
          buildSearchIndexSchemaDDL("osm_search") + buildSearchIndexIndexesDDL("osm_search"),
        );
        await pg.sql.unsafe(`INSERT INTO osm_search.index_state(singleton,region,source_path,source_fingerprint,current_fingerprint,epoch,status,started_at,published_at,updated_at) VALUES(1,'aachen','fixture','fixture','fixture','admission','ready',now(),now(),now());
        INSERT INTO osm_search.places(osm_type,osm_id,name,lat,lng,category,tags,importance) VALUES('node',1,'Clinic',50.77,6.08,'amenity:hospital','{}',0.8)`);
        // Initialize the dedicated schema without accepting a publication.
        const { ensureAmbientSchema } = await import("../../src/jobs/ambient-places/schema.js");
        await ensureAmbientSchema(pg.sql);
        await pg.sql.unsafe(`CREATE FUNCTION ambient_places.hold_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(399401); RETURN NEW; END $$;
        CREATE TRIGGER hold_fixture BEFORE INSERT ON ambient_places.features FOR EACH ROW EXECUTE FUNCTION ambient_places.hold_fixture()`);
        await barrier.unsafe(`SELECT pg_advisory_lock(399401)`);
        let competingStatus: number;
        let sameProcessStatus: number;
        let coldStatus: number;
        try {
          expect((await a.inject(request)).statusCode).toBe(202);
          const deadline = Date.now() + 10_000;
          while (true) {
            const [lock] = await pg.sql.unsafe<{ blocked: boolean }[]>(
              `SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=399401 AND NOT granted) AS blocked`,
            );
            if (lock.blocked) break;
            if (Date.now() > deadline)
              throw new Error("Publication did not reach the fixture barrier");
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          competingStatus = (await b.inject(request)).statusCode;
          sameProcessStatus = (await a.inject(request)).statusCode;
          coldStatus = (await cold.inject(request)).statusCode;
        } finally {
          await barrier.unsafe(`SELECT pg_advisory_unlock(399401)`);
        }
        const deadline = Date.now() + 10_000;
        let status: { building: boolean; lastError: string | null };
        do {
          status = (await a.inject({ method: "GET", url: "/ambient-places/status" })).json();
          if (!status.building) break;
          if (Date.now() > deadline) throw new Error("Winning publication did not finish");
          await new Promise((resolve) => setTimeout(resolve, 10));
        } while (status.building);
        expect(competingStatus).toBe(409);
        expect(sameProcessStatus).toBe(409);
        expect(coldStatus).toBe(409);
        expect((await readAmbientManifest(pg.sql))?.placeCount).toBe(1);
        expect(status.lastError).toBeNull();
      } finally {
        await cold.close();
        await coldSql.end({ timeout: 2 });
        await barrier.end({ timeout: 2 });
        await a.close();
        await b.close();
        await pg.stop();
      }
    }, 120_000);
  },
);
