/**
 * Build an Error carrying an HTTP `statusCode`. Fastify's error handler reads
 * `statusCode` and serializes the response with that status, so throwing one of
 * these from a route handler (or an integration handler, or an auth guard it
 * calls) is the safe way to abort a request: the reply is sent exactly once,
 * through the controlled error path, instead of the handler sending manually
 * and then returning — which, with an async preSerialization hook installed,
 * races a second send and crashes the process.
 *
 * Lives in the framework so both the API host and the integration handlers it
 * runs share one helper (integrations can't import from `apps/api`).
 */
export function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}
