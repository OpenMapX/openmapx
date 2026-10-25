import { transitousRunnerRequestSchema } from "@openmapx/core/transitous-runner";
import Fastify from "fastify";
import {
  createTransitousRunner,
  TransitousRunnerError,
  type TransitousRunnerOptions,
} from "./runner";

/**
 * HTTP surface of the private Transitous runner.
 *
 * The service is not proxied, holds no Docker socket, no repository mount, no
 * Docker credentials, and no platform secret. Its only inputs are a read-only
 * catalog checkout, a writable staging directory, and single-use capability
 * tokens signed with a key it shares with exactly one caller.
 */

/** One request body is a small typed envelope; nothing legitimate is larger. */
const BODY_LIMIT_BYTES = 64 * 1024;

export function buildTransitousRunnerServer(options: TransitousRunnerOptions) {
  const app = Fastify({ logger: false, bodyLimit: BODY_LIMIT_BYTES });
  const runner = createTransitousRunner(options);

  app.get("/health", async () => ({ ok: true }));

  app.post("/v1/run", async (request, reply) => {
    const parsed = transitousRunnerRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      // The rejection names no field and echoes no value: a malformed request
      // may still carry a live capability token.
      return reply.code(400).send({ ok: false, error: "validation" });
    }
    try {
      return await runner.run(parsed.data);
    } catch (error) {
      if (error instanceof TransitousRunnerError) {
        const status = error.reason === "authorization" ? 401 : 400;
        return reply.code(status).send({ ok: false, error: error.reason });
      }
      return reply.code(500).send({ ok: false, error: "runtime" });
    }
  });

  for (const action of ["inspect", "cancel", "acknowledge"] as const)
    app.post(`/v1/run/${action}`, async (request, reply) => {
      const parsed = transitousRunnerRequestSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ ok: false, error: "validation" });
      try {
        return action === "cancel"
          ? runner.cancel(parsed.data)
          : action === "acknowledge"
            ? runner.acknowledge(parsed.data)
            : runner.inspect(parsed.data);
      } catch {
        return reply.code(404).send({ ok: false, error: "unknown" });
      }
    });
  return app;
}
