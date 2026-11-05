import z from "zod/v4";
import { type AdminOperation, adminCommonResponses, adminJson, httpErrorSchema } from "../admin";
import { adminServiceIdempotencyHeadersSchema } from "../service-admin/common";
import {
  accountDeliverySchema,
  accountMailActionSchema,
  accountProvisioningResultSchema,
  accountRoleChangeSchema,
  accountRoleSchema,
  assistedAccountPasswordSchema,
  assistedAccountVerifySchema,
  provisionAccountSchema,
} from "./users";

const params = z.strictObject({ userId: z.string().min(1).max(256) }),
  headers = adminServiceIdempotencyHeadersSchema,
  sensitiveHeaders = headers.extend({ "x-openmapx-reauth-challenge": z.uuid() });
const responses = {
  ...adminCommonResponses,
  200: adminJson(accountProvisioningResultSchema),
  404: adminJson(httpErrorSchema),
  409: adminJson(httpErrorSchema),
  503: adminJson(httpErrorSchema),
};
export const accountProvisioningOperations = {
  getAdminAccountDelivery: {
    method: "GET",
    path: "/api/admin/accounts/:userId/delivery",
    auth: "admin",
    request: { params },
    responses: { ...responses, 200: adminJson(accountDeliverySchema) },
  },
  createAdminAccount: {
    method: "POST",
    path: "/api/admin/accounts",
    auth: "admin",
    request: { body: provisionAccountSchema, headers },
    responses,
  },
  inviteAdminAccount: {
    method: "POST",
    path: "/api/admin/accounts/:userId/invitation",
    auth: "admin",
    request: { params, body: accountMailActionSchema, headers: sensitiveHeaders },
    responses,
  },
  sendAdminAccountVerificationEmail: {
    method: "POST",
    path: "/api/admin/accounts/:userId/verification-email",
    auth: "admin",
    request: { params, body: accountMailActionSchema, headers: sensitiveHeaders },
    responses,
  },
  verifyAdminAccount: {
    method: "POST",
    path: "/api/admin/accounts/:userId/verify",
    auth: "admin",
    request: { params, body: assistedAccountVerifySchema, headers: sensitiveHeaders },
    responses,
  },
  sendAdminAccountPasswordReset: {
    method: "POST",
    path: "/api/admin/accounts/:userId/reset-password",
    auth: "admin",
    request: { params, body: accountMailActionSchema, headers: sensitiveHeaders },
    responses,
  },
  setAdminAccountPassword: {
    method: "POST",
    path: "/api/admin/accounts/:userId/password",
    auth: "admin",
    request: { params, body: assistedAccountPasswordSchema, headers: sensitiveHeaders },
    responses,
  },
  changeAdminAccountRole: {
    method: "PATCH",
    path: "/api/admin/accounts/:userId/role",
    auth: "admin",
    request: { params, body: accountRoleChangeSchema, headers },
    responses: {
      ...responses,
      200: adminJson(
        z.strictObject({ userId: z.string(), role: accountRoleSchema, changed: z.boolean() }),
      ),
    },
  },
} as const satisfies Record<string, AdminOperation>;
