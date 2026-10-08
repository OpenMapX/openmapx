import type { FastifyBaseLogger } from "fastify";
import { type DestinationStream, pino } from "pino";
import type { JobLogger } from "./jobs/transitous/types.js";
import { scrubDiagnosticValue, scrubUrl } from "./utils/scrub-secrets.js";

/**
 * Factory so tests can inject a sink stream. LOG_LEVEL is read with `||`
 * (not `??`) because docker-compose `${VAR:-}` interpolation injects empty
 * strings that would defeat a nullish fallback.
 *
 * The return type is Fastify's `FastifyBaseLogger` (pino's Logger is a
 * structural superset) so `Fastify({ loggerInstance: rootLogger })` does not
 * over-narrow its logger generic — which would otherwise break the plain
 * `FastifyInstance` parameters of registerAuth/registerApi.
 * `FastifyBaseLogger` still exposes info/warn/error/debug and `.child()`, i.e.
 * everything the job loggers below need.
 */
export function createRootLogger(destination?: DestinationStream): FastifyBaseLogger {
  const options = {
    level: process.env.LOG_LEVEL || "info",
    redact: {
      paths: ["req.url", "request.url"],
      censor: (value: unknown) => (typeof value === "string" ? scrubUrl(value) : "[redacted]"),
    },
    formatters: {
      bindings(bindings: Record<string, unknown>) {
        return scrubDiagnosticValue(bindings) as Record<string, unknown>;
      },
    },
    hooks: {
      logMethod(args: unknown[], method: (this: unknown, ...methodArgs: unknown[]) => void): void {
        method.apply(this, args.map(scrubDiagnosticValue));
      },
    },
  };
  return wrapChildBindings(destination ? pino(options, destination) : pino(options));
}

function wrapChildBindings(
  logger: FastifyBaseLogger,
  createChild: FastifyBaseLogger["child"] = logger.child,
): FastifyBaseLogger {
  logger.child = ((
    bindings: Parameters<FastifyBaseLogger["child"]>[0],
    options?: Parameters<FastifyBaseLogger["child"]>[1],
  ) => {
    const scrubbedBindings = scrubDiagnosticValue(bindings) as Record<string, unknown>;
    return wrapChildBindings(createChild.call(logger, scrubbedBindings, options), createChild);
  }) as FastifyBaseLogger["child"];
  return logger;
}

/**
 * Process-wide root logger. index.ts hands this to Fastify via
 * `loggerInstance`, so `app.log` and every job child share one pino root
 * (and therefore one LOG_LEVEL).
 */
export const rootLogger = createRootLogger();

/** Child logger carrying job-run bindings, e.g. { job, jobId }. */
export function jobChildLogger(
  bindings: Record<string, unknown>,
  base: FastifyBaseLogger = rootLogger,
): FastifyBaseLogger {
  return base.child(bindings);
}

/** Adapt a pino child to the Transitous message-only JobLogger interface. */
export function asJobLogger(child: FastifyBaseLogger): JobLogger {
  return {
    info: (msg) => child.info(msg),
    warn: (msg) => child.warn(msg),
    error: (msg) => child.error(msg),
  };
}
