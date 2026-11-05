import { randomUUID } from "node:crypto";
import {
  type AmbientBuildProgress,
  type AmbientRegion,
  validateAmbientRegion,
} from "@openmapx/core/ambient-places";
import { readAmbientManifest } from "@openmapx/core/ambient-places-server";
import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import { registerDataManagerRoute } from "../../route-contract.js";
import { withLegacyDataMutation } from "../execution/legacy-mutation.js";
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
  registerDataManagerRoute(app, "getAmbientPlacesStatus", async () => {
    const active = await readAmbientManifest(sql);
    const stage = await readPlanetStage(sql);
    const candidate = stage
      ? {
          ...stage,
          startedAt: new Date(stage.startedAt).toISOString(),
          updatedAt: new Date(stage.updatedAt).toISOString(),
        }
      : null;
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
        last_build_started_at: Date | string | null;
        last_build_finished_at: Date | string | null;
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
      attribution: active
        ? {
            formatVersion: active.version,
            precision: active.attributionPrecision ?? "legacy-aggregate",
            rebuildRequired:
              active.version === 1 || active.attributionPrecision !== "captured-fields",
          }
        : null,
      previous: state.previous,
      building: Boolean(building) || writer.busy,
      lastError: state.last_build_error,
      // Drizzle installs transparent timestamp parsers on the shared sql
      // client; isolated clients can still return Date objects. Normalize both
      // representations before validating the JSON wire timestamp contract.
      startedAt:
        state.last_build_started_at === null
          ? null
          : new Date(state.last_build_started_at).toISOString(),
      finishedAt:
        state.last_build_finished_at === null
          ? null
          : new Date(state.last_build_finished_at).toISOString(),
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
    void withLegacyDataMutation(
      "ambient-publication",
      () =>
        job(
          () => {
            claimed = true;
            accept();
          },
          {
            onProgress: (value) => {
              if (building === attempt) progress = value;
            },
          },
        ),
      sql,
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
  registerDataManagerRoute(app, "buildAmbientPlaces", async (request, reply) => {
    let region: AmbientRegion;
    try {
      region = validateAmbientRegion(request.body);
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
    return start((claim, options) => buildAmbientPlaces(sql, region, claim, options), reply);
  });
  for (const action of ["resume", "discard"] as const) {
    registerDataManagerRoute(
      app,
      action === "resume" ? "resumeAmbientPlaces" : "discardAmbientPlaces",
      async (request, reply) => {
        const { generation } = request.body;
        if (action === "resume")
          return start(
            (claim, options) => resumePlanetPlaces(sql, generation, claim, options),
            reply,
          );
        if (building) return reply.code(409).send({ error: "An ambient build is already running" });
        try {
          await withLegacyDataMutation(
            "ambient-publication",
            () => discardPlanetPlaces(sql, generation),
            sql,
          );
          return { ok: true };
        } catch (error) {
          return reply.code(409).send({ error: (error as Error).message });
        }
      },
    );
  }
  registerDataManagerRoute(app, "setAmbientPlacesEnabled", async (request, reply) => {
    try {
      await withLegacyDataMutation(
        "ambient-publication",
        () => setAmbientEnabled(sql, request.body.enabled),
        sql,
      );
      return { ok: true };
    } catch (error) {
      return reply.code(409).send({ error: (error as Error).message });
    }
  });
  registerDataManagerRoute(app, "rollbackAmbientPlaces", async (_request, reply) => {
    try {
      await withLegacyDataMutation("ambient-publication", () => rollbackAmbientPlaces(sql), sql);
      return { ok: true };
    } catch (error) {
      return reply.code(409).send({ error: (error as Error).message });
    }
  });
}
