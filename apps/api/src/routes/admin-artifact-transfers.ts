import { Readable } from "node:stream";
import { artifactTransferAdminOperations } from "@openmapx/core/api-contracts";
import type { FastifyInstance } from "fastify";
import { AdminArtifactTransferError, AdminArtifactTransfers } from "../services/artifact-transfers";
import { configuredTrustedWebOrigins, makeCsrfGuardHook } from "../utils/csrf";
import { getAdminSession, requireAdmin } from "../utils/require-admin";
import { declareRouteAuth } from "../utils/route-auth";
import { sendAdminByteResponse } from "./admin-byte-response";
import { createAdminRouteRegistrar } from "./admin-contract";

const register = createAdminRouteRegistrar(artifactTransferAdminOperations, {
  tag: "service-admin",
  validationPhase: "preHandler",
});
export async function adminArtifactTransfersRoute(app: FastifyInstance): Promise<void> {
  declareRouteAuth(app, "admin");
  // onRequest runs before the scoped octet parser can expose body bytes.
  app.addHook("onRequest", makeCsrfGuardHook(configuredTrustedWebOrigins()));
  app.addHook("onRequest", async (request) => {
    request.adminSession = await requireAdmin(request);
  });
  app.addContentTypeParser("application/octet-stream", (_request, payload, done) =>
    done(null, payload),
  );
  app.setErrorHandler((error, _request, reply) => {
    if (reply.raw.headersSent) {
      reply.raw.destroy();
      return;
    }
    const status =
      error instanceof AdminArtifactTransferError
        ? error.statusCode
        : (error as { statusCode?: number }).statusCode;
    return reply
      .code(
        status && [400, 401, 403, 404, 409, 410, 413, 415, 422, 429, 503, 507].includes(status)
          ? status
          : 503,
      )
      .send({
        error:
          error instanceof AdminArtifactTransferError
            ? error.message
            : "Artifact transfer unavailable",
      });
  });
  const broker = () => new AdminArtifactTransfers();
  const owner = (request: Parameters<typeof getAdminSession>[0]) =>
    getAdminSession(request).user.id;
  register(app, "validateAdminArtifactTransfer", async (req, reply) =>
    reply
      .code(202)
      .send(
        await broker().validate(
          owner(req),
          req.params.stageId,
          String(req.headers["idempotency-key"]),
        ),
      ),
  );
  register(app, "listAdminArtifactTransfers", (req) =>
    broker().list(owner(req), req.query.limit, req.query.offset),
  );
  register(app, "createAdminArtifactTransfer", (req) =>
    broker().create(owner(req), String(req.headers["idempotency-key"]), req.body),
  );
  register(app, "getAdminArtifactTransfer", (req) =>
    broker().inspect(owner(req), req.params.stageId),
  );
  register(app, "deleteAdminArtifactTransfer", (req) =>
    broker().delete(owner(req), req.params.stageId),
  );
  register(app, "uploadAdminArtifactTransferContent", async (req, reply) => {
    if (
      req.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/octet-stream"
    )
      return reply.code(415).send({ error: "Artifact upload requires application/octet-stream" });
    const controller = new AbortController();
    const aborted = () => {
      if (!reply.raw.writableFinished) controller.abort();
    };
    req.raw.on("aborted", aborted);
    reply.raw.on("close", aborted);
    try {
      return await broker().upload(
        owner(req),
        req.params.stageId,
        Readable.toWeb(req.body as Readable) as ReadableStream<Uint8Array>,
        controller.signal,
        req.headers["content-length"] === undefined
          ? undefined
          : Number(req.headers["content-length"]),
      );
    } finally {
      req.raw.off("aborted", aborted);
      reply.raw.off("close", aborted);
    }
  });
  register(app, "downloadAdminArtifactTransferContent", async (req, reply) => {
    const controller = new AbortController();
    const aborted = () => {
      if (!reply.raw.writableFinished) controller.abort();
    };
    reply.raw.on("close", aborted);
    try {
      await broker().download(owner(req), req.params.stageId, controller.signal, (input) =>
        sendAdminByteResponse(reply, input),
      );
    } finally {
      reply.raw.off("close", aborted);
    }
  });
}
