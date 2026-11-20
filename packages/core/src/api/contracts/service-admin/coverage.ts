import z from "zod/v4";
import {
  coverageDomainSchema,
  coverageRegionsResponseSchema,
  coverageReportSchema,
  coverageSourceDetailSchema,
} from "../../../coverage";
import { type AdminOperation, adminCommonResponses, adminJson } from "../admin";

const snapshotId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const decimal = (maxLength: number) =>
  z
    .string()
    .regex(/^[0-9]+$/)
    .max(maxLength);
const assessment = z.enum([
  "operational",
  "commercial",
  "redistribute-source-data",
  "redistribute-derived-data",
]);
export const adminCoverageRegionsQuerySchema = z.object({
  snapshotId: snapshotId.optional(),
  search: z.string().min(1).max(256).optional(),
  offset: decimal(8).optional(),
  limit: decimal(3).optional(),
});
export const adminCoverageReportQuerySchema = z.object({
  regionId: z.string().min(1).max(256),
  snapshotId: snapshotId.optional(),
  domain: coverageDomainSchema.optional(),
  attention: z.enum(["true", "false"]).optional(),
  enabled: z.enum(["all", "true", "false"]).optional(),
  assessment: assessment.optional(),
  offset: decimal(8).optional(),
  limit: decimal(3).optional(),
});
export const adminCoverageSourceQuerySchema = z.object({
  key: z.string().min(1).max(512),
  regionId: z.string().min(1).max(256),
  snapshotId: snapshotId.optional(),
  assessment: assessment.optional(),
});
/** Coverage failures carry a stable code such as `snapshot_expired` in `error`. */
const coverageErrorSchema = z.strictObject({ error: z.string() });
const noStore = z.object({ "cache-control": z.literal("private, no-store") });
const coverageResponses = <S extends z.ZodType>(schema: S) => ({
  200: adminJson(schema, noStore),
  ...adminCommonResponses,
  404: adminJson(coverageErrorSchema),
  409: adminJson(coverageErrorSchema),
  503: adminJson(coverageErrorSchema),
});

export const coverageAdminOperations = {
  listAdminCoverageRegions: {
    method: "GET",
    path: "/api/admin/coverage/regions",
    auth: "admin",
    request: { query: adminCoverageRegionsQuerySchema },
    responses: coverageResponses(coverageRegionsResponseSchema),
  },
  getAdminCoverageReport: {
    method: "GET",
    path: "/api/admin/coverage",
    auth: "admin",
    request: { query: adminCoverageReportQuerySchema },
    responses: coverageResponses(coverageReportSchema),
  },
  getAdminCoverageSource: {
    method: "GET",
    path: "/api/admin/coverage/source",
    auth: "admin",
    request: { query: adminCoverageSourceQuerySchema },
    responses: coverageResponses(coverageSourceDetailSchema),
  },
} as const satisfies Record<string, AdminOperation>;
