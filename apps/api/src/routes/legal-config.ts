import type { FastifyPluginAsync } from "fastify";
import { resolveSettings } from "./admin-settings";

/**
 * Public, unauthenticated read of the legal facts the published /privacy page
 * needs to render. Values resolve env > database > default exactly like the
 * admin Settings panel (they share `resolveSettings`), so an operator can set
 * the hosting provider either via the LEGAL_HOSTING_* env vars or in the admin
 * Settings → Legal panel, with the env var taking priority. Only non-secret
 * legal fields are exposed here — never any setting from another group.
 */
/** A positive whole number of days, or 30 for a missing/invalid value. The
 * result is interpolated verbatim into the published privacy text, so a bad
 * value (NaN, ≤0, non-integer) must never render as a retention claim. */
function retentionDays(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 30;
}

const asString = (v: unknown): string => (typeof v === "string" ? v : "");

export const legalConfigRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get("/legal-config", async (_req, reply) => {
    const groups = await resolveSettings();
    const legal = groups.find((g) => g.id === "legal");
    const values = Object.fromEntries((legal?.settings ?? []).map((s) => [s.key, s.value]));

    reply.header("Cache-Control", "public, max-age=60");
    return reply.send({
      hostingProvider: asString(values.legalHostingProvider),
      hostingLocations: asString(values.legalHostingLocations),
      supervisoryAuthority: asString(values.legalSupervisoryAuthority),
      supervisoryAuthorityUrl: asString(values.legalSupervisoryAuthorityUrl),
      serverLogRetentionDays: retentionDays(values.legalServerLogRetentionDays),
    });
  });
};
