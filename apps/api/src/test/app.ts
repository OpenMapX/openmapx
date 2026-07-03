import Fastify, {
  type FastifyInstance,
  type FastifyPluginAsync,
  type FastifyPluginCallback,
} from "fastify";
import { uniformErrorHandler } from "../server-wiring.js";

export interface BuildTestAppOptions {
  /** Route prefix, e.g. "/api". */
  prefix?: string;
}

/**
 * Boot a Fastify instance shaped like production for route tests.
 *
 * Route tests historically hand-built a bare `Fastify()` with no error handler,
 * so a thrown `httpError(401, …)` surfaced as a 500 instead of the real status.
 * This installs the exact `uniformErrorHandler` that `server.ts` uses — a
 * thrown error with `statusCode` becomes `status + { error: message }`, and 5xx
 * is masked to "Internal Server Error" — so tests exercise the controlled error
 * path that production auth guards and handlers rely on.
 */
export async function buildTestApp(
  register: FastifyPluginCallback | FastifyPluginAsync,
  options: BuildTestAppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setErrorHandler(uniformErrorHandler);
  await app.register(
    register as FastifyPluginAsync,
    options.prefix ? { prefix: options.prefix } : {},
  );
  await app.ready();
  return app;
}
