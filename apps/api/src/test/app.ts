import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyPluginAsync,
  type FastifyPluginCallback,
} from "fastify";

export interface BuildTestAppOptions {
  /** Route prefix, e.g. "/api". */
  prefix?: string;
}

/**
 * Boot a Fastify instance shaped like production for route tests.
 *
 * Route tests historically hand-built a bare `Fastify()` with no error handler,
 * so a thrown `httpError(401, …)` surfaced as a 500 instead of the real status.
 * This installs the exact error handler `server.ts` uses (server.ts:153) — a
 * thrown error with `statusCode` becomes `status + { error: message }`, and 5xx
 * is masked to "Internal Server Error" — so tests exercise the controlled error
 * path that production auth guards and handlers rely on.
 *
 * Keep this in sync with `server.ts`'s `setErrorHandler`.
 */
export async function buildTestApp(
  register: FastifyPluginCallback | FastifyPluginAsync,
  options: BuildTestAppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const statusCode = error.statusCode ?? 500;
    if (statusCode >= 500) {
      request.log.error({ err: error }, "Request error");
      return reply.status(statusCode).send({ error: "Internal Server Error" });
    }
    return reply.status(statusCode).send({ error: error.message });
  });
  await app.register(
    register as FastifyPluginAsync,
    options.prefix ? { prefix: options.prefix } : {},
  );
  await app.ready();
  return app;
}
