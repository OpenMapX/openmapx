import { sharingOperations } from "@openmapx/core/api-contracts";
import { createContractRouteRegistrar } from "./contract-route";
export const registerSharingRoute = createContractRouteRegistrar(sharingOperations, {
  tag: "sharing",
  schemaPrefix: "Sharing",
  label: "sharing",
  reuseSchemas: true,
  validationPhase: "preHandler",
});
