/**
 * Build an Error carrying an HTTP `statusCode`. Fastify's error handler reads
 * `statusCode` and serializes the response with that status, so throwing one of
 * these from a route handler (or an auth guard it calls) is the safe way to
 * abort a request: the reply is sent exactly once, through Fastify's controlled
 * error path, instead of the handler sending manually and then returning —
 * which, with an async preSerialization hook installed, races a second send and
 * crashes the process. See [[project-fastify-return-reply-contract]].
 */
export function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}
