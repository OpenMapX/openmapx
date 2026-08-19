import { isIP } from "node:net";
import { domainToASCII } from "node:url";

export const MANAGED_REFERENCE_ID = "openmapx-managed-services";
export const DAWARICH_SOFTWARE_ID = "openmapx-managed-dawarich";
export const DAWARICH_APP_SERVICE_ID = "dawarich-app";
export const DAWARICH_WORKER_SERVICE_ID = "dawarich-sidekiq";
export const DAWARICH_POSTGIS_SERVICE_ID = "dawarich-postgis";
export const DAWARICH_REDIS_SERVICE_ID = "dawarich-redis";
export const DAWARICH_VERSION = "1.10.3";
export const DAWARICH_PROVISIONING_GENERATION_KEY = "OPENMAPX_PROVISIONING_GENERATION";
export const DAWARICH_OIDC_RECOVERY_REQUIRED_KEY = "OPENMAPX_OIDC_RECOVERY_REQUIRED";

const CALLBACK_PATH = "/users/auth/openid_connect/callback";
const OIDC_SCOPES = "openid profile email";

export interface ManagedOAuthClient {
  client_id: string;
  client_secret?: string;
  client_name?: string;
  client_uri?: string;
  software_id?: string;
  software_version?: string;
  reference_id?: string;
  redirect_uris: string[];
  token_endpoint_auth_method?: string;
  grant_types?: string[];
  response_types?: string[];
  scope?: string;
  require_pkce?: boolean;
  skip_consent?: boolean;
  enable_end_session?: boolean;
  public?: boolean;
  disabled?: boolean;
  type?: string;
  client_secret_expires_at?: number | string;
}

export type ManagedDawarichProvisioningErrorCode =
  | "DAWARICH_INVALID_PUBLIC_HOST"
  | "DAWARICH_OAUTH_CLIENT_CONFLICT"
  | "DAWARICH_DATABASE_SECRET_CONFLICT"
  | "DAWARICH_RAILS_SECRET_CONFLICT"
  | "DAWARICH_OIDC_SECRET_RECOVERY_REQUIRED"
  | "DAWARICH_PROVISIONING_FAILED";

export class ManagedDawarichProvisioningError extends Error {
  constructor(readonly code: ManagedDawarichProvisioningErrorCode) {
    super(code);
    this.name = "ManagedDawarichProvisioningError";
  }
}

export interface ProvisioningContext {
  hostname: string;
  publicOrigin: string;
  callback: string;
  issuer: string;
}

export function validatePublicHostname(value: string): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length === 0 ||
    !/^[a-zA-Z0-9.-]+$/.test(value)
  ) {
    throw new ManagedDawarichProvisioningError("DAWARICH_INVALID_PUBLIC_HOST");
  }
  const withoutTrailingDot = value.endsWith(".") ? value.slice(0, -1) : value;
  const ascii = domainToASCII(withoutTrailingDot).toLowerCase();
  const labels = ascii.split(".");
  if (
    !ascii ||
    ascii.length > 253 ||
    labels.length < 2 ||
    isIP(ascii) !== 0 ||
    labels.some(
      (label) =>
        label.length === 0 || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
    )
  ) {
    throw new ManagedDawarichProvisioningError("DAWARICH_INVALID_PUBLIC_HOST");
  }
  return ascii;
}

export function callbackForPublicOrigin(publicOrigin: string): string {
  return `${publicOrigin}${CALLBACK_PATH}`;
}

export function desiredClient(context: ProvisioningContext): Record<string, unknown> {
  return {
    client_name: "OpenMapX Managed Dawarich",
    client_uri: context.publicOrigin,
    software_id: DAWARICH_SOFTWARE_ID,
    software_version: DAWARICH_VERSION,
    redirect_uris: [context.callback],
    token_endpoint_auth_method: "client_secret_basic",
    grant_types: ["authorization_code"],
    response_types: ["code"],
    scope: OIDC_SCOPES,
    require_pkce: true,
    skip_consent: true,
    enable_end_session: false,
    client_secret_expires_at: 0,
    type: "web",
  };
}

export function sameArray(left: string[] | undefined, right: string[]): boolean {
  return (
    Array.isArray(left) &&
    left.length === right.length &&
    left.every((value, i) => value === right[i])
  );
}

export function assertImmutableClientSecurity(client: ManagedOAuthClient): void {
  if (
    client.reference_id !== MANAGED_REFERENCE_ID ||
    client.token_endpoint_auth_method !== "client_secret_basic" ||
    client.require_pkce !== true ||
    client.public === true ||
    client.disabled === true
  ) {
    throw new ManagedDawarichProvisioningError("DAWARICH_OAUTH_CLIENT_CONFLICT");
  }
}

export function mutableClientUpdates(
  client: ManagedOAuthClient,
  context: ProvisioningContext,
): Partial<ManagedOAuthClient> {
  const desired = desiredClient(context) as Partial<ManagedOAuthClient>;
  const updates: Partial<ManagedOAuthClient> = {};
  const scalarKeys = [
    "client_name",
    "client_uri",
    "software_id",
    "software_version",
    "scope",
    "skip_consent",
    "enable_end_session",
    "client_secret_expires_at",
    "type",
  ] as const;
  for (const key of scalarKeys) {
    if (
      key === "client_secret_expires_at" &&
      desired[key] === 0 &&
      (client[key] === undefined || client[key] === 0 || client[key] === "0")
    ) {
      continue;
    }
    if (client[key] !== desired[key]) {
      (updates as Record<string, unknown>)[key] = desired[key];
    }
  }
  for (const key of ["redirect_uris", "grant_types", "response_types"] as const) {
    const expected = desired[key] as string[];
    if (!sameArray(client[key], expected)) {
      (updates as Record<string, unknown>)[key] = expected;
    }
  }
  return updates;
}

/**
 * Compare a redacted persisted client snapshot with the managed client contract.
 * This intentionally accepts Better Auth's omitted non-expiring sentinel,
 * matching reconciliation, and never needs the client secret.
 */
export function managedOAuthClientMatchesExpected(
  client: ManagedOAuthClient,
  publicOrigin: string,
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(publicOrigin);
  } catch {
    return false;
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    parsed.origin !== publicOrigin ||
    validatePublicHostname(parsed.hostname) !== parsed.hostname ||
    client.software_id !== DAWARICH_SOFTWARE_ID
  ) {
    return false;
  }
  try {
    assertImmutableClientSecurity(client);
  } catch {
    return false;
  }
  const context: ProvisioningContext = {
    hostname: parsed.hostname,
    publicOrigin,
    callback: callbackForPublicOrigin(publicOrigin),
    issuer: "",
  };
  return Object.keys(mutableClientUpdates(client, context)).length === 0;
}
