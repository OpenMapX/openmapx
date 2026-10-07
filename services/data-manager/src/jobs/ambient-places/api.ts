import { type AmbientRegion, validateAmbientRegion } from "@openmapx/core/ambient-places";
import { readAmbientManifest } from "@openmapx/core/ambient-places-server";
import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import { buildAmbientPlaces, rollbackAmbientPlaces, setAmbientEnabled } from "./build.js";
import { AMBIENT_WRITE_LOCK, ensureAmbientSchema } from "./schema.js";

/** Mounted inside data-manager's bearer-token protected application. */
export function registerAmbientPlacesApi(app: FastifyInstance, sql: postgres.Sql): void {
  let building = false;
  app.get("/ambient-places/status", async () => {
    const active = await readAmbientManifest(sql);
    const [exists] = await sql.unsafe<{ exists: boolean }[]>(
      `SELECT to_regclass('ambient_places.state') IS NOT NULL AS exists`,
    );
    if (!exists.exists) return { active: null, previous: null, building, lastError: null };
    const [state] = await sql.unsafe<
      {
        previous: string | null;
        last_build_error: string | null;
        last_build_started_at: Date | null;
        last_build_finished_at: Date | null;
      }[]
    >(
      `SELECT previous,last_build_error,last_build_started_at,last_build_finished_at FROM ambient_places.state WHERE singleton=1`,
    );
    const [writer] = await sql.unsafe<{ busy: boolean }[]>(
      `SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=$1 AND granted) AS busy`,
      [AMBIENT_WRITE_LOCK],
    );
    return {
      active,
      previous: state.previous,
      building: building || writer.busy,
      lastError: state.last_build_error,
      startedAt: state.last_build_started_at,
      finishedAt: state.last_build_finished_at,
    };
  });
  app.post("/ambient-places/build", async (request, reply) => {
    let region: AmbientRegion;
    try {
      region = validateAmbientRegion(request.body);
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
    if (building) return reply.code(409).send({ error: "An ambient build is already running" });
    await ensureAmbientSchema(sql);
    building = true;
    try {
      await sql.unsafe(
        `UPDATE ambient_places.state SET last_build_started_at=now(),last_build_finished_at=NULL,last_build_error=NULL WHERE singleton=1`,
      );
    } catch (error) {
      building = false;
      throw error;
    }
    void buildAmbientPlaces(sql, region)
      .then(
        () =>
          sql.unsafe(
            `UPDATE ambient_places.state SET last_build_finished_at=now(),last_build_error=NULL WHERE singleton=1`,
          ),
        (error) => {
          app.log.warn(
            { errorClass: error instanceof Error ? error.name : "Unknown" },
            "Ambient publication failed; active generation retained",
          );
          return sql.unsafe(
            `UPDATE ambient_places.state SET last_build_finished_at=now(),last_build_error=$1 WHERE singleton=1`,
            [error instanceof Error ? error.message : "Publication failed"],
          );
        },
      )
      .catch((error) =>
        app.log.error(
          { errorClass: error instanceof Error ? error.name : "Unknown" },
          "Ambient job status could not be recorded",
        ),
      )
      .finally(() => {
        building = false;
      });
    return reply.code(202).send({ accepted: true });
  });
  app.post(
    "/ambient-places/enabled",
    {
      schema: {
        body: {
          type: "object",
          required: ["enabled"],
          additionalProperties: false,
          properties: { enabled: { type: "boolean" } },
        },
      },
    },
    async (request, reply) => {
      try {
        await setAmbientEnabled(sql, (request.body as { enabled: boolean }).enabled);
        return { ok: true };
      } catch (error) {
        return reply.code(409).send({ error: (error as Error).message });
      }
    },
  );
  app.post("/ambient-places/rollback", async (_request, reply) => {
    try {
      await rollbackAmbientPlaces(sql);
      return { ok: true };
    } catch (error) {
      return reply.code(409).send({ error: (error as Error).message });
    }
  });
}
