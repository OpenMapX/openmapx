import { garageOperations } from "@openmapx/core/api-contracts";
import { createContractRouteRegistrar } from "./contract-route";

export const registerGarageRoute = createContractRouteRegistrar(garageOperations, {
  tag: "garage",
  schemaPrefix: "Garage",
  label: "garage",
  reuseSchemas: true,
  validationPhase: "preHandler",
});
