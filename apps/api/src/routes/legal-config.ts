import { type PrivacySource, privacySourceSchema } from "@openmapx/core/privacy";
import type { FastifyPluginAsync } from "fastify";
import { declareRouteAuth } from "../utils/route-auth";
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

function boundedNumber(raw: unknown, fallback: number, min: number, max: number): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

function safePrivacySources(
  raw: unknown,
): Array<Omit<PrivacySource, "contactCode" | "instructionsCode">> {
  const result = privacySourceSchema.array().safeParse(raw);
  if (!result.success) return [];
  return result.data.map(
    ({ contactCode: _contactCode, instructionsCode: _instructionsCode, ...publicSource }) =>
      publicSource,
  );
}

const asString = (v: unknown): string => (typeof v === "string" ? v : "");

export const legalConfigRoute: FastifyPluginAsync = async (fastify) => {
  declareRouteAuth(fastify, "public");

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
      dataRequestEmail: asString(values.legalDataRequestEmail),
      dsarCaseRetentionDays: boundedNumber(values.legalDsarCaseRetentionDays, 1095, 30, 3650),
      identityEvidenceRetentionDays: boundedNumber(
        values.legalIdentityEvidenceRetentionDays,
        30,
        1,
        365,
      ),
      exportArtifactRetentionHours: boundedNumber(
        values.legalExportArtifactRetentionHours,
        168,
        24,
        720,
      ),
      deploymentJurisdiction: asString(values.legalDeploymentJurisdiction),
      privacySources: safePrivacySources(values.legalPrivacySources),
    });
  });
};
