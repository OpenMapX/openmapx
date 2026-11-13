import { Readable } from "node:stream";
import {
  ACTIVE_REQUEST_STATES,
  acceptsCaseDecision,
  acceptsManualIdentityVerification,
  acceptsTaskResolution,
  canExtendDeadline,
  privacyCaseDecisionSchema,
  privacyCaseExtensionSchema,
  privacyIdentityVerificationSchema,
  privacyTaskResolutionSchema,
} from "@openmapx/core/privacy";
import { httpError } from "@openmapx/integration-framework";
import { asc, eq, inArray } from "drizzle-orm";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { AdminActionReauthentication } from "../account/admin-reauthentication.js";
import { db } from "../db/index.js";
import {
  dataSubjectRequest,
  dataSubjectRequestEvent,
  dataSubjectRequestTask,
} from "../db/schema.js";
import { privacyCaseProjection as projection } from "../privacy/admin-projections.js";
import { PrivacyRequestError, privacyErrorReply } from "../privacy/errors.js";
import { exportResponseHeaders, pumpExport } from "../privacy/export-response.js";
import { createSubjectRequestSchema } from "../privacy/request-contracts.js";
import { PrivacyRequestService } from "../privacy/request-service.js";
import {
  type PreparedSubjectExport,
  type PrepareSubjectExportOptions,
  prepareSubjectExport,
} from "../privacy/subject-export.js";
import { getAdminSession, requireAdmin } from "../utils/require-admin.js";
import { declareRouteAuth } from "../utils/route-auth.js";
import { sendAdminByteResponse } from "./admin-byte-response.js";
import { adminReauthNonce } from "./admin-reauthentication.js";
import { registerPrivacyAdminRoute } from "./privacy-admin-contract.js";

export interface PrivacyAdminRouteOptions {
  service?: PrivacyRequestService;
  database?: typeof db;
  /** Collector settings for the export; tests replace the external sources. */
  exportSources?: Pick<PrepareSubjectExportOptions, "openmapx" | "dawarich">;
}

function eventProjection(row: {
  eventType: string;
  actorKind: string;
  createdAt: Date;
  payload: unknown;
}) {
  const payload =
    row.payload && typeof row.payload === "object" && !Array.isArray(row.payload)
      ? (row.payload as Record<string, unknown>)
      : {};
  const safe: Record<string, string> = {};
  for (const key of ["reasonCode", "kind", "channel", "from"]) {
    if (typeof payload[key] === "string" && payload[key].length <= 128)
      safe[key] = payload[key] as string;
  }
  return {
    eventType: row.eventType,
    actorKind: row.actorKind,
    createdAt: row.createdAt,
    ...(Object.keys(safe).length ? { payload: safe } : {}),
  };
}

/** Privacy decisions need an attributable account, so the loopback CLI
 * session that `requireAdmin` admits is refused here. */
async function requirePrivacyCaseAdmin(request: FastifyRequest) {
  const session = await requireAdmin(request);
  if (session.user.id === "loopback") throw httpError(403, "Administrator account required");
  return session;
}

/** Why an assisted case's subject cannot be exported, if anything. An
 * unreadable locator keeps the case readable but names the failure. */
function subjectExportReason(
  service: PrivacyRequestService,
  row: Parameters<PrivacyRequestService["subjectUserId"]>[0],
): string | undefined {
  try {
    return service.subjectUserId(row) === null ? "subject-account-unknown" : undefined;
  } catch (error) {
    if (error instanceof PrivacyRequestError && error.code === "SUBJECT_LOCATOR_UNREADABLE")
      return "subject-locator-unreadable";
    throw error;
  }
}

function requireMutationKey(request: {
  headers: { [key: string]: string | string[] | undefined };
}): string {
  const raw = request.headers["idempotency-key"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || !/^[A-Za-z0-9][A-Za-z0-9._~-]{15,127}$/.test(value))
    throw new PrivacyRequestError("IDEMPOTENCY_KEY_REQUIRED", 400);
  return value;
}

export const privacyAdminRoute: FastifyPluginAsync<PrivacyAdminRouteOptions> = async (
  fastify,
  options,
) => {
  declareRouteAuth(fastify, "admin");
  fastify.addHook("onRequest", async (request) => {
    request.adminSession = await requirePrivacyCaseAdmin(request);
  });
  fastify.addHook("onSend", async (_request, reply, payload) => {
    reply.header("Cache-Control", "private, no-store");
    reply.header("Pragma", "no-cache");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    return payload;
  });
  const database = options.database ?? db;
  const serviceForRequest = () => options.service ?? new PrivacyRequestService({ database });
  const respond = (row: unknown) => ({ request: projection(row as Record<string, unknown>) });

  registerPrivacyAdminRoute(fastify, "listPrivacyAdminQueue", async (_request, reply) => {
    try {
      const rows = await database
        .select()
        .from(dataSubjectRequest)
        .where(inArray(dataSubjectRequest.state, [...ACTIVE_REQUEST_STATES]))
        .orderBy(asc(dataSubjectRequest.dueAt));
      return reply.send({
        requests: rows.map((row) => projection(row as unknown as Record<string, unknown>)),
      });
    } catch (error) {
      return privacyErrorReply(reply, error);
    }
  });

  registerPrivacyAdminRoute<{ Params: { requestId: string } }>(
    fastify,
    "getPrivacyAdminCase",
    async (request, reply) => {
      try {
        const service = serviceForRequest();
        const row = await service.getById(request.params.requestId);
        const tasks = await database
          .select({
            id: dataSubjectRequestTask.id,
            registrationId: dataSubjectRequestTask.registrationId,
            source: dataSubjectRequestTask.source,
            status: dataSubjectRequestTask.status,
            publicCode: dataSubjectRequestTask.publicCode,
            resolutionCode: dataSubjectRequestTask.resolutionCode,
            resolvedAt: dataSubjectRequestTask.resolvedAt,
          })
          .from(dataSubjectRequestTask)
          .where(eq(dataSubjectRequestTask.requestId, row.id))
          .orderBy(asc(dataSubjectRequestTask.registrationId));
        const events = (
          await database
            .select({
              eventType: dataSubjectRequestEvent.eventType,
              actorKind: dataSubjectRequestEvent.actorKind,
              createdAt: dataSubjectRequestEvent.createdAt,
              payload: dataSubjectRequestEvent.payload,
            })
            .from(dataSubjectRequestEvent)
            .where(eq(dataSubjectRequestEvent.requestId, row.id))
            .orderBy(asc(dataSubjectRequestEvent.createdAt))
        ).map(eventProjection);
        const active = acceptsCaseDecision(row.state);
        const exportReason =
          row.channel === "self_service"
            ? "self-service-request"
            : !active
              ? "case-not-active"
              : !row.identityMethod
                ? "identity-required"
                : subjectExportReason(service, row);
        return reply.send({
          request: projection(row as unknown as Record<string, unknown>),
          tasks,
          events,
          capabilities: {
            verifyIdentity: !row.identityMethod && acceptsManualIdentityVerification(row.state),
            resolveTasks:
              acceptsTaskResolution(row.state) && tasks.some((task) => task.status === "open"),
            extendDeadline: canExtendDeadline(row.state),
            caseDecision: active,
            export: exportReason === undefined,
            reasons: {
              ...(exportReason ? { export: exportReason } : {}),
              ...(!active ? { case: "case-not-active" } : {}),
            },
          },
        });
      } catch (error) {
        return privacyErrorReply(reply, error);
      }
    },
  );

  registerPrivacyAdminRoute<{ Body: unknown }>(
    fastify,
    "createPrivacyAdminCase",
    async (request, reply) => {
      try {
        const actor = getAdminSession(request);
        const idempotencyKey = requireMutationKey(request);
        const body = createSubjectRequestSchema.parse({
          ...((request.body as Record<string, unknown>) ?? {}),
          channel: (request.body as Record<string, unknown>)?.channel ?? "email",
          actorUserId: actor.user.id,
          actorSessionId: actor.session.id,
          idempotencyKey,
        });
        if (body.channel === "self_service")
          throw new PrivacyRequestError("ASSISTED_CHANNEL_REQUIRED", 400);
        return reply.status(202).send(respond(await serviceForRequest().create(body)));
      } catch (error) {
        return privacyErrorReply(reply, error);
      }
    },
  );

  registerPrivacyAdminRoute<{ Params: { requestId: string }; Body: unknown }>(
    fastify,
    "verifyPrivacyAdminIdentity",
    async (request, reply) => {
      try {
        const idempotencyKey = requireMutationKey(request);
        const body = privacyIdentityVerificationSchema.parse(request.body);
        const row = await serviceForRequest().verifyIdentity({
          requestId: request.params.requestId,
          ...body,
          actorId: getAdminSession(request).user.id,
          idempotencyKey,
        });
        return reply.send(respond(row));
      } catch (error) {
        return privacyErrorReply(reply, error);
      }
    },
  );

  registerPrivacyAdminRoute<{ Params: { requestId: string; taskId: string }; Body: unknown }>(
    fastify,
    "resolvePrivacyAdminTask",
    async (request, reply) => {
      try {
        const idempotencyKey = requireMutationKey(request);
        const body = privacyTaskResolutionSchema.parse(request.body);
        const row = await serviceForRequest().resolveTask({
          requestId: request.params.requestId,
          taskId: request.params.taskId,
          ...body,
          actorId: getAdminSession(request).user.id,
          idempotencyKey,
        });
        return reply.send(respond(row));
      } catch (error) {
        return privacyErrorReply(reply, error);
      }
    },
  );

  registerPrivacyAdminRoute<{ Params: { requestId: string }; Body: unknown }>(
    fastify,
    "extendPrivacyAdminCase",
    async (request, reply) => {
      try {
        const idempotencyKey = requireMutationKey(request);
        const body = privacyCaseExtensionSchema.parse(request.body);
        const row = await serviceForRequest().recordExtension({
          requestId: request.params.requestId,
          version: body.version,
          extendedUntil: new Date(body.extendedUntil),
          extensionNotifiedAt: new Date(body.extensionNotifiedAt),
          reasonCode: body.reasonCode,
          actorId: getAdminSession(request).user.id,
          idempotencyKey,
        });
        return reply.send(respond(row));
      } catch (error) {
        return privacyErrorReply(reply, error);
      }
    },
  );

  registerPrivacyAdminRoute<{ Params: { requestId: string }; Body: unknown }>(
    fastify,
    "decidePrivacyAdminCase",
    async (request, reply) => {
      try {
        const idempotencyKey = requireMutationKey(request);
        const body = privacyCaseDecisionSchema.parse(request.body);
        const row = await serviceForRequest().recordDecision({
          requestId: request.params.requestId,
          ...body,
          actorId: getAdminSession(request).user.id,
          idempotencyKey,
        });
        return reply.send(respond(row));
      } catch (error) {
        return privacyErrorReply(reply, error);
      }
    },
  );

  /**
   * Export an assisted request's subject with the same streaming function as
   * self-service. A completed `privacy.export` reauthentication proof for this
   * case is checked before collection and consumed just before the headers.
   */
  registerPrivacyAdminRoute<{ Params: { requestId: string }; Body: unknown }>(
    fastify,
    "exportPrivacyAdminCase",
    async (request, reply) => {
      const actor = getAdminSession(request);
      const service = serviceForRequest();
      const challengeId = request.headers["x-admin-reauth-proof"];
      const nonce = adminReauthNonce(request.headers.cookie);
      const proof = {
        challengeId: typeof challengeId === "string" ? challengeId : "",
        purpose: "privacy.export" as const,
        targetId: request.params.requestId,
        sessionId: actor.session.id,
        nonce: nonce ?? "",
      };
      let prepared: PreparedSubjectExport | undefined;
      let started = false;
      try {
        if (!nonce || !proof.challengeId)
          throw new PrivacyRequestError("REAUTHENTICATION_REQUIRED", 409);
        await database.transaction((tx) => new AdminActionReauthentication(tx).check(proof, tx));
        const row = await service.beginAdminExport(request.params.requestId, actor.user.id);
        started = true;
        prepared = await prepareSubjectExport({
          request: row,
          subjectUserId: service.subjectUserId(row),
          database,
          ...(options.exportSources ?? {}),
        });
        await database.transaction((tx) => new AdminActionReauthentication(tx).consume(proof, tx));
      } catch (error) {
        await prepared?.dispose();
        if (started)
          await service
            .recordExportFailure(request.params.requestId, "export-preparation-failed")
            .catch(() => undefined);
        return privacyErrorReply(reply, error);
      }
      const ready = prepared;
      const { body, delivered } = pumpExport(ready, reply.raw);
      const abort = new AbortController();
      const sending = sendAdminByteResponse(reply, {
        body: Readable.toWeb(body) as ReadableStream<Uint8Array>,
        signal: abort.signal,
        headers: new Headers(exportResponseHeaders(ready.filename)),
      }).catch(() => undefined);
      const ok = await delivered;
      if (!ok) abort.abort(new Error("privacy export interrupted"));
      await sending;
      try {
        if (ok)
          await service.finishExport(request.params.requestId, {
            kind: "admin",
            id: actor.user.id,
          });
        else await service.recordExportFailure(request.params.requestId, "export-interrupted");
      } catch (error) {
        request.log.error({ err: error }, "failed to record the privacy export outcome");
      }
      return reply;
    },
  );
};
