/**
 * Production wiring for the OSM contribution service.
 *
 * The token is resolved through Better Auth's public server API with the
 * caller's own session headers; nothing here reads or decrypts the account
 * table directly.
 */

import { envString } from "@openmapx/core/server-env";
import { auth } from "../../auth.js";
import { redis } from "../../redis.js";
import { getOsmConfig } from "../../utils/osm-config.js";
import { recordOsmContributionOperation } from "../metrics/index.js";
import { createOsmAccountService, type OsmTokenResolution } from "./account.js";
import { createOsmApiClient } from "./osm-client.js";
import { createOsmContributionService, type OsmContributionService } from "./service.js";
import { createSubmissionGuard, type SubmissionGuardRedis } from "./submission-guard.js";

const OSM_PROVIDER_ID = "openstreetmap";

async function resolveToken(headers: Headers): Promise<OsmTokenResolution> {
  let accountId: string | undefined;
  try {
    const accounts = await auth.api.listUserAccounts({ headers });
    accountId = accounts.find((account) => account.providerId === OSM_PROVIDER_ID)?.id;
  } catch {
    return { status: "not_linked" };
  }
  if (!accountId) return { status: "not_linked" };

  try {
    const result = await auth.api.getAccessToken({
      body: { accountId },
      headers,
    });
    if (!result.accessToken) return { status: "reauthorization_required" };
    return { status: "ok", accessToken: result.accessToken, scopes: result.scopes ?? [] };
  } catch {
    // A refresh or consent failure is never surfaced verbatim: the person is
    // simply asked to authorize again.
    return { status: "reauthorization_required" };
  }
}

let singleton: OsmContributionService | undefined;

export function createOsmContributionsService(): OsmContributionService {
  if (singleton) return singleton;
  const config = getOsmConfig();
  const client = createOsmApiClient({ config });
  singleton = createOsmContributionService({
    config,
    client,
    account: createOsmAccountService({ config, client, resolveToken }),
    guard: createSubmissionGuard({
      // The guard's digests only need to be unpredictable and stable for this
      // deployment; the auth secret already has both properties.
      secret: envString("BETTER_AUTH_SECRET", "openmapx-osm-contributions"),
      redis: (redis as SubmissionGuardRedis | null) ?? undefined,
    }),
    // Two closed enums and a duration. Nothing about the person, the element
    // or the contribution's content reaches the exposition.
    recordOperation: recordOsmContributionOperation,
  });
  return singleton;
}

export { createOsmAccountService, deriveCapabilities } from "./account.js";
export { createOsmApiClient } from "./osm-client.js";
export type { OsmContributionService, OsmRequestContext } from "./service.js";
export { createOsmContributionService } from "./service.js";
export { createSubmissionGuard } from "./submission-guard.js";
export { applyOsmFieldChanges, buildContextFields } from "./tag-policy.js";
export { isOsmContributionError, OsmContributionError } from "./types.js";
