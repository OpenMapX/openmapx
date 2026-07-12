import type { IntegrationContext } from "@openmapx/integration-framework";
import { isSafeReportId, isSubClaimAction, type RelayResult, relayContribution } from "./relay.js";

const ISSUER_KEYS_CACHE_KEY = "crowd-reports:issuer-keys";
const ISSUER_KEYS_TTL_SECONDS = 300;

/**
 * Crowd-reports backend: thin relays from the browser to the self-hosted
 * OpenConditions contributions-api. The browser signs each report/vote with its
 * device key (see `@openmapx/openconditions-contrib-client`) and POSTs the
 * envelope here; these handlers forward the body verbatim and pass the upstream
 * status + JSON straight back. All verification happens in the contributions-api
 * — this side adds no auth (reports are pseudonymous) and never inspects the
 * signed payload.
 *
 * Egress target: `OPENCONDITIONS_CONTRIBUTIONS_URL` (operator-configured,
 * default `http://localhost:3002`) — see `relay.ts` for the trust model.
 */
export function setup(ctx: IntegrationContext): void {
  // POST /reports → /contrib/reports (signed SignedReport envelope in the body).
  ctx.registerRoute("POST", "/reports", async (req, reply) => {
    try {
      const result = await relayContribution("POST", "/contrib/reports", { body: req.body });
      reply.status(result.status).send(result.body);
    } catch (err) {
      ctx.log.error("crowd-reports relay POST /reports failed", err);
      reply.status(502).send({ error: "contributions service unavailable" });
    }
  });

  // POST /reports/:id/:action → /contrib/reports/:id/:action (confirm/negate/flag).
  ctx.registerRoute("POST", "/reports/:id/:action", async (req, reply) => {
    const id = req.params.id ?? "";
    const action = req.params.action ?? "";
    if (!isSafeReportId(id) || !isSubClaimAction(action)) {
      reply.status(400).send({ error: "invalid report id or action" });
      return;
    }
    try {
      const result = await relayContribution(
        "POST",
        `/contrib/reports/${encodeURIComponent(id)}/${action}`,
        { body: req.body },
      );
      reply.status(result.status).send(result.body);
    } catch (err) {
      ctx.log.error("crowd-reports relay POST /reports/:id/:action failed", err);
      reply.status(502).send({ error: "contributions service unavailable" });
    }
  });

  // POST /enroll → /contrib/enroll (device-key enrollment for reporting grants).
  ctx.registerRoute("POST", "/enroll", async (req, reply) => {
    try {
      const result = await relayContribution("POST", "/contrib/enroll", { body: req.body });
      reply.status(result.status).send(result.body);
    } catch (err) {
      ctx.log.error("crowd-reports relay POST /enroll failed", err);
      reply.status(502).send({ error: "contributions service unavailable" });
    }
  });

  // POST /tokens → /contrib/tokens (exchange an enrollment for reporting tokens).
  ctx.registerRoute("POST", "/tokens", async (req, reply) => {
    try {
      const result = await relayContribution("POST", "/contrib/tokens", { body: req.body });
      reply.status(result.status).send(result.body);
    } catch (err) {
      ctx.log.error("crowd-reports relay POST /tokens failed", err);
      reply.status(502).send({ error: "contributions service unavailable" });
    }
  });

  // GET /issuer-keys → /contrib/issuer-keys (public issuer keys; cached briefly).
  // Only successful (2xx) upstream responses are cached — caching a transient
  // 5xx would pin the failure for the whole TTL.
  ctx.registerRoute("GET", "/issuer-keys", async (_req, reply) => {
    try {
      const cached = await ctx.cache.get<RelayResult>(ISSUER_KEYS_CACHE_KEY);
      if (cached) {
        reply.header("Cache-Control", `public, max-age=${ISSUER_KEYS_TTL_SECONDS}`);
        reply.status(cached.status).send(cached.body);
        return;
      }
      const result = await relayContribution("GET", "/contrib/issuer-keys");
      if (result.status >= 200 && result.status < 300) {
        await ctx.cache.set(ISSUER_KEYS_CACHE_KEY, result, ISSUER_KEYS_TTL_SECONDS);
        reply.header("Cache-Control", `public, max-age=${ISSUER_KEYS_TTL_SECONDS}`);
      } else {
        reply.header("Cache-Control", "no-cache");
      }
      reply.status(result.status).send(result.body);
    } catch (err) {
      ctx.log.error("crowd-reports relay GET /issuer-keys failed", err);
      reply.status(502).send({ error: "contributions service unavailable" });
    }
  });
}
