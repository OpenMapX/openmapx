import { fromNodeHeaders } from "better-auth/node";
import type {
  FastifyContextConfig,
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { auth } from "../auth";
import { MobileAuthHandoffService } from "../services/mobileAuthHandoff";
import { envString } from "../utils/env";
import { declareRouteAuth } from "../utils/route-auth";

/**
 * The two endpoints that move a session from the system browser into the
 * WebView, and nothing else.
 *
 * `issue` runs in the system browser, on the fixed-origin `/mobile-auth` page,
 * with the session cookie that page just established. `exchange` runs in the
 * WebView, with no session at all — that is the point, it is how the WebView
 * gets one.
 *
 * Both are deliberately hostile to their own callers:
 *
 *  - Every response is `no-store`. A one-time token in a shared cache is a
 *    one-time token somebody else can use.
 *  - Neither endpoint accepts, returns, or logs a redirect target. The callback
 *    URL is compiled into the app; a server that could be told where to send a
 *    code is a server that can be told to send it elsewhere.
 *  - Failures are uniform. `exchange` in particular reports one error for every
 *    rejection, because the difference between "no such code" and "wrong
 *    verifier" is exactly what an attacker is probing for.
 */

/** Bodies here are a handful of short base64url fields; anything larger is noise. */
const MAX_BODY_BYTES = 4 * 1024;
const BASE64URL_PATTERN = "^[A-Za-z0-9_-]+$";

interface IssueBody {
  purpose: "sign-in" | "link-provider" | "add-passkey";
  codeChallenge: string;
  state: string;
}

interface ExchangeBody {
  callbackCode: string;
  codeVerifier: string;
  state: string;
}

const issueBodySchema = {
  type: "object",
  additionalProperties: false,
  propertyNames: { enum: ["purpose", "codeChallenge", "state"] },
  required: ["purpose", "codeChallenge", "state"],
  properties: {
    purpose: { type: "string", enum: ["sign-in", "link-provider", "add-passkey"] },
    codeChallenge: {
      type: "string",
      minLength: 43,
      maxLength: 128,
      pattern: BASE64URL_PATTERN,
    },
    state: { type: "string", minLength: 16, maxLength: 128, pattern: BASE64URL_PATTERN },
  },
} as const;

const exchangeBodySchema = {
  type: "object",
  additionalProperties: false,
  propertyNames: { enum: ["callbackCode", "codeVerifier", "state"] },
  required: ["callbackCode", "codeVerifier", "state"],
  properties: {
    callbackCode: {
      type: "string",
      minLength: 16,
      maxLength: 256,
      pattern: BASE64URL_PATTERN,
    },
    codeVerifier: {
      type: "string",
      minLength: 43,
      maxLength: 128,
      pattern: BASE64URL_PATTERN,
    },
    state: { type: "string", minLength: 16, maxLength: 128, pattern: BASE64URL_PATTERN },
  },
} as const;

const service = new MobileAuthHandoffService();

function noStore(reply: FastifyReply): void {
  reply.header("Cache-Control", "no-store");
  reply.header("Pragma", "no-cache");
  // The page that calls this must not leak its URL — which carries the purpose
  // and state — to anything it subsequently reaches.
  reply.header("Referrer-Policy", "no-referrer");
}

/**
 * The origins allowed to call these endpoints.
 *
 * Both live on the deployed web app; nothing else has any business calling
 * them. Read from configuration rather than reflected from the request, because
 * reflecting an Origin is the same as having no check.
 */
function allowedOrigins(): string[] {
  const configured = envString("MOBILE_AUTH_ALLOWED_ORIGINS", "");
  if (configured)
    return configured
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean);
  const web = envString("WEB_ORIGIN", "http://localhost:3000");
  return [web];
}

/**
 * Same-origin enforcement.
 *
 * A missing Origin is refused rather than allowed: every browser sends one on a
 * cross-origin POST, and the callers here are both browsers.
 */
function originAllowed(request: FastifyRequest): boolean {
  const origin = request.headers.origin;
  if (typeof origin !== "string" || origin === "") return false;
  return allowedOrigins().includes(origin);
}

export const mobileAuthRoute: FastifyPluginAsync = async (fastify) => {
  declareRouteAuth(fastify, "public");

  /**
   * Called by the fixed-origin system-browser page, after a session exists.
   *
   * The one-time token is minted here rather than in the browser so it never
   * appears in a page the user can be persuaded to read out.
   */
  fastify.post<{ Body: IssueBody }>(
    "/mobile-auth/issue",
    {
      config: { auth: "session" } as FastifyContextConfig & { auth: "session" },
      bodyLimit: MAX_BODY_BYTES,
      schema: { body: issueBodySchema },
      onRequest: (_request, reply) => {
        noStore(reply);
        return Promise.resolve();
      },
    },
    async (request, reply) => {
      noStore(reply);
      if (!originAllowed(request)) return reply.code(403).send({ error: "invalid_request" });

      const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
      if (!session) return reply.code(401).send({ error: "authentication_required" });

      const generated = await auth.api.generateOneTimeToken({
        headers: fromNodeHeaders(request.headers),
      });
      const token = (generated as { token?: unknown } | null)?.token;
      const oneTimeToken = typeof token === "string" ? token : "";
      if (!oneTimeToken) return reply.code(500).send({ error: "invalid_request" });

      const result = await service.issue({
        userId: session.user.id,
        purpose: request.body.purpose,
        codeChallenge: request.body.codeChallenge,
        state: request.body.state,
        oneTimeToken,
        nowMs: Date.now(),
      });
      if (!result.ok) {
        const status = result.reason === "too-many-attempts" ? 429 : 400;
        return reply.code(status).send({ error: "invalid_request" });
      }

      // The code and nothing else. No token, no user, no redirect target.
      return reply.send({ callbackCode: result.callbackCode, expiresAtMs: result.expiresAtMs });
    },
  );

  /**
   * Called by the WebView, unauthenticated, with the verifier it kept.
   *
   * Returns the one-time token once. The WebView immediately verifies it through
   * Better Auth, which is what actually sets the WebView's session cookie — this
   * endpoint never sets one.
   */
  fastify.post<{ Body: ExchangeBody }>(
    "/mobile-auth/exchange",
    {
      bodyLimit: MAX_BODY_BYTES,
      schema: { body: exchangeBodySchema },
      onRequest: (_request, reply) => {
        noStore(reply);
        return Promise.resolve();
      },
    },
    async (request, reply) => {
      noStore(reply);
      if (!originAllowed(request)) return reply.code(403).send({ error: "invalid_request" });

      const result = await service.exchange({
        callbackCode: request.body.callbackCode,
        codeVerifier: request.body.codeVerifier,
        state: request.body.state,
        nowMs: Date.now(),
      });
      // One status, one body, for every possible rejection.
      if (!result.ok) return reply.code(400).send({ error: "invalid_request" });

      return reply.send({ token: result.oneTimeToken });
    },
  );
};
