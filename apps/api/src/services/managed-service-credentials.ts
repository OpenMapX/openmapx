import { isProvisioningOwnedDawarichCredential } from "./dawarich/credential-policy";
export const TRANSIT_CREDENTIAL_MANAGED_BY = "transit.credentials" as const;
export const TRANSIT_CREDENTIAL_MANAGED_CODE = "transit_credentials_managed" as const;
export const isManagedTransitCredential = (serviceId: string, key: string) =>
  serviceId === "data-manager" && key === "TRANSITOUS_API_KEYS";
export function managedServiceCredential(serviceId: string, key: string) {
  return isManagedTransitCredential(serviceId, key)
    ? TRANSIT_CREDENTIAL_MANAGED_BY
    : isProvisioningOwnedDawarichCredential(serviceId, key)
      ? ("dawarich-provisioning" as const)
      : undefined;
}
