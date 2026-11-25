import type { PrivacySource } from "@openmapx/core/privacy";
import type { FastifyPluginAsync } from "fastify";
import { retentionPeriods } from "../services/retention-settings";
import { resolveSettingValues } from "../services/settings";
import { declareRouteAuth } from "../utils/route-auth";

/**
 * Public, unauthenticated read of the legal facts the published legal pages
 * need to render. Values resolve exactly like every other setting
 * (environment, then the administration's stored value, then the default),
 * and the periods are the ones the API's retention enforces. Only non-secret
 * legal fields are exposed here — never any setting from another group.
 */
const PUBLIC_LEGAL_SETTINGS = {
  name: "legal.controller.name",
  street: "legal.controller.street",
  postalCode: "legal.controller.postalCode",
  city: "legal.controller.city",
  country: "legal.controller.country",
  email: "legal.controller.email",
  phone: "legal.controller.phone",
  hostingProvider: "legal.hosting.provider",
  hostingLocations: "legal.hosting.locations",
  supervisoryAuthority: "legal.supervisoryAuthority.name",
  supervisoryAuthorityUrl: "legal.supervisoryAuthority.url",
  dataRequestEmail: "legal.dataRequestEmail",
  deploymentJurisdiction: "legal.deploymentJurisdiction",
  privacySources: "legal.privacySources",
} as const;
type PublicLegalFact = keyof typeof PUBLIC_LEGAL_SETTINGS;

export const legalConfigRoute: FastifyPluginAsync = async (fastify) => {
  declareRouteAuth(fastify, "public");

  fastify.get("/legal-config", async (_req, reply) => {
    const facts = Object.keys(PUBLIC_LEGAL_SETTINGS) as PublicLegalFact[];
    const values = await resolveSettingValues(facts.map((fact) => PUBLIC_LEGAL_SETTINGS[fact]));
    const text = (fact: PublicLegalFact) => values[PUBLIC_LEGAL_SETTINGS[fact]] as string;
    const periods = await retentionPeriods();
    const privacySources = (values[PUBLIC_LEGAL_SETTINGS.privacySources] as PrivacySource[]).map(
      ({ contactCode: _contactCode, instructionsCode: _instructionsCode, ...publicSource }) =>
        publicSource,
    );

    reply.header("Cache-Control", "public, max-age=60");
    return reply.send({
      name: text("name"),
      street: text("street"),
      postalCode: text("postalCode"),
      city: text("city"),
      country: text("country"),
      email: text("email"),
      phone: text("phone"),
      hostingProvider: text("hostingProvider"),
      hostingLocations: text("hostingLocations"),
      supervisoryAuthority: text("supervisoryAuthority"),
      supervisoryAuthorityUrl: text("supervisoryAuthorityUrl"),
      serverLogRetentionDays: periods.serverLog,
      dataRequestEmail: text("dataRequestEmail") || text("email"),
      dsarCaseRetentionDays: periods.privacyCase,
      deploymentJurisdiction: text("deploymentJurisdiction"),
      privacySources,
      backupRetentionDays: periods.backup,
      auditLogRetentionDays: periods.auditLog,
    });
  });
};
