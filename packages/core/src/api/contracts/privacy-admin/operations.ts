import z from "zod/v4";
import {
  privacyCaseDecisionSchema,
  privacyCaseExtensionSchema,
  privacyIdentityVerificationSchema,
  privacyTaskResolutionSchema,
} from "../../../privacy/admin-contracts";
import { type AdminOperation, adminBytes, adminJson, adminTimestampSchema as date } from "../admin";
import {
  privacyAdminDetailSchema,
  privacyCaseViewSchema,
  privacyErrorSchema,
  privacyExportHeaders,
} from "./common";

const params = z.strictObject({ requestId: z.uuid() });
const task = params.extend({ taskId: z.uuid() });
const errors = Object.fromEntries(
  [400, 401, 403, 404, 409, 500, 503].map((s) => [s, adminJson(privacyErrorSchema)]),
);
const headers = z.object({
  "idempotency-key": z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._~-]{15,127}$/),
});
const requestResult = z.strictObject({ request: privacyCaseViewSchema });
const base = "/api/privacy/admin" as const;
const read = <S extends z.ZodType>(path: `/api/${string}`, schema: S, p?: z.ZodType) => ({
  method: "GET" as const,
  path,
  auth: "admin" as const,
  ...(p ? { request: { params: p } } : {}),
  responses: { ...errors, 200: adminJson(schema) },
});
const write = <S extends z.ZodType>(
  path: `/api/${string}`,
  body: z.ZodType,
  schema: S,
  p: z.ZodType = params,
  success = 200,
) => ({
  method: "POST" as const,
  path,
  auth: "admin" as const,
  request: { params: p, body, headers },
  responses: { ...errors, [success]: adminJson(schema) },
});
export const privacyAdminOperations = {
  listPrivacyAdminQueue: read(
    `${base}/queue`,
    z.strictObject({ requests: z.array(privacyCaseViewSchema) }),
  ),
  getPrivacyAdminCase: read(`${base}/requests/:requestId`, privacyAdminDetailSchema, params),
  createPrivacyAdminCase: write(
    `${base}/requests`,
    z.strictObject({
      kind: z.enum(["access", "portability", "access_and_portability"]).optional(),
      channel: z.enum(["email", "post", "representative", "internal"]).optional(),
      userId: z.string().nullable().optional(),
      subject: z
        .strictObject({
          locatorType: z.enum([
            "user_id",
            "email",
            "username",
            "erasure_reference",
            "other_reference",
          ]),
          locator: z.string().min(1).max(512),
          accountState: z.enum(["current", "inaccessible", "deleted", "unknown"]),
        })
        .optional(),
      receivedAt: date.optional(),
      locale: z.string().optional(),
      timeZone: z.string().optional(),
    }),
    requestResult,
    z.strictObject({}),
    202,
  ),
  verifyPrivacyAdminIdentity: write(
    `${base}/requests/:requestId/identity`,
    privacyIdentityVerificationSchema,
    requestResult,
  ),
  resolvePrivacyAdminTask: write(
    `${base}/requests/:requestId/tasks/:taskId/resolution`,
    privacyTaskResolutionSchema,
    requestResult,
    task,
  ),
  extendPrivacyAdminCase: write(
    `${base}/requests/:requestId/extension`,
    privacyCaseExtensionSchema,
    requestResult,
  ),
  decidePrivacyAdminCase: write(
    `${base}/requests/:requestId/decision`,
    privacyCaseDecisionSchema,
    requestResult,
  ),
  /** Streams the subject's export for an assisted case. It needs a completed
   * `privacy.export` reauthentication proof in `x-admin-reauth-proof`. */
  exportPrivacyAdminCase: {
    method: "POST",
    path: `${base}/requests/:requestId/export`,
    auth: "admin",
    request: {
      params,
      body: z.strictObject({}),
      headers: z.object({ "x-admin-reauth-proof": z.uuid() }),
    },
    responses: { ...errors, 200: adminBytes("application/zip", privacyExportHeaders) },
  },
} as const satisfies Record<string, AdminOperation>;
