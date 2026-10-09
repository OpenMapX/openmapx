import { readBoundedResponseText } from "@openmapx/core";
import {
  AMBIENT_LIMITS,
  type AmbientManifest,
  validateAmbientRegion,
} from "@openmapx/core/ambient-places";
import {
  readAmbientManifest,
  readAmbientTile,
  validAmbientTile,
} from "@openmapx/core/ambient-places-server";
import { services } from "@openmapx/core/server";
import { envString } from "@openmapx/core/server-env";
import type { FastifyInstance } from "fastify";
import { sql } from "../db/index.js";
import { writeAuditLog } from "../utils/audit-log.js";
import { systemMaintenanceLimit } from "../utils/rate-limit.js";
import { getAdminSession, requireAdmin } from "../utils/require-admin.js";
import { declareRouteAuth } from "../utils/route-auth.js";

interface AmbientRouteOptions {
  readManifest?: () => Promise<AmbientManifest | null>;
  readTile?: (generation: string, z: number, x: number, y: number) => Promise<Buffer | null>;
}
async function proxy(method: "GET" | "POST", action: string, body?: unknown) {
  const base = services.validateDataManagerBaseUrl(
    envString("DATA_MANAGER_URL", "http://localhost:4000"),
  );
  const response = await fetch(`${base}/ambient-places/${action}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${envString("DATA_MANAGER_AUTH_TOKEN", "")}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  const text = await readBoundedResponseText(response, 256 * 1024, {
    label: "ambient operator response",
  });
  return { status: response.status, body: JSON.parse(text) };
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
    for (const action of ["status", "build", "enabled", "rollback"] as const) {
      admin.route({
        method: action === "status" ? "GET" : "POST",
        url: `/admin/ambient-places/${action}`,
        schema:
          action === "build"
            ? {
                body: {
                  type: "object",
                  required: ["name", "bounds"],
                  additionalProperties: false,
                  properties: {
                    name: { type: "string", minLength: 1, maxLength: 80 },
                    coverage: { type: "string", enum: ["germany"] },
                    bounds: { type: "array", minItems: 4, maxItems: 4, items: { type: "number" } },
                  },
                },
              }
            : action === "enabled"
              ? {
                  body: {
                    type: "object",
                    required: ["enabled"],
                    additionalProperties: false,
                    properties: { enabled: { type: "boolean" } },
                  },
                }
              : undefined,
        preHandler: action === "build" ? systemMaintenanceLimit.preHandler() : undefined,
        handler: async (request, reply) => {
          reply.header("Cache-Control", "no-store");
          if (action === "build")
            try {
              validateAmbientRegion(request.body);
            } catch (error) {
              return reply.code(400).send({ error: (error as Error).message });
            }
          if (
            action === "enabled" &&
            typeof (request.body as { enabled?: unknown })?.enabled !== "boolean"
          )
            return reply.code(400).send({ error: "enabled must be a boolean" });
          try {
            const result = await proxy(
              action === "status" ? "GET" : "POST",
              action,
              action === "status" ? undefined : request.body,
            );
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
      });
    }
  });
}
