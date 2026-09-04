import z from "zod/v4";

/** Stable vocabulary shared by the catalogue, collectors and public reports. */
export const subjectDataStrategySchema = z.enum(["collector", "operator_task", "not_personal"]);
export type SubjectDataStrategy = z.infer<typeof subjectDataStrategySchema>;

export const article15DecisionSchema = z.enum(["include", "not_personal"]);
export type Article15Decision = z.infer<typeof article15DecisionSchema>;

export const portabilityDecisionSchema = z.enum(["include", "exclude", "conditional"]);
export type PortabilityDecision = z.infer<typeof portabilityDecisionSchema>;

export const subjectDataSourceSchema = z.enum([
  "openmapx-db",
  "redis",
  "managed-service",
  "operator",
]);
export type SubjectDataSource = z.infer<typeof subjectDataSourceSchema>;

export const locatorTypeSchema = z.enum([
  "user_id",
  "actor_id",
  "target_id",
  "creator_id",
  "updater_id",
  "triggered_by",
  "exact_identifier",
  "hmac_principal",
  "managed_oidc_subject",
  "manual",
]);
export type SubjectLocatorType = z.infer<typeof locatorTypeSchema>;

export const processingPurposeCodeSchema = z.enum([
  "account-management",
  "authentication",
  "security-and-abuse-prevention",
  "saved-content",
  "personalization",
  "navigation",
  "timeline-processing",
  "service-provisioning",
  "support-and-operations",
  "legal-accountability",
  "communications",
  "publication",
  "analytics",
]);
export type ProcessingPurposeCode = z.infer<typeof processingPurposeCodeSchema>;

export const legalBasisCodeSchema = z.enum([
  "contract",
  "consent",
  "legal-obligation",
  "legitimate-interest",
]);
export type LegalBasisCode = z.infer<typeof legalBasisCodeSchema>;

export const originKindSchema = z.enum([
  "subject",
  "controller",
  "processor",
  "public-source",
  "operator",
]);
export type OriginKind = z.infer<typeof originKindSchema>;

export const recipientRoleCodeSchema = z.enum([
  "controller",
  "processor",
  "independent-controller",
  "public-recipient",
  "operator",
]);
export type RecipientRoleCode = z.infer<typeof recipientRoleCodeSchema>;

export const secretProjectionModeSchema = z.enum(["redact", "metadata", "operator_review"]);
export type SecretProjectionMode = z.infer<typeof secretProjectionModeSchema>;

export const rightsOfOthersModeSchema = z.enum(["none", "redact", "operator_review"]);
export type RightsOfOthersMode = z.infer<typeof rightsOfOthersModeSchema>;

export const collectorAvailabilitySchema = z.enum([
  "available",
  "unavailable",
  "operator_review",
  "not_applicable",
]);
export type CollectorAvailability = z.infer<typeof collectorAvailabilitySchema>;

export const sourceOutcomeCodeSchema = z.enum([
  "included",
  "not_applicable",
  "unavailable",
  "reviewed_no_match",
  "omitted_with_reason",
]);
export type SourceOutcomeCode = z.infer<typeof sourceOutcomeCodeSchema>;
