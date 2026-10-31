import z from "zod/v4";
import { isSafeCacheTargetText } from "../../../cache-namespaces";
import { type AdminOperation, adminCommonResponses, adminJson } from "../admin";

const boundedTarget = z
  .string()
  .min(1)
  .max(256)
  .refine(isSafeCacheTargetText, "Control characters are not allowed");
export const adminCacheClearInputSchema = z
  .strictObject({
    namespace: boundedTarget.optional(),
    pattern: boundedTarget.regex(/^(?:int:|cache:)/).optional(),
    dryRun: z.boolean().optional(),
  })
  .refine(
    (value) => value.namespace === undefined || value.pattern === undefined,
    "Choose namespace or pattern",
  )
  .optional();
export const adminCacheClearResultSchema = z.union([
  z.strictObject({ deleted: z.number().int().nonnegative(), patterns: z.array(z.string()) }),
  z.strictObject({
    dryRun: z.literal(true),
    estimatedCount: z.number().int().nonnegative(),
    patterns: z.array(z.string()),
  }),
]);
export const cacheAdminOperations = {
  listAdminCacheNamespaces: {
    method: "GET",
    path: "/api/admin/cache",
    auth: "admin",
    responses: {
      200: adminJson(
        z.strictObject({
          namespaces: z.array(
            z.strictObject({ namespace: z.string(), keyCount: z.number().int().nonnegative() }),
          ),
        }),
      ),
      ...adminCommonResponses,
    },
  },
  clearAdminCache: {
    method: "POST",
    path: "/api/admin/cache/clear",
    auth: "admin",
    request: { body: adminCacheClearInputSchema },
    responses: { 200: adminJson(adminCacheClearResultSchema), ...adminCommonResponses },
  },
} as const satisfies Record<string, AdminOperation>;
