import type { RollingStreamBudget, RollingStreamBudgetLease } from "@openmapx/core/server";
import { fromNodeHeaders } from "better-auth/node";
import { eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import z from "zod/v4";
import { auth } from "../auth.js";
import { db } from "../db/index.js";
import { dataSubjectRequestTask } from "../db/schema.js";
import { PrivacyRequestError, privacyErrorReply } from "../privacy/errors.js";
import { acquireExportSlot, privacyExportAdmission } from "../privacy/export-admission.js";
import {
  type ExportStreamLimits,
  exportResponseHeaders,
  pumpExport,
} from "../privacy/export-response.js";
import { selfServiceExportSchema } from "../privacy/request-contracts.js";
import { PrivacyRequestService } from "../privacy/request-service.js";
import { hasFreshAssurance } from "../privacy/session-assurance.js";
import {
  type PreparedSubjectExport,
  type PrepareSubjectExportOptions,
  prepareSubjectExport,
} from "../privacy/subject-export.js";
import { bindRequestAbort, withDeadline } from "../utils/request-abort.js";
import { getUserId, requireAuthHook } from "../utils/require-auth.js";
import { declareRouteAuth } from "../utils/route-auth.js";

/** Request ids are UUIDs; anything else is an unknown request. */
const requestIdSchema = z.uuid();

export interface PrivacyRequestsRouteOptions {
  service?: PrivacyRequestService;
  database?: typeof db;
  /** Collector settings for the export; tests replace the external sources. */
  exportSources?: Pick<PrepareSubjectExportOptions, "openmapx" | "dawarich">;
  /** Export slots; tests pass their own so cases stay independent. */
  exportAdmission?: RollingStreamBudget;
  /** Download deadlines; tests shorten them. */
  exportStreamLimits?: ExportStreamLimits;
}

/**
 * Longest time collecting an export may take before the managed timeline
 * transfer is stopped. The operations agent ends its own export after 15
 * minutes, so this never cuts a transfer the agent still considers healthy.
 */
const EXPORT_PREPARATION_DEADLINE_MS = 20 * 60_000;

function publicRequest(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    kind: row.kind,
    channel: row.channel,
    status: row.status,
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
  const exportAdmission = options.exportAdmission ?? privacyExportAdmission;

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
    let slot: RollingStreamBudgetLease | undefined;
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
      // Taken before the request is touched, so a refused export records nothing.
      slot = acquireExportSlot(exportAdmission, userId);
      const row = await service.beginSelfServiceExport({
        userId,
        sessionId: session.session.id,
        ...body,
      });
      requestId = row.id;
      // The managed timeline is fetched through the operations agent, which
      // takes the cancellation signal. A client that leaves, or a collection
      // that outlasts the deadline, stops that transfer and fails preparation.
      const disconnect = bindRequestAbort(request, reply);
      try {
        prepared = await prepareSubjectExport({
          request: row,
          subjectUserId: row.userId,
          database,
          recordExtensionsLeftOut: (leftOut) => service.recordExtensionsLeftOut(row.id, leftOut),
          ...(options.exportSources ?? {}),
          dawarich: {
            ...(options.exportSources?.dawarich ?? {}),
            signal: withDeadline(disconnect.signal, EXPORT_PREPARATION_DEADLINE_MS),
          },
        });
      } finally {
        disconnect.dispose();
      }
    } catch (error) {
      if (requestId)
        await service
          .recordExportFailure(requestId, "export-preparation-failed")
          .catch(() => undefined);
      slot?.release();
      return privacyErrorReply(reply, error);
    }
    const exportRequestId = requestId;
    const heldSlot = slot;
    let delivered: Promise<boolean>;
    let body: ReturnType<typeof pumpExport>["body"];
    try {
      ({ body, delivered } = pumpExport(prepared, reply.raw, options.exportStreamLimits));
    } catch (error) {
      // Nothing was sent yet; without this the slot would stay taken.
      await prepared.dispose().catch(() => undefined);
      await service
        .recordExportFailure(exportRequestId, "export-preparation-failed")
        .catch(() => undefined);
      heldSlot.release();
      return privacyErrorReply(reply, error);
    }
    // After the headers the request stays in progress unless every byte
    // arrives, so an interrupted download can simply be retried. The slot is
    // freed only once the outcome is recorded, so a retry never overlaps the
    // earlier attempt's bookkeeping.
    void delivered
      .then(async (ok) => {
        if (ok) await service.finishExport(exportRequestId, { kind: "subject", id: userId });
        else await service.recordExportFailure(exportRequestId, "export-interrupted");
      })
      .catch((error: unknown) =>
        request.log.error({ err: error }, "failed to record the privacy export outcome"),
      )
      .finally(() => heldSlot.release());
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
        if (!requestIdSchema.safeParse(request.params.requestId).success)
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
        if (!requestIdSchema.safeParse(request.params.requestId).success)
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
