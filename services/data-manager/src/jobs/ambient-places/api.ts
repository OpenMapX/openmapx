import { randomUUID } from "node:crypto";
import {
  AMBIENT_GENERATION_PATTERN,
  type AmbientBuildProgress,
  type AmbientRegion,
  validateAmbientRegion,
} from "@openmapx/core/ambient-places";
import { readAmbientManifest } from "@openmapx/core/ambient-places-server";
import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import {
  buildAmbientPlaces,
  discardPlanetPlaces,
  resumePlanetPlaces,
  rollbackAmbientPlaces,
  setAmbientEnabled,
} from "./build.js";
import { readPlanetStage } from "./planet-state.js";
import { AMBIENT_WRITE_LOCK, AmbientPublicationBusyError } from "./schema.js";

/** Mounted inside data-manager's bearer-token protected application. */
export function registerAmbientPlacesApi(app: FastifyInstance, sql: postgres.Sql): void {
  let building: string | null = null;
  let progress: AmbientBuildProgress | null = null;
  app.get("/ambient-places/status", async () => {
    const active = await readAmbientManifest(sql);
    const candidate = await readPlanetStage(sql);
    const [exists] = await sql.unsafe<{ exists: boolean }[]>(
      `SELECT to_regclass('ambient_places.state') IS NOT NULL AS exists`,
    );
    if (!exists.exists)
      return {
        active: null,
        previous: null,
        building: Boolean(building),
        lastError: null,
        progress,
        candidate,
      };
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
      `SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND classid=0 AND objsubid=1 AND objid=$1 AND granted) AS busy`,
      [AMBIENT_WRITE_LOCK],
    );
    return {
      active,
      previous: state.previous,
      building: Boolean(building) || writer.busy,
      lastError: state.last_build_error,
      startedAt: state.last_build_started_at,
      finishedAt: state.last_build_finished_at,
      progress: progress ?? candidate?.checkpoint ?? null,
      candidate,
    };
  });
  async function start(
    job: (
      claim: () => void,
      options: { onProgress: (p: AmbientBuildProgress) => void },
    ) => Promise<unknown>,
    reply: import("fastify").FastifyReply,
  ) {
    if (building) return reply.code(409).send({ error: "An ambient build is already running" });
    // Claim the local slot before the first await. Cross-process admission is
    // acknowledged only once the publisher has acquired the database lock.
    const attempt = randomUUID();
    building = attempt;
    progress = null;
    let claimed = false;
    let accept!: () => void;
    let reject!: (error: unknown) => void;
    const admission = new Promise<void>((resolve, rejectPromise) => {
      accept = resolve;
      reject = rejectPromise;
    });
    void job(
      () => {
        claimed = true;
        accept();
      },
      {
        onProgress: (value) => {
          if (building === attempt) progress = value;
        },
      },
    )
      .catch((error) => {
        if (!claimed) {
          if (building === attempt) building = null;
          reject(error);
        }
        app.log.warn(
          { errorClass: error instanceof Error ? error.name : "Unknown" },
          "Ambient publication failed; active generation retained",
        );
      })
      .finally(() => {
        if (building === attempt) {
          building = null;
          progress = null;
        }
      });
    try {
      await admission;
    } catch (error) {
      if (error instanceof AmbientPublicationBusyError)
        return reply.code(409).send({ error: error.message });
      throw error;
    }
    return reply.code(202).send({ accepted: true });
  }
  app.post("/ambient-places/build", async (request, reply) => {
    let region: AmbientRegion;
    try {
      region = validateAmbientRegion(request.body);
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
    return start((claim, options) => buildAmbientPlaces(sql, region, claim, options), reply);
  });
  for (const action of ["resume", "discard"] as const) {
    app.post(
      `/ambient-places/${action}`,
      {
        schema: {
          body: {
            type: "object",
            required: ["generation"],
            additionalProperties: false,
            properties: { generation: { type: "string", pattern: AMBIENT_GENERATION_PATTERN } },
          },
        },
      },
      async (request, reply) => {
        const { generation } = request.body as { generation: string };
        if (action === "resume")
          return start(
            (claim, options) => resumePlanetPlaces(sql, generation, claim, options),
            reply,
          );
        if (building) return reply.code(409).send({ error: "An ambient build is already running" });
        try {
          await discardPlanetPlaces(sql, generation);
          return { ok: true };
        } catch (error) {
          return reply.code(409).send({ error: (error as Error).message });
        }
      },
    );
  }
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
