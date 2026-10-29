import { extensionAdminOperations } from "@openmapx/core/api-contracts";
import { createAdminRouteRegistrar } from "./admin-contract";

export const registerExtensionAdminRoute = createAdminRouteRegistrar(extensionAdminOperations, {
  tag: "extension-admin",
  documentOptionalBodies: true,
  validationPhase: "preHandler",
});
