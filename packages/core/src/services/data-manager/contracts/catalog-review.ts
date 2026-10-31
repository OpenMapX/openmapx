import z from "zod/v4";
import {
  catalogProposalSchema,
  catalogProposalSummarySchema,
} from "../../../catalog-pins/proposal-schemas";
import {
  catalogRuntimeInputsSchema,
  catalogValidationSchema,
} from "../../../catalog-pins/review-schemas";
import { catalogPinSetSchema } from "../../../catalog-pins/schemas";
import { dataExecutionStatusSchema } from "./executions";

const count = z.number().int().nonnegative().safe();
export const catalogReviewQuerySchema = z.object({
  proposalId: z.uuid().optional(),
  offset: z.coerce.number().int().min(0).max(4096).default(0),
  diffOffset: z.coerce.number().int().min(0).max(200000).default(0),
});
const change = z.strictObject({
  id: z.string(),
  region: z.string(),
  source: z.string(),
  change: z.enum(["added", "removed", "changed"]),
  fields: z.array(
    z.enum(["endpoint", "origin", "license", "attribution", "eligibility", "metadata"]),
  ),
  licenseStatus: z.enum(["declared", "unknown"]),
  before: z.record(z.string(), z.json()).nullable(),
  after: z.record(z.string(), z.json()).nullable(),
});
export const catalogReviewPageSchema = z.strictObject({
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  total: count,
  offset: count,
  rows: z.array(change).max(100),
  nextOffset: count.nullable(),
});
export const catalogReviewSnapshotSchema = z.strictObject({
  active: catalogPinSetSchema.nullable(),
  allowedCountries: z.array(z.string().regex(/^[a-z]{2,3}$/)).max(256),
  catalogRevisionId: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  page: z.strictObject({
    proposals: z.array(catalogProposalSummarySchema).max(100),
    total: count,
    offset: count,
    nextOffset: count.nullable(),
  }),
  proposal: catalogProposalSchema.nullable(),
  diff: catalogReviewPageSchema.nullable(),
  validation: catalogValidationSchema.nullable(),
  execution: dataExecutionStatusSchema.nullable(),
  validationInputs: catalogRuntimeInputsSchema.nullable(),
  validationEligible: z.boolean(),
  blocker: z.string().max(2048).nullable(),
});
export const catalogProposalCreateSchema = z.strictObject({
  branch: z
    .string()
    .min(1)
    .max(215)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/)
    .refine(
      (value) =>
        !value.includes("..") &&
        !value.includes("@{") &&
        !value.endsWith("/") &&
        !value.endsWith(".lock"),
    )
    .default("main"),
});
export const catalogValidateRequestSchema = z.strictObject({
  countries: z.array(z.string().regex(/^[A-Za-z]{2,3}$/)).max(256),
});
export const catalogActivateRequestSchema = z.strictObject({
  validationId: z.uuid(),
  expectedGenerationId: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  diffDigest: z.string().regex(/^[a-f0-9]{64}$/),
  acknowledgeLicenseChanges: z.boolean(),
});
