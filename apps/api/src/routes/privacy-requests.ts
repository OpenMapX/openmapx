import { fromNodeHeaders } from "better-auth/node";
import { eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { auth } from "../auth.js";
import { db } from "../db/index.js";
import { dataSubjectRequestTask } from "../db/schema.js";
import { PrivacyRequestError, privacyErrorReply } from "../privacy/errors.js";
import { exportResponseHeaders, pumpExport } from "../privacy/export-response.js";
import { selfServiceExportSchema } from "../privacy/request-contracts.js";
import { PrivacyRequestService } from "../privacy/request-service.js";
import { hasFreshAssurance } from "../privacy/session-assurance.js";
import {
  type PreparedSubjectExport,
  type PrepareSubjectExportOptions,
  prepareSubjectExport,
} from "../privacy/subject-export.js";
import { getUserId, requireAuthHook } from "../utils/require-auth.js";
import { declareRouteAuth } from "../utils/route-auth.js";

export interface PrivacyRequestsRouteOptions {
  service?: PrivacyRequestService;
  database?: typeof db;
  /** Collector settings for the export; tests replace the external sources. */
  exportSources?: Pick<PrepareSubjectExportOptions, "openmapx" | "dawarich">;
}

function publicRequest(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    kind: row.kind,
    channel: row.channel,
    state: row.state,
    locale: row.locale,
    timeZone: row.timeZone,
    receivedAt: row.receivedAt,
    registeredAt: row.registeredAt,
    snapshotAt: row.snapshotAt,
    dueAt: row.dueAt,
    extension: row.extension,
    identityMethod: row.identityMethod,
    refusalCode: row.refusalCode,
    completedAt: row.completedAt,
    closedAt: row.closedAt,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function requireIdempotencyKey(request: {
  headers: { [key: string]: string | string[] | undefined };
}): string {
  const raw = request.headers["idempotency-key"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || !/^[A-Za-z0-9][A-Za-z0-9._~-]{15,127}$/.test(value))
    throw new PrivacyRequestError("IDEMPOTENCY_KEY_REQUIRED", 400);
  return value;
}

export const privacyRequestsRoute: FastifyPluginAsync<PrivacyRequestsRouteOptions> = async (
  fastify,
  options,
) => {
  declareRouteAuth(fastify, "session");
  fastify.addHook("onRequest", requireAuthHook);
  fastify.addHook("onSend", async (_request, reply, payload) => {
    reply.header("Cache-Control", "private, no-store");
    reply.header("Pragma", "no-cache");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    return payload;
  });
  const database = options.database ?? db;
  const serviceForRequest = () => options.service ?? new PrivacyRequestService({ database });

  /**
   * The self-service export. A recent interactive sign-in is the identity
   * proof; without one the answer is 401 FRESH_SIGN_IN_REQUIRED and the web
   * app sends the person through a new sign-in. Every step that can fail runs
   * before the headers are written; the ZIP then streams straight into the
   * response.
   */
  fastify.post<{ Body: unknown }>("/privacy/export", async (request, reply) => {
    const service = serviceForRequest();
    let requestId: string | undefined;
    let prepared: PreparedSubjectExport;
    let userId: string;
    try {
      const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
      if (!session || session.user.id !== getUserId(request))
        throw new PrivacyRequestError("AUTHENTICATION_REQUIRED", 401);
      userId = session.user.id;
      const fresh = await hasFreshAssurance(
        {
          sessionId: session.session.id,
          userId,
          mfaConfigured: session.user.twoFactorEnabled === true,
        },
        database,
      );
      if (!fresh) throw new PrivacyRequestError("FRESH_SIGN_IN_REQUIRED", 401);
      const body = selfServiceExportSchema.parse(request.body ?? {});
      const row = await service.beginSelfServiceExport({
        userId,
        sessionId: session.session.id,
        ...body,
      });
      requestId = row.id;
      prepared = await prepareSubjectExport({
        request: row,
        subjectUserId: row.userId,
        database,
        ...(options.exportSources ?? {}),
      });
    } catch (error) {
      if (requestId)
        await service
          .recordExportFailure(requestId, "export-preparation-failed")
          .catch(() => undefined);
      return privacyErrorReply(reply, error);
    }
    const exportRequestId = requestId;
    const { body, delivered } = pumpExport(prepared, reply.raw);
    // After the headers the request stays in progress unless every byte
    // arrives, so an interrupted download can simply be retried.
    void delivered
      .then(async (ok) => {
        if (ok) await service.finishExport(exportRequestId, { kind: "subject", id: userId });
        else await service.recordExportFailure(exportRequestId, "export-interrupted");
      })
      .catch((error: unknown) =>
        request.log.error({ err: error }, "failed to record the privacy export outcome"),
      );
    reply.headers(exportResponseHeaders(prepared.filename));
    return reply.send(body);
  });

  fastify.get("/privacy/data-requests", async (request, reply) => {
    try {
      const rows = await serviceForRequest().listForUser(getUserId(request));
      return reply.send({
        requests: rows.map((row) => publicRequest(row as unknown as Record<string, unknown>)),
      });
    } catch (error) {
      return privacyErrorReply(reply, error);
    }
  });

  fastify.get<{ Params: { requestId: string } }>(
    "/privacy/data-requests/:requestId",
    async (request, reply) => {
      try {
        if (!/^[0-9a-f-]{36}$/i.test(request.params.requestId))
          throw new PrivacyRequestError("REQUEST_NOT_FOUND", 404);
        const row = await serviceForRequest().getForUser(
          request.params.requestId,
          getUserId(request),
        );
        const tasks = await database
          .select({
            registrationId: dataSubjectRequestTask.registrationId,
            status: dataSubjectRequestTask.status,
          })
          .from(dataSubjectRequestTask)
          .where(eq(dataSubjectRequestTask.requestId, row.id));
        return reply.send({ ...publicRequest(row as unknown as Record<string, unknown>), tasks });
      } catch (error) {
        return privacyErrorReply(reply, error);
      }
    },
  );

  fastify.post<{ Params: { requestId: string }; Body: { version?: unknown } }>(
    "/privacy/data-requests/:requestId/withdraw",
    async (request, reply) => {
      try {
        const idempotencyKey = requireIdempotencyKey(request);
        const version = Number(request.body?.version);
        if (!Number.isSafeInteger(version) || version < 1)
          throw new PrivacyRequestError("INVALID_VERSION", 400);
        if (!/^[0-9a-f-]{36}$/i.test(request.params.requestId))
          throw new PrivacyRequestError("REQUEST_NOT_FOUND", 404);
        const row = await serviceForRequest().withdraw(
          request.params.requestId,
          getUserId(request),
          version,
          idempotencyKey,
        );
        return reply.send(publicRequest(row as unknown as Record<string, unknown>));
      } catch (error) {
        return privacyErrorReply(reply, error);
      }
    },
  );
};
