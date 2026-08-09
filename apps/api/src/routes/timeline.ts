import type { ConnectPersonalTimelineRequest } from "@openmapx/core";
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import { applyTimelinePrivacyHeaders } from "../server-wiring.js";
import {
  TimelineConnectionError,
  type TimelineConnectionErrorCode,
  timelineConnectionService,
} from "../services/dawarich/connection-service.js";
import { timelineDayService } from "../services/dawarich/day-service.js";
import { getUserId, requireAuthHook } from "../utils/require-auth.js";

const MAX_API_KEY_BYTES = 4 * 1024;
const MAX_INSTANCE_URL_BYTES = 2 * 1024;

const boundedBytes = (maxBytes: number) =>
  z
    .string()
    .min(1)
    .refine((value) => Buffer.byteLength(value, "utf8") <= maxBytes);

const connectRequestSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("external"),
      instanceUrl: boundedBytes(MAX_INSTANCE_URL_BYTES),
      apiKey: boundedBytes(MAX_API_KEY_BYTES),
      displayName: z
        .string()
        .refine((value) => [...value].length <= 100)
        .optional(),
    })
    .strict(),
  z
    .object({
      mode: z.literal("managed"),
      apiKey: boundedBytes(MAX_API_KEY_BYTES),
    })
    .strict(),
]);

const dayDateSchema = z.iso.date();

const errorResponses: Record<TimelineConnectionErrorCode, { status: number; message: string }> = {
  TIMELINE_NOT_CONNECTED: { status: 400, message: "Timeline is not connected" },
  TIMELINE_MANAGED_DISABLED: { status: 503, message: "Managed timeline is unavailable" },
  TIMELINE_CREDENTIAL_INVALID: { status: 422, message: "Timeline credential is invalid" },
  TIMELINE_INSTANCE_UNSUPPORTED: {
    status: 400,
    message: "Timeline instance is not supported",
  },
  TIMELINE_PLAN_RESTRICTED: { status: 422, message: "Timeline access is restricted" },
  TIMELINE_RATE_LIMITED: { status: 429, message: "Timeline source is rate limited" },
  TIMELINE_UPSTREAM_UNAVAILABLE: { status: 503, message: "Timeline source is unavailable" },
  TIMELINE_RESPONSE_INVALID: {
    status: 502,
    message: "Timeline source returned an invalid response",
  },
};

const dayErrorStatuses: Record<TimelineConnectionErrorCode, number> = {
  TIMELINE_NOT_CONNECTED: 404,
  TIMELINE_MANAGED_DISABLED: 409,
  TIMELINE_CREDENTIAL_INVALID: 422,
  TIMELINE_INSTANCE_UNSUPPORTED: 422,
  TIMELINE_PLAN_RESTRICTED: 422,
  TIMELINE_RATE_LIMITED: 429,
  TIMELINE_UPSTREAM_UNAVAILABLE: 503,
  TIMELINE_RESPONSE_INVALID: 502,
};

function sendTimelineError(reply: FastifyReply, error: unknown, route: "connection" | "day") {
  const safeError =
    error instanceof TimelineConnectionError
      ? error
      : new TimelineConnectionError("TIMELINE_UPSTREAM_UNAVAILABLE");
  const response = errorResponses[safeError.code];
  const retryAfterSeconds =
    safeError.code === "TIMELINE_RATE_LIMITED" &&
    safeError.retryAfterSeconds !== null &&
    Number.isInteger(safeError.retryAfterSeconds) &&
    safeError.retryAfterSeconds >= 0 &&
    safeError.retryAfterSeconds <= 86_400
      ? safeError.retryAfterSeconds
      : null;
  if (retryAfterSeconds !== null) reply.header("Retry-After", String(retryAfterSeconds));
  return reply.status(route === "day" ? dayErrorStatuses[safeError.code] : response.status).send({
    error: response.message,
    code: safeError.code,
    ...(retryAfterSeconds === null ? {} : { retryAfterSeconds }),
  });
}

export const timelineRoute: FastifyPluginAsync = async (fastify) => {
  fastify.setErrorHandler((error, request, reply) => {
    const errorFields =
      typeof error === "object" && error !== null
        ? (error as { code?: unknown; statusCode?: unknown })
        : {};
    const errorCode = typeof errorFields.code === "string" ? errorFields.code : null;
    const errorStatusCode =
      typeof errorFields.statusCode === "number" && Number.isInteger(errorFields.statusCode)
        ? errorFields.statusCode
        : null;
    applyTimelinePrivacyHeaders(reply);
    if (errorCode?.startsWith("FST_ERR_CTP_")) {
      // Preserve protocol-meaningful parser statuses (400 malformed JSON,
      // 413 body limit, 415 media type), while replacing every parser message
      // with one stable redacted timeline error.
      const statusCode =
        errorStatusCode && errorStatusCode >= 400 && errorStatusCode < 500 ? errorStatusCode : 400;
      return reply.status(statusCode).send({
        error: "Invalid timeline request",
        code: "TIMELINE_INSTANCE_UNSUPPORTED",
      });
    }
    if (errorStatusCode === 401) {
      return reply.status(401).send({ error: "Authentication required", code: "UNAUTHORIZED" });
    }
    request.log.error({ errorCode, statusCode: errorStatusCode ?? 500 }, "Timeline request error");
    return reply.status(503).send({
      error: "Timeline source is unavailable",
      code: "TIMELINE_UPSTREAM_UNAVAILABLE",
    });
  });
  fastify.addHook("onRequest", async (_request, reply) => {
    applyTimelinePrivacyHeaders(reply);
  });
  fastify.addHook("preHandler", async (request, reply) => {
    try {
      await requireAuthHook(request);
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode !== 401) throw error;
      return reply.status(401).send({ error: "Authentication required", code: "UNAUTHORIZED" });
    }
  });

  fastify.get("/timeline/connection", async (request, reply) => {
    try {
      return await timelineConnectionService.getConnectionView(getUserId(request));
    } catch (error) {
      return sendTimelineError(reply, error, "connection");
    }
  });

  fastify.put("/timeline/connection", async (request, reply) => {
    const parsed = connectRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid timeline connection request",
        code: "TIMELINE_INSTANCE_UNSUPPORTED",
      });
    }
    try {
      return await timelineConnectionService.connect(
        getUserId(request),
        parsed.data as ConnectPersonalTimelineRequest,
      );
    } catch (error) {
      return sendTimelineError(reply, error, "connection");
    }
  });

  fastify.post("/timeline/connection/test", async (request, reply) => {
    try {
      return await timelineConnectionService.testConnection(getUserId(request));
    } catch (error) {
      return sendTimelineError(reply, error, "connection");
    }
  });

  fastify.delete("/timeline/connection", async (request, reply) => {
    try {
      await timelineConnectionService.deleteConnection(getUserId(request));
      return { ok: true };
    } catch (error) {
      return sendTimelineError(reply, error, "connection");
    }
  });

  fastify.get<{ Params: { date: string } }>(
    "/timeline/day/:date",
    { logLevel: "silent" },
    async (request, reply) => {
      const parsed = dayDateSchema.safeParse(request.params.date);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "Invalid timeline date",
          code: "TIMELINE_RESPONSE_INVALID",
        });
      }
      try {
        return await timelineDayService.getPersonalTimelineDay(getUserId(request), parsed.data);
      } catch (error) {
        return sendTimelineError(reply, error, "day");
      }
    },
  );
};
