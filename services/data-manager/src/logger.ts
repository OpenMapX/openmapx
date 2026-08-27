import type { FastifyBaseLogger } from "fastify";
import { type DestinationStream, pino } from "pino";
import type { PoiJobLogger } from "./jobs/poi-ingest/types.js";
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
 * `FastifyInstance` parameters of registerAuth/registerApi/registerPoiIngestApi.
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

/** Adapt a pino child to the PoiJobLogger (msg + merge-object) interface. */
export function asPoiJobLogger(child: FastifyBaseLogger): PoiJobLogger {
  return {
    info: (msg, extra) => child.info(extra ?? {}, msg),
    warn: (msg, extra) => child.warn(extra ?? {}, msg),
    error: (msg, extra) => child.error(extra ?? {}, msg),
    debug: (msg, extra) => child.debug(extra ?? {}, msg),
  };
}

/**
 * Wrap an existing PoiJobLogger so every line carries the given bindings in
 * its merge object. Used by the POI runner to stamp { job, sourceId, kind,
 * jobId } onto all pipeline-stage lines without changing the interface.
 */
export function withPoiBindings(
  logger: PoiJobLogger,
  bindings: Record<string, unknown>,
): PoiJobLogger {
  return {
    info: (msg, extra) => logger.info(msg, { ...bindings, ...extra }),
    warn: (msg, extra) => logger.warn(msg, { ...bindings, ...extra }),
    error: (msg, extra) => logger.error(msg, { ...bindings, ...extra }),
    debug: (msg, extra) => logger.debug(msg, { ...bindings, ...extra }),
  };
}
