import { dataManagerAdminOperations } from "@openmapx/core/api-contracts";
import { createAdminRouteRegistrar } from "./admin-contract";

/** Preserve the original data-manager preValidation and beforeValidation ordering. */
export const registerDataManagerAdminRoute = createAdminRouteRegistrar(dataManagerAdminOperations, {
  tag: "data-manager-admin",
  validationPhase: "preValidation",
});
