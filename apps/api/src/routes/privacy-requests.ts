import { envString } from "@openmapx/core/server-env";
import { fromNodeHeaders } from "better-auth/node";
import { and, eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { ZodError } from "zod/v4";
import { auth } from "../auth.js";
import { db } from "../db/index.js";
import { dataExportArtifact, dataSubjectRequest, dataSubjectRequestTask } from "../db/schema.js";
import {
  artifactResultFromRow,
  contentDisposition,
  parseWrappedDek,
  startArtifactStream,
} from "../privacy/artifact-download.js";
import type { EncryptedBlobStore } from "../privacy/artifact-storage.js";
import { recordSuccessfulArtifactDelivery } from "../privacy/delivery.js";
import { PrivacyReauthenticationService, REAUTH_COOKIE_NAME } from "../privacy/reauthentication.js";
import type { ReceiptPreservationDependencies } from "../privacy/receipt-snapshot.js";
import {
  artifactIdParamSchema,
  createSubjectRequestSchema,
  reauthCompleteSchema,
} from "../privacy/request-contracts.js";
import { PrivacyRequestError, PrivacyRequestService } from "../privacy/request-service.js";
import { getSessionAuthAssurance } from "../privacy/session-assurance.js";
import { getUserId, requireAuthHook } from "../utils/require-auth.js";
import { declareRouteAuth } from "../utils/route-auth.js";

export interface PrivacyRequestsRouteOptions {
  service?: PrivacyRequestService;
  database?: typeof db;
  reauthentication?: PrivacyReauthenticationService;
  artifactStore?: EncryptedBlobStore;
  receiptPreservation?: ReceiptPreservationDependencies;
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
    preservationAt: row.preservationAt,
    snapshotAt: row.snapshotAt,
    dueAt: row.dueAt,
    extension: row.extension,
    identityState: row.identityState,
    refusalCode: row.refusalCode,
    deliveryState: row.deliveryState,
    withdrawalAt: row.withdrawalAt,
    completedAt: row.completedAt,
    closedAt: row.closedAt,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function errorStatus(error: unknown): number {
  return error instanceof ZodError
    ? 400
    : error instanceof PrivacyRequestError
      ? error.statusCode
      : 503;
}

function errorCode(error: unknown): string {
  return error instanceof ZodError
    ? "INVALID_REQUEST"
    : error instanceof PrivacyRequestError
      ? error.code
      : "PRIVACY_SERVICE_UNAVAILABLE";
}

function parseCookieHeader(header: string | undefined, name: string): string | null {
  for (const piece of (header ?? "").split(";")) {
    const [key, ...value] = piece.trim().split("=");
    if (key === name) return value.join("=") || null;
  }
  return null;
}

export function parseReauthCookie(
  header: string | undefined,
): { challengeId: string; nonce: Buffer } | null {
  const value = parseCookieHeader(header, REAUTH_COOKIE_NAME);
  if (!value) return null;
  const separator = value.indexOf(".");
  if (separator < 1 || separator === value.length - 1) return null;
  const challengeId = value.slice(0, separator);
  const encoded = value.slice(separator + 1);
  if (!/^[0-9a-f-]{36}$/i.test(challengeId) || !/^[A-Za-z0-9_-]{43}$/.test(encoded)) return null;
  const nonce = Buffer.from(encoded, "base64url");
  return nonce.byteLength === 32 ? { challengeId, nonce } : null;
}

export function setReauthCookie(
  reply: { header(name: string, value: string): unknown },
  value: string,
  maxAge: number,
): void {
  reply.header(
    "Set-Cookie",
    `${REAUTH_COOKIE_NAME}=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`,
  );
}

export function clearReauthCookie(reply: { header(name: string, value: string): unknown }): void {
  setReauthCookie(reply, "", 0);
}

export function genericReauthFailure(reply: {
  status(code: number): { send(value: unknown): unknown };
}): unknown {
  return reply.status(401).send({ code: "REAUTHENTICATION_FAILED" });
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
  fastify.addHook("preHandler", requireAuthHook);
  fastify.addHook("onSend", async (_request, reply, payload) => {
    reply.header("Cache-Control", "private, no-store");
    reply.header("Pragma", "no-cache");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    return payload;
  });
  const database = options.database ?? db;
  const artifactStore = options.artifactStore;
  const reauthForRequest = () =>
    options.reauthentication ?? new PrivacyReauthenticationService(database);
  const serviceForRequest = () =>
    options.service ??
    new PrivacyRequestService({
      database,
      receiptPreservation: options.receiptPreservation,
      deleteArtifactStorage: artifactStore ? (key) => artifactStore.delete(key) : undefined,
    });

  fastify.post<{ Body: unknown }>("/privacy/data-requests", async (request, reply) => {
    try {
      const idempotencyKey = requireIdempotencyKey(request);
      const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
      if (!session || session.user.id !== getUserId(request))
        throw new PrivacyRequestError("AUTHENTICATION_REQUIRED", 401);
      const body = createSubjectRequestSchema.parse({
        ...((request.body as Record<string, unknown>) ?? {}),
        userId: getUserId(request),
        actorUserId: session.user.id,
        actorSessionId: session.session.id,
        channel: "self_service",
        idempotencyKey,
      });
      const row = await serviceForRequest().create(body);
      return reply.status(202).send(publicRequest(row as unknown as Record<string, unknown>));
    } catch (error) {
      return reply.status(errorStatus(error)).send({ code: errorCode(error) });
    }
  });

  fastify.post<{ Params: { requestId: string } }>(
    "/privacy/assisted-requests/:requestId/identity/account-login",
    async (request, reply) => {
      try {
        const idempotencyKey = requireIdempotencyKey(request);
        if (!/^[0-9a-f-]{36}$/i.test(request.params.requestId))
          throw new PrivacyRequestError("ACCOUNT_LOGIN_PROOF_FAILED", 404);
        const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
        if (!session || session.user.id !== getUserId(request))
          throw new PrivacyRequestError("ACCOUNT_LOGIN_PROOF_FAILED", 404);
        const row = await serviceForRequest().recordAccountLoginProof({
          requestId: request.params.requestId,
          userId: session.user.id,
          sessionId: session.session.id,
          idempotencyKey,
        });
        return reply.send({ request: publicRequest(row as unknown as Record<string, unknown>) });
      } catch (error) {
        return reply.status(errorStatus(error)).send({ code: errorCode(error) });
      }
    },
  );

  fastify.get("/privacy/data-requests", async (request, reply) => {
    try {
      const rows = await serviceForRequest().listForUser(getUserId(request));
      return reply.send({
        requests: rows.map((row) => publicRequest(row as unknown as Record<string, unknown>)),
      });
    } catch (error) {
      return reply.status(errorStatus(error)).send({ code: errorCode(error) });
    }
  });

  fastify.get<{ Params: { requestId: string } }>(
    "/privacy/data-requests/:requestId",
    async (request, reply) => {
      try {
        const row = await serviceForRequest().getForUser(
          request.params.requestId,
          getUserId(request),
        );
        const [artifacts, tasks] = await Promise.all([
          database
            .select({
              id: dataExportArtifact.id,
              state: dataExportArtifact.state,
              filename: dataExportArtifact.filename,
              mediaType: dataExportArtifact.mediaType,
              plaintextBytes: dataExportArtifact.plaintextBytes,
              expiresAt: dataExportArtifact.expiresAt,
              readyAt: dataExportArtifact.readyAt,
              downloadCount: dataExportArtifact.downloadCount,
            })
            .from(dataExportArtifact)
            .where(eq(dataExportArtifact.requestId, row.id)),
          database
            .select({
              registrationId: dataSubjectRequestTask.registrationId,
              status: dataSubjectRequestTask.status,
              required: dataSubjectRequestTask.required,
              recordCount: dataSubjectRequestTask.recordCount,
              exceptionCode: dataSubjectRequestTask.exceptionCode,
              redactionCode: dataSubjectRequestTask.redactionCode,
            })
            .from(dataSubjectRequestTask)
            .where(eq(dataSubjectRequestTask.requestId, row.id)),
        ]);
        return reply.send({
          ...publicRequest(row as unknown as Record<string, unknown>),
          artifacts,
          tasks,
        });
      } catch (error) {
        return reply.status(errorStatus(error)).send({ code: errorCode(error) });
      }
    },
  );

  fastify.post<{ Params: { requestId: string }; Body: { version?: unknown } }>(
    "/privacy/data-requests/:requestId/withdraw",
    async (request, reply) => {
      let idempotencyKey: string;
      try {
        idempotencyKey = requireIdempotencyKey(request);
      } catch (error) {
        return reply.status(errorStatus(error)).send({ code: errorCode(error) });
      }
      const version = Number(request.body?.version);
      if (!Number.isSafeInteger(version) || version < 1)
        return reply.status(400).send({ code: "INVALID_VERSION" });
      try {
        const row = await serviceForRequest().withdraw(
          request.params.requestId,
          getUserId(request),
          version,
          idempotencyKey,
        );
        return reply.send(publicRequest(row as unknown as Record<string, unknown>));
      } catch (error) {
        return reply.status(errorStatus(error)).send({ code: errorCode(error) });
      }
    },
  );

  fastify.post<{ Params: { requestId: string }; Body: { version?: unknown } }>(
    "/privacy/data-requests/:requestId/regenerate",
    async (request, reply) => {
      let idempotencyKey: string;
      try {
        idempotencyKey = requireIdempotencyKey(request);
      } catch (error) {
        return reply.status(errorStatus(error)).send({ code: errorCode(error) });
      }
      const version = Number(request.body?.version);
      if (!Number.isSafeInteger(version) || version < 1)
        return reply.status(400).send({ code: "INVALID_VERSION" });
      try {
        const row = await serviceForRequest().regenerate(
          request.params.requestId,
          getUserId(request),
          version,
          idempotencyKey,
        );
        return reply.status(202).send(publicRequest(row as unknown as Record<string, unknown>));
      } catch (error) {
        return reply.status(errorStatus(error)).send({ code: errorCode(error) });
      }
    },
  );

  fastify.delete<{ Params: { requestId: string; artifactId: string } }>(
    "/privacy/data-requests/:requestId/artifacts/:artifactId",
    async (request, reply) => {
      const parsed = artifactIdParamSchema.safeParse(request.params);
      if (!parsed.success) return reply.status(404).send({ code: "NOT_FOUND" });
      try {
        const idempotencyKey = requireIdempotencyKey(request);
        await serviceForRequest().revokeArtifact(
          parsed.data.requestId,
          parsed.data.artifactId,
          getUserId(request),
          idempotencyKey,
        );
        return reply.status(204).send();
      } catch (error) {
        return reply.status(errorStatus(error)).send({ code: errorCode(error) });
      }
    },
  );

  fastify.post<{ Params: { requestId: string; artifactId: string } }>(
    "/privacy/data-requests/:requestId/artifacts/:artifactId/reauth/start",
    async (request, reply) => {
      try {
        requireIdempotencyKey(request);
      } catch {
        return genericReauthFailure(reply);
      }
      const parsed = artifactIdParamSchema.safeParse(request.params);
      if (!parsed.success) return genericReauthFailure(reply);
      const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
      if (!session || session.user.id !== getUserId(request)) return genericReauthFailure(reply);
      try {
        const challenge = await reauthForRequest().start({
          requestId: parsed.data.requestId,
          artifactId: parsed.data.artifactId,
          userId: session.user.id,
          startingSessionId: session.session.id,
        });
        setReauthCookie(
          reply,
          `${challenge.challengeId}.${challenge.nonce.toString("base64url")}`,
          600,
        );
        return reply.status(200).send({
          challengeId: challenge.challengeId,
          expiresAt: challenge.expiresAt.toISOString(),
          loginPath: "/auth/privacy",
        });
      } catch {
        return genericReauthFailure(reply);
      }
    },
  );

  fastify.post<{
    Params: { requestId: string; artifactId: string };
    Body: { challengeId?: unknown };
  }>(
    "/privacy/data-requests/:requestId/artifacts/:artifactId/reauth/complete",
    async (request, reply) => {
      try {
        requireIdempotencyKey(request);
      } catch {
        clearReauthCookie(reply);
        return genericReauthFailure(reply);
      }
      const parsed = artifactIdParamSchema.safeParse(request.params);
      const cookie = parseReauthCookie(request.headers.cookie);
      const completeBody = reauthCompleteSchema.safeParse(request.body);
      const challengeId = completeBody.success ? completeBody.data.challengeId : "";
      if (!parsed.success || !cookie || challengeId !== cookie.challengeId) {
        clearReauthCookie(reply);
        return genericReauthFailure(reply);
      }
      const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
      if (!session || session.user.id !== getUserId(request)) {
        clearReauthCookie(reply);
        return genericReauthFailure(reply);
      }
      const assurance = await getSessionAuthAssurance(session.session.id, database);
      if (!assurance) {
        clearReauthCookie(reply);
        return genericReauthFailure(reply);
      }
      try {
        await reauthForRequest().complete({
          requestId: parsed.data.requestId,
          artifactId: parsed.data.artifactId,
          challengeId: cookie.challengeId,
          nonce: cookie.nonce,
          session: {
            id: session.session.id,
            userId: session.user.id,
            authenticatedAt: assurance.authenticatedAt,
            method: assurance.method,
            mfaConfigured: session.user.twoFactorEnabled === true,
          },
        });
        // Download consumes this cookie together with the completed challenge.
        // Keep its original expiry; completion must not extend the ceremony.
        return reply.send({ completed: true });
      } catch {
        clearReauthCookie(reply);
        return genericReauthFailure(reply);
      }
    },
  );

  fastify.get<{ Params: { requestId: string; artifactId: string } }>(
    "/privacy/data-requests/:requestId/artifacts/:artifactId/download",
    async (request, reply) => {
      const parsed = artifactIdParamSchema.safeParse(request.params);
      if (!parsed.success || request.headers.range)
        return reply
          .status(parsed.success ? 416 : 404)
          .send({ code: parsed.success ? "RANGE_NOT_SUPPORTED" : "NOT_FOUND" });
      const cookie = parseReauthCookie(request.headers.cookie);
      const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
      if (!cookie || !session || session.user.id !== getUserId(request))
        return genericReauthFailure(reply);
      const rows = await database
        .select({ artifact: dataExportArtifact, requestState: dataSubjectRequest.state })
        .from(dataExportArtifact)
        .innerJoin(dataSubjectRequest, eq(dataExportArtifact.requestId, dataSubjectRequest.id))
        .where(
          and(
            eq(dataExportArtifact.id, parsed.data.artifactId),
            eq(dataExportArtifact.requestId, parsed.data.requestId),
            eq(dataSubjectRequest.userId, session.user.id),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (
        row?.artifact.state !== "ready" ||
        !["ready", "delivered"].includes(row.requestState) ||
        !row.artifact.wrappedDek ||
        (row.artifact.expiresAt && row.artifact.expiresAt.getTime() <= Date.now())
      )
        return reply.status(404).send({ code: "NOT_FOUND" });
      if (!options.artifactStore)
        return reply.status(503).send({ code: "PRIVACY_SERVICE_UNAVAILABLE" });
      let prepared: ReturnType<typeof startArtifactStream> | undefined;
      try {
        const artifactRow = row.artifact;
        const wrappedDek = artifactRow.wrappedDek;
        if (!wrappedDek) return reply.status(404).send({ code: "NOT_FOUND" });
        const artifact = artifactResultFromRow(artifactRow as never, {
          deploymentId: envString("OPENMAPX_DEPLOYMENT_ID", "openmapx"),
          wrappedDek: parseWrappedDek(wrappedDek),
        });
        prepared = startArtifactStream(options.artifactStore, artifact);
        await prepared.verified;
        const current = await database
          .select({ state: dataSubjectRequest.state })
          .from(dataSubjectRequest)
          .where(eq(dataSubjectRequest.id, parsed.data.requestId))
          .limit(1);
        if (!current[0] || !["ready", "delivered"].includes(current[0].state))
          throw new Error("artifact no longer available");
        const consumed = await reauthForRequest().consume({
          challengeId: cookie.challengeId,
          nonce: cookie.nonce,
          sessionId: session.session.id,
          artifactId: parsed.data.artifactId,
          deliveryChannel: "self_service",
        });
        if (!consumed) {
          prepared.deny(new Error("reauthentication failed"));
          prepared.stream.destroy();
          return genericReauthFailure(reply);
        }
        prepared.authorize();
        reply.raw.once("finish", () => {
          void recordSuccessfulArtifactDelivery(
            {
              requestId: parsed.data.requestId,
              artifactId: parsed.data.artifactId,
              channel: "self_service",
              actorKind: "subject",
              actorId: session.user.id,
            },
            database,
          ).catch((error) => request.log.error({ err: error }, "failed to record export delivery"));
        });
        clearReauthCookie(reply);
        reply.header("Content-Type", artifactRow.mediaType || "application/zip");
        reply.header("Content-Length", String(artifactRow.plaintextBytes ?? ""));
        reply.header("Content-Disposition", contentDisposition(artifactRow.filename));
        reply.header("Cache-Control", "private, no-store");
        reply.header("Pragma", "no-cache");
        reply.header("Referrer-Policy", "no-referrer");
        return reply.send(prepared.stream);
      } catch {
        try {
          prepared?.deny(new Error("download failed"));
        } catch {
          /* no prepared stream */
        }
        clearReauthCookie(reply);
        return reply.status(404).send({ code: "NOT_FOUND" });
      }
    },
  );
};
