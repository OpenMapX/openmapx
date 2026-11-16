import { constants } from "node:zlib";
import compress from "@fastify/compress";
import type { FastifyInstance } from "fastify";

/**
 * The only response types the API compresses: application/json,
 * application/geo+json, application/problem+json and other application/*+json
 * types, with or without parameters such as charset.
 */
export const COMPRESSIBLE_RESPONSE_TYPE = /^application\/(?:[\w.!#$&^-]+\+)?json\s*(?:;|$)/i;

/**
 * Registers response compression (no request decompression) for every route
 * registered after this call. Must run before any route registration.
 *
 * `customTypes` alone cannot keep other types out: @fastify/compress falls back
 * to mime-db's `compressible` flag, which marks application/octet-stream,
 * text/* and XML compressible, and it treats a missing Content-Type as JSON.
 * The shared onSend hook below therefore opts every other response out through
 * the plugin's documented `x-no-compression` request header. Fastify runs the
 * plugin's route-level onSend after all shared onSend hooks, so this runs
 * first. HEAD responses are never compressed. Hijacked replies (SSE, image
 * proxy, log streams) bypass onSend entirely.
 *
 * The hook uses callback style with a synchronous `done`, like the other
 * global hooks in app.ts.
 */
export async function registerResponseCompression(server: FastifyInstance): Promise<void> {
  server.addHook("onSend", (request, reply, payload, done) => {
    const type = reply.getHeader("content-type");
    if (
      request.method === "HEAD" ||
      typeof type !== "string" ||
      !COMPRESSIBLE_RESPONSE_TYPE.test(type)
    ) {
      request.headers["x-no-compression"] = "1";
    }
    done(null, payload);
  });
  await server.register(compress, {
    globalDecompression: false,
    threshold: 1024,
    encodings: ["br", "gzip"],
    customTypes: COMPRESSIBLE_RESPONSE_TYPE,
    brotliOptions: { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } },
  });
}
