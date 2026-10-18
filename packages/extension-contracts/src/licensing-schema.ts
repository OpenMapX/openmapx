import z from "zod/v4";
import {
  ATTRIBUTION_LOGOS,
  ATTRIBUTION_SURFACES,
  isSafeAttributionUrl,
  LICENSE_SCOPES,
} from "./licensing";

const textSchema = z.string().min(1).max(1_000);
const attributionUrlSchema = z.url().max(2_048).refine(isSafeAttributionUrl);

/** Serializable captured identities; semantic recognition remains in parseLicensing. */
export const licenseDescriptorSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("spdx"),
    expression: textSchema,
    url: attributionUrlSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("custom"),
    id: textSchema,
    namespace: z.string().min(1).max(256),
    name: textSchema,
    url: attributionUrlSchema.optional(),
    version: textSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("unknown"),
    raw: textSchema.optional(),
    url: attributionUrlSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("per-item"),
    raw: textSchema.optional(),
    url: attributionUrlSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("public-domain"),
    name: textSchema,
    url: attributionUrlSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("status"),
    id: z.literal("CC-PDM-1.0"),
    url: attributionUrlSchema.optional(),
  }),
]);

/** Reviewed presentation evidence, never a grant of data or API permissions. */
export const attributionPolicySchema = z.strictObject({
  placement: z.enum(["visible", "details"]),
  surfaces: z.array(z.enum(ATTRIBUTION_SURFACES)).min(1).max(3).readonly(),
  basis: z.enum(["licence", "provider-terms", "recommendation", "unresolved"]),
  reviewedAt: z.iso.date(),
  evidenceUrls: z.array(attributionUrlSchema).min(1).max(8).readonly(),
  reason: z.string().min(1).max(2_000),
  /** Reviewed minimal visible wording; the complete notice remains captured. */
  compactText: z.string().min(1).max(2_000).optional(),
  /** Reviewed local branding asset, never an extension-supplied URL. */
  logo: z.enum(ATTRIBUTION_LOGOS).optional(),
  prominence: z.literal("normal").optional(),
  /** Preserve the record publisher beside the visible service credit. */
  includePublisher: z.literal(true).optional(),
});

export const licenseBindingSchema = z.strictObject({
  scope: z.enum(LICENSE_SCOPES),
  subject: textSchema,
  license: licenseDescriptorSchema,
  notice: z.string().min(1).max(16_000).optional(),
  conditions: z.array(textSchema).max(32).readonly().optional(),
  attribution: attributionPolicySchema.optional(),
});

/** Output-only structure: no authoring transforms or inferred licence identities. */
export const licensingSchema = z.strictObject({
  version: z.literal(1),
  bindings: z.array(licenseBindingSchema).max(64).readonly(),
  /** Original declarations are evidence, never display identity or permissions. */
  declarations: z
    .array(z.strictObject({ text: textSchema.optional(), url: attributionUrlSchema.optional() }))
    .max(64)
    .readonly()
    .optional(),
});
