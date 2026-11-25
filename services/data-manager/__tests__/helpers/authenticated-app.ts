import type { FastifyInstance } from "fastify";
import { registerAuth } from "../../src/auth.js";
import type { DataManagerPrincipal } from "../../src/principals.js";

/** Synthetic, distinct caller tokens for a test application. */
export const TEST_CALLER_TOKENS: Readonly<Record<DataManagerPrincipal, string>> = {
  api: "synthetic-api-token-0123456789abcdef",
  "ops-agent": "synthetic-agent-token-0123456789abcdef",
  "host-cli": "synthetic-cli-token-0123456789abcdef",
};

/**
 * Installs data-manager's bearer authentication on `app`, and has a request
 * that names no caller sent as `principal`, so route handlers see the caller a
 * job is recorded for.
 */
export function authenticateAs(
  app: FastifyInstance,
  principal: DataManagerPrincipal = "host-cli",
): FastifyInstance {
  app.addHook("onRequest", async (request) => {
    request.headers.authorization ??= `Bearer ${TEST_CALLER_TOKENS[principal]}`;
  });
  registerAuth(app, TEST_CALLER_TOKENS);
  return app;
}
