/**
 * Resolves the linked OpenStreetMap account and its *effective* contribution
 * rights.
 *
 * Two rules matter here. First, the token is resolved through Better Auth's
 * public server API and never leaves this module — the public capability
 * projection carries only account metadata. Second, permission is read from
 * OSM's own `/permissions` endpoint rather than the locally stored scope
 * string, so a revoked authorization cannot look effective.
 */
import type { OsmContributionCapabilities, OsmContributionScope } from "@openmapx/core";
import type { OsmConfig } from "../../utils/osm-config.js";
import type { OsmApiClient, OsmPermissions, OsmUserDetails } from "./types.js";

export type OsmTokenResolution =
  | { status: "ok"; accessToken: string; scopes: string[] }
  | { status: "not_linked" }
  | { status: "reauthorization_required" };

export type OsmAccountState =
  | { status: "not_linked" }
  | { status: "reauthorization_required" }
  | {
      status: "linked";
      /** Server-only. Never projected into a response, log or metric. */
      accessToken: string;
      scopes: string[];
      permissions: OsmPermissions;
      user: OsmUserDetails;
    };

export interface OsmAccountServiceDeps {
  config: OsmConfig;
  client: OsmApiClient;
  resolveToken(headers: Headers): Promise<OsmTokenResolution>;
}

export interface OsmAccountService {
  /** Live account state for this session. Contacts OSM only when linked. */
  load(headers: Headers): Promise<OsmAccountState>;
}

function isUnauthorized(error: unknown): boolean {
  const status = (error as { status?: unknown } | null | undefined)?.status;
  return status === 401 || status === 403;
}

export function createOsmAccountService(deps: OsmAccountServiceDeps): OsmAccountService {
  return {
    async load(headers: Headers): Promise<OsmAccountState> {
      const resolution = await deps.resolveToken(headers);
      if (resolution.status !== "ok") return { status: resolution.status };

      try {
        const [permissions, user] = await Promise.all([
          deps.client.getPermissions(resolution.accessToken),
          deps.client.getUserDetails(resolution.accessToken),
        ]);
        return {
          status: "linked",
          accessToken: resolution.accessToken,
          scopes: resolution.scopes,
          permissions,
          user,
        };
      } catch (error) {
        // A rejected token is indistinguishable from a revoked authorization
        // from here; both are resolved by asking the person to authorize again.
        if (isUnauthorized(error)) return { status: "reauthorization_required" };
        throw error;
      }
    },
  };
}

/**
 * Public capability snapshot. Fails closed: without both OAuth credentials the
 * feature reports disabled even if a flag was turned on by mistake.
 */
export function deriveCapabilities(input: {
  config: OsmConfig;
  state: OsmAccountState;
}): OsmContributionCapabilities {
  const { config, state } = input;
  const enabled = config.contributionsEnabled && config.oauthConfigured;
  const directEditingEnabled = enabled && config.directEditingEnabled;

  const linked = state.status !== "not_linked";
  const permissions = state.status === "linked" ? state.permissions : null;
  const canWriteApi = permissions?.allowWriteApi === true;
  const canWriteNotes = permissions?.allowWriteNotes === true;

  const requiredScopes: OsmContributionScope[] = [];
  if (!canWriteApi) requiredScopes.push("write_api");
  if (!canWriteNotes) requiredScopes.push("write_notes");

  const user = state.status === "linked" ? state.user : null;
  const contributorTermsAgreed = user?.contributorTermsAgreed === true;
  const activeBlock = user?.activeBlock === true;

  return {
    enabled,
    directEditingEnabled,
    linked,
    canWriteApi,
    canWriteNotes,
    contributorTermsAgreed,
    activeBlock,
    ...(user
      ? {
          account: {
            id: user.id,
            displayName: user.displayName,
            profileUrl: config.userProfileUrl(user.displayName),
          },
        }
      : {}),
    requiredScopes,
    actions: {
      reauthorize: requiredScopes.length > 0 || state.status !== "linked",
      ...(user && !contributorTermsAgreed
        ? { contributorTermsUrl: config.contributorTermsUrl() }
        : {}),
      ...(activeBlock ? { accountMessagesUrl: config.accountMessagesUrl() } : {}),
    },
  };
}
