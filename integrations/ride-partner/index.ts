import type { IntegrationContext } from "@openmapx/integration-framework";

export interface PartnerCredential {
  /** Matches a `dataSources[].sourceId` in the manifest. */
  sourceId: string;
  /** Vault keys this partner needs, all of them, before an adapter could run. */
  keys: string[];
}

/**
 * Partners whose APIs are documented and viable but need a commercial
 * relationship before any code can run against them. The credential fields and
 * their setup guides live in the manifest so an operator who has a contract can
 * store the keys through the admin panel; the adapters themselves are not
 * written, because neither vendor issues credentials self-service.
 */
export const PARTNER_CREDENTIALS: readonly PartnerCredential[] = [
  { sourceId: "yango", keys: ["yango-client-id", "yango-api-key"] },
  { sourceId: "karhoo", keys: ["karhoo-client-id", "karhoo-client-secret"] },
];

/**
 * Ride partner scaffolding. Registers no provider: it exists to carry the
 * credential fields and their setup guides, and to tell an operator loudly
 * when they have stored a key that nothing can yet use — silently accepting
 * one would read as "the integration is working".
 */
export function setup(ctx: IntegrationContext): void {
  for (const partner of PARTNER_CREDENTIALS) {
    const stored = partner.keys
      .map((key) => ctx.config[key])
      .filter((v) => typeof v === "string" && v.trim());
    if (stored.length > 0) {
      ctx.log.warn(
        `ride partner credentials stored but no adapter exists yet: ${partner.sourceId} will not appear in ride mode`,
      );
    }
  }
}
