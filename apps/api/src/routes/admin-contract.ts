import { type AdminOperation, assertAdminOperationContract } from "@openmapx/core/api-contracts";
import { createContractRouteRegistrar } from "./contract-route";

export type { RegistrationOptions } from "./contract-route";
/** Administration wrappers keep their narrower auth contract and namespace. */
export function createAdminRouteRegistrar<const R extends Record<string, AdminOperation>>(
  registry: R,
  family: Parameters<typeof createContractRouteRegistrar>[1],
) {
  for (const operation of Object.values(registry)) assertAdminOperationContract(operation);
  return createContractRouteRegistrar(registry, family);
}
