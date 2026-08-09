import type { ConnectPersonalTimelineRequest } from "@openmapx/core";
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import {
  TimelineConnectionError,
  type TimelineConnectionErrorCode,
  timelineConnectionService,
} from "../services/dawarich/connection-service.js";
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

function sendTimelineError(reply: FastifyReply, error: unknown) {
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
  return reply.status(response.status).send({
    error: response.message,
    code: safeError.code,
    ...(retryAfterSeconds === null ? {} : { retryAfterSeconds }),
  });
}

export const timelineRoute: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("onRequest", async (_request, reply) => {
    reply.header("Cache-Control", "private, no-store");
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
      return sendTimelineError(reply, error);
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
      return sendTimelineError(reply, error);
    }
  });

  fastify.post("/timeline/connection/test", async (request, reply) => {
    try {
      return await timelineConnectionService.testConnection(getUserId(request));
    } catch (error) {
      return sendTimelineError(reply, error);
    }
  });

  fastify.delete("/timeline/connection", async (request, reply) => {
    try {
      await timelineConnectionService.deleteConnection(getUserId(request));
      return { ok: true };
    } catch (error) {
      return sendTimelineError(reply, error);
    }
  });
};
