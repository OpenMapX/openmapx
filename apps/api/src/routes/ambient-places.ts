import { AMBIENT_LIMITS, type AmbientManifest } from "@openmapx/core/ambient-places";
import {
  readAmbientManifest,
  readAmbientTile,
  validAmbientTile,
} from "@openmapx/core/ambient-places-server";
import { dataManagerAdminOperations } from "@openmapx/core/api-contracts";
import * as dm from "@openmapx/core/data-manager-sdk";
import { envString } from "@openmapx/core/server-env";
import type { FastifyInstance } from "fastify";
import { sql } from "../db/index.js";
import { writeAuditLog } from "../utils/audit-log.js";
import { systemMaintenanceLimit } from "../utils/rate-limit.js";
import { getAdminSession, requireAdmin } from "../utils/require-admin.js";
import { declareRouteAuth } from "../utils/route-auth.js";
import { registerDataManagerAdminRoute } from "./data-manager-admin-contract.js";

interface AmbientRouteOptions {
  readManifest?: () => Promise<AmbientManifest | null>;
  readTile?: (generation: string, z: number, x: number, y: number) => Promise<Buffer | null>;
}
type AmbientAction = "status" | "build" | "enabled" | "rollback" | "resume" | "discard";
async function proxy(action: AmbientAction, body?: unknown) {
  const options = {
    transport: dm.createDataManagerTransport({
      baseUrl: envString("DATA_MANAGER_URL", "http://localhost:4000"),
      authToken: envString("DATA_MANAGER_AUTH_TOKEN", ""),
      maxJsonBytes: 256 * 1024,
      requestTimeoutMs: 15_000,
    }),
  };
  const operations = dataManagerAdminOperations;
  const response = await (() => {
    switch (action) {
      case "status":
        return dm.getAmbientPlacesStatus(options);
      case "build":
        return dm.buildAmbientPlaces(
          operations.postApiAdminAmbientPlacesBuild.request.body.parse(body),
          options,
        );
      case "enabled":
        return dm.setAmbientPlacesEnabled(
          operations.postApiAdminAmbientPlacesEnabled.request.body.parse(body),
          options,
        );
      case "rollback":
        return dm.rollbackAmbientPlaces(options);
      case "resume":
        return dm.resumeAmbientPlaces(
          operations.postApiAdminAmbientPlacesResume.request.body.parse(body),
          options,
        );
      case "discard":
        return dm.discardAmbientPlaces(
          operations.postApiAdminAmbientPlacesDiscard.request.body.parse(body),
          options,
        );
    }
  })();
  return { status: response.status, body: response.data };
}
export async function ambientPlacesRoute(
  app: FastifyInstance,
  options: AmbientRouteOptions,
): Promise<void> {
  declareRouteAuth(app, "public");
  let pending = 0;
  app.get("/ambient-places/manifest", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    try {
      return { manifest: await (options.readManifest ?? (() => readAmbientManifest(sql)))() };
    } catch (error) {
      request.log.warn(
        { errorClass: error instanceof Error ? error.name : "Unknown" },
        "Ambient discovery unavailable",
      );
      return reply.code(503).send({ error: "Ambient places temporarily unavailable" });
    }
  });
  app.get<{ Params: { generation: string; z: string; x: string; y: string } }>(
    "/ambient-places/tiles/:generation/:z/:x/:y.mvt",
    {
      schema: {
        params: {
          type: "object",
          required: ["generation", "z", "x", "y"],
          properties: {
            generation: { type: "string" },
            z: { type: "string" },
            x: { type: "string" },
            y: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      const { generation } = request.params;
      const { z, x, y } = Object.fromEntries(
        ["z", "x", "y"].map((k) => [k, Number(request.params[k as "z" | "x" | "y"])]),
      );
      if (
        ![request.params.z, request.params.x, request.params.y].every((v) => /^\d+$/.test(v)) ||
        !validAmbientTile(generation, z, x, y)
      )
        return reply.code(400).send({ error: "Invalid regional tile coordinates" });
      if (pending >= 8)
        return reply
          .code(429)
          .header("Retry-After", "1")
          .send({ error: "Ambient tile request budget exceeded" });
      pending++;
      try {
        const tile = await (options.readTile ?? ((g, z, x, y) => readAmbientTile(sql, g, z, x, y)))(
          generation,
          z,
          x,
          y,
        );
        if (tile === null) return reply.code(404).send({ error: "Unknown ambient generation" });
        if (tile.length > AMBIENT_LIMITS.tileBytes)
          throw new Error("Tile exceeds publication budget");
        return reply
          .type("application/vnd.mapbox-vector-tile")
          .header("Cache-Control", `public, max-age=${AMBIENT_LIMITS.cacheSeconds}, immutable`)
          .send(tile);
      } catch (error) {
        request.log.warn(
          { errorClass: error instanceof Error ? error.name : "Unknown" },
          "Ambient tile unavailable",
        );
        return reply.code(503).send({ error: "Ambient tile temporarily unavailable" });
      } finally {
        pending--;
      }
    },
  );
  await app.register(async (admin) => {
    declareRouteAuth(admin, "admin");
    admin.addHook("onRequest", async (request) => {
      request.adminSession = await requireAdmin(request);
    });
    const operations = {
      status: "getApiAdminAmbientPlacesStatus",
      build: "postApiAdminAmbientPlacesBuild",
      enabled: "postApiAdminAmbientPlacesEnabled",
      rollback: "postApiAdminAmbientPlacesRollback",
      resume: "postApiAdminAmbientPlacesResume",
      discard: "postApiAdminAmbientPlacesDiscard",
    } as const;
    for (const action of Object.keys(operations) as AmbientAction[]) {
      registerDataManagerAdminRoute(
        admin,
        operations[action],
        async (request, reply) => {
          reply.header("Cache-Control", "no-store");
          try {
            const result = await proxy(action, action === "status" ? undefined : request.body);
            if (action !== "status")
              await writeAuditLog({
                actorId: getAdminSession(request).user.id,
                action: `ambient-places.${action}`,
                targetType: "ambient-places",
                details: { status: result.status },
                request,
              });
            return reply.code(result.status).send(result.body);
          } catch (error) {
            request.log.warn(
              { errorClass: error instanceof Error ? error.name : "Unknown" },
              "Ambient operator service unavailable",
            );
            return reply.code(503).send({ error: "Ambient publication service unavailable" });
          }
        },
        {
          preHandler: ["build", "resume", "discard"].includes(action)
            ? systemMaintenanceLimit.preHandler()
            : undefined,
        },
      );
    }
  });
}
