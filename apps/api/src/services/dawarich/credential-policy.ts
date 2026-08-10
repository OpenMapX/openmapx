const PROVISIONING_OWNED_CREDENTIALS: Readonly<Record<string, ReadonlySet<string>>> = {
  "dawarich-app": new Set(["DATABASE_PASSWORD", "SECRET_KEY_BASE", "OIDC_CLIENT_SECRET"]),
  "dawarich-sidekiq": new Set(["DATABASE_PASSWORD", "SECRET_KEY_BASE", "OIDC_CLIENT_SECRET"]),
  "dawarich-postgis": new Set(["POSTGRES_PASSWORD"]),
};

export const DAWARICH_CREDENTIAL_MANAGED_CODE = "DAWARICH_CREDENTIAL_MANAGED";
export const DAWARICH_CREDENTIAL_MANAGED_BY = "dawarich-provisioning";
export const DAWARICH_CREDENTIAL_MANAGED_ERROR =
  "Managed Dawarich setup owns this credential. Use Provision/reconcile or the dedicated OIDC recovery action; follow the operator guide for database or Rails credential conflict recovery.";

export function isProvisioningOwnedDawarichCredential(serviceId: string, key: string): boolean {
  return PROVISIONING_OWNED_CREDENTIALS[serviceId]?.has(key) ?? false;
}
