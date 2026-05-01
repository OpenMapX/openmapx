import type { FastifyInstance } from "fastify";

export interface PinoLikeLogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  debug(...args: unknown[]): void;
}

export interface IntegrationLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
}

/**
 * Build a pino-aware logger for an integration. Picks any `Error` argument
 * out of `args` and merges it as `err` so pino's standard serializer
 * captures the stack — calls like `ctx.log.error("upstream failed", err)`
 * would otherwise be passed as printf args and silently dropped.
 */
export function createIntegrationLogger(
  integrationId: string,
  fastify: Pick<FastifyInstance, "log">,
): IntegrationLogger {
  const make =
    (level: keyof PinoLikeLogger) =>
    (msg: string, ...args: unknown[]) => {
      const bindings: Record<string, unknown> = { integration: integrationId };
      const errIdx = args.findIndex((a) => a instanceof Error);
      if (errIdx !== -1) {
        bindings.err = args[errIdx];
        args.splice(errIdx, 1);
      }
      const pinoLog = fastify.log as unknown as PinoLikeLogger;
      pinoLog[level](bindings, msg, ...args);
    };
  return {
    info: make("info"),
    warn: make("warn"),
    error: make("error"),
    debug: make("debug"),
  };
}
