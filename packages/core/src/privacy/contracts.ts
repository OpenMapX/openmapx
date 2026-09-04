import z from "zod/v4";
import {
  article15DecisionSchema,
  collectorAvailabilitySchema,
  legalBasisCodeSchema,
  locatorTypeSchema,
  portabilityDecisionSchema,
  processingPurposeCodeSchema,
  recipientRoleCodeSchema,
  rightsOfOthersModeSchema,
  secretProjectionModeSchema,
  sourceOutcomeCodeSchema,
  subjectDataSourceSchema,
  subjectDataStrategySchema,
} from "./codes";

const stableCode = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/);
const stableId = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);

const locatorBase = z.object({
  type: locatorTypeSchema,
  field: z.string().min(1).max(128),
  descriptionCode: stableCode.optional(),
});

export const subjectLocatorDeclarationSchema = z.discriminatedUnion("type", [
  locatorBase.extend({ type: z.literal("user_id") }).strict(),
  locatorBase.extend({ type: z.literal("actor_id") }).strict(),
  locatorBase.extend({ type: z.literal("target_id") }).strict(),
  locatorBase.extend({ type: z.literal("creator_id") }).strict(),
  locatorBase.extend({ type: z.literal("updater_id") }).strict(),
  locatorBase.extend({ type: z.literal("triggered_by") }).strict(),
  locatorBase.extend({ type: z.literal("exact_identifier"), format: stableCode }).strict(),
  locatorBase.extend({ type: z.literal("hmac_principal"), purposeCode: stableCode }).strict(),
  locatorBase
    .extend({
      type: z.literal("managed_oidc_subject"),
      provider: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
    })
    .strict(),
  locatorBase.extend({ type: z.literal("manual"), instructionsCode: stableCode }).strict(),
]);
export type SubjectLocatorDeclaration = z.infer<typeof subjectLocatorDeclarationSchema>;

const retentionRuleBase = z.object({
  reasonCode: stableCode.optional(),
  daysAfterClosure: z.number().int().min(0).max(3650),
});

export const retentionRuleSchema = z.discriminatedUnion("kind", [
  retentionRuleBase.extend({ kind: z.literal("account-lifetime") }).strict(),
  retentionRuleBase
    .extend({ kind: z.literal("fixed-days"), days: z.number().int().min(1).max(36500) })
    .strict(),
  retentionRuleBase.extend({ kind: z.literal("legal-hold") }).strict(),
  retentionRuleBase
    .extend({ kind: z.literal("ephemeral"), hours: z.number().int().min(1).max(8760) })
    .strict(),
]);
export type RetentionRule = z.infer<typeof retentionRuleSchema>;

export const dataOriginDeclarationSchema = z
  .object({
    kind: z.enum(["subject", "controller", "processor", "public-source", "operator"]),
    descriptionCode: stableCode,
    sourceId: stableId.optional(),
  })
  .strict();
export type DataOriginDeclaration = z.infer<typeof dataOriginDeclarationSchema>;

export const recipientRuleSchema = z
  .object({
    id: stableId,
    roleCode: recipientRoleCodeSchema,
    country: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .optional(),
    privacyUrl: z.url().optional(),
    transferSafeguardCode: stableCode.optional(),
  })
  .strict();
export type RecipientRule = z.infer<typeof recipientRuleSchema>;

export const portabilityRuleSchema = z
  .object({
    decision: portabilityDecisionSchema,
    format: z.enum(["json", "jsonl", "geojson", "csv"]).nullable().optional(),
    reasonCode: stableCode.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.decision === "include" && !value.format) {
      ctx.addIssue({ code: "custom", path: ["format"], message: "included data needs a format" });
    }
    if (value.decision !== "include" && !value.reasonCode) {
      ctx.addIssue({
        code: "custom",
        path: ["reasonCode"],
        message: "excluded data needs a reason code",
      });
    }
  });
export type PortabilityRule = z.infer<typeof portabilityRuleSchema>;

export const secretProjectionPolicySchema = z
  .object({
    mode: secretProjectionModeSchema,
    code: stableCode,
    allowedFields: z.array(stableCode).max(64).optional(),
  })
  .strict();
export type SecretProjectionPolicy = z.infer<typeof secretProjectionPolicySchema>;

export const rightsOfOthersPolicySchema = z
  .object({
    mode: rightsOfOthersModeSchema,
    code: stableCode.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.mode !== "none" && !value.code) {
      ctx.addIssue({
        code: "custom",
        path: ["code"],
        message: "a review/redaction code is required",
      });
    }
  });
export type RightsOfOthersPolicy = z.infer<typeof rightsOfOthersPolicySchema>;

export const subjectDataRegistrationSchema = z
  .object({
    id: stableId,
    version: z.number().int().positive(),
    category: stableCode,
    source: subjectDataSourceSchema,
    strategy: subjectDataStrategySchema,
    locators: z.array(subjectLocatorDeclarationSchema).max(32),
    purposes: z.array(processingPurposeCodeSchema).min(1).max(16),
    legalBases: z.array(legalBasisCodeSchema).min(1).max(8),
    origin: dataOriginDeclarationSchema,
    retention: retentionRuleSchema,
    recipients: z.array(recipientRuleSchema).max(32),
    article15: article15DecisionSchema,
    portability: portabilityRuleSchema,
    secretPolicy: secretProjectionPolicySchema,
    rightsOfOthers: rightsOfOthersPolicySchema,
    collectorId: stableId.optional(),
    collectorVersion: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.strategy === "not_personal") {
      if (value.article15 !== "not_personal") {
        ctx.addIssue({
          code: "custom",
          path: ["article15"],
          message: "not_personal cannot be included",
        });
      }
      if (value.locators.length > 0) {
        ctx.addIssue({
          code: "custom",
          path: ["locators"],
          message: "not_personal cannot have subject locators",
        });
      }
      if (value.collectorId) {
        ctx.addIssue({
          code: "custom",
          path: ["collectorId"],
          message: "not_personal cannot have a collector",
        });
      }
    } else if (value.locators.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["locators"],
        message: "personal data needs a locator",
      });
    }
    if (value.strategy === "collector" && !value.collectorId) {
      ctx.addIssue({
        code: "custom",
        path: ["collectorId"],
        message: "collector strategy needs collectorId",
      });
    }
    if (value.strategy === "operator_task" && !value.collectorId) {
      // operator_task may intentionally have no automated collector; the stable
      // registration id itself is the task key.
      return;
    }
  });
export type SubjectDataRegistration = z.infer<typeof subjectDataRegistrationSchema>;

export const collectorOutcomeSchema = z
  .object({
    registrationId: stableId,
    availability: collectorAvailabilitySchema,
    outcome: sourceOutcomeCodeSchema,
    collectorId: stableId.optional(),
    collectorVersion: z.number().int().positive().optional(),
    recordCount: z.number().int().min(0).max(10_000_000),
    warningCodes: z.array(stableCode).max(64),
    capturedAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type CollectorOutcome = z.infer<typeof collectorOutcomeSchema>;

export const operatorSourceDeclarationSchema = z
  .object({
    id: stableId,
    registrationId: stableId,
    instructionsCode: stableCode,
    contactCode: stableCode,
    retentionDays: z.number().int().min(1).max(3650),
  })
  .strict();
export type OperatorSourceDeclaration = z.infer<typeof operatorSourceDeclarationSchema>;

export const privacySourceSchema = z
  .object({
    sourceId: stableId,
    kind: z.enum(["controller", "processor", "independent-controller", "operator"]),
    relationship: stableCode,
    location: z.string().min(1).max(256),
    retention: z.string().min(1).max(256),
    accessStrategy: z.enum(["collector", "operator_task", "not_applicable"]),
    contactCode: stableCode.optional(),
    instructionsCode: stableCode.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.accessStrategy === "operator_task" && !value.instructionsCode) {
      ctx.addIssue({
        code: "custom",
        path: ["instructionsCode"],
        message: "operator source needs instructions",
      });
    }
  });
export type PrivacySource = z.infer<typeof privacySourceSchema>;

export function validateSubjectDataRegistrations(
  values: readonly unknown[],
): { success: true; data: SubjectDataRegistration[] } | { success: false; error: z.ZodError } {
  const parsed = z.array(subjectDataRegistrationSchema).safeParse(values);
  if (!parsed.success) return parsed;
  const ids = new Set<string>();
  const issues: z.core.$ZodIssue[] = [];
  parsed.data.forEach((value, index) => {
    if (ids.has(value.id)) {
      issues.push({
        code: "custom",
        path: [index, "id"],
        message: `duplicate registration id: ${value.id}`,
      });
    }
    ids.add(value.id);
  });
  if (issues.length) return { success: false, error: new z.ZodError(issues) };
  return parsed;
}
