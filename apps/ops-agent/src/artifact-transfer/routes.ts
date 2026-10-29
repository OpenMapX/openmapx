import { createHash, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { verifyArtifactStreamCapability } from "@openmapx/core/ops";
import type { FastifyInstance } from "fastify";
import { ArtifactTransferError } from "./errors";
import type { ArtifactTransferStore } from "./store";
export function registerArtifactTransferRoutes(
  app: FastifyInstance,
  options: { store: ArtifactTransferStore; apiToken: string; admissionsOpen?: () => boolean },
): void {
  app.register(async (scoped) => {
    scoped.addContentTypeParser("application/octet-stream", (_request, payload, done) =>
      done(null, payload),
    );
    scoped.addHook("onRequest", async (request, reply) => {
      const candidate = createHash("sha256")
        .update(request.headers.authorization ?? "")
        .digest();
      const expected = createHash("sha256").update(`Bearer ${options.apiToken}`).digest();
      if (!timingSafeEqual(candidate, expected))
        return reply.code(401).send({ error: "Artifact stream authentication required" });
      if (options.admissionsOpen?.() === false)
        return reply.code(503).send({ error: "Artifact transfer admission is draining" });
      try {
        const capability = verifyArtifactStreamCapability(
          options.apiToken,
          String(request.headers["x-openmapx-artifact-capability"] ?? ""),
        );
        const params = request.params as { stageId: string };
        if (
          capability.stageId !== params.stageId ||
          capability.direction !== (request.method === "PUT" ? "upload" : "download")
        )
          throw Error();
        await options.store.getStage({
          stageId: capability.stageId,
          ownerId: capability.ownerId,
          purpose: capability.purpose,
        });
      } catch (error) {
        return reply.code(error instanceof ArtifactTransferError ? error.statusCode : 403).send({
          error:
            error instanceof ArtifactTransferError
              ? error.message
              : "Artifact stream capability refused",
        });
      }
    });
    scoped.setErrorHandler((error, _request, reply) => {
      if (reply.raw.headersSent) {
        reply.raw.destroy();
        return;
      }
      return reply
        .code(
          error instanceof ArtifactTransferError
            ? error.statusCode
            : (error as { statusCode?: number }).statusCode === 415
              ? 415
              : 503,
        )
        .send({
          error:
            error instanceof ArtifactTransferError ? error.message : "Artifact stream unavailable",
        });
    });
    scoped.put(
      "/v1/artifact-transfers/:stageId/content",
      { config: { artifactTransferBytes: true } },
      async (request, reply) => {
        if (
          request.headers["content-type"]?.split(";")[0].trim().toLowerCase() !==
          "application/octet-stream"
        )
          return reply
            .code(415)
            .send({ error: "Artifact upload requires application/octet-stream" });
        const capability = verifyArtifactStreamCapability(
          options.apiToken,
          String(request.headers["x-openmapx-artifact-capability"]),
        );
        const abort = new AbortController();
        const disconnected = () => {
          if (!reply.raw.writableFinished) abort.abort();
        };
        request.raw.on("aborted", disconnected);
        reply.raw.on("close", disconnected);
        try {
          const stage = await options.store.getStage({
            stageId: capability.stageId,
            ownerId: capability.ownerId,
            purpose: capability.purpose,
          });
          if (stage.bytes > capability.byteCap)
            throw new ArtifactTransferError(413, "Artifact stream exceeds capability limit");
          const source = request.body as Readable;
          const bounded = async function* () {
            let bytes = 0;
            for await (const chunk of source) {
              bytes += chunk.length;
              if (bytes > capability.byteCap)
                throw new ArtifactTransferError(413, "Artifact stream exceeds capability limit");
              yield chunk;
            }
          };
          const contentLength =
            request.headers["content-length"] === undefined
              ? undefined
              : Number(request.headers["content-length"]);
          const result = await options.store.upload({
            ...capability,
            body: Readable.toWeb(Readable.from(bounded())) as ReadableStream<Uint8Array>,
            contentLength,
            signal: abort.signal,
          });
          return reply
            .header("Cache-Control", "no-store")
            .header("X-Content-Type-Options", "nosniff")
            .send(result);
        } finally {
          request.raw.off("aborted", disconnected);
          reply.raw.off("close", disconnected);
        }
      },
    );
    scoped.get(
      "/v1/artifact-transfers/:stageId/content",
      { config: { artifactTransferBytes: true } },
      async (request, reply) => {
        const capability = verifyArtifactStreamCapability(
          options.apiToken,
          String(request.headers["x-openmapx-artifact-capability"]),
        );
        const abort = new AbortController();
        const disconnected = () => {
          if (!reply.raw.writableFinished) abort.abort();
        };
        reply.raw.on("close", disconnected);
        try {
          await options.store.openDownload(
            { ...capability, signal: abort.signal },
            async ({ body, headers, signal }) => {
              if (Number(headers.get("Content-Length")) > capability.byteCap)
                throw new ArtifactTransferError(413, "Artifact stream exceeds capability limit");
              headers.forEach((value, name) => {
                reply.header(name, value);
              });
              reply.hijack();
              reply.raw.writeHead(200, Object.fromEntries(headers.entries()));
              await pipeline(
                Readable.fromWeb(body as import("node:stream/web").ReadableStream<Uint8Array>),
                reply.raw,
                { signal },
              );
            },
          );
        } finally {
          reply.raw.off("close", disconnected);
        }
      },
    );
  });
}
