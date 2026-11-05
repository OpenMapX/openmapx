import z from "zod/v4";
import { type AdminOperation, adminCommonResponses, adminJson, httpErrorSchema } from "../admin";
import { accountProvisioningOperations } from "./operations";
import { authPolicyApplySchema, authPolicySnapshotSchema, authPolicyViewSchema } from "./policy";
import { adminReauthOperations } from "./reauth";

export * from "./operations";
export * from "./policy";
export * from "./reauth";
export * from "./users";
export const accountAdminOperations = {
  ...adminReauthOperations,
  ...accountProvisioningOperations,
  getAdminAuthPolicy: {
    method: "GET",
    path: "/api/admin/accounts/policy",
    auth: "admin",
    responses: {
      ...adminCommonResponses,
      200: adminJson(authPolicyViewSchema),
      503: adminJson(httpErrorSchema),
    },
  },
  applyAdminAuthPolicy: {
    method: "POST",
    path: "/api/admin/accounts/policy/apply",
    auth: "admin",
    request: { body: authPolicyApplySchema },
    responses: {
      ...adminCommonResponses,
      200: adminJson(
        z.strictObject({
          active: authPolicySnapshotSchema,
          authPolicyRevision: z.string(),
          activationVersion: z.literal(1),
          appliesTo: z.literal("new_auth_operations"),
        }),
      ),
      409: adminJson(httpErrorSchema),
      503: adminJson(httpErrorSchema),
    },
  },
} as const satisfies Record<string, AdminOperation>;
