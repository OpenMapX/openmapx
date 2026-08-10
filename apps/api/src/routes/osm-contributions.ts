/**
 * The authenticated HTTP surface for OpenStreetMap place contributions.
 *
 * Routes do three things and nothing else: authenticate, parse the request
 * against the shared contract, and translate the service's typed failure into
 * the shared safe body. No handler builds a tag, a URL or a coordinate, and no
 * upstream exception is ever serialized to a client.
 */
import {
  osmCategorySearchQuerySchema,
  osmContributionPreviewRequestSchema,
  osmContributionPublishRequestSchema,
  osmElementRefSchema,
  osmLocaleSchema,
  osmNoteRequestSchema,
} from "@openmapx/core";
import { fromNodeHeaders } from "better-auth/node";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type {
  OsmContributionService,
  OsmRequestContext,
} from "../services/osm-contributions/service.js";
import { isOsmContributionError } from "../services/osm-contributions/types.js";
import {
  osmContributionNoteLimit,
  osmContributionPreviewLimit,
  osmContributionPublishLimit,
  osmContributionReadLimit,
} from "../utils/rate-limit.js";
import { getUserId, requireAuthHook } from "../utils/require-auth.js";

/** 32 KiB is far above a legitimate curated edit and far below an upload. */
const BODY_LIMIT_BYTES = 32 * 1024;

const localeQuerySchema = z.object({ locale: osmLocaleSchema.default("en") });

function requestContext(request: FastifyRequest): OsmRequestContext {
  return {
    headers: fromNodeHeaders(request.headers),
    userId: getUserId(request),
    requestId: request.id,
  };
}

function sendTypedError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
): FastifyReply {
  if (isOsmContributionError(error)) {
    if (error.retryAfterSeconds !== undefined) {
      reply.header("Retry-After", String(error.retryAfterSeconds));
    }
    return reply.status(error.status).send({
      code: error.code,
      message: error.message,
      ...(error.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: error.retryAfterSeconds }),
      ...(error.context ? { context: error.context } : {}),
      ...(error.inspect ? { inspect: error.inspect } : {}),
    });
  }
  // Unexpected: log a correlation id and a closed operation code only.
  request.log.error(
    { event: "osm_contribution_unexpected_error", requestId: request.id },
    "osm contribution failed",
  );
  return reply.status(500).send({ code: "OSM_UNAVAILABLE", message: "Something went wrong." });
}

function badRequest(reply: FastifyReply, message: string): FastifyReply {
  return reply.status(400).send({ code: "INVALID_CHANGE", message });
}

export interface OsmContributionsRouteOptions {
  /** Injected in tests; production builds the real dependency graph. */
  service?: OsmContributionService;
}

export function osmContributionsRoute(
  options: OsmContributionsRouteOptions = {},
): FastifyPluginAsync {
  return async (fastify) => {
    // Imported lazily so a test that injects a service does not pull in the
    // production auth/Redis graph just by importing this module.
    const service =
      options.service ??
      (await import("../services/osm-contributions/index.js")).createOsmContributionsService();

    // Every contribution route is per-user. Authenticate once at plugin scope
    // so no handler can forget it, and register the user-keyed limiters after
    // that hook so `request.userId` is already set when they derive a bucket.
    fastify.addHook("preHandler", requireAuthHook);

    fastify.get(
      "/osm/contributions/capabilities",
      { preHandler: osmContributionReadLimit.preHandler() },
      async (request, reply) => {
        try {
          return await reply.send(await service.getCapabilities(requestContext(request)));
        } catch (error) {
          return sendTypedError(request, reply, error);
        }
      },
    );

    fastify.get(
      "/osm/contributions/categories",
      { preHandler: osmContributionReadLimit.preHandler() },
      async (request, reply) => {
        const query = osmCategorySearchQuerySchema.safeParse(request.query);
        if (!query.success) return badRequest(reply, "Invalid category search.");
        try {
          return await reply.send(
            await service.suggestCategories(requestContext(request), query.data),
          );
        } catch (error) {
          return sendTypedError(request, reply, error);
        }
      },
    );

    fastify.get(
      "/osm/contributions/:type/:id",
      { preHandler: osmContributionReadLimit.preHandler() },
      async (request, reply) => {
        const ref = osmElementRefSchema.safeParse(request.params);
        if (!ref.success) return badRequest(reply, "Invalid element reference.");
        const query = localeQuerySchema.safeParse(request.query ?? {});
        if (!query.success) return badRequest(reply, "Invalid locale.");
        try {
          return await reply.send(
            await service.getContext(requestContext(request), ref.data, query.data.locale),
          );
        } catch (error) {
          return sendTypedError(request, reply, error);
        }
      },
    );

    fastify.post(
      "/osm/contributions/preview",
      { bodyLimit: BODY_LIMIT_BYTES, preHandler: osmContributionPreviewLimit.preHandler() },
      async (request, reply) => {
        const body = osmContributionPreviewRequestSchema.safeParse(request.body);
        if (!body.success) return badRequest(reply, "Invalid contribution.");
        try {
          return await reply.send(await service.preview(requestContext(request), body.data));
        } catch (error) {
          return sendTypedError(request, reply, error);
        }
      },
    );

    fastify.post(
      "/osm/contributions/publish",
      { bodyLimit: BODY_LIMIT_BYTES, preHandler: osmContributionPublishLimit.preHandler() },
      async (request, reply) => {
        const body = osmContributionPublishRequestSchema.safeParse(request.body);
        if (!body.success) return badRequest(reply, "Invalid contribution.");
        try {
          return await reply.send(await service.publish(requestContext(request), body.data));
        } catch (error) {
          return sendTypedError(request, reply, error);
        }
      },
    );

    fastify.post(
      "/osm/contributions/notes",
      { bodyLimit: BODY_LIMIT_BYTES, preHandler: osmContributionNoteLimit.preHandler() },
      async (request, reply) => {
        const body = osmNoteRequestSchema.safeParse(request.body);
        if (!body.success) return badRequest(reply, "Invalid note.");
        try {
          return await reply.send(await service.createNote(requestContext(request), body.data));
        } catch (error) {
          return sendTypedError(request, reply, error);
        }
      },
    );
  };
}
