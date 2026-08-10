import type { FastifyPluginAsync } from "fastify";
import { safeAuthErrorEvent } from "../utils/auth-error-log";

export interface AuthRouteOptions {
  authHandler: (request: Request) => Promise<Response>;
  authUiOrigin: string;
}

const INTERACTION_PAGES = ["/auth/oidc/sign-in", "/auth/oidc/consent"] as const;
const CLIENT_AUTH_ENDPOINTS = new Set([
  "/api/auth/oauth2/token",
  "/api/auth/oauth2/introspect",
  "/api/auth/oauth2/revoke",
]);
const METADATA_ENDPOINTS = new Set([
  "/api/auth/.well-known/openid-configuration",
  "/api/auth/.well-known/oauth-authorization-server",
]);

function trustedUiOrigin(configuredOrigin: string): string {
  const parsed = new URL(configuredOrigin);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Auth UI origin must use HTTP or HTTPS");
  }
  if (parsed.username || parsed.password)
    throw new Error("Auth UI origin must not contain credentials");
  return parsed.origin;
}

function containsBodyClientSecret(body: unknown): boolean {
  if (typeof body === "string") return new URLSearchParams(body).has("client_secret");
  if (!body || typeof body !== "object") return false;
  return Object.hasOwn(body, "client_secret");
}

function advertiseBasicClientAuthenticationOnly(responseBody: string): string {
  const metadata = JSON.parse(responseBody) as Record<string, unknown>;
  metadata.token_endpoint_auth_methods_supported = ["client_secret_basic"];
  metadata.introspection_endpoint_auth_methods_supported = ["client_secret_basic"];
  metadata.revocation_endpoint_auth_methods_supported = ["client_secret_basic"];
  return JSON.stringify(metadata);
}

/**
 * Bridges Fastify requests to Better Auth's Fetch API handler. Keeping this as
 * a route plugin lets protocol tests exercise the exact production boundary.
 */
export const authRoute: FastifyPluginAsync<AuthRouteOptions> = async (server, options) => {
  const uiOrigin = trustedUiOrigin(options.authUiOrigin);

  server.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_request, body, done) => done(null, body),
  );

  for (const page of INTERACTION_PAGES) {
    server.get(page, { logLevel: "silent" }, async (request, reply) => {
      const target = `${uiOrigin}${request.url}`;
      return reply.status(302).header("location", target).send();
    });
  }

  server.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    // OAuth callbacks, interaction queries and form posts carry codes, state
    // and credentials. Disable Fastify's automatic URL-bearing request logs;
    // the catch boundary below emits one bounded event instead.
    logLevel: "silent",
    async handler(request, reply) {
      try {
        const url = new URL(request.url, `http://${request.headers.host}`);
        const headers = new Headers();
        for (const [key, value] of Object.entries(request.headers)) {
          if (value) headers.append(key, Array.isArray(value) ? value.join(", ") : value);
        }
        const body =
          request.body === undefined || request.body === null
            ? undefined
            : typeof request.body === "string"
              ? request.body
              : JSON.stringify(request.body);
        if (CLIENT_AUTH_ENDPOINTS.has(url.pathname) && containsBodyClientSecret(request.body)) {
          return reply.status(400).send({
            error: "invalid_request",
            error_description: "Client secrets must use HTTP Basic authentication",
          });
        }
        const authRequest = new Request(url.toString(), {
          method: request.method,
          headers,
          ...(body !== undefined ? { body } : {}),
        });
        const response = await options.authHandler(authRequest);
        let responseBody = response.status === 204 ? null : await response.text();
        const metadataHardened =
          response.ok && responseBody !== null && METADATA_ENDPOINTS.has(url.pathname);
        if (metadataHardened && responseBody !== null) {
          responseBody = advertiseBasicClientAuthenticationOnly(responseBody);
        }
        reply.status(response.status);
        response.headers.forEach((value, key) => {
          if (metadataHardened && key.toLowerCase() === "content-length") return;
          reply.header(key, value);
        });
        return reply.send(responseBody);
      } catch (error) {
        server.log.error(safeAuthErrorEvent(error, request.id, request.method), "Auth error");
        return reply.status(500).send({ error: "Internal authentication error" });
      }
    },
  });
};
